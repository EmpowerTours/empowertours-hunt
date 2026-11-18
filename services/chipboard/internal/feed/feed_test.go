package feed

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/EmpowerTours/empowertours-hunt/services/chipboard/internal/price"
)

const r0 = int64(1_794_962_106_546)

func TestParsePerpl(t *testing.T) {
	// live trade: stamped with the local receive time, price scaled by 10
	got := parsePerpl([]byte(`{"mt":18,"d":[{"p":647411,"s":61,"sd":1,"at":{"t":1794962105000,"b":123160783}}]}`), r0)
	if len(got) != 1 || got[0] != (Tick{price.Perpl, r0, 64741.1}) {
		t.Errorf("live trade: %+v", got)
	}
	// snapshot trades: stamped with Perpl's own trade time, not "now"
	got = parsePerpl([]byte(`{"mt":17,"d":[{"p":647076,"s":2,"sd":1,"at":{"t":1794962026000,"b":1}},{"p":647076,"s":10,"sd":1,"at":{"t":1794962027000,"b":2}},{"p":647076,"s":1,"sd":1}]}`), r0)
	if len(got) != 2 || got[0].T != 1794962026000 || got[1].T != 1794962027000 || got[0].P != 64707.6 {
		t.Errorf("snapshot: %+v", got)
	}
	// market-state: BTC is market 1; other markets and a zero mark are ignored
	got = parsePerpl([]byte(`{"mt":9,"d":{"1":{"mrk":647579,"bid":647410,"ask":647411},"2":{"mrk":30000}}}`), r0)
	if len(got) != 1 || got[0] != (Tick{price.PerplMark, r0, 64757.9}) {
		t.Errorf("mark: %+v", got)
	}
	for _, msg := range []string{`{"mt":9,"d":{"1":{"mrk":0}}}`, `{"mt":9,"d":{"2":{"mrk":5}}}`, `{"mt":100,"h":123}`, `not json`, `{"mt":18,"d":[{"p":0}]}`} {
		if got := parsePerpl([]byte(msg), r0); len(got) != 0 {
			t.Errorf("%s gave %+v", msg, got)
		}
	}
}

func TestParseReferenceVenues(t *testing.T) {
	cases := []struct {
		name  string
		parse func([]byte, int64) []Tick
		msg   string
		want  []Tick
	}{
		{"binance", parseBinance, `{"e":"trade","E":1,"s":"BTCUSDT","t":1,"p":"64807.68000000","q":"0.00009000","T":1794962104850,"m":false}`, []Tick{{price.Binance, r0, 64807.68}}},
		{"binance other event", parseBinance, `{"result":null,"id":1}`, nil},
		{"okx", parseOKX, `{"arg":{"channel":"trades","instId":"BTC-USDT-SWAP"},"data":[{"instId":"BTC-USDT-SWAP","px":"64772.7","sz":"0.06","side":"sell","ts":"1794962102753"},{"px":"64772.8","sz":"1","side":"buy","ts":"1"}]}`, []Tick{{price.OKX, r0, 64772.7}, {price.OKX, r0, 64772.8}}},
		{"okx subscribe ack", parseOKX, `{"event":"subscribe","arg":{"channel":"trades"}}`, nil},
		{"bybit", parseBybit, `{"topic":"publicTrade.BTCUSDT","type":"snapshot","ts":1,"data":[{"T":1794962102812,"s":"BTCUSDT","S":"Buy","v":"0.003","p":"64779.90","L":"PlusTick","i":"x","BT":false}]}`, []Tick{{price.Bybit, r0, 64779.9}}},
		{"bybit pong", parseBybit, `{"success":true,"ret_msg":"pong","op":"ping"}`, nil},
		{"coinbase", parseCoinbase, `{"type":"match","price":"64737.79","size":"0.00000008","side":"buy","time":"2026-11-17T23:55:02.706Z"}`, []Tick{{price.Coinbase, r0, 64737.79}}},
		{"coinbase last_match", parseCoinbase, `{"type":"last_match","price":"64737.79"}`, nil},
	}
	for _, c := range cases {
		got := c.parse([]byte(c.msg), r0)
		if len(got) == 0 && len(c.want) == 0 {
			continue
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: %+v, want %+v", c.name, got, c.want)
		}
	}
}

func TestBackoff(t *testing.T) {
	want := []int{1, 2, 4, 8, 16, 32, 60, 60, 60}
	for i, w := range want {
		if got := backoff(i, time.Second); got != time.Duration(w)*time.Second {
			t.Errorf("attempt %d: %v", i, got)
		}
	}
}

func TestSynthDeterministic(t *testing.T) {
	start := int64(1_800_000_000_000)
	a := NewSynth(7, start).RunTo(start + 300_000)
	b := NewSynth(7, start).RunTo(start + 300_000)
	if len(a) < 3000 || !reflect.DeepEqual(a, b) {
		t.Fatalf("same seed, different ticks (%d vs %d)", len(a), len(b))
	}
	c := NewSynth(8, start).RunTo(start + 300_000)
	if reflect.DeepEqual(a, c) {
		t.Fatal("different seeds gave the same ticks")
	}
	seen := map[price.Source]int{}
	for _, tk := range a {
		seen[tk.Src]++
		if tk.P < 90_000 || tk.P > 120_000 {
			t.Fatalf("price walked off: %+v", tk)
		}
	}
	for _, s := range price.Sources {
		if seen[s] == 0 {
			t.Errorf("no ticks for %s", s)
		}
	}
}

func TestSynthFillsAHealthyBook(t *testing.T) {
	now := int64(1_800_000_000_000)
	b := price.NewBook(price.DefaultConfig())
	NewSynth(1, now-SyntheticBackfillMs).FillBook(b, now)
	s := b.Snapshot(now)
	for _, rule := range price.Rules {
		if _, void := b.Judge(rule, s); void != "" {
			t.Errorf("%s voided on the synthetic feed: %s (%+v)", rule, void, s)
		}
	}
	if s.FreshVenues != 4 {
		t.Errorf("fresh venues %d", s.FreshVenues)
	}
}

// A socket that goes quiet is dropped and redialled; a socket the server
// closes is redialled too.
func TestLiveReconnects(t *testing.T) {
	var dials atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		n := dials.Add(1)
		ctx := r.Context()
		if _, sub, err := c.Read(ctx); err != nil || string(sub) != "SUB" {
			return
		}
		c.Write(ctx, websocket.MessageText, []byte(`{"e":"trade","p":"100.5"}`))
		if n == 1 {
			return // 1st connection: the server hangs up
		}
		// later connections: go silent and wait to be dropped
		c.Read(ctx)
	}))
	defer srv.Close()

	book := price.NewBook(price.DefaultConfig())
	l := NewLive(book, func(string, ...any) {})
	l.specs = []spec{{name: "binance", url: "ws" + strings.TrimPrefix(srv.URL, "http"), sub: "SUB", parse: parseBinance}}
	l.state = map[string]*connState{"binance": {}}
	l.silence, l.retry = 150*time.Millisecond, 10*time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { l.Run(ctx); close(done) }()

	deadline := time.Now().Add(5 * time.Second)
	for dials.Load() < 3 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if dials.Load() < 3 {
		t.Fatalf("only %d dials: no reconnect after a hang-up and a silence", dials.Load())
	}
	st := l.Status(time.Now().UnixMilli())["binance"]
	if st.Reconnects < 2 || st.Messages < 2 {
		t.Errorf("status %+v", st)
	}
	if p, ok := book.Tape(price.Binance).Last(); !ok || p.P != 100.5 {
		t.Errorf("tick not in the book: %+v", p)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("Run did not stop")
	}
}
