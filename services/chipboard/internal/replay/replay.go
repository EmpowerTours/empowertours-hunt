// Package replay rebuilds every round from an event log with the same engine
// the server runs, and checks the rebuilt bands, baselines, landed bands and
// scores against the logged ones.
package replay

import (
	"fmt"
	"sort"

	"github.com/EmpowerTours/empowertours-hunt/services/chipboard/internal/engine"
	"github.com/EmpowerTours/empowertours-hunt/services/chipboard/internal/eventlog"
)

type Total struct{ Points, Rounds int }

type Report struct {
	Files      int
	Events     int
	Boots      int
	Opened     int
	Settled    int
	Voided     int
	Incomplete int // opened in the log but never closed (in flight at a restart or at the end of the log)
	Unseen     int // closed or locked in the log but opened before it starts
	Placements int
	Scores     int
	TornLines  int
	// QualifyRounds is read from the last boot line (20 if the log has none).
	QualifyRounds int
	Mismatches    []string
	Totals        map[string]map[string]Total // day -> player -> totals rebuilt from recomputed scores
	maxErrs       int
}

func (r *Report) OK() bool { return len(r.Mismatches) == 0 }

func (r *Report) bad(format string, a ...any) {
	if len(r.Mismatches) < r.maxErrs {
		r.Mismatches = append(r.Mismatches, fmt.Sprintf(format, a...))
	} else if len(r.Mismatches) == r.maxErrs {
		r.Mismatches = append(r.Mismatches, "... more mismatches not listed")
	}
}

// Run replays the given log files in order (pass them oldest first).
func Run(paths ...string) (*Report, error) {
	rep := &Report{Totals: map[string]map[string]Total{}, maxErrs: 50, QualifyRounds: 20}
	g := engine.NewGame()
	// scores recomputed at a close, waiting for the logged scores line
	pending := map[int64][]engine.Score{}
	pendingClose := map[int64]int64{}

	handle := func(ev eventlog.Event) error {
		rep.Events++
		switch ev.Ev {
		case eventlog.EvBoot:
			rep.Boots++
			if q, ok := ev.Config["qualifyRounds"].(float64); ok {
				rep.QualifyRounds = int(q)
			}
			// Rounds in flight when the server stopped were never closed.
			rep.Incomplete += len(g.Rounds())
			g = engine.NewGame()

		case eventlog.EvOpen:
			if ev.OpenPrice == nil || ev.Sigma == nil || ev.Band == nil || ev.Centre == nil {
				rep.bad("round %d: open line is missing fields", ev.Round)
				return nil
			}
			r := g.Open(ev.Round, *ev.OpenPrice, *ev.Sigma)
			rep.Opened++
			if r.Band != *ev.Band || r.Centre != *ev.Centre {
				rep.bad("round %d: rebuilt band %v centre %v, logged band %v centre %v", ev.Round, r.Band, r.Centre, *ev.Band, *ev.Centre)
			}
			if ev.Px != nil && ev.Px.Prices[ev.Rule] != nil && *ev.Px.Prices[ev.Rule] != *ev.OpenPrice {
				rep.bad("round %d: open price %v is not the logged %s candidate %v", ev.Round, *ev.OpenPrice, ev.Rule, *ev.Px.Prices[ev.Rule])
			}

		case eventlog.EvPlace:
			if _, ok := g.Get(ev.Round); !ok {
				rep.Unseen++
				return nil
			}
			if ev.Chips == nil {
				rep.bad("round %d: placement by %s has no chips", ev.Round, ev.Player)
				return nil
			}
			rep.Placements++
			// The engine re-applies its own rules: a logged placement at or
			// after the lock, or over 100 chips, is refused here.
			if _, reason := g.Set(ev.T, ev.Player, ev.Round, ev.Chips[:]); reason != "" {
				rep.bad("round %d: logged placement by %s at %d is refused on replay: %s", ev.Round, ev.Player, ev.T, reason)
			}

		case eventlog.EvLock:
			if _, ok := g.Get(ev.Round); !ok {
				rep.Unseen++
				return nil
			}
			if ev.LockPrice == nil || ev.Baseline == nil {
				rep.bad("round %d: lock line is missing fields", ev.Round)
				return nil
			}
			r, ok := g.Lock(ev.Round, *ev.LockPrice)
			if !ok {
				rep.bad("round %d: locked twice", ev.Round)
				return nil
			}
			if *r.Baseline != *ev.Baseline {
				rep.bad("round %d: rebuilt baseline differs from the logged one", ev.Round)
			}

		case eventlog.EvVoid, eventlog.EvClose:
			if ev.Void != "" {
				rep.Voided++
				if ev.Price != nil || ev.Landed != nil {
					rep.bad("round %d: void round carries a price or a band", ev.Round)
				}
				g.Void(ev.Round, ev.Void)
				return nil
			}
			if _, ok := g.Get(ev.Round); !ok {
				rep.Unseen++
				return nil
			}
			if ev.Price == nil || ev.Landed == nil {
				rep.bad("round %d: close line has neither a void reason nor a price", ev.Round)
				return nil
			}
			if ev.Px == nil || ev.Px.Prices[ev.Rule] == nil || *ev.Px.Prices[ev.Rule] != *ev.Price {
				rep.bad("round %d: closing price %v is not the logged %s candidate", ev.Round, *ev.Price, ev.Rule)
			}
			r, scores, ok := g.Close(ev.Round, *ev.Price)
			if !ok {
				rep.bad("round %d: closed without being locked", ev.Round)
				return nil
			}
			rep.Settled++
			if r.Landed != *ev.Landed {
				rep.bad("round %d: price %v lands in band %d on replay, logged band %d", ev.Round, *ev.Price, r.Landed, *ev.Landed)
			}
			pending[ev.Round], pendingClose[ev.Round] = scores, r.CloseMs

		case eventlog.EvScores:
			want, ok := pending[ev.Round]
			if !ok {
				rep.Unseen++
				return nil
			}
			delete(pending, ev.Round)
			if day := engine.DayOf(pendingClose[ev.Round]); day != ev.Day {
				rep.bad("round %d: scores logged for day %s, round closed on %s", ev.Round, ev.Day, day)
			}
			delete(pendingClose, ev.Round)
			if len(want) != len(ev.Scores) {
				rep.bad("round %d: %d scores on replay, %d logged", ev.Round, len(want), len(ev.Scores))
			}
			logged := map[string]engine.Score{}
			for _, s := range ev.Scores {
				logged[s.Player] = s
			}
			for _, s := range want {
				rep.Scores++
				l, ok := logged[s.Player]
				switch {
				case !ok:
					rep.bad("round %d: %s scored %d on replay but has no logged score", ev.Round, s.Player, s.Points)
				case l != s:
					rep.bad("round %d: %s replay %+v, logged %+v", ev.Round, s.Player, s, l)
				}
				d := rep.Totals[ev.Day]
				if d == nil {
					d = map[string]Total{}
					rep.Totals[ev.Day] = d
				}
				t := d[s.Player]
				d[s.Player] = Total{t.Points + s.Points, t.Rounds + 1}
			}

		default:
			rep.bad("unknown event kind %q", ev.Ev)
		}
		return nil
	}

	for _, p := range paths {
		torn, err := eventlog.Read(p, handle)
		if err != nil {
			return rep, err
		}
		rep.Files++
		if torn {
			rep.TornLines++
		}
	}
	rep.Incomplete += len(g.Rounds())
	for id := range pending {
		rep.bad("round %d: closed in the log but its scores line is missing", id)
	}
	return rep, nil
}

// Top returns a day's rebuilt standings, best first.
func (r *Report) Top(day string, n int) []engine.Standing {
	t := engine.NewTournament(r.QualifyRounds)
	for p, tot := range r.Totals[day] {
		t.Restore(day, p, tot.Points, tot.Rounds)
	}
	lb := t.Leaderboard(day)
	if n > 0 && len(lb) > n {
		lb = lb[:n]
	}
	return lb
}

// Days lists the tournament days seen, oldest first.
func (r *Report) Days() []string {
	out := make([]string, 0, len(r.Totals))
	for d := range r.Totals {
		out = append(out, d)
	}
	sort.Strings(out)
	return out
}
