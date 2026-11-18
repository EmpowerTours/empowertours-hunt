// Package server is the judge in motion: it opens, locks and closes rounds on
// the wall clock, takes placements over WebSocket, and writes every decision
// to the event log.
package server

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"sync"
	"sync/atomic"
	"time"

	"github.com/EmpowerTours/empowertours-hunt/services/chipboard/internal/auth"
	"github.com/EmpowerTours/empowertours-hunt/services/chipboard/internal/engine"
	"github.com/EmpowerTours/empowertours-hunt/services/chipboard/internal/eventlog"
	"github.com/EmpowerTours/empowertours-hunt/services/chipboard/internal/feed"
	"github.com/EmpowerTours/empowertours-hunt/services/chipboard/internal/price"
)

// Reasons the server itself adds to the engine's refusal codes.
const (
	ReasonRateLimited = "rate_limited"
	ReasonBadMessage  = "bad_message"
)

// Void reasons the scheduler adds to the price package's.
const (
	VoidSigmaWarmup = "sigma_warmup" // not enough 1-second samples to size the bands
	VoidMissed      = "missed_close" // the round's close time passed without a close (should not happen)
)

type Config struct {
	Rule            string  // SETTLE_PRICE
	SigmaMinSamples int     // 1-second differences needed before a round may open
	SettleDelayMs   int64   // wait after a boundary before reading prices, so ticks received just before it are in
	QualifyRounds   int     // rounds in a day to qualify for prizes
	RatePerSec      float64 // client messages per second, per connection
	RateBurst       int
	MaxConns        int
	AllowedOrigins  []string // extra browser origins allowed on /ws (the request host always is)
	DevAnon         bool     // DEV_ANON=1: accept {"t":"auth","player":"..."} without a token
	FeedMode        string
	PxPerSec        int  // price ticks per second to each client, 1-4
	Pprof           bool // PPROF=1: serve /debug/pprof (profiling; off by default)
}

func DefaultConfig() Config {
	return Config{Rule: price.RuleComposite, SigmaMinSamples: 60, SettleDelayMs: 50, QualifyRounds: 20, RatePerSec: 20, RateBurst: 40, MaxConns: 20000, PxPerSec: 4}
}

type Hub struct {
	cfg      Config
	book     *price.Book
	settler  price.Settler
	feed     feed.Feed
	log      *eventlog.Writer
	verifier auth.Verifier // nil: tokens are not accepted
	now      func() time.Time
	logf     func(string, ...any)
	fatalf   func(string, ...any)

	// mu guards the game, the tournament, the connection table, and the
	// order of lines in the event log.
	mu    sync.Mutex
	game  *engine.Game
	tour  *engine.Tournament
	conns map[string]*client

	nConns    atomic.Int64
	msgsIn    atomic.Int64
	msgsOut   atomic.Int64
	lastRound atomic.Int64
	// ackHist counts replies to placements by how long they took from the
	// message being read to the reply being written to the socket.
	ackHist   [len(ackBucketsMs) + 1]atomic.Int64
	metricsMu sync.Mutex
	metrics   map[string]int64
	framesOut atomic.Int64
	shardSeq  int
	// work queued by a boundary to run once the lock is released
	afterUnlock []func()
	stopped     bool // set by Shutdown, under mu: nothing is recorded after it
	// how long the last boundary took under the lock, the longest so far, and
	// the latest any boundary started after its instant (ms)
	boundaryLast, boundaryMax, boundaryLateMax atomic.Int64
}

type Deps struct {
	Book     *price.Book
	Feed     feed.Feed
	Log      *eventlog.Writer
	Verifier auth.Verifier
	Now      func() time.Time
	Logf     func(string, ...any)
	Fatalf   func(string, ...any)
}

func NewHub(cfg Config, d Deps) (*Hub, error) {
	st, err := d.Book.Settler(cfg.Rule)
	if err != nil {
		return nil, err
	}
	h := &Hub{
		cfg: cfg, book: d.Book, settler: st, feed: d.Feed, log: d.Log, verifier: d.Verifier,
		now: d.Now, logf: d.Logf, fatalf: d.Fatalf,
		game: engine.NewGame(), tour: engine.NewTournament(cfg.QualifyRounds),
		conns: map[string]*client{}, metrics: map[string]int64{},
	}
	if h.now == nil {
		h.now = time.Now
	}
	if h.logf == nil {
		h.logf = func(string, ...any) {}
	}
	if h.fatalf == nil {
		h.fatalf = func(f string, a ...any) { panic("chipboard: " + f) }
	}
	return h, nil
}

func (h *Hub) observeAck(d time.Duration) {
	ms := d.Milliseconds()
	for i, le := range ackBucketsMs {
		if ms < le {
			h.ackHist[i].Add(1)
			return
		}
	}
	h.ackHist[len(ackBucketsMs)].Add(1)
}

func (h *Hub) nowMs() int64 { return h.now().UnixMilli() }

func (h *Hub) inc(name string, n int64) {
	h.metricsMu.Lock()
	h.metrics[name] += n
	h.metricsMu.Unlock()
}

// record appends to the event log. A judge that cannot write down its
// decisions must not keep judging: a write error stops the server.
func (h *Hub) record(ev eventlog.Event) {
	if h.stopped {
		return
	}
	if err := h.log.Append(ev); err != nil {
		h.fatalf("event log write failed: %v", err)
	}
}

// Boot writes the boot line and restores today's standings from the log.
func (h *Hub) Boot(logDir string) error {
	now := h.nowMs()
	day := engine.DayOf(now)
	pts, rounds, err := eventlog.DayTotals(day, eventlog.FileFor(logDir, now-86_400_000), eventlog.FileFor(logDir, now))
	if err != nil {
		return err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for p, n := range rounds {
		h.tour.Restore(day, p, pts[p], n)
	}
	h.record(eventlog.Event{Ev: eventlog.EvBoot, T: now, Rule: h.cfg.Rule, Config: map[string]any{
		"feed": h.cfg.FeedMode, "sigmaMinSamples": h.cfg.SigmaMinSamples, "settleDelayMs": h.cfg.SettleDelayMs,
		"qualifyRounds": h.cfg.QualifyRounds, "voidPerplStaleMs": h.book.Cfg.PerplStaleMs,
		"voidDivergenceBps": h.book.Cfg.DivergenceBps, "freshMs": h.book.Cfg.FreshMs, "minVenues": h.book.Cfg.MinVenues,
		"restoredPlayers": len(rounds), "day": day,
	}})
	return h.log.Flush()
}

// Run drives the round clock and the price ticks until ctx is done.
func (h *Hub) Run(ctx context.Context) {
	go h.priceLoop(ctx)
	next := engine.RoundIDAt(h.nowMs()) + 1
	for {
		due := next*engine.PeriodMs + h.cfg.SettleDelayMs
		if wait := due - h.nowMs(); wait > 0 {
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Duration(wait) * time.Millisecond):
			}
			continue // re-check the wall clock: a timer is not the judge
		}
		h.Boundary(next)
		next++
		if ctx.Err() != nil {
			return
		}
	}
}

// sigmaAt measures sigma from 1-second samples of the reference price over
// the two minutes before t.
func (h *Hub) sigmaAt(t int64) (float64, int) {
	samples := make([]float64, 0, engine.SigmaWindowS+1)
	for s := int64(engine.SigmaWindowS); s >= 0; s-- {
		if p, ok := h.settler.CloseAt(t - s*1000); ok {
			samples = append(samples, p)
		} else {
			samples = append(samples, math.NaN())
		}
	}
	return engine.Sigma(samples)
}

// Boundary handles the instant T = k*20 s: round k-4 closes, round k-1 locks
// and round k opens, all on the same reading of the reference price at T.
func (h *Hub) Boundary(k int64) {
	T := k * engine.PeriodMs
	snap := h.book.Snapshot(T)
	px, void := h.book.Judge(h.cfg.Rule, snap)
	sigma, sigmaN := 0.0, 0
	if void == "" {
		sigma, sigmaN = h.sigmaAt(T)
	}

	h.mu.Lock()
	began := time.Now()
	now := h.nowMs()
	if late := now - T; late > h.boundaryLateMax.Load() {
		h.boundaryLateMax.Store(late)
	}
	// Anything whose close time has already passed without a close is void.
	for _, r := range h.game.Rounds() {
		if r.CloseMs < T {
			h.voidRound(now, r.ID, "close", VoidMissed, &snap)
		}
	}
	h.closeRound(now, k-4, px, void, &snap)
	h.lockRound(now, k-1, px, void, &snap)
	h.openRound(now, k, px, void, sigma, sigmaN, &snap)
	h.tour.Prune(engine.DayOf(now - 2*86_400_000))
	took := time.Since(began).Milliseconds()
	after := h.afterUnlock
	h.afterUnlock = nil
	h.mu.Unlock()
	for _, f := range after {
		f()
	}
	h.lastRound.Store(k)
	h.boundaryLast.Store(took)
	if took > h.boundaryMax.Load() {
		h.boundaryMax.Store(took)
	}
}

func (h *Hub) voidRound(now, id int64, phase, reason string, snap *price.Snapshot) {
	h.game.Void(id, reason)
	kind := eventlog.EvVoid
	if phase == "close" {
		kind = eventlog.EvClose
	}
	h.record(eventlog.Event{Ev: kind, T: now, Round: id, Rule: h.cfg.Rule, Px: snap, Void: reason, Phase: phase})
	h.inc("rounds_void_total", 1)
	h.inc("rounds_void_"+reason, 1)
	h.logf("round %d VOID at %s: %s | candidates %s", id, phase, reason, fmtPrices(snap))
	h.broadcast(mustJSON(map[string]any{"t": "void", "round": id, "phase": phase, "reason": reason}))
}

func (h *Hub) closeRound(now, id int64, px float64, void string, snap *price.Snapshot) {
	r, ok := h.game.Get(id)
	if !ok || r.Status != engine.StatusLocked {
		return
	}
	if void != "" {
		h.voidRound(now, id, "close", void, snap)
		return
	}
	round, scores, _ := h.game.Close(id, px)
	day := engine.DayOf(round.CloseMs)
	h.record(eventlog.Event{Ev: eventlog.EvClose, T: now, Round: id, Rule: h.cfg.Rule, Px: snap, Price: &px, Landed: &round.Landed})
	h.record(eventlog.Event{Ev: eventlog.EvScores, T: now, Round: id, Day: day, Scores: scores})
	h.inc("rounds_settled_total", 1)
	h.inc("scores_total", int64(len(scores)))
	h.logf("round %d CLOSED: rule %s price %.2f band %d (%d players) | candidates %s", id, h.cfg.Rule, px, round.Landed, len(scores), fmtPrices(snap))
	h.broadcast(mustJSON(map[string]any{"t": "close", "round": id, "rule": h.cfg.Rule, "price": px, "band": round.Landed, "prices": snap.Prices}))
	// Per-player results and standings are built and sent after the game lock
	// is released (see Boundary): with thousands of players that is most of a
	// boundary's work, and placements must not wait behind it.
	landed := round.Landed
	for _, s := range scores {
		h.tour.Record(day, s.Player, s.Points)
	}
	lb := h.tour.Leaderboard(day)
	byPlayer := make(map[string]engine.Standing, len(lb))
	for _, st := range lb {
		byPlayer[st.Player] = st
	}
	type target struct {
		c  *client
		s  engine.Score
		st engine.Standing
	}
	targets := make([]target, 0, len(scores))
	for _, s := range scores {
		if c := h.conns[s.Player]; c != nil {
			targets = append(targets, target{c, s, byPlayer[s.Player]})
		}
	}
	players := len(lb)
	h.afterUnlock = append(h.afterUnlock, func() {
		for _, t := range targets {
			t.c.enqueue(mustJSON(map[string]any{"t": "result", "round": id, "price": px, "band": landed, "chips": t.s.Chips, "placed": t.s.Placed, "points": t.s.Points}))
			t.c.enqueue(h.standingMsg(day, t.st, players))
		}
	})
}

func (h *Hub) lockRound(now, id int64, px float64, void string, snap *price.Snapshot) {
	r, ok := h.game.Get(id)
	if !ok || r.Status != engine.StatusOpen {
		return
	}
	if void != "" {
		h.voidRound(now, id, "lock", void, snap)
		return
	}
	round, _ := h.game.Lock(id, px)
	h.record(eventlog.Event{Ev: eventlog.EvLock, T: now, Round: id, Rule: h.cfg.Rule, Px: snap, LockPrice: &px, Baseline: round.Baseline})
	h.inc("rounds_locked_total", 1)
	h.broadcast(mustJSON(map[string]any{"t": "lock", "round": id, "lockPrice": px, "baseline": round.Baseline}))
}

func (h *Hub) openRound(now, id int64, px float64, void string, sigma float64, sigmaN int, snap *price.Snapshot) {
	if void == "" && sigmaN < h.cfg.SigmaMinSamples {
		void = VoidSigmaWarmup
	}
	if void != "" {
		h.voidRound(now, id, "open", void, snap)
		return
	}
	r := h.game.Open(id, px, sigma)
	h.record(eventlog.Event{Ev: eventlog.EvOpen, T: now, Round: id, Rule: h.cfg.Rule, Px: snap, OpenPrice: &px, Sigma: &sigma, SigmaN: sigmaN, Band: &r.Band, Centre: &r.Centre})
	h.inc("rounds_opened_total", 1)
	h.logf("round %d OPEN: price %.2f sigma %.3f (n=%d) band %g centre %g", id, px, sigma, sigmaN, r.Band, r.Centre)
	h.broadcast(mustJSON(map[string]any{"t": "open", "round": r}))
}

func (h *Hub) standingMsg(day string, st engine.Standing, players int) []byte {
	return mustJSON(map[string]any{"t": "standing", "day": day, "points": st.Points, "rounds": st.Rounds, "rank": st.Rank, "players": players, "qualified": st.Qualified, "qualifyRounds": h.cfg.QualifyRounds})
}

// place applies a set or an add for a player. The server clock is read under
// the lock, so log order and time order agree.
func (h *Hub) place(player string, m *inMsg) (chips [engine.NB]int, now int64, reason string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	now = h.nowMs()
	switch m.T {
	case "set":
		chips, reason = h.game.Set(now, player, m.Round, m.Chips)
	case "add":
		if m.Band == nil {
			return chips, now, engine.ReasonBadBand
		}
		chips, reason = h.game.Add(now, player, m.Round, *m.Band, m.Delta)
	default:
		return chips, now, ReasonBadMessage
	}
	if reason == "" {
		h.record(eventlog.Event{Ev: eventlog.EvPlace, T: now, Round: m.Round, Player: player, Chips: &chips})
	}
	return chips, now, reason
}

// pxShards spreads the price ticks over the tick period: instead of writing
// to every client in one burst 4 times a second, the clients are cut into
// slices and one slice is written every few milliseconds. Each client still
// gets at most PX_HZ ticks a second, and the server's load stays flat, so a
// placement never waits behind a burst of ticks.
const pxShards = 25

// priceLoop sends the reference price to each client at most 4 times a second
// (PX_HZ): when it changed, or once a second as a heartbeat.
func (h *Hub) priceLoop(ctx context.Context) {
	hz := h.cfg.PxPerSec
	if hz < 1 || hz > 4 {
		hz = 4
	}
	t := time.NewTicker(time.Second / time.Duration(hz*pxShards))
	defer t.Stop()
	var lastPx [pxShards]float64
	var lastSent [pxShards]int64
	for shard := 0; ; shard = (shard + 1) % pxShards {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		now := h.nowMs()
		p, ok := h.settler.CloseAt(now)
		if (ok && p != lastPx[shard]) || now-lastSent[shard] >= 1000 {
			msg := map[string]any{"t": "px", "ts": now}
			if ok {
				msg["p"] = p
				lastPx[shard] = p
			}
			lastSent[shard] = now
			b := mustJSON(msg)
			h.mu.Lock()
			for _, c := range h.conns {
				if c.shard == shard {
					c.enqueueDroppable(b)
				}
			}
			h.mu.Unlock()
		}
	}
}

func (h *Hub) broadcast(b []byte) {
	for _, c := range h.conns {
		c.enqueue(b)
	}
}

// hello is the first message after auth: server time, the live rounds with
// this player's chips on them, and today's standing.
func (h *Hub) helloLocked(player string) []byte {
	now := h.nowMs()
	type roundView struct {
		engine.Round
		Chips [engine.NB]int `json:"chips"`
	}
	rounds := []roundView{}
	for _, r := range h.game.Rounds() {
		rounds = append(rounds, roundView{r, h.game.Chips(r.ID, player)})
	}
	msg := map[string]any{
		"t": "hello", "ts": now, "player": player, "rule": h.cfg.Rule, "rounds": rounds,
		"chipsPerRound": engine.ChipsPerRound, "bands": engine.NB, "qualifyRounds": h.cfg.QualifyRounds,
		"periodMs": engine.PeriodMs, "openMs": engine.OpenMs, "holdMs": engine.HoldMs, "day": engine.DayOf(now),
	}
	lb := h.tour.Leaderboard(engine.DayOf(now))
	for _, st := range lb {
		if st.Player == player {
			msg["standing"] = json.RawMessage(h.standingMsg(engine.DayOf(now), st, len(lb)))
		}
	}
	return mustJSON(msg)
}

// Leaderboard returns the top of a day's standings.
func (h *Hub) Leaderboard(day string, limit int) (string, []engine.Standing, int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if day == "" {
		day = engine.DayOf(h.nowMs())
	}
	lb := h.tour.Leaderboard(day)
	n := len(lb)
	if limit > 0 && len(lb) > limit {
		lb = lb[:limit]
	}
	return day, lb, n
}

// Shutdown closes every connection and the event log.
func (h *Hub) Shutdown() {
	h.mu.Lock()
	for _, c := range h.conns {
		c.drop(closeShutdown, "server shutting down")
	}
	h.stopped = true
	h.mu.Unlock()
	h.log.Close()
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

func fmtPrices(s *price.Snapshot) string {
	out := ""
	for _, r := range price.Rules {
		if p := s.Prices[r]; p != nil {
			out += fmt.Sprintf("%s=%.2f ", r, *p)
		} else {
			out += r + "=n/a "
		}
	}
	return out + fmt.Sprintf("venues=%d perplTradeAgeMs=%d perplMarkAgeMs=%d", s.FreshVenues, s.TradeAgeMs, s.MarkAgeMs)
}

// PlaceForTest applies a placement exactly as the socket handler does. It
// exists so other packages' tests can drive a hub without a network.
func (h *Hub) PlaceForTest(player, kind string, round int64, chips []int, band, delta int) string {
	_, _, reason := h.place(player, &inMsg{T: kind, Round: round, Chips: chips, Band: &band, Delta: delta})
	return reason
}
