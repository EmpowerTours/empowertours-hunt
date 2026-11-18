package price

import (
	"math"
	"testing"
)

const t0 = int64(1_800_000_000_000)

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

// book with four venues trading every 500 ms around 100000 with fixed offsets
// to Binance, a Perpl tape 3 bps under, and a mark; sampled every second so the
// rolling medians are settled. Ends at t0.
func settledBook(cfg Config) *Book {
	b := NewBook(cfg)
	offs := map[Source]float64{Binance: 0, OKX: -20, Bybit: -15, Coinbase: 30}
	for t := t0 - 60_000; t <= t0; t += 500 {
		for v, o := range offs {
			b.Add(v, t, 100000+o)
		}
		b.Add(Perpl, t, 99970)
		b.Add(PerplMark, t, 99975)
		if t%1000 == 0 {
			b.Sample(t)
		}
	}
	return b
}

func TestTapeAtAndOrder(t *testing.T) {
	tp := NewTape(60_000)
	if _, ok := tp.At(t0); ok {
		t.Fatal("empty tape has a price")
	}
	tp.Add(t0, 100)
	tp.Add(t0+1000, 101)
	tp.Add(t0+500, 999) // late: dropped
	tp.Add(t0+2000, 0)  // not a price: dropped
	if p, _ := tp.At(t0 + 999); p.P != 100 {
		t.Errorf("At just before the 2nd tick = %v", p.P)
	}
	if p, _ := tp.At(t0 + 1000); p.P != 101 {
		t.Errorf("At the 2nd tick = %v", p.P)
	}
	if _, ok := tp.At(t0 - 1); ok {
		t.Error("price before the first tick")
	}
}

func TestTapePruneKeepsLastPrice(t *testing.T) {
	tp := NewTape(1000)
	tp.Add(t0, 50)
	for i := int64(1); i <= 9000; i++ {
		tp.Add(t0+100_000+i, 60)
	}
	if n := len(tp.pts); n > 5000 {
		t.Errorf("tape not pruned: %d points", n)
	}
	if p, ok := tp.Last(); !ok || p.P != 60 {
		t.Error("lost the last price")
	}
}

func TestTWAP(t *testing.T) {
	tp := NewTape(600_000)
	tp.Add(t0-40_000, 100) // in force when the window starts
	tp.Add(t0-20_000, 200) // 10 s at 100, then 20 s at 200
	if v, ok := tp.TWAP(t0-30_000, t0); !ok || !near(v, (100*10+200*20)/30.0) {
		t.Errorf("twap = %v", v)
	}
	// A trade after t must not count.
	tp.Add(t0+1, 99999)
	if v, _ := tp.TWAP(t0-30_000, t0); !near(v, (100*10+200*20)/30.0) {
		t.Errorf("twap looked ahead: %v", v)
	}
	// Nothing before the window: average only over the covered part.
	tp2 := NewTape(600_000)
	tp2.Add(t0-10_000, 300)
	tp2.Add(t0-5_000, 400)
	if v, _ := tp2.TWAP(t0-30_000, t0); !near(v, 350) {
		t.Errorf("partial twap = %v", v)
	}
	if _, ok := NewTape(1).TWAP(t0-30_000, t0); ok {
		t.Error("twap of an empty tape")
	}
	tp3 := NewTape(600_000)
	tp3.Add(t0, 500)
	if v, ok := tp3.TWAP(t0-30_000, t0); !ok || v != 500 {
		t.Errorf("single trade at t: %v %v", v, ok)
	}
}

func TestCompositeMedianWithOffsets(t *testing.T) {
	b := settledBook(DefaultConfig())
	offs := b.Offsets()
	if offs[OKX] != -20 || offs[Bybit] != -15 || offs[Coinbase] != 30 || offs[Binance] != 0 {
		t.Fatalf("offsets %v", offs)
	}
	st, _ := b.Settler(RuleComposite)
	if p, ok := st.CloseAt(t0); !ok || !near(p, 100000) {
		t.Fatalf("composite = %v %v", p, ok)
	}
	// One venue prints a wild price: the median ignores it.
	b.Add(Coinbase, t0+100, 100930) // +900 after its offset
	if p, _ := st.CloseAt(t0 + 100); !near(p, 100000) {
		t.Errorf("composite followed one venue: %v", p)
	}
	// Two venues move by 10, two stay: the median is halfway.
	b.Add(Coinbase, t0+200, 100030)
	b.Add(Binance, t0+200, 100010)
	b.Add(OKX, t0+200, 99990)
	if p, _ := st.CloseAt(t0 + 200); !near(p, 100005) {
		t.Errorf("even-count median = %v", p)
	}
}

func TestCompositeStaleVenues(t *testing.T) {
	b := settledBook(DefaultConfig())
	st, _ := b.Settler(RuleComposite)
	// Binance and OKX keep trading; Bybit and Coinbase stop at t0.
	b.Add(Binance, t0+4000, 100100)
	b.Add(OKX, t0+4000, 100080)
	// 5.000 s after their last trade the quiet venues still count (<= 5 s).
	s := b.Snapshot(t0 + 5000)
	if s.FreshVenues != 4 {
		t.Fatalf("at exactly 5 s: %d fresh venues", s.FreshVenues)
	}
	if p, _ := st.CloseAt(t0 + 5000); !near(p, 100050) { // median of 100100, 100100, 100000, 100000
		t.Errorf("4-venue composite = %v", p)
	}
	// 1 ms later they are stale: only the two live venues are blended.
	s = b.Snapshot(t0 + 5001)
	if s.FreshVenues != 2 {
		t.Fatalf("at 5.001 s: %d fresh venues", s.FreshVenues)
	}
	if p, ok := st.CloseAt(t0 + 5001); !ok || !near(p, 100100) {
		t.Errorf("2-venue composite = %v %v", p, ok)
	}
	// Then OKX goes quiet too: one venue is not a composite.
	b.Add(Binance, t0+9500, 100100)
	if p, ok := st.CloseAt(t0 + 9500); ok {
		t.Errorf("composite from one venue: %v", p)
	}
	if s = b.Snapshot(t0 + 9500); s.FreshVenues != 1 || s.Prices[RuleComposite] != nil {
		t.Errorf("snapshot with one venue: %+v", s)
	}
}

func TestSnapshotAllFourCandidates(t *testing.T) {
	b := settledBook(DefaultConfig())
	s := b.Snapshot(t0)
	want := map[string]float64{RulePerplLast: 99970, RulePerplTwap30: 99970, RulePerplMark: 99975, RuleComposite: 100000}
	for rule, w := range want {
		if p := s.Prices[rule]; p == nil || !near(*p, w) {
			t.Errorf("%s = %v, want %v", rule, p, w)
		}
	}
	if s.TradeAgeMs != 0 || s.MarkAgeMs != 0 {
		t.Errorf("ages %d %d", s.TradeAgeMs, s.MarkAgeMs)
	}
	if !near(s.BasisBps[RulePerplLast], -3) || !near(s.BasisBps[RulePerplMark], -2.5) {
		t.Errorf("basis %v", s.BasisBps)
	}
	for rule, d := range s.DevBps {
		if math.Abs(d) > 1e-9 {
			t.Errorf("%s deviates %v bps on a steady tape", rule, d)
		}
	}
}

func TestVoidRules(t *testing.T) {
	cfg := DefaultConfig()
	for _, rule := range Rules {
		b := settledBook(cfg)
		if p, void := b.Judge(rule, b.Snapshot(t0)); void != "" || !(p > 0) {
			t.Errorf("%s: healthy tape voided: %q", rule, void)
		}
	}

	t.Run("chosen price unavailable", func(t *testing.T) {
		b := NewBook(cfg)
		for _, v := range RefVenues {
			b.Add(v, t0, 100000)
		}
		for _, rule := range []string{RulePerplLast, RulePerplTwap30, RulePerplMark} {
			if _, void := b.Judge(rule, b.Snapshot(t0)); void != VoidUnavailable {
				t.Errorf("%s with no Perpl data: %q", rule, void)
			}
		}
		if _, void := b.Judge(RuleComposite, b.Snapshot(t0)); void != "" {
			t.Errorf("composite should stand on its own: %q", void)
		}
	})

	t.Run("fewer than 2 fresh venues", func(t *testing.T) {
		for _, rule := range Rules {
			b := settledBook(cfg)
			b.Add(Perpl, t0+6000, 99970)
			b.Add(PerplMark, t0+6000, 99975)
			b.Add(Binance, t0+6000, 100000) // the other three stopped at t0
			if _, void := b.Judge(rule, b.Snapshot(t0+6000)); void != VoidVenues {
				t.Errorf("%s with one venue: %q", rule, void)
			}
		}
	})

	t.Run("perpl last trade too old", func(t *testing.T) {
		b := settledBook(cfg)
		keepVenues := func(at int64) {
			for v, o := range map[Source]float64{Binance: 0, OKX: -20, Bybit: -15, Coinbase: 30} {
				b.Add(v, at, 100000+o)
			}
			b.Add(PerplMark, at, 99975)
		}
		keepVenues(t0 + 30_000)
		for _, rule := range []string{RulePerplLast, RulePerplTwap30} {
			if _, void := b.Judge(rule, b.Snapshot(t0+30_000)); void != "" {
				t.Errorf("%s at exactly 30 s old: %q", rule, void)
			}
		}
		keepVenues(t0 + 30_001)
		for _, rule := range []string{RulePerplLast, RulePerplTwap30} {
			if _, void := b.Judge(rule, b.Snapshot(t0+30_001)); void != VoidPerplStale {
				t.Errorf("%s at 30.001 s old: %q", rule, void)
			}
		}
		// The mark is still fresh, and the composite does not care about Perpl.
		for _, rule := range []string{RulePerplMark, RuleComposite} {
			if _, void := b.Judge(rule, b.Snapshot(t0+30_001)); void != "" {
				t.Errorf("%s voided by a stale Perpl trade: %q", rule, void)
			}
		}
		// A threshold from the environment is honoured.
		b.Cfg.PerplStaleMs = 60_000
		if _, void := b.Judge(RulePerplLast, b.Snapshot(t0+30_001)); void != "" {
			t.Errorf("60 s threshold: %q", void)
		}
	})

	t.Run("stale mark", func(t *testing.T) {
		b := settledBook(cfg)
		for _, v := range RefVenues {
			b.Add(v, t0+31_000, 100000+b.Offsets()[v])
		}
		b.Add(Perpl, t0+31_000, 99970)
		if _, void := b.Judge(RulePerplMark, b.Snapshot(t0+31_000)); void != VoidPerplStale {
			t.Errorf("31 s old mark: %q", void)
		}
	})

	t.Run("divergence from the composite", func(t *testing.T) {
		// Usual discount is -3 bps. 8 bps beyond that is about $80 at 100000.
		b := settledBook(cfg)
		b.Add(Perpl, t0+100, 99970+79) // +7.9 bps: inside
		if _, void := b.Judge(RulePerplLast, b.Snapshot(t0+100)); void != "" {
			t.Errorf("7.9 bps: %q", void)
		}
		b.Add(Perpl, t0+200, 99970+81) // +8.1 bps: out
		s := b.Snapshot(t0 + 200)
		if _, void := b.Judge(RulePerplLast, s); void != VoidDivergence {
			t.Errorf("8.1 bps: %q (dev %v)", void, s.DevBps)
		}
		// The same print barely moves a 30 s TWAP, and never touches mark or composite.
		for _, rule := range []string{RulePerplTwap30, RulePerplMark, RuleComposite} {
			if _, void := b.Judge(rule, s); void != "" {
				t.Errorf("%s voided by one Perpl print: %q", rule, void)
			}
		}
		b.Add(PerplMark, t0+300, 99975-90)
		if _, void := b.Judge(RulePerplMark, b.Snapshot(t0+300)); void != VoidDivergence {
			t.Errorf("mark 9 bps off: %q", void)
		}
		b.Cfg.DivergenceBps = 20
		if _, void := b.Judge(RulePerplLast, b.Snapshot(t0+200)); void != "" {
			t.Errorf("20 bps threshold: %q", void)
		}
	})
}

func TestUnknownRule(t *testing.T) {
	if _, err := NewBook(DefaultConfig()).Settler("vwap"); err == nil {
		t.Fatal("unknown rule accepted")
	}
}
