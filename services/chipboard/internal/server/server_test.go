package server

import (
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/EmpowerTours/empowertours-hunt/services/chipboard/internal/auth"
	"github.com/EmpowerTours/empowertours-hunt/services/chipboard/internal/engine"
	"github.com/EmpowerTours/empowertours-hunt/services/chipboard/internal/eventlog"
	"github.com/EmpowerTours/empowertours-hunt/services/chipboard/internal/feed"
	"github.com/EmpowerTours/empowertours-hunt/services/chipboard/internal/price"
)

// T0 is a round boundary: 2027-01-15 08:00:00 UTC.
const (
	T0     = int64(1_800_000_000_000)
	K0     = T0 / engine.PeriodMs
	secret = "test-secret-test-secret-test-secret-0123"
)

type nullFeed struct{}

func (nullFeed) Run(context.Context)                 {}
func (nullFeed) Status(int64) map[string]feed.Status { return map[string]feed.Status{} }

// world is a hub on a hand-driven clock with a hand-fed book.
type world struct {
	t     *testing.T
	hub   *Hub
	book  *price.Book
	dir   string
	clock atomic.Int64
	fedTo int64
	// what the feeds deliver while time advances
	perplTrades, perplMark bool
	venues                 int
}

func newWorld(t *testing.T, rule string, mut func(*Config)) *world {
	t.Helper()
	w := &world{t: t, book: price.NewBook(price.DefaultConfig()), dir: t.TempDir(), perplTrades: true, perplMark: true, venues: 4}
	w.fedTo = T0 - 150_000
	w.clock.Store(w.fedTo)
	w.hub = w.newHub(rule, mut)
	return w
}

func (w *world) newHub(rule string, mut func(*Config)) *Hub {
	cfg := DefaultConfig()
	cfg.Rule = rule
	if mut != nil {
		mut(&cfg)
	}
	elog, err := eventlog.Open(w.dir)
	if err != nil {
		w.t.Fatal(err)
	}
	v, _ := auth.NewHMAC(secret)
	hub, err := NewHub(cfg, Deps{Book: w.book, Feed: nullFeed{}, Log: elog, Verifier: v,
		Now:    func() time.Time { return time.UnixMilli(w.clock.Load()) },
		Fatalf: func(f string, a ...any) { w.t.Errorf(f, a...) }})
	if err != nil {
		w.t.Fatal(err)
	}
	return hub
}

// mid is the fed price path: a slow wave plus a 1-second zigzag, so sigma is
// well defined and the price crosses bands.
func mid(t int64) float64 {
	s := float64(t-T0) / 1000
	zig := 4.0
	if (t/1000)%2 == 0 {
		zig = -4
	}
	return 100_000 + 60*math.Sin(s/40) + zig
}

// to feeds every source in 250 ms steps up to t and moves the clock there.
func (w *world) to(t int64) {
	offs := []float64{0, -18, -15, 25}
	for x := w.fedTo + 250; x <= t; x += 250 {
		for i, v := range price.RefVenues {
			if i < w.venues {
				w.book.Add(v, x, mid(x)+offs[i])
			}
		}
		if w.perplTrades {
			w.book.Add(price.Perpl, x, mid(x)*0.9997)
		}
		if w.perplMark {
			w.book.Add(price.PerplMark, x, mid(x)*0.9997)
		}
		if x%1000 == 0 {
			w.book.Sample(x)
		}
		w.fedTo = x
	}
	w.clock.Store(t)
}

// boundary advances to 50 ms past boundary k and runs it.
func (w *world) boundary(k int64) {
	w.to(k*engine.PeriodMs + 50)
	w.hub.Boundary(k)
}

func (w *world) set(player string, round int64, band, n int) string {
	chips := make([]int, engine.NB)
	chips[band] = n
	_, _, reason := w.hub.place(player, &inMsg{T: "set", Round: round, Chips: chips})
	return reason
}

func (w *world) events() []eventlog.Event {
	w.hub.log.Flush()
	var out []eventlog.Event
	if _, err := eventlog.Read(eventlog.FileFor(w.dir, T0), func(e eventlog.Event) error { out = append(out, e); return nil }); err != nil {
		w.t.Fatal(err)
	}
	return out
}

func find(evs []eventlog.Event, kind string, round int64) *eventlog.Event {
	for i := range evs {
		if evs[i].Ev == kind && evs[i].Round == round {
			return &evs[i]
		}
	}
	return nil
}

func TestRoundClockOnHub(t *testing.T) {
	w := newWorld(t, price.RuleComposite, nil)
	w.boundary(K0)
	r, ok := w.hub.game.Get(K0)
	if !ok || r.Status != engine.StatusOpen || r.OpenMs != T0 || r.LockMs != T0+20_000 || r.CloseMs != T0+80_000 {
		t.Fatalf("round after open: %+v", r)
	}
	if r.Band != 5 { // sigma = sd of +-8 zigzag steps ~ 8 -> 8*sqrt(80)*0.42 = 30
		// the wave adds a little; accept the nice value the engine picks but check it is consistent
		if r.Band != engine.BandWidth(r.Sigma) {
			t.Fatalf("band %v does not follow sigma %v", r.Band, r.Sigma)
		}
	}

	// Placement is judged on the server clock: 1 ms before lock is in, at lock is out.
	w.to(r.LockMs - 1)
	if reason := w.set("ana", K0, 6, 100); reason != "" {
		t.Fatalf("at lock-1ms: %s", reason)
	}
	w.to(r.LockMs)
	if reason := w.set("ana", K0, 5, 100); reason != engine.ReasonLocked {
		t.Fatalf("at lock: %q", reason)
	}
	if reason := w.set("late", K0, 5, 100); reason != engine.ReasonLocked {
		t.Fatalf("new player at lock: %q", reason)
	}

	// One round is open and three wait to close.
	for k := K0 + 1; k <= K0+3; k++ {
		w.boundary(k)
	}
	open, locked := 0, 0
	for _, r := range w.hub.game.Rounds() {
		switch r.Status {
		case engine.StatusOpen:
			open++
		case engine.StatusLocked:
			locked++
		}
	}
	if open != 1 || locked != 3 {
		t.Fatalf("open %d locked %d, want 1 and 3", open, locked)
	}

	w.boundary(K0 + 4) // T0+80 s: round K0 closes
	if _, ok := w.hub.game.Get(K0); ok {
		t.Fatal("round K0 still live after its close")
	}
	evs := w.events()
	cl := find(evs, eventlog.EvClose, K0)
	if cl == nil || cl.Void != "" || cl.Price == nil || cl.Landed == nil {
		t.Fatalf("close event: %+v", cl)
	}
	// All four candidates are logged, and the chosen one is the composite.
	for _, rule := range price.Rules {
		if cl.Px.Prices[rule] == nil {
			t.Errorf("candidate %s missing from the close line", rule)
		}
	}
	if *cl.Price != *cl.Px.Prices[price.RuleComposite] || cl.Rule != price.RuleComposite {
		t.Errorf("chosen price %v is not the composite %v", *cl.Price, *cl.Px.Prices[price.RuleComposite])
	}
	if cl.Px.T != T0+80_000 {
		t.Errorf("close priced at %d, want exactly the close time", cl.Px.T)
	}
	sc := find(evs, eventlog.EvScores, K0)
	if sc == nil || len(sc.Scores) != 1 || sc.Scores[0].Player != "ana" || sc.Scores[0].Chips[6] != 100 {
		t.Fatalf("scores: %+v", sc)
	}
	_, lb, n := w.hub.Leaderboard("", 10)
	if n != 1 || lb[0].Player != "ana" || lb[0].Points != sc.Scores[0].Points || lb[0].Rounds != 1 || lb[0].Qualified {
		t.Fatalf("leaderboard %+v", lb)
	}
}

func TestSettlementRuleIsPluggable(t *testing.T) {
	for _, rule := range price.Rules {
		w := newWorld(t, rule, nil)
		for k := K0; k <= K0+4; k++ {
			w.boundary(k)
			if k == K0 {
				w.set("ana", K0, 6, 50)
			}
		}
		cl := find(w.events(), eventlog.EvClose, K0)
		if cl == nil || cl.Void != "" || cl.Rule != rule || *cl.Price != *cl.Px.Prices[rule] {
			t.Errorf("%s: close %+v", rule, cl)
		}
	}
	if _, err := NewHub(Config{Rule: "nope"}, Deps{Book: price.NewBook(price.DefaultConfig())}); err == nil {
		t.Error("unknown rule accepted")
	}
}

func TestVoidAtCloseLockAndOpen(t *testing.T) {
	w := newWorld(t, price.RulePerplLast, nil)
	w.boundary(K0)
	if reason := w.set("ana", K0, 6, 100); reason != "" {
		t.Fatal(reason)
	}
	w.boundary(K0 + 1)
	w.set("beto", K0+1, 6, 100)
	w.boundary(K0 + 2)
	// Perpl stops trading 31 s before round K0's close.
	w.to(T0 + 49_000)
	w.perplTrades = false
	w.boundary(K0 + 3) // T0+60: Perpl 11 s old, still fine
	if _, ok := w.hub.game.Get(K0 + 2); !ok {
		t.Fatal("round K0+2 should have locked normally")
	}
	w.boundary(K0 + 4) // T0+80: Perpl 31 s old
	evs := w.events()
	cl := find(evs, eventlog.EvClose, K0)
	if cl == nil || cl.Void != price.VoidPerplStale || cl.Price != nil || cl.Landed != nil || cl.Phase != "close" {
		t.Fatalf("close of K0: %+v", cl)
	}
	// The four candidates are still logged on a void close.
	if cl.Px == nil || cl.Px.Prices[price.RuleComposite] == nil || cl.Px.TradeAgeMs != 31_000 {
		t.Errorf("void close snapshot: %+v", cl.Px)
	}
	if find(evs, eventlog.EvScores, K0) != nil {
		t.Error("a void round has scores")
	}
	if _, _, n := w.hub.Leaderboard("", 10); n != 0 {
		t.Error("a void round reached the tournament")
	}
	// The same bad instant voids the round that should lock and the one that should open.
	if v := find(evs, eventlog.EvVoid, K0+3); v == nil || v.Phase != "lock" || v.Void != price.VoidPerplStale {
		t.Errorf("round due to lock: %+v", v)
	}
	if v := find(evs, eventlog.EvVoid, K0+4); v == nil || v.Phase != "open" {
		t.Errorf("round due to open: %+v", v)
	}
	if reason := w.set("ana", K0+4, 6, 100); reason != engine.ReasonUnknown {
		t.Errorf("placing on a round that never opened: %q", reason)
	}
	// Rounds already locked are untouched and settle once Perpl trades again.
	w.perplTrades = true
	w.boundary(K0 + 5)
	if cl := find(w.events(), eventlog.EvClose, K0+1); cl == nil || cl.Void != "" {
		t.Errorf("round K0+1 should settle after Perpl came back: %+v", cl)
	}
}

func TestVoidOnTooFewVenuesAndDivergence(t *testing.T) {
	w := newWorld(t, price.RuleComposite, nil)
	w.boundary(K0)
	w.set("ana", K0, 6, 100)
	for k := K0 + 1; k <= K0+3; k++ {
		w.boundary(k)
	}
	w.to(T0 + 70_000)
	w.venues = 1 // three venues go quiet 10 s before the close
	w.boundary(K0 + 4)
	if cl := find(w.events(), eventlog.EvClose, K0); cl == nil || cl.Void != price.VoidVenues || cl.Px.FreshVenues != 1 {
		t.Fatalf("close with one venue: %+v", cl)
	}

	w2 := newWorld(t, price.RulePerplMark, nil)
	w2.boundary(K0)
	w2.set("ana", K0, 6, 100)
	for k := K0 + 1; k <= K0+3; k++ {
		w2.boundary(k)
	}
	w2.to(T0 + 79_900)
	w2.perplMark = false
	w2.book.Add(price.PerplMark, T0+79_950, mid(T0+79_950)*0.9997+150) // a mark 15 bps off the venues
	w2.boundary(K0 + 4)
	if cl := find(w2.events(), eventlog.EvClose, K0); cl == nil || cl.Void != price.VoidDivergence {
		t.Fatalf("close on a diverged mark: %+v", cl)
	}
}

func TestSigmaWarmupKeepsRoundsClosed(t *testing.T) {
	w := &world{t: t, book: price.NewBook(price.DefaultConfig()), dir: t.TempDir(), perplTrades: true, perplMark: true, venues: 4}
	w.fedTo = T0 - 30_000 // only 30 s of history
	w.clock.Store(w.fedTo)
	w.hub = w.newHub(price.RuleComposite, nil)
	w.boundary(K0)
	if v := find(w.events(), eventlog.EvVoid, K0); v == nil || v.Void != VoidSigmaWarmup || v.Phase != "open" {
		t.Fatalf("open with 30 s of samples: %+v", v)
	}
	w.boundary(K0 + 1)
	w.boundary(K0 + 2) // 70 s of history: 60 differences are there
	if r, ok := w.hub.game.Get(K0 + 2); !ok || r.Status != engine.StatusOpen {
		t.Fatal("round did not open once sigma had its samples")
	}
}

func TestStandingsSurviveRestart(t *testing.T) {
	w := newWorld(t, price.RuleComposite, nil)
	for k := K0; k <= K0+5; k++ {
		w.boundary(k)
		if k <= K0+1 {
			w.set("ana", k, 6, 100)
			w.set("beto", k, 3, 40)
		}
	}
	_, before, _ := w.hub.Leaderboard("", 10)
	if len(before) != 2 || before[0].Rounds != 2 {
		t.Fatalf("before restart: %+v", before)
	}
	w.hub.log.Close()
	w.hub = w.newHub(price.RuleComposite, nil)
	if err := w.hub.Boot(w.dir); err != nil {
		t.Fatal(err)
	}
	_, after, _ := w.hub.Leaderboard("", 10)
	if len(after) != 2 || after[0] != before[0] || after[1] != before[1] {
		t.Fatalf("after restart: %+v, want %+v", after, before)
	}
}

/* ---------------- WebSocket protocol ---------------- */

type wsClient struct {
	t  *testing.T
	c  *websocket.Conn
	in chan map[string]any
	// closed gets the close code when the server ends the connection
	closed chan websocket.StatusCode
}

func dial(t *testing.T, srv *httptest.Server, auth map[string]any) *wsClient {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	c.SetReadLimit(1 << 20)
	cl := &wsClient{t: t, c: c, in: make(chan map[string]any, 256), closed: make(chan websocket.StatusCode, 1)}
	if auth != nil {
		cl.send(auth)
	}
	go func() {
		for {
			_, data, err := c.Read(context.Background())
			if err != nil {
				cl.closed <- websocket.CloseStatus(err)
				return
			}
			for _, line := range strings.Split(string(data), "\n") { // a frame holds one message per line
				var m map[string]any
				json.Unmarshal([]byte(line), &m)
				cl.in <- m
			}
		}
	}()
	t.Cleanup(func() { c.CloseNow() })
	return cl
}

func (c *wsClient) send(v any) {
	b, _ := json.Marshal(v)
	if err := c.c.Write(context.Background(), websocket.MessageText, b); err != nil {
		c.t.Logf("write: %v", err)
	}
}

// next returns the next message of the given type, skipping others.
func (c *wsClient) next(typ string) map[string]any {
	c.t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case m := <-c.in:
			if m["t"] == typ {
				return m
			}
		case code := <-c.closed:
			c.t.Fatalf("connection closed (%d) while waiting for %q", code, typ)
		case <-deadline:
			c.t.Fatalf("no %q message", typ)
		}
	}
}

func (c *wsClient) closeCode() websocket.StatusCode {
	c.t.Helper()
	select {
	case code := <-c.closed:
		return code
	case <-time.After(8 * time.Second):
		c.t.Fatal("connection was not closed")
		return 0
	}
}

func token(t *testing.T, player string, exp time.Time) string {
	v, _ := auth.NewHMAC(secret)
	tok, err := v.Mint(player, exp)
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

func TestWebSocketProtocol(t *testing.T) {
	w := newWorld(t, price.RuleComposite, func(c *Config) { c.RatePerSec, c.RateBurst = 1000, 1000 })
	w.boundary(K0)
	srv := httptest.NewServer(w.hub.Handler())
	defer srv.Close()
	now := time.UnixMilli(w.clock.Load())

	// Auth: the first message must prove who you are.
	if code := dial(t, srv, map[string]any{"t": "set", "round": K0}).closeCode(); code != closeAuth {
		t.Errorf("no auth message: close %d", code)
	}
	if code := dial(t, srv, map[string]any{"t": "auth", "token": "ana.9999999999.AAAA"}).closeCode(); code != closeAuth {
		t.Errorf("forged token: close %d", code)
	}
	if code := dial(t, srv, map[string]any{"t": "auth", "token": token(t, "ana", now.Add(-time.Second))}).closeCode(); code != closeAuth {
		t.Errorf("expired token: close %d", code)
	}
	if code := dial(t, srv, map[string]any{"t": "auth", "player": "ana"}).closeCode(); code != closeAuth {
		t.Errorf("anonymous without DEV_ANON: close %d", code)
	}

	ana := dial(t, srv, map[string]any{"t": "auth", "token": token(t, "ana", now.Add(time.Hour))})
	hello := ana.next("hello")
	rounds := hello["rounds"].([]any)
	if hello["player"] != "ana" || hello["rule"] != "composite" || int64(hello["ts"].(float64)) != w.clock.Load() || len(rounds) != 1 {
		t.Fatalf("hello: %v", hello)
	}
	if r := rounds[0].(map[string]any); int64(r["id"].(float64)) != K0 || r["status"] != "open" || len(r["edges"].([]any)) != 11 {
		t.Fatalf("hello round: %v", r)
	}
	// The trail: one [ts, price] per second up to now, oldest first, on whole
	// seconds, each equal to the settlement rule's price at that second.
	trail := hello["trail"].([]any)
	if len(trail) != helloTrailS+1 {
		t.Fatalf("hello trail: %d points, want %d", len(trail), helloTrailS+1)
	}
	for i, pt := range trail {
		pair := pt.([]any)
		ts, p := int64(pair[0].(float64)), pair[1].(float64)
		want, ok := w.hub.settler.CloseAt(ts)
		if ts%1000 != 0 || !ok || p != want || (i > 0 && ts != int64(trail[i-1].([]any)[0].(float64))+1000) {
			t.Fatalf("trail[%d] = %v (rule price %v %v)", i, pair, want, ok)
		}
	}
	if last := int64(trail[len(trail)-1].([]any)[0].(float64)); last > w.clock.Load() || w.clock.Load()-last >= 1000 {
		t.Errorf("trail ends at %d, clock %d", last, w.clock.Load())
	}

	chips := make([]int, 12)
	chips[6] = 60
	ana.send(map[string]any{"t": "set", "id": 1, "round": K0, "chips": chips})
	if a := ana.next("ack"); a["ok"] != true || a["id"].(float64) != 1 || a["chips"].([]any)[6].(float64) != 60 || a["left"].(float64) != 40 {
		t.Fatalf("set ack: %v", a)
	}
	ana.send(map[string]any{"t": "add", "id": 2, "round": K0, "band": 5, "delta": 40})
	if a := ana.next("ack"); a["ok"] != true || a["left"].(float64) != 0 {
		t.Fatalf("add ack: %v", a)
	}
	refusals := []struct {
		msg  map[string]any
		want string
	}{
		{map[string]any{"t": "add", "id": 3, "round": K0, "band": 5, "delta": 1}, engine.ReasonOver100},
		{map[string]any{"t": "add", "id": 4, "round": K0, "band": 12, "delta": -1}, engine.ReasonBadBand},
		{map[string]any{"t": "add", "id": 5, "round": K0, "delta": -1}, engine.ReasonBadBand},
		{map[string]any{"t": "set", "id": 6, "round": K0, "chips": []int{1, 2, 3}}, engine.ReasonBadBand},
		{map[string]any{"t": "set", "id": 7, "round": K0 + 9, "chips": chips}, engine.ReasonUnknown},
		{map[string]any{"t": "dance", "id": 8}, ReasonBadMessage},
	}
	for _, r := range refusals {
		ana.send(r.msg)
		if a := ana.next("ack"); a["ok"] != false || a["reason"] != r.want || int(a["id"].(float64)) != r.msg["id"].(int) {
			t.Errorf("%v: ack %v, want %s", r.msg, a, r.want)
		}
	}
	ana.c.Write(context.Background(), websocket.MessageText, []byte("{not json"))
	if a := ana.next("ack"); a["reason"] != ReasonBadMessage {
		t.Errorf("garbage: %v", a)
	}

	// Lock: the event arrives, and placements are refused from the lock instant.
	w.boundary(K0 + 1)
	if l := ana.next("lock"); int64(l["round"].(float64)) != K0 || len(l["baseline"].([]any)) != 12 {
		t.Fatalf("lock event: %v", l)
	}
	if o := ana.next("open"); int64(o["round"].(map[string]any)["id"].(float64)) != K0+1 {
		t.Fatalf("open event: %v", o)
	}
	ana.send(map[string]any{"t": "set", "id": 9, "round": K0, "chips": chips})
	if a := ana.next("ack"); a["reason"] != engine.ReasonLocked {
		t.Errorf("set after lock: %v", a)
	}

	// One connection per player: the newest wins, and it sees its chips in hello.
	ana2 := dial(t, srv, map[string]any{"t": "auth", "token": token(t, "ana", now.Add(time.Hour))})
	h2 := ana2.next("hello")
	if code := ana.closeCode(); code != closeReplaced {
		t.Errorf("older connection: close %d, want %d", code, closeReplaced)
	}
	var mine []any
	for _, r := range h2["rounds"].([]any) {
		if r := r.(map[string]any); int64(r["id"].(float64)) == K0 {
			mine = r["chips"].([]any)
		}
	}
	if mine == nil || mine[6].(float64) != 60 || mine[5].(float64) != 40 {
		t.Errorf("chips in hello after reconnect: %v", mine)
	}

	// Close: everyone gets the close, the player gets a result and a standing.
	for k := K0 + 2; k <= K0+4; k++ {
		w.boundary(k)
	}
	cl := ana2.next("close")
	if int64(cl["round"].(float64)) != K0 || len(cl["prices"].(map[string]any)) != 4 {
		t.Fatalf("close event: %v", cl)
	}
	res := ana2.next("result")
	st := ana2.next("standing")
	if int64(res["round"].(float64)) != K0 || res["placed"].(float64) != 100 || st["points"] != res["points"] || st["rounds"].(float64) != 1 || st["rank"].(float64) != 1 || st["qualified"] != false {
		t.Fatalf("result %v standing %v", res, st)
	}

	// HTTP side.
	for path, want := range map[string]string{"/healthz": `"currentRound"`, "/metrics": "chipboard_placements_accepted 2", "/leaderboard": `"player":"ana"`} {
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 || !strings.Contains(string(body), want) {
			t.Errorf("%s: %d, missing %s in %.300s", path, resp.StatusCode, want, body)
		}
	}
	// Neither the secret nor any token reaches the event log.
	w.hub.log.Flush()
	raw, _ := os.ReadFile(eventlog.FileFor(w.dir, T0))
	if strings.Contains(string(raw), secret) || strings.Contains(string(raw), token(t, "ana", now.Add(time.Hour))) {
		t.Error("secret or token found in the event log")
	}
}

func TestAnonymousAndRateLimit(t *testing.T) {
	w := newWorld(t, price.RuleComposite, func(c *Config) { c.DevAnon, c.RatePerSec, c.RateBurst = true, 0.001, 3 })
	w.boundary(K0)
	srv := httptest.NewServer(w.hub.Handler())
	defer srv.Close()
	c := dial(t, srv, map[string]any{"t": "auth", "player": "lupita"})
	if h := c.next("hello"); h["player"] != "anon-lupita" {
		t.Fatalf("anonymous id: %v", h["player"])
	}
	ok, limited := 0, 0
	for i := 1; i <= 8; i++ {
		c.send(map[string]any{"t": "add", "id": i, "round": K0, "band": 4, "delta": 1})
	}
	for i := 0; i < 8; i++ {
		a := c.next("ack")
		switch {
		case a["ok"] == true:
			ok++
		case a["reason"] == ReasonRateLimited:
			limited++
		}
	}
	if ok != 3 || limited != 5 {
		t.Errorf("burst of 3: %d accepted, %d rate limited", ok, limited)
	}
	if got := w.hub.game.Chips(K0, "anon-lupita"); got[4] != 3 {
		t.Errorf("a rate-limited message still placed chips: %v", got)
	}
}
