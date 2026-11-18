package feed

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"github.com/EmpowerTours/empowertours-hunt/services/chipboard/internal/price"
)

const (
	silenceTimeout = 60 * time.Second // a socket this quiet is treated as dead
	dialTimeout    = 15 * time.Second
)

// Status is one socket's health.
type Status struct {
	Connected  bool   `json:"connected"`
	LastMsgAge int64  `json:"lastMsgAgeMs"` // -1: nothing received yet
	Reconnects int64  `json:"reconnects"`
	Messages   int64  `json:"messages"`
	LastError  string `json:"lastError,omitempty"`
}

type connState struct {
	connected  atomic.Bool
	lastMsg    atomic.Int64
	reconnects atomic.Int64
	messages   atomic.Int64
	mu         sync.Mutex
	lastErr    string
}

// Feed is a source of ticks for a book.
type Feed interface {
	// Run blocks until ctx is done.
	Run(ctx context.Context)
	// Status reports each connection's health at now (ms).
	Status(now int64) map[string]Status
}

// Live connects to Perpl, Binance, OKX, Bybit and Coinbase.
type Live struct {
	book  *price.Book
	specs []spec
	state map[string]*connState
	logf  func(format string, args ...any)
	// silence is how long a socket may stay quiet before it is dropped and
	// redialled; retry scales the reconnect waits (tests shorten both).
	silence time.Duration
	retry   time.Duration
}

func NewLive(book *price.Book, logf func(string, ...any)) *Live {
	l := &Live{book: book, specs: liveSpecs, state: map[string]*connState{}, logf: logf, silence: silenceTimeout, retry: time.Second}
	for _, s := range l.specs {
		st := &connState{}
		st.lastMsg.Store(-1)
		l.state[s.name] = st
	}
	return l
}

func (l *Live) Run(ctx context.Context) {
	var wg sync.WaitGroup
	// The once-a-second reading behind the book's rolling medians.
	wg.Add(1)
	go func() {
		defer wg.Done()
		t := time.NewTicker(time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-t.C:
				l.book.Sample(now.UnixMilli())
			}
		}
	}()
	for _, s := range l.specs {
		wg.Add(1)
		go func(s spec) {
			defer wg.Done()
			l.loop(ctx, s)
		}(s)
	}
	wg.Wait()
}

// backoff is 1, 2, 4 ... capped at 60, in units of `unit` (one second live).
func backoff(attempt int, unit time.Duration) time.Duration {
	if attempt > 6 {
		attempt = 6
	}
	n := time.Duration(1) << attempt
	if n > 60 {
		n = 60
	}
	return n * unit
}

// loop keeps one socket alive: reconnect with 1 s, 2 s, 4 s ... 60 s between
// tries, starting over once a connection opens.
func (l *Live) loop(ctx context.Context, s spec) {
	st := l.state[s.name]
	for attempt := 0; ctx.Err() == nil; attempt++ {
		opened, err := l.session(ctx, s, st)
		st.connected.Store(false)
		if ctx.Err() != nil {
			return
		}
		if opened {
			attempt = 0
		}
		msg := "closed"
		if err != nil {
			msg = err.Error()
			if len(msg) > 200 {
				msg = msg[:200]
			}
		}
		st.mu.Lock()
		st.lastErr = msg
		st.mu.Unlock()
		st.reconnects.Add(1)
		wait := backoff(attempt, l.retry)
		l.logf("feed %s: down (%s); reconnecting in %s", s.name, msg, wait)
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}

func (l *Live) session(ctx context.Context, s spec, st *connState) (opened bool, err error) {
	dctx, cancel := context.WithTimeout(ctx, dialTimeout)
	c, _, err := websocket.Dial(dctx, s.url, nil)
	cancel()
	if err != nil {
		return false, err
	}
	defer c.CloseNow()
	c.SetReadLimit(8 << 20) // Perpl's market-state carries every market
	sctx, stop := context.WithCancel(ctx)
	defer stop()
	if s.sub != "" {
		if err := c.Write(sctx, websocket.MessageText, []byte(s.sub)); err != nil {
			return false, err
		}
	}
	st.connected.Store(true)
	l.logf("feed %s: connected", s.name)
	if s.ping != "" {
		go func() {
			t := time.NewTicker(pingEvery)
			defer t.Stop()
			for {
				select {
				case <-sctx.Done():
					return
				case <-t.C:
					if c.Write(sctx, websocket.MessageText, []byte(s.ping)) != nil {
						return
					}
				}
			}
		}()
	}
	for {
		rctx, rcancel := context.WithTimeout(sctx, l.silence)
		_, data, err := c.Read(rctx)
		rcancel()
		if err != nil {
			return true, err
		}
		r := time.Now().UnixMilli()
		st.lastMsg.Store(r)
		st.messages.Add(1)
		if string(data) == "pong" {
			continue
		}
		for _, tk := range s.parse(data, r) {
			l.book.Add(tk.Src, tk.T, tk.P)
		}
	}
}

func (l *Live) Status(now int64) map[string]Status {
	out := map[string]Status{}
	for name, st := range l.state {
		age := int64(-1)
		if lm := st.lastMsg.Load(); lm >= 0 {
			age = now - lm
		}
		st.mu.Lock()
		e := st.lastErr
		st.mu.Unlock()
		out[name] = Status{Connected: st.connected.Load(), LastMsgAge: age, Reconnects: st.reconnects.Load(), Messages: st.messages.Load(), LastError: e}
	}
	return out
}
