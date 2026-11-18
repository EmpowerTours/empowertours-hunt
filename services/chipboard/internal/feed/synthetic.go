package feed

import (
	"context"
	"math"
	"math/rand"
	"sync/atomic"
	"time"

	"github.com/EmpowerTours/empowertours-hunt/services/chipboard/internal/price"
)

const synthStepMs = 100

// Synth is a seeded BTC-like random walk (about $10 per sqrt second, with an
// occasional jump) that also plays the four reference venues, Perpl's tape and
// Perpl's mark. The same seed and the same start time give the same ticks.
type Synth struct {
	rng *rand.Rand
	p   float64
	t   int64 // time of the last step, a multiple of synthStepMs
	n   int64
	// Emitted counts ticks, for Status.
	emitted atomic.Int64
}

// Fixed venue offsets to the walk ($) and Perpl's discount.
var synthOffsets = map[price.Source]float64{price.Binance: 0, price.OKX: -18, price.Bybit: -15, price.Coinbase: 25}

const synthPerplDiscount = 0.9997 // 3 bps under

func NewSynth(seed, startMs int64) *Synth {
	return &Synth{rng: rand.New(rand.NewSource(seed)), p: 104250, t: startMs - startMs%synthStepMs}
}

func round(x, unit float64) float64 { return math.Round(x/unit) * unit }

// step advances the walk by 100 ms and returns that instant's ticks.
func (s *Synth) step() []Tick {
	s.t += synthStepMs
	s.n++
	r := s.rng
	s.p += r.NormFloat64() * 10 * math.Sqrt(synthStepMs/1000.0)
	if r.Float64() < 0.0008 { // a jump about every two minutes
		j := 40 + r.Float64()*80
		if r.Float64() < 0.5 {
			j = -j
		}
		s.p += j
	}
	out := make([]Tick, 0, 6)
	// The rng is consumed in a fixed order so a seed always replays the same.
	for i, v := range price.RefVenues {
		u, noise := r.Float64(), r.NormFloat64()*0.5
		if i == 0 || u < 0.7 {
			out = append(out, Tick{v, s.t, round(s.p+synthOffsets[v]+noise, 0.01)})
		}
	}
	u, noise := r.Float64(), r.NormFloat64()
	if u < 0.08 { // a Perpl trade a little under once a second
		out = append(out, Tick{price.Perpl, s.t, round(s.p*synthPerplDiscount+noise, 0.1)})
	}
	if s.n%4 == 0 {
		out = append(out, Tick{price.PerplMark, s.t, round(s.p*synthPerplDiscount, 0.1)})
	}
	return out
}

// RunTo steps the walk up to tMs and returns every tick on the way.
func (s *Synth) RunTo(tMs int64) []Tick {
	var out []Tick
	for s.t+synthStepMs <= tMs {
		out = append(out, s.step()...)
	}
	return out
}

// Now is the time of the last step.
func (s *Synth) Now() int64 { return s.t }

// FillBook steps to tMs, writing the ticks into the book and taking the
// once-a-second sample behind its rolling medians.
func (s *Synth) FillBook(b *price.Book, tMs int64) {
	for s.t+synthStepMs <= tMs {
		for _, tk := range s.step() {
			b.Add(tk.Src, tk.T, tk.P)
			s.emitted.Add(1)
		}
		if s.t%1000 == 0 {
			b.Sample(s.t)
		}
	}
}

// SynthFeed drives a Synth from the wall clock.
type SynthFeed struct {
	book  *price.Book
	synth *Synth
	last  atomic.Int64
}

// SyntheticBackfillMs is how much history a synthetic feed makes up at start,
// so sigma has its two minutes of samples and rounds can open at once.
const SyntheticBackfillMs = 150_000

func NewSynthFeed(book *price.Book, seed, nowMs int64) *SynthFeed {
	f := &SynthFeed{book: book, synth: NewSynth(seed, nowMs-SyntheticBackfillMs)}
	f.synth.FillBook(book, nowMs)
	f.last.Store(f.synth.Now())
	return f
}

func (f *SynthFeed) Run(ctx context.Context) {
	t := time.NewTicker(synthStepMs * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			f.synth.FillBook(f.book, time.Now().UnixMilli())
			f.last.Store(f.synth.Now())
		}
	}
}

func (f *SynthFeed) Status(now int64) map[string]Status {
	return map[string]Status{"synthetic": {Connected: true, LastMsgAge: now - f.last.Load(), Messages: f.synth.emitted.Load()}}
}
