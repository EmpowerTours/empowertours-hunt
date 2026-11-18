package engine

import (
	"math"
	"testing"
)

// The approved test vectors: centre 100000, band 10, baseline sd 20.
func vectorRound() ([NB - 1]float64, [NB]float64) {
	e := Edges(100000, 10)
	return e, Baseline(e, 100000, 20)
}

func TestEdges(t *testing.T) {
	e, _ := vectorRound()
	if e[0] != 99950 || e[10] != 100050 || e[5] != 100000 {
		t.Fatalf("edges %v", e)
	}
}

func TestBaselineVector(t *testing.T) {
	_, b := vectorRound()
	want := [NB]int{1, 2, 4, 9, 15, 19, 19, 15, 9, 4, 2, 1}
	sum := 0.0
	for i, x := range b {
		sum += x
		if got := int(math.Round(x * 100)); got != want[i] {
			t.Errorf("band %d: baseline %.4f rounds to %d, want %d", i, x, got, want[i])
		}
	}
	if math.Abs(sum-1) > 1e-12 {
		t.Errorf("baseline sums to %v", sum)
	}
}

func TestScoringVectors(t *testing.T) {
	e, b := vectorRound()
	on := func(pairs ...int) [NB]int {
		var c [NB]int
		for i := 0; i < len(pairs); i += 2 {
			c[pairs[i]] = pairs[i+1]
		}
		return c
	}
	mid := BandOf(e, 10, 100000) // [100000,100010)
	if mid != 6 {
		t.Fatalf("100000 is in band %d, want 6", mid)
	}
	all := on(mid, 100)
	cases := []struct {
		name  string
		chips [NB]int
		price float64
		want  int
	}{
		{"all on middle, lands there", all, 100005, 76},
		{"all on middle, lands at its lower edge", all, 100000, 76},
		{"all on middle, lands one below", all, 99995, -124},
		{"all on middle, lands at 99990", all, 99990, -124},
		{"all on middle, lands in [100030,100040)", all, 100030, -95},
		{"all on middle, lands in [100030,100040) top", all, 100039.9, -95},
		{"all on middle, lands below", all, 99949.9, -87},
		{"50/50 lands lower middle", on(5, 50, 6, 50), 99999.9, 26},
		{"50/50 lands upper middle", on(5, 50, 6, 50), 100009.9, 26},
	}
	for _, c := range cases {
		k := BandOf(e, 10, c.price)
		if got := Points(Shares(c.chips, b), b, k); got != c.want {
			t.Errorf("%s: band %d, got %d, want %d", c.name, k, got, c.want)
		}
	}
}

func TestCopyingBaselineScoresZero(t *testing.T) {
	_, b := vectorRound()
	chips := [NB]int{1, 2, 4, 9, 15, 19, 19, 15, 9, 4, 2, 1}
	if Sum(chips) != 100 {
		t.Fatal("baseline chips must sum to 100")
	}
	for k := 0; k < NB; k++ {
		if got := Points(Shares(chips, b), b, k); got < -1 || got > 1 {
			t.Errorf("band %d: copying the baseline scored %d", k, got)
		}
		// No chips at all is exactly the baseline: exactly 0.
		if got := Points(Shares([NB]int{}, b), b, k); got != 0 {
			t.Errorf("band %d: empty board scored %d", k, got)
		}
	}
}

func TestUnplacedChipsSpreadLikeBaseline(t *testing.T) {
	_, b := vectorRound()
	var chips [NB]int
	chips[6] = 40
	q := Shares(chips, b)
	sum := 0.0
	for i := range q {
		want := 0.6 * b[i]
		if i == 6 {
			want += 0.4
		}
		if math.Abs(q[i]-want) > 1e-12 {
			t.Errorf("band %d: share %v, want %v", i, q[i], want)
		}
		sum += q[i]
	}
	if math.Abs(sum-1) > 1e-12 {
		t.Errorf("shares sum to %v", sum)
	}
	// 40 on the middle band: between an empty board (0) and all-in (+76).
	if got := Points(q, b, 6); got <= 0 || got >= 76 {
		t.Errorf("40 chips on the winning band scored %d", got)
	}
}

func TestBandOf(t *testing.T) {
	e, _ := vectorRound()
	cases := map[float64]int{99949.99: 0, 99950: 1, 99959.99: 1, 99960: 2, 100049.99: 10, 100050: 11, 250000: 11, 0: 0}
	for p, want := range cases {
		if got := BandOf(e, 10, p); got != want {
			t.Errorf("BandOf(%v) = %d, want %d", p, got, want)
		}
	}
}

func TestNiceBandAndCentre(t *testing.T) {
	for x, want := range map[float64]float64{0: 5, 7.4: 5, 7.6: 10, 37.6: 40, 62: 50, 63: 75, 500: 100} {
		if got := NiceBand(x); got != want {
			t.Errorf("NiceBand(%v) = %v, want %v", x, got, want)
		}
	}
	// sigma 10 $/sqrt(s): 10*sqrt(80)*0.42 = 37.57 -> 40
	if got := BandWidth(10); got != 40 {
		t.Errorf("BandWidth(10) = %v", got)
	}
	if got := Centre(104251, 40); got != 104240 {
		t.Errorf("Centre = %v", got)
	}
	if got := Centre(100020, 40); got != 100040 { // half rounds up
		t.Errorf("Centre tie = %v", got)
	}
}

func TestSigma(t *testing.T) {
	// differences alternate +3, -3: mean 0, sample sd = 3*sqrt(n/(n-1))
	s := []float64{100}
	for i := 0; i < 120; i++ {
		d := 3.0
		if i%2 == 1 {
			d = -3
		}
		s = append(s, s[len(s)-1]+d)
	}
	sig, n := Sigma(s)
	if n != 120 || math.Abs(sig-3*math.Sqrt(120.0/119)) > 1e-9 {
		t.Errorf("sigma %v n %d", sig, n)
	}
	// a flat tape is floored at 1
	if sig, _ := Sigma(make([]float64, 121)); sig != 1 {
		t.Errorf("flat sigma %v", sig)
	}
	// a missing second removes the two differences that touch it
	s[50] = math.NaN()
	if _, n := Sigma(s); n != 118 {
		t.Errorf("n with a gap = %d", n)
	}
}

func TestRoundTimes(t *testing.T) {
	o, l, c := Times(5)
	if o != 100_000 || l != 120_000 || c != 180_000 {
		t.Fatalf("times %d %d %d", o, l, c)
	}
	if RoundIDAt(119_999) != 5 || RoundIDAt(120_000) != 6 {
		t.Fatal("RoundIDAt")
	}
}

func TestLockBoundary(t *testing.T) {
	g := NewGame()
	r := g.Open(5, 100000, 1.25)
	chips := make([]int, NB)
	chips[6] = 100
	if _, reason := g.Set(r.LockMs-1, "ana", 5, chips); reason != "" {
		t.Fatalf("placement 1 ms before lock refused: %s", reason)
	}
	// At the lock instant the clock refuses it, even though Lock() has not run yet.
	chips[6], chips[5] = 0, 100
	if _, reason := g.Set(r.LockMs, "ana", 5, chips); reason != ReasonLocked {
		t.Fatalf("placement at lock: %q, want %s", reason, ReasonLocked)
	}
	if _, reason := g.Add(r.LockMs, "ana", 5, 6, -10); reason != ReasonLocked {
		t.Fatalf("add at lock: %q", reason)
	}
	if got := g.Chips(5, "ana"); got[6] != 100 {
		t.Fatalf("refused placement changed the board: %v", got)
	}
	g.Lock(5, 100000)
	if _, reason := g.Set(r.LockMs+1, "ana", 5, chips); reason != ReasonLocked {
		t.Fatalf("placement after lock: %q", reason)
	}
}

func TestPlacementRules(t *testing.T) {
	g := NewGame()
	r := g.Open(5, 100000, 1.25)
	now := r.OpenMs + 1000
	if _, reason := g.Set(now, "ana", 6, make([]int, NB)); reason != ReasonUnknown {
		t.Errorf("unknown round: %q", reason)
	}
	if _, reason := g.Set(now, "ana", 5, make([]int, 11)); reason != ReasonBadBand {
		t.Errorf("11 bands: %q", reason)
	}
	neg := make([]int, NB)
	neg[0] = -1
	if _, reason := g.Set(now, "ana", 5, neg); reason != ReasonBadBand {
		t.Errorf("negative: %q", reason)
	}
	over := make([]int, NB)
	over[0], over[1] = 60, 41
	if _, reason := g.Set(now, "ana", 5, over); reason != ReasonOver100 {
		t.Errorf("101 chips: %q", reason)
	}
	if _, reason := g.Add(now, "ana", 5, 12, 5); reason != ReasonBadBand {
		t.Errorf("band 12: %q", reason)
	}
	if c, reason := g.Add(now, "ana", 5, 3, 70); reason != "" || c[3] != 70 {
		t.Errorf("add 70: %v %q", c, reason)
	}
	if _, reason := g.Add(now, "ana", 5, 4, 31); reason != ReasonOver100 {
		t.Errorf("add past 100: %q", reason)
	}
	if c, reason := g.Add(now, "ana", 5, 4, 30); reason != "" || Sum(c) != 100 {
		t.Errorf("add to exactly 100: %v %q", c, reason)
	}
	if c, reason := g.Add(now, "ana", 5, 3, -90); reason != "" || c[3] != 0 || Sum(c) != 30 {
		t.Errorf("taking off more than is there: %v %q", c, reason)
	}
}

func TestRoundLifecycle(t *testing.T) {
	g := NewGame()
	r := g.Open(5, 100000, 20/math.Sqrt(60)) // baseline sd 20; band nice(20/sqrt(60)*sqrt(80)*0.42 = 9.7) = 10
	if r.Band != 10 || r.Centre != 100000 {
		t.Fatalf("band %v centre %v", r.Band, r.Centre)
	}
	all := make([]int, NB)
	all[6] = 100
	g.Set(r.OpenMs+5, "all-in", 5, all)
	g.Add(r.OpenMs+6, "half", 5, 5, 50)
	g.Add(r.OpenMs+7, "half", 5, 6, 50)
	g.Add(r.OpenMs+8, "cleared", 5, 2, 10)
	g.Add(r.OpenMs+9, "cleared", 5, 2, -10)
	if _, _, ok := g.Close(5, 100005); ok {
		t.Fatal("closed a round that was never locked")
	}
	if _, ok := g.Lock(5, 100000); !ok {
		t.Fatal("lock failed")
	}
	if _, ok := g.Lock(5, 100000); ok {
		t.Fatal("locked twice")
	}
	rr, scores, ok := g.Close(5, 100005)
	if !ok || rr.Landed != 6 || rr.Status != StatusSettled {
		t.Fatalf("close: %+v", rr)
	}
	if len(scores) != 2 || scores[0].Player != "all-in" || scores[0].Points != 76 || scores[1].Player != "half" || scores[1].Points != 26 {
		t.Fatalf("scores %+v", scores)
	}
	if _, ok := g.Get(5); ok {
		t.Fatal("settled round still held")
	}
}

func TestTournamentDayResetMexicoCity(t *testing.T) {
	// Mexico City is UTC-6 all year (no DST since 2022): its midnight is 06:00 UTC.
	utc := func(s string) int64 {
		tm, err := timeParse(s)
		if err != nil {
			t.Fatal(err)
		}
		return tm
	}
	before := utc("2026-11-18T05:59:59.999Z")
	after := utc("2026-11-18T06:00:00.000Z")
	if DayOf(before) != "2026-11-17" || DayOf(after) != "2026-11-18" {
		t.Fatalf("days %s %s", DayOf(before), DayOf(after))
	}
	// Midnight UTC is NOT the boundary.
	if DayOf(utc("2026-11-18T00:00:00Z")) != "2026-11-17" {
		t.Fatal("day changed at UTC midnight")
	}
	// Summer too: still UTC-6.
	if DayOf(utc("2026-07-01T05:59:59Z")) != "2026-06-30" || DayOf(utc("2026-07-01T06:00:00Z")) != "2026-07-01" {
		t.Fatal("summer boundary is not 06:00 UTC")
	}

	tr := NewTournament(20)
	for i := 0; i < 19; i++ {
		tr.Record(DayOf(before), "ana", 10)
	}
	tr.Record(DayOf(before), "beto", 500)
	lb := tr.Leaderboard("2026-11-17")
	if lb[0].Player != "beto" || lb[1].Player != "ana" || lb[1].Points != 190 || lb[1].Qualified || lb[1].Rank != 2 {
		t.Fatalf("leaderboard %+v", lb)
	}
	tr.Record(DayOf(before), "ana", -5)
	if lb = tr.Leaderboard("2026-11-17"); !lb[1].Qualified || lb[1].Rounds != 20 || lb[1].Points != 185 {
		t.Fatalf("after 20 rounds %+v", lb)
	}
	// The first round of the new day starts from zero.
	tr.Record(DayOf(after), "ana", 7)
	lb = tr.Leaderboard("2026-11-18")
	if len(lb) != 1 || lb[0].Points != 7 || lb[0].Rounds != 1 || lb[0].Qualified {
		t.Fatalf("new day %+v", lb)
	}
	tr.Prune("2026-11-18")
	if len(tr.Leaderboard("2026-11-17")) != 0 {
		t.Fatal("prune kept the old day")
	}
}
