package price

import (
	"fmt"
	"math"
	"sort"
	"sync"
)

// Settlement rules, selected by SETTLE_PRICE.
const (
	RulePerplLast   = "perpl_last"
	RulePerplTwap30 = "perpl_twap30"
	RulePerplMark   = "perpl_mark"
	RuleComposite   = "composite"
)

// Rules lists every candidate; all four are computed and logged at each close.
var Rules = []string{RulePerplLast, RulePerplTwap30, RulePerplMark, RuleComposite}

// Void reasons.
const (
	VoidUnavailable = "price_unavailable"
	VoidVenues      = "composite_venues"
	VoidPerplStale  = "perpl_stale"
	VoidDivergence  = "divergence"
)

// Config holds the void thresholds.
type Config struct {
	FreshMs       int64   // a reference venue counts if its last trade is at most this old (5000)
	MinVenues     int     // fresh venues the composite needs (2)
	PerplStaleMs  int64   // VOID_PERPL_STALE_S
	DivergenceBps float64 // VOID_DIVERGENCE_BPS
	TwapMs        int64   // 30000
	RollN         int     // 1-second samples behind each rolling median (600 = 10 min)
}

func DefaultConfig() Config {
	return Config{FreshMs: 5000, MinVenues: 2, PerplStaleMs: 30_000, DivergenceBps: 8, TwapMs: 30_000, RollN: 600}
}

// Settler is the pluggable settlement price: the price that closes a round at
// time t. ok is false when the rule has no price for t.
type Settler interface {
	Rule() string
	CloseAt(tMs int64) (price float64, ok bool)
}

// Book holds the tapes and the two slow-moving corrections: each venue's
// usual offset to Binance, and Perpl's usual discount to the composite.
type Book struct {
	Cfg   Config
	tapes map[Source]*Tape

	mu      sync.Mutex
	offsets map[Source]*rollMedian // venue - binance, $
	basis   map[string]*rollMedian // (perpl rule - composite) / composite, bps
}

func NewBook(cfg Config) *Book {
	b := &Book{Cfg: cfg, tapes: map[Source]*Tape{}, offsets: map[Source]*rollMedian{}, basis: map[string]*rollMedian{}}
	for _, s := range Sources {
		b.tapes[s] = NewTape(5 * 60_000)
	}
	for _, s := range RefVenues {
		b.offsets[s] = newRollMedian(cfg.RollN)
	}
	for _, r := range Rules {
		if r != RuleComposite {
			b.basis[r] = newRollMedian(cfg.RollN)
		}
	}
	return b
}

// Add records a tick.
func (b *Book) Add(src Source, tMs int64, p float64) {
	if tp := b.tapes[src]; tp != nil {
		tp.Add(tMs, p)
	}
}

// Tape exposes one source's tape.
func (b *Book) Tape(src Source) *Tape { return b.tapes[src] }

// AgeMs is how old the source's newest tick is at now, or -1 if it has none.
func (b *Book) AgeMs(src Source, now int64) int64 {
	p, ok := b.tapes[src].Last()
	if !ok {
		return -1
	}
	return now - p.T
}

func (b *Book) offset(src Source) float64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.offsets[src].median()
}

// Basis is Perpl's usual discount (bps) to the composite under a Perpl rule.
func (b *Book) Basis(rule string) float64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	if m := b.basis[rule]; m != nil {
		return m.median()
	}
	return 0
}

// Offsets returns each venue's rolling median offset to Binance.
func (b *Book) Offsets() map[Source]float64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := map[Source]float64{}
	for s, m := range b.offsets {
		out[s] = m.median()
	}
	return out
}

func (b *Book) fresh(src Source, t int64) (float64, bool) {
	p, ok := b.tapes[src].At(t)
	if !ok || t-p.T > b.Cfg.FreshMs {
		return 0, false
	}
	return p.P, true
}

// compositeAt is the median of the fresh venues, each shifted onto Binance by
// its usual offset. n is how many venues were fresh.
func (b *Book) compositeAt(t int64) (price float64, n int) {
	v := make([]float64, 0, len(RefVenues))
	for _, s := range RefVenues {
		if p, ok := b.fresh(s, t); ok {
			v = append(v, p-b.offset(s))
		}
	}
	if len(v) == 0 {
		return 0, 0
	}
	return medianOf(v), len(v)
}

/* ---- the four settlement rules ---- */

type perplLast struct{ b *Book }

func (perplLast) Rule() string { return RulePerplLast }
func (s perplLast) CloseAt(t int64) (float64, bool) {
	p, ok := s.b.tapes[Perpl].At(t)
	return p.P, ok
}

type perplTwap30 struct{ b *Book }

func (perplTwap30) Rule() string { return RulePerplTwap30 }
func (s perplTwap30) CloseAt(t int64) (float64, bool) {
	return s.b.tapes[Perpl].TWAP(t-s.b.Cfg.TwapMs, t)
}

type perplMark struct{ b *Book }

func (perplMark) Rule() string { return RulePerplMark }
func (s perplMark) CloseAt(t int64) (float64, bool) {
	p, ok := s.b.tapes[PerplMark].At(t)
	return p.P, ok
}

type composite struct{ b *Book }

func (composite) Rule() string { return RuleComposite }
func (s composite) CloseAt(t int64) (float64, bool) {
	p, n := s.b.compositeAt(t)
	return p, n >= s.b.Cfg.MinVenues
}

// Settler returns the implementation for a rule name.
func (b *Book) Settler(rule string) (Settler, error) {
	switch rule {
	case RulePerplLast:
		return perplLast{b}, nil
	case RulePerplTwap30:
		return perplTwap30{b}, nil
	case RulePerplMark:
		return perplMark{b}, nil
	case RuleComposite:
		return composite{b}, nil
	}
	return nil, fmt.Errorf("unknown SETTLE_PRICE %q (want one of %v)", rule, Rules)
}

// Snapshot is everything known about one instant: all four candidate prices
// and the facts the void rules look at. It is what gets logged.
type Snapshot struct {
	T           int64               `json:"t"`
	Prices      map[string]*float64 `json:"prices"`             // rule -> price, null when unavailable
	FreshVenues int                 `json:"freshVenues"`        // reference venues with a trade in the last FreshMs
	Venues      map[Source]float64  `json:"venues,omitempty"`   // raw last trade of each fresh venue
	TradeAgeMs  int64               `json:"perplTradeAgeMs"`    // -1: Perpl has not traded
	MarkAgeMs   int64               `json:"perplMarkAgeMs"`     // -1: no mark yet
	BasisBps    map[string]float64  `json:"basisBps,omitempty"` // Perpl's usual discount per Perpl rule
	DevBps      map[string]float64  `json:"devBps,omitempty"`   // each Perpl rule vs composite, after the usual discount
}

// Snapshot computes all four candidates at t.
func (b *Book) Snapshot(t int64) Snapshot {
	s := Snapshot{T: t, Prices: map[string]*float64{}, Venues: map[Source]float64{}, BasisBps: map[string]float64{}, DevBps: map[string]float64{}, TradeAgeMs: -1, MarkAgeMs: -1}
	for _, rule := range Rules {
		st, _ := b.Settler(rule)
		if p, ok := st.CloseAt(t); ok {
			p := p
			s.Prices[rule] = &p
		} else {
			s.Prices[rule] = nil
		}
	}
	for _, v := range RefVenues {
		if p, ok := b.fresh(v, t); ok {
			s.Venues[v] = p
			s.FreshVenues++
		}
	}
	if p, ok := b.tapes[Perpl].At(t); ok {
		s.TradeAgeMs = t - p.T
	}
	if p, ok := b.tapes[PerplMark].At(t); ok {
		s.MarkAgeMs = t - p.T
	}
	comp := s.Prices[RuleComposite]
	for _, rule := range Rules {
		if rule == RuleComposite {
			continue
		}
		s.BasisBps[rule] = b.Basis(rule)
		if p := s.Prices[rule]; p != nil && comp != nil {
			s.DevBps[rule] = (*p-*comp) / *comp * 1e4 - s.BasisBps[rule]
		}
	}
	return s
}

// Judge applies the void rules to a snapshot for the chosen rule. It returns
// the price to use, or a void reason (never both).
func (b *Book) Judge(rule string, s Snapshot) (price float64, void string) {
	p := s.Prices[rule]
	if rule != RuleComposite && p == nil {
		return 0, VoidUnavailable
	}
	// Without a composite nothing can be cross-checked, whatever the rule.
	if s.FreshVenues < b.Cfg.MinVenues {
		return 0, VoidVenues
	}
	if p == nil || s.Prices[RuleComposite] == nil {
		return 0, VoidUnavailable
	}
	switch rule {
	case RulePerplLast, RulePerplTwap30:
		if s.TradeAgeMs < 0 || s.TradeAgeMs > b.Cfg.PerplStaleMs {
			return 0, VoidPerplStale
		}
	case RulePerplMark:
		// The mark is an index Perpl publishes with or without trades, so its
		// own age is what makes it stale.
		if s.MarkAgeMs < 0 || s.MarkAgeMs > b.Cfg.PerplStaleMs {
			return 0, VoidPerplStale
		}
	}
	if rule != RuleComposite {
		if math.Abs(s.DevBps[rule]) > b.Cfg.DivergenceBps {
			return 0, VoidDivergence
		}
	}
	return *p, ""
}

// Sample takes the once-a-second reading behind the rolling medians. Call it
// about every second with the current time.
func (b *Book) Sample(now int64) {
	if bin, ok := b.fresh(Binance, now); ok {
		for _, v := range RefVenues {
			if p, ok := b.fresh(v, now); ok {
				b.mu.Lock()
				b.offsets[v].push(p - bin)
				b.mu.Unlock()
			}
		}
	}
	comp, n := b.compositeAt(now)
	if n < b.Cfg.MinVenues {
		return
	}
	tradeFresh := false
	if p, ok := b.tapes[Perpl].At(now); ok && now-p.T <= b.Cfg.PerplStaleMs {
		tradeFresh = true
	}
	markFresh := false
	if p, ok := b.tapes[PerplMark].At(now); ok && now-p.T <= b.Cfg.PerplStaleMs {
		markFresh = true
	}
	for rule, ok := range map[string]bool{RulePerplLast: tradeFresh, RulePerplTwap30: tradeFresh, RulePerplMark: markFresh} {
		if !ok {
			continue // a stale Perpl price says nothing about its usual discount
		}
		st, _ := b.Settler(rule)
		if p, ok := st.CloseAt(now); ok {
			b.mu.Lock()
			b.basis[rule].push((p - comp) / comp * 1e4)
			b.mu.Unlock()
		}
	}
}

/* ---- rolling median ---- */

type rollMedian struct {
	buf  []float64
	next int
	full bool
	med  float64 // median of what has been pushed; 0 before the first sample
}

func newRollMedian(n int) *rollMedian { return &rollMedian{buf: make([]float64, n)} }

func (r *rollMedian) push(x float64) {
	r.buf[r.next] = x
	r.next++
	if r.next == len(r.buf) {
		r.next, r.full = 0, true
	}
	n := r.next
	if r.full {
		n = len(r.buf)
	}
	r.med = medianOf(append([]float64(nil), r.buf[:n]...))
}

func (r *rollMedian) median() float64 { return r.med }

func medianOf(v []float64) float64 {
	sort.Float64s(v)
	n := len(v)
	if n%2 == 1 {
		return v[n/2]
	}
	return (v[n/2-1] + v[n/2]) / 2
}
