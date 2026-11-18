// loadtest connects simulated players to a chipboard server and has each of
// them place chips in every round, then reports connections held, message
// rates, placement-to-acceptance latency and (with -pid) the server's memory
// and CPU.
//
//	loadtest -url ws://127.0.0.1:8090/ws -n 5000 -rounds 3 -pid <server pid>
//	loadtest -n 1 -rounds 1 -verbose      (one player, print what it sees)
//
// The server must run with DEV_ANON=1.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"os"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

type msg struct {
	T      string          `json:"t"`
	ID     int64           `json:"id"`
	OK     bool            `json:"ok"`
	Reason string          `json:"reason"`
	Round  json.RawMessage `json:"round"`
	Points int             `json:"points"`
}

type roundInfo struct {
	ID     int64  `json:"id"`
	Lock   int64  `json:"lock"`
	Status string `json:"status"`
}

type stats struct {
	connected, dialErrors, disconnects                atomic.Int64
	sent, received, frames                            atomic.Int64
	acksOK, acksRefused, unacked                      atomic.Int64
	px, opens, locks, closes, voids, results, standng atomic.Int64
	sendErrors                                        atomic.Int64
	mu                                                sync.Mutex
	lat                                               []float64 // ms
	refused                                           map[string]int
	closeCodes                                        map[string]int
	roundsPlayed                                      map[int64]int // round -> players with an accepted set
	roundsResult                                      map[int64]int // round -> results received
	roundsDone                                        map[int64]string
	pointsSum                                         int64
}

var (
	url     = flag.String("url", "ws://127.0.0.1:8090/ws", "server /ws URL")
	n       = flag.Int("n", 5000, "simulated players")
	rounds  = flag.Int("rounds", 3, "rounds every player places chips in")
	ramp    = flag.Int("ramp", 500, "new connections per second while connecting")
	pid     = flag.Int("pid", 0, "server process id, to sample its memory and CPU from /proc")
	verbose = flag.Bool("verbose", false, "print every message except price ticks (use with a small -n)")
	seed    = flag.Int64("seed", 1, "seed for the simulated players' choices")
	prefix  = flag.String("prefix", "lt", "player name prefix")
)

var pxMark = []byte(`"t":"px"`)

var st = &stats{refused: map[string]int{}, closeCodes: map[string]int{}, roundsPlayed: map[int64]int{}, roundsResult: map[int64]int{}, roundsDone: map[int64]string{}}

// play is the set of rounds the test places chips in: the first -rounds
// rounds that open after every player is connected.
var play struct {
	sync.Mutex
	armed  bool
	rounds map[int64]bool
}

func wantRound(id int64) bool {
	play.Lock()
	defer play.Unlock()
	if !play.armed {
		return false
	}
	if play.rounds[id] {
		return true
	}
	if len(play.rounds) < *rounds {
		play.rounds[id] = true
		return true
	}
	return false
}

type player struct {
	name string
	rng  *rand.Rand
	c    *websocket.Conn
	mu   sync.Mutex
	sent map[int64]sentMsg
	next int64
}

type sentMsg struct {
	at    time.Time
	isSet bool
}

func (p *player) send(ctx context.Context, v map[string]any) {
	p.mu.Lock()
	p.next++
	id := p.next
	v["id"] = id
	b, _ := json.Marshal(v)
	p.sent[id] = sentMsg{time.Now(), v["t"] == "set"}
	p.mu.Unlock()
	if err := p.c.Write(ctx, websocket.MessageText, b); err != nil {
		st.sendErrors.Add(1)
		return
	}
	st.sent.Add(1)
}

// placeIn schedules this player's chips for one open round: a full board at a
// random moment of the open window, then one adjustment shortly after.
func (p *player) placeIn(ctx context.Context, round, lockMs int64) {
	left := time.Until(time.UnixMilli(lockMs)) - 1500*time.Millisecond
	if left < 500*time.Millisecond {
		return
	}
	p.mu.Lock()
	at := 200*time.Millisecond + time.Duration(p.rng.Int63n(int64(left-400*time.Millisecond)))
	chips := make([]int, 12)
	rest := 100
	for rest > 0 {
		k := 5 * (1 + p.rng.Intn(10))
		if k > rest {
			k = rest
		}
		chips[2+p.rng.Intn(8)] += k
		rest -= k
	}
	from := 0
	for i, c := range chips {
		if c > 0 {
			from = i
		}
	}
	gap := 300*time.Millisecond + time.Duration(p.rng.Int63n(int64(900*time.Millisecond)))
	p.mu.Unlock()
	time.AfterFunc(at, func() {
		if ctx.Err() != nil {
			return
		}
		p.send(ctx, map[string]any{"t": "set", "round": round, "chips": chips})
		time.AfterFunc(gap, func() {
			if ctx.Err() == nil {
				p.send(ctx, map[string]any{"t": "add", "round": round, "band": from, "delta": -5})
			}
		})
	})
}

func (p *player) run(ctx context.Context, ready *sync.WaitGroup) {
	dctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	c, _, err := websocket.Dial(dctx, *url, nil)
	cancel()
	if err != nil {
		st.dialErrors.Add(1)
		if *verbose {
			fmt.Println("dial:", err)
		}
		ready.Done()
		return
	}
	defer c.CloseNow()
	c.SetReadLimit(1 << 20)
	p.c = c
	auth, _ := json.Marshal(map[string]any{"t": "auth", "player": p.name})
	if err := c.Write(ctx, websocket.MessageText, auth); err != nil {
		st.dialErrors.Add(1)
		ready.Done()
		return
	}
	isReady := false
	for {
		_, data, err := c.Read(ctx)
		if err != nil {
			if !isReady {
				st.dialErrors.Add(1)
				ready.Done()
			} else if ctx.Err() == nil {
				st.connected.Add(-1)
				st.disconnects.Add(1)
				st.mu.Lock()
				st.closeCodes[strconv.Itoa(int(websocket.CloseStatus(err)))]++
				st.mu.Unlock()
			}
			return
		}
		now := time.Now()
		st.frames.Add(1)
		// A frame holds one or more messages, one per line.
		for len(data) > 0 {
			line := data
			if i := bytes.IndexByte(data, '\n'); i >= 0 {
				line, data = data[:i], data[i+1:]
			} else {
				data = nil
			}
			if !isReady && bytes.Contains(line, []byte(`"t":"hello"`)) {
				isReady = true
				st.connected.Add(1)
				ready.Done()
			}
			p.handle(ctx, line, now)
		}
	}
}

// handle processes one server message.
func (p *player) handle(ctx context.Context, data []byte, now time.Time) {
	{
		st.received.Add(1)
		// Price ticks are most of the traffic; count them without parsing.
		if bytes.Contains(data, pxMark) {
			st.px.Add(1)
			return
		}
		var m msg
		if json.Unmarshal(data, &m) != nil {
			return
		}
		if *verbose && m.T != "px" {
			fmt.Printf("%s  <- %s\n", now.UTC().Format("15:04:05.000"), data)
		}
		switch m.T {
		case "px":
			st.px.Add(1)
		case "open":
			st.opens.Add(1)
			var r roundInfo
			if json.Unmarshal(m.Round, &r) == nil && wantRound(r.ID) {
				p.placeIn(ctx, r.ID, r.Lock)
			}
		case "ack":
			p.mu.Lock()
			t0, ok := p.sent[m.ID]
			delete(p.sent, m.ID)
			p.mu.Unlock()
			if !ok {
				return
			}
			ms := float64(now.Sub(t0.at).Microseconds()) / 1000
			st.mu.Lock()
			if m.OK {
				st.lat = append(st.lat, ms)
				var rid int64
				json.Unmarshal(m.Round, &rid)
				if t0.isSet {
					st.roundsPlayed[rid]++
				}
			} else {
				st.refused[m.Reason]++
			}
			st.mu.Unlock()
			if m.OK {
				st.acksOK.Add(1)
			} else {
				st.acksRefused.Add(1)
			}
		case "lock":
			st.locks.Add(1)
		case "close", "void":
			var rid int64
			json.Unmarshal(m.Round, &rid)
			st.mu.Lock()
			st.roundsDone[rid] = m.T
			st.mu.Unlock()
			if m.T == "close" {
				st.closes.Add(1)
			} else {
				st.voids.Add(1)
			}
		case "result":
			var rid int64
			json.Unmarshal(m.Round, &rid)
			st.results.Add(1)
			st.mu.Lock()
			st.roundsResult[rid]++
			st.pointsSum += int64(m.Points)
			st.mu.Unlock()
		case "standing":
			st.standng.Add(1)
		}
	}
}

/* ---- server process sampling (Linux /proc) ---- */

type procSample struct {
	rssKB, hwmKB int64
	cpuTicks     int64
}

func readProc(pid int) (procSample, bool) {
	var s procSample
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		return s, false
	}
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) >= 2 {
			switch f[0] {
			case "VmRSS:":
				s.rssKB, _ = strconv.ParseInt(f[1], 10, 64)
			case "VmHWM:":
				s.hwmKB, _ = strconv.ParseInt(f[1], 10, 64)
			}
		}
	}
	b, err = os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return s, false
	}
	// fields after the ")" that ends the command name: utime and stime are the 12th and 13th
	rest := strings.Fields(string(b[strings.LastIndexByte(string(b), ')')+1:]))
	if len(rest) > 12 {
		u, _ := strconv.ParseInt(rest[11], 10, 64)
		k, _ := strconv.ParseInt(rest[12], 10, 64)
		s.cpuTicks = u + k
	}
	return s, true
}

func pct(v []float64, p float64) float64 {
	if len(v) == 0 {
		return 0
	}
	return v[int(p*float64(len(v)-1))]
}

func main() {
	flag.Parse()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	play.rounds = map[int64]bool{}
	fmt.Printf("loadtest: %d players -> %s, %d rounds each\n", *n, *url, *rounds)

	// connect
	var ready sync.WaitGroup
	t0 := time.Now()
	tick := time.NewTicker(time.Second / time.Duration(*ramp))
	for i := 0; i < *n; i++ {
		<-tick.C
		ready.Add(1)
		p := &player{name: fmt.Sprintf("%s%d", *prefix, i), rng: rand.New(rand.NewSource(*seed*1_000_003 + int64(i))), sent: map[int64]sentMsg{}}
		go p.run(ctx, &ready)
	}
	tick.Stop()
	ready.Wait()
	held := st.connected.Load()
	fmt.Printf("connected %d of %d in %.1fs (dial errors %d)\n", held, *n, time.Since(t0).Seconds(), st.dialErrors.Load())
	if held == 0 {
		os.Exit(1)
	}

	// sample the server once a second
	var samples []procSample
	var cpuPeak float64
	minHeld := held
	sampleDone := make(chan struct{})
	go func() {
		defer close(sampleDone)
		tk := time.NewTicker(time.Second)
		defer tk.Stop()
		var prev procSample
		for {
			select {
			case <-ctx.Done():
				return
			case <-tk.C:
				if c := st.connected.Load(); c < minHeld {
					minHeld = c
				}
				if *pid == 0 {
					continue
				}
				if s, ok := readProc(*pid); ok {
					if len(samples) > 0 {
						if c := float64(s.cpuTicks - prev.cpuTicks); c > cpuPeak { // ticks are 1/100 s: ticks per second = % of one core
							cpuPeak = c
						}
					}
					prev = s
					samples = append(samples, s)
				}
			}
		}
	}()

	// play: the next -rounds rounds to open
	play.Lock()
	play.armed = true
	play.Unlock()
	playStart := time.Now()
	self0, _ := readProc(os.Getpid())
	sent0, recv0, frames0 := st.sent.Load(), st.received.Load(), st.frames.Load()
	deadline := time.After(time.Duration(*rounds*20+140) * time.Second)
wait:
	for {
		select {
		case <-deadline:
			fmt.Println("gave up waiting for the rounds to close")
			break wait
		case <-time.After(500 * time.Millisecond):
			play.Lock()
			st.mu.Lock()
			done := len(play.rounds) == *rounds
			for id := range play.rounds {
				if st.roundsDone[id] == "" {
					done = false
				}
			}
			st.mu.Unlock()
			play.Unlock()
			if done {
				time.Sleep(2 * time.Second) // let the last results arrive
				break wait
			}
		}
	}
	dur := time.Since(playStart).Seconds()
	self1, _ := readProc(os.Getpid())
	sent, recv, frames := st.sent.Load()-sent0, st.received.Load()-recv0, st.frames.Load()-frames0
	endHeld := st.connected.Load()

	var metrics string
	if resp, err := http.Get(strings.Replace(strings.Replace(*url, "ws://", "http://", 1), "/ws", "/metrics", 1)); err == nil {
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		metrics = string(b)
	}
	cancel()
	<-sampleDone

	st.mu.Lock()
	defer st.mu.Unlock()
	sort.Float64s(st.lat)
	p := func() {
		play.Lock()
		defer play.Unlock()
		ids := make([]int64, 0, len(play.rounds))
		for id := range play.rounds {
			ids = append(ids, id)
		}
		sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
		for _, id := range ids {
			fmt.Printf("  round %d: %s · %d players had a board accepted · %d results received\n", id, st.roundsDone[id], st.roundsPlayed[id], st.roundsResult[id])
		}
	}
	fmt.Printf("\n== load test result ==\n")
	fmt.Printf("connections: %d connected, lowest held during play %d, %d at the end, %d disconnects %v\n", held, minHeld, endHeld, st.disconnects.Load(), st.closeCodes)
	fmt.Printf("play window: %.1fs\n", dur)
	p()
	fmt.Printf("client -> server: %d messages (%.0f/s average), send errors %d\n", sent, float64(sent)/dur, st.sendErrors.Load())
	fmt.Printf("server -> client: %d messages (%.0f/s average) in %d frames (%.0f/s) · px %d · open %d · lock %d · close %d · void %d · result %d · standing %d\n",
		recv, float64(recv)/dur, frames, float64(frames)/dur, st.px.Load(), st.opens.Load(), st.locks.Load(), st.closes.Load(), st.voids.Load(), st.results.Load(), st.standng.Load())
	unacked := sent - st.acksOK.Load() - st.acksRefused.Load()
	fmt.Printf("placements: %d accepted, %d refused %v, %d sent but never acknowledged\n", st.acksOK.Load(), st.acksRefused.Load(), st.refused, unacked)
	if len(st.lat) > 0 {
		fmt.Printf("placement -> acceptance latency (client clock, n=%d): p50 %.2f ms · p90 %.2f ms · p99 %.2f ms · max %.2f ms\n",
			len(st.lat), pct(st.lat, 0.5), pct(st.lat, 0.9), pct(st.lat, 0.99), st.lat[len(st.lat)-1])
	}
	if len(samples) > 1 {
		first, last := samples[0], samples[len(samples)-1]
		var rssMax int64
		for _, s := range samples {
			if s.rssKB > rssMax {
				rssMax = s.rssKB
			}
		}
		avg := float64(last.cpuTicks-first.cpuTicks) / float64(len(samples)-1)
		fmt.Printf("server pid %d: RSS %.0f MB at the end, %.0f MB highest sampled, %.0f MB peak since start (VmHWM) · CPU %.0f%% of one core on average, %.0f%% in the busiest second\n",
			*pid, float64(last.rssKB)/1024, float64(rssMax)/1024, float64(last.hwmKB)/1024, avg, cpuPeak)
	} else if *pid != 0 {
		fmt.Printf("server pid %d: could not read /proc\n", *pid)
	}
	fmt.Printf("this load generator: CPU %.0f%% of one core on average (the machine has %d cores, shared with the server)\n", float64(self1.cpuTicks-self0.cpuTicks)/dur, runtime.NumCPU())
	if metrics != "" {
		fmt.Println("server /metrics at the end:")
		for _, line := range strings.Split(strings.TrimSpace(metrics), "\n") {
			if !strings.Contains(line, "feed_age") {
				fmt.Println("  " + line)
			}
		}
	}
}
