// Package price keeps the recent ticks of every source and answers "what was
// the price at time t" under each candidate settlement rule. Every query takes
// t explicitly; nothing here reads a clock.
package price

import (
	"sort"
	"sync"
)

type Source string

const (
	Perpl     Source = "perpl"      // Perpl BTC trades
	PerplMark Source = "perpl_mark" // Perpl's published mark price
	Binance   Source = "binance"    // BTCUSDT spot
	OKX       Source = "okx"        // BTC-USDT-SWAP
	Bybit     Source = "bybit"      // BTCUSDT linear
	Coinbase  Source = "coinbase"   // BTC-USD spot
)

// RefVenues are the four venues blended into the composite.
var RefVenues = []Source{Binance, OKX, Bybit, Coinbase}

// Sources is every tape the book keeps.
var Sources = []Source{Perpl, PerplMark, Binance, OKX, Bybit, Coinbase}

type Point struct {
	T int64 // ms, UTC epoch
	P float64
}

// Tape is a time-ordered list of ticks for one source.
type Tape struct {
	mu     sync.RWMutex
	pts    []Point
	keepMs int64
	adds   int
}

func NewTape(keepMs int64) *Tape { return &Tape{keepMs: keepMs} }

// Add appends a tick. A tick older than the newest one already held is
// dropped (it can only be a late snapshot row).
func (tp *Tape) Add(t int64, p float64) {
	if !(p > 0) {
		return
	}
	tp.mu.Lock()
	defer tp.mu.Unlock()
	if n := len(tp.pts); n > 0 && t < tp.pts[n-1].T {
		return
	}
	tp.pts = append(tp.pts, Point{t, p})
	tp.adds++
	if tp.adds%4096 == 0 {
		// Forget what is older than keepMs, but always keep the newest tick
		// at or before the cut: it is still "the last price" for that stretch.
		cut := sort.Search(len(tp.pts), func(i int) bool { return tp.pts[i].T > t-tp.keepMs })
		if cut > 1 {
			tp.pts = append(tp.pts[:0], tp.pts[cut-1:]...)
		}
	}
}

// At returns the last tick at or before t.
func (tp *Tape) At(t int64) (Point, bool) {
	tp.mu.RLock()
	defer tp.mu.RUnlock()
	i := sort.Search(len(tp.pts), func(i int) bool { return tp.pts[i].T > t })
	if i == 0 {
		return Point{}, false
	}
	return tp.pts[i-1], true
}

// Last returns the newest tick.
func (tp *Tape) Last() (Point, bool) {
	tp.mu.RLock()
	defer tp.mu.RUnlock()
	if len(tp.pts) == 0 {
		return Point{}, false
	}
	return tp.pts[len(tp.pts)-1], true
}

// TWAP is the time-weighted price over [from, to]: each tick holds until the
// next one. The price in force at `from` is the last tick before it; if there
// is none, the average starts at the first tick inside the window.
func (tp *Tape) TWAP(from, to int64) (float64, bool) {
	tp.mu.RLock()
	defer tp.mu.RUnlock()
	end := sort.Search(len(tp.pts), func(i int) bool { return tp.pts[i].T > to })
	if end == 0 {
		return 0, false
	}
	start := sort.Search(end, func(i int) bool { return tp.pts[i].T > from })
	var sum float64
	var covered int64
	curT, curP := from, 0.0
	have := false
	if start > 0 {
		curP, have = tp.pts[start-1].P, true
	}
	for i := start; i < end; i++ {
		if have {
			sum += curP * float64(tp.pts[i].T-curT)
			covered += tp.pts[i].T - curT
		}
		curT, curP, have = tp.pts[i].T, tp.pts[i].P, true
	}
	sum += curP * float64(to-curT)
	covered += to - curT
	if covered <= 0 {
		return curP, true // the only tick is exactly at `to`
	}
	return sum / float64(covered), true
}
