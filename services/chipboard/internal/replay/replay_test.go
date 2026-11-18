package replay_test

import (
	"bytes"
	"context"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/EmpowerTours/empowertours-hunt/services/chipboard/internal/engine"
	"github.com/EmpowerTours/empowertours-hunt/services/chipboard/internal/eventlog"
	"github.com/EmpowerTours/empowertours-hunt/services/chipboard/internal/feed"
	"github.com/EmpowerTours/empowertours-hunt/services/chipboard/internal/price"
	"github.com/EmpowerTours/empowertours-hunt/services/chipboard/internal/replay"
	"github.com/EmpowerTours/empowertours-hunt/services/chipboard/internal/server"
)

type nullFeed struct{}

func (nullFeed) Run(context.Context)                 {}
func (nullFeed) Status(int64) map[string]feed.Status { return nil }

// playSession runs a real hub on the synthetic feed with a hand-driven clock:
// `rounds` rounds, 40 players placing through the same code path the socket
// uses. It starts 6 minutes before Mexico City midnight, so the session
// crosses the tournament day, and returns the hub and its log file.
func playSession(t *testing.T, dir string, rounds int) (*server.Hub, string, int64) {
	t.Helper()
	// 2027-01-15 05:54:00 UTC = 23:54 in Mexico City on the 14th.
	t0 := time.Date(2027, 1, 15, 5, 54, 0, 0, time.UTC).UnixMilli()
	k0 := t0 / engine.PeriodMs
	var clock atomic.Int64
	book := price.NewBook(price.DefaultConfig())
	synth := feed.NewSynth(42, t0-feed.SyntheticBackfillMs)
	elog, err := eventlog.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	hub, err := server.NewHub(server.DefaultConfig(), server.Deps{Book: book, Feed: nullFeed{}, Log: elog,
		Now: func() time.Time { return time.UnixMilli(clock.Load()) }, Fatalf: t.Fatalf})
	if err != nil {
		t.Fatal(err)
	}
	advance := func(ms int64) { synth.FillBook(book, ms); clock.Store(ms) }
	advance(t0 - 1000)
	if err := hub.Boot(dir); err != nil {
		t.Fatal(err)
	}
	rng := rand.New(rand.NewSource(9))
	for k := k0; k < k0+int64(rounds)+4; k++ {
		T := k * engine.PeriodMs
		advance(T + 50)
		hub.Boundary(k)
		if k >= k0+int64(rounds) {
			continue // let the last rounds close without new chips
		}
		for p := 0; p < 40; p++ {
			advance(T + 100 + int64(p)*400)
			player := "p" + string(rune('A'+p%26)) + string(rune('a'+p/26))
			chips := make([]int, engine.NB)
			left := 100
			for left > 0 && rng.Intn(6) > 0 {
				n := 5 * (1 + rng.Intn(8))
				if n > left {
					n = left
				}
				chips[rng.Intn(engine.NB)] += n
				left -= n
			}
			hub.PlaceForTest(player, "set", k, chips, 0, 0)
			if p%3 == 0 {
				hub.PlaceForTest(player, "add", k, nil, rng.Intn(engine.NB), -10)
			}
		}
		// right at the lock instant: must be refused and must not reach the log
		advance(T + engine.OpenMs)
		if reason := hub.PlaceForTest("late", "set", k, make([]int, engine.NB), 0, 0); reason != engine.ReasonLocked {
			t.Fatalf("placement at lock: %q", reason)
		}
	}
	hub.Shutdown()
	return hub, eventlog.FileFor(dir, t0), t0
}

func TestReplayRoundTrip(t *testing.T) {
	dir := t.TempDir()
	hub, file, t0 := playSession(t, dir, 24)

	rep, err := replay.Run(file)
	if err != nil {
		t.Fatal(err)
	}
	if !rep.OK() {
		t.Fatalf("replay of an honest log found mismatches: %v", rep.Mismatches)
	}
	// 24 rounds were played and closed; the session stops with the next 4
	// (opened so the earlier ones could close) still in flight.
	if rep.Opened != 28 || rep.Settled != 24 || rep.Voided != 0 || rep.Incomplete != 4 {
		t.Fatalf("rounds: %+v", rep)
	}
	if rep.Placements < 24*40 || rep.Scores < 24*30 {
		t.Fatalf("placements %d scores %d", rep.Placements, rep.Scores)
	}

	// The session crossed Mexico City midnight: two tournament days, and the
	// standings rebuilt from the log equal the server's own.
	days := rep.Days()
	if len(days) != 2 || days[0] != "2027-01-14" || days[1] != "2027-01-15" || engine.DayOf(t0) != days[0] {
		t.Fatalf("days %v", days)
	}
	for _, day := range days {
		_, live, n := hub.Leaderboard(day, 0)
		rebuilt := rep.Top(day, 0)
		if n == 0 || len(live) != len(rebuilt) {
			t.Fatalf("%s: %d live standings, %d rebuilt", day, len(live), len(rebuilt))
		}
		for i := range live {
			if live[i] != rebuilt[i] {
				t.Fatalf("%s rank %d: live %+v, rebuilt %+v", day, i+1, live[i], rebuilt[i])
			}
		}
	}
	// A round counts for the day it closes in: the first day's rounds are the
	// ones that closed before 06:00 UTC.
	_, d1, _ := hub.Leaderboard(days[0], 1)
	_, d2, _ := hub.Leaderboard(days[1], 1)
	if d1[0].Rounds+d2[0].Rounds > 24 || d1[0].Rounds == 0 || d2[0].Rounds == 0 {
		t.Fatalf("rounds per day: %d + %d", d1[0].Rounds, d2[0].Rounds)
	}

	// Replaying twice gives the same answer.
	rep2, _ := replay.Run(file)
	if rep2.Scores != rep.Scores || len(rep2.Totals[days[0]]) != len(rep.Totals[days[0]]) {
		t.Fatal("replay is not deterministic")
	}
}

// Any edit to the log that would change a score is caught.
func TestReplayCatchesTampering(t *testing.T) {
	dir := t.TempDir()
	_, file, _ := playSession(t, dir, 6)
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	lines := bytes.Split(bytes.TrimSpace(raw), []byte("\n"))
	firstOf := func(kind string) int {
		for i, l := range lines {
			if bytes.Contains(l, []byte(`"ev":"`+kind+`"`)) {
				return i
			}
		}
		t.Fatalf("no %s line", kind)
		return -1
	}
	edits := map[string]func(l [][]byte){
		"a score changed": func(l [][]byte) {
			i := firstOf("scores")
			var ev eventlogEvent
			ev.decode(t, l[i])
			ev.Scores[0].Points++
			l[i] = ev.encode(t)
		},
		"chips moved after the fact": func(l [][]byte) {
			// the last placement of the first round: that player's final board
			var first eventlogEvent
			first.decode(t, l[firstOf("place")])
			for i := len(l) - 1; i >= 0; i-- {
				var ev eventlogEvent
				ev.decode(t, l[i])
				if ev.Ev == "place" && ev.Round == first.Round {
					ev.Chips[0], ev.Chips[11] = ev.Chips[0]+ev.Chips[11]+1, 0
					for b := 1; b < 11 && engine.Sum(*ev.Chips) > 100; b++ {
						ev.Chips[b] = 0
					}
					l[i] = ev.encode(t)
					return
				}
			}
		},
		"a placement dated after the lock": func(l [][]byte) {
			i := firstOf("place")
			var ev eventlogEvent
			ev.decode(t, l[i])
			ev.T += engine.OpenMs
			l[i] = ev.encode(t)
		},
		"the closing price moved": func(l [][]byte) {
			i := firstOf("close")
			var ev eventlogEvent
			ev.decode(t, l[i])
			*ev.Price += 500
			l[i] = ev.encode(t)
		},
		"the lock price moved": func(l [][]byte) {
			i := firstOf("lock")
			var ev eventlogEvent
			ev.decode(t, l[i])
			*ev.LockPrice += 40
			l[i] = ev.encode(t)
		},
		"a scores line removed": func(l [][]byte) {
			l[firstOf("scores")] = []byte(" ")
		},
	}
	for name, edit := range edits {
		cp := make([][]byte, len(lines))
		copy(cp, lines)
		edit(cp)
		p := filepath.Join(t.TempDir(), "events-tampered.jsonl")
		os.WriteFile(p, append(bytes.Join(cp, []byte("\n")), '\n'), 0o600)
		rep, err := replay.Run(p)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if rep.OK() {
			t.Errorf("%s: replay did not notice", name)
		}
	}

	// A crash mid-line leaves a torn last line: reported, not fatal.
	p := filepath.Join(t.TempDir(), "events-torn.jsonl")
	os.WriteFile(p, append(append([]byte{}, raw...), []byte(`{"ev":"place","t":17`)...), 0o600)
	rep, err := replay.Run(p)
	if err != nil || !rep.OK() || rep.TornLines != 1 {
		t.Errorf("torn line: err %v, ok %v, torn %d", err, rep.OK(), rep.TornLines)
	}
	if !strings.HasSuffix(file, "events-2027-01-15.jsonl") {
		t.Errorf("log file name %s", file)
	}
}
