package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/pprof"
	"sort"
	"strconv"

	"github.com/EmpowerTours/empowertours-hunt/services/chipboard/internal/engine"
	"github.com/EmpowerTours/empowertours-hunt/services/chipboard/internal/price"
)

// Handler serves /ws, /healthz, /metrics and /leaderboard.
func (h *Hub) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", h.ServeWS)
	mux.HandleFunc("/healthz", h.serveHealth)
	mux.HandleFunc("/metrics", h.serveMetrics)
	mux.HandleFunc("/leaderboard", h.serveLeaderboard)
	if h.cfg.Pprof {
		mux.HandleFunc("/debug/pprof/", pprof.Index)
		mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	}
	return mux
}

// /healthz: feed freshness per source, current round, connections. "ok" is
// whether a round closing right now would be paid (no void rule tripped).
func (h *Hub) serveHealth(w http.ResponseWriter, r *http.Request) {
	now := h.nowMs()
	snap := h.book.Snapshot(now)
	_, void := h.book.Judge(h.cfg.Rule, snap)
	sources := map[string]any{}
	for _, s := range price.Sources {
		sources[string(s)] = map[string]any{"lastTickAgeMs": h.book.AgeMs(s, now)}
	}
	h.mu.Lock()
	rounds := h.game.Rounds()
	h.mu.Unlock()
	live := []map[string]any{}
	for _, rd := range rounds {
		live = append(live, map[string]any{"id": rd.ID, "status": rd.Status, "lock": rd.LockMs, "close": rd.CloseMs})
	}
	out := map[string]any{
		"ok": void == "", "void": void, "now": now, "rule": h.cfg.Rule, "feed": h.cfg.FeedMode,
		"currentRound": engine.RoundIDAt(now), "rounds": live, "connections": h.nConns.Load(),
		"sources": sources, "sockets": h.feed.Status(now), "prices": snap.Prices, "freshVenues": snap.FreshVenues,
		"basisBps": snap.BasisBps, "offsets": h.book.Offsets(),
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

// /metrics: plain-text counters, one "name value" per line.
func (h *Hub) serveMetrics(w http.ResponseWriter, r *http.Request) {
	m := map[string]int64{
		"connections":      h.nConns.Load(),
		"messages_in":      h.msgsIn.Load(),
		"messages_out":     h.msgsOut.Load(),
		"frames_out":       h.framesOut.Load(),
		"last_boundary_id": h.lastRound.Load(),
		"boundary_ms_last": h.boundaryLast.Load(),
		"boundary_ms_max":  h.boundaryMax.Load(),
		// includes the configured settle delay (50 ms by default)
		"boundary_late_ms_max": h.boundaryLateMax.Load(),
	}
	h.metricsMu.Lock()
	for k, v := range h.metrics {
		m[k] = v
	}
	h.metricsMu.Unlock()
	now := h.nowMs()
	for _, s := range price.Sources {
		m["feed_age_ms_"+string(s)] = h.book.AgeMs(s, now)
	}
	for name, st := range h.feed.Status(now) {
		m["feed_reconnects_"+name] = st.Reconnects
		m["feed_messages_"+name] = st.Messages
	}
	// Replies to placements, by time from reading the message to writing the
	// reply (cumulative, like a Prometheus histogram).
	var cum int64
	for i, le := range ackBucketsMs {
		cum += h.ackHist[i].Load()
		m[fmt.Sprintf("ack_ms_le_%04d", le)] = cum
	}
	m["ack_ms_count"] = cum + h.ackHist[len(ackBucketsMs)].Load()
	names := make([]string, 0, len(m))
	for k := range m {
		names = append(names, k)
	}
	sort.Strings(names)
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	for _, k := range names {
		fmt.Fprintf(w, "chipboard_%s %d\n", k, m[k])
	}
}

// /leaderboard?day=YYYY-MM-DD&limit=50 (day defaults to today in Mexico City).
func (h *Hub) serveLeaderboard(w http.ResponseWriter, r *http.Request) {
	limit := 50
	if v, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && v > 0 && v <= 1000 {
		limit = v
	}
	day, lb, n := h.Leaderboard(r.URL.Query().Get("day"), limit)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"day": day, "zone": engine.TournamentZone, "players": n, "qualifyRounds": h.cfg.QualifyRounds, "standings": lb})
}
