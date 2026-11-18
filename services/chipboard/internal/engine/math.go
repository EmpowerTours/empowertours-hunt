// Package engine holds the Chip Board rules. It is pure: it never reads a
// clock, a socket or a file. Times and prices are passed in, so the server and
// the replay tool run exactly the same code.
package engine

import "math"

const (
	// NB is the number of bands: "below", 10 inner bands, "above".
	NB = 12
	// ChipsPerRound is what every player holds in every round.
	ChipsPerRound = 100

	PeriodMs = 20_000 // a new round opens every 20 s
	OpenMs   = 20_000 // a round takes chips for 20 s
	HoldMs   = 60_000 // and closes 60 s after it locks

	// SigmaWindowS is how far back the 1-second samples for sigma reach.
	SigmaWindowS = 120
	bandFactor   = 0.42
)

var niceBands = [...]float64{5, 10, 15, 20, 25, 30, 40, 50, 75, 100}

// jsRound rounds half up, like JavaScript's Math.round, so the server and the
// approved mockup agree on every tie.
func jsRound(x float64) float64 { return math.Floor(x + 0.5) }

// RoundIDAt returns the round that opens at or before ms: round k opens at k*20 s (UTC epoch).
func RoundIDAt(ms int64) int64 {
	k := ms / PeriodMs
	if ms%PeriodMs < 0 {
		k--
	}
	return k
}

// Times returns when round id opens, locks and closes (UTC epoch ms).
func Times(id int64) (open, lock, close int64) {
	open = id * PeriodMs
	return open, open + OpenMs, open + OpenMs + HoldMs
}

// NiceBand returns the nice value nearest to x (the first one wins a tie).
func NiceBand(x float64) float64 {
	best := niceBands[0]
	for _, b := range niceBands[1:] {
		if math.Abs(b-x) < math.Abs(best-x) {
			best = b
		}
	}
	return best
}

// BandWidth is the band for a round opened with this sigma ($ per sqrt second).
func BandWidth(sigma float64) float64 {
	return NiceBand(sigma * math.Sqrt(float64(OpenMs+HoldMs)/1000) * bandFactor)
}

// Centre is the open price rounded to the band.
func Centre(openPrice, band float64) float64 { return jsRound(openPrice/band) * band }

// Sigma is the realized volatility in $ per sqrt(second) from prices sampled
// one second apart, oldest first. A NaN marks a second with no price; a
// difference is only taken between two neighbouring seconds that both have
// one. It returns the sample standard deviation of those differences (floored
// at 1, as in the mockup) and how many differences went into it.
func Sigma(samples []float64) (sigma float64, n int) {
	var d []float64
	for i := 1; i < len(samples); i++ {
		if math.IsNaN(samples[i]) || math.IsNaN(samples[i-1]) {
			continue
		}
		d = append(d, samples[i]-samples[i-1])
	}
	n = len(d)
	if n < 2 {
		return 0, n
	}
	var mean float64
	for _, x := range d {
		mean += x
	}
	mean /= float64(n)
	var ss float64
	for _, x := range d {
		ss += (x - mean) * (x - mean)
	}
	return math.Max(1, math.Sqrt(ss/float64(n-1))), n
}

// Edges returns the 11 inner edges: centre-5*band ... centre+5*band.
func Edges(centre, band float64) [NB - 1]float64 {
	var e [NB - 1]float64
	for k := range e {
		e[k] = centre + float64(k-5)*band
	}
	return e
}

// BandOf returns the band holding price p. Bands are closed below, open above:
// band 0 is p < edges[0], band 11 is p >= edges[10].
func BandOf(edges [NB - 1]float64, band, p float64) int {
	if p < edges[0] {
		return 0
	}
	if p >= edges[NB-2] {
		return NB - 1
	}
	k := 1 + int(math.Floor((p-edges[0])/band))
	// Guard the float division right at an edge.
	for k > 1 && p < edges[k-1] {
		k--
	}
	for k < NB-2 && p >= edges[k] {
		k++
	}
	return k
}

func phi(z float64) float64 { return 0.5 * (1 + math.Erf(z/math.Sqrt2)) }

// Baseline is a normal distribution (mean mu, standard deviation sd) cut into the 12 bands.
func Baseline(edges [NB - 1]float64, mu, sd float64) [NB]float64 {
	var b [NB]float64
	cdf := func(x float64) float64 { return phi((x - mu) / sd) }
	b[0] = cdf(edges[0])
	for k := 1; k <= NB-2; k++ {
		b[k] = cdf(edges[k]) - cdf(edges[k-1])
	}
	b[NB-1] = 1 - cdf(edges[NB-2])
	return b
}

// BaselineSD is the baseline's spread at lock: sigma (measured at open) over the 60 s hold.
func BaselineSD(sigma float64) float64 { return sigma * math.Sqrt(float64(HoldMs)/1000) }

// Shares turns placed chips into shares; chips still in hand are spread like the baseline.
func Shares(chips [NB]int, base [NB]float64) [NB]float64 {
	placed := 0
	for _, c := range chips {
		placed += c
	}
	left := float64(ChipsPerRound - placed)
	var q [NB]float64
	for i, c := range chips {
		q[i] = (float64(c) + left*base[i]) / ChipsPerRound
	}
	return q
}

func brier(q [NB]float64, k int) float64 {
	var ss float64
	for _, x := range q {
		ss += x * x
	}
	return 2*q[k] - ss
}

// Points is the quadratic (Brier) score against the baseline when the price
// lands in band k. Copying the baseline scores 0.
func Points(q, base [NB]float64, k int) int {
	return int(jsRound(100 * (brier(q, k) - brier(base, k))))
}

// Sum adds up a chip array.
func Sum(chips [NB]int) int {
	n := 0
	for _, c := range chips {
		n += c
	}
	return n
}
