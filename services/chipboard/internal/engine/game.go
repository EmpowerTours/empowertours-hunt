package engine

import (
	"sort"
)

// Reason codes sent to a client whose placement is refused.
const (
	ReasonLocked  = "round_locked"
	ReasonUnknown = "round_unknown"
	ReasonOver100 = "over_100"
	ReasonBadBand = "bad_band"
)

type Status string

const (
	StatusOpen    Status = "open"
	StatusLocked  Status = "locked"
	StatusSettled Status = "settled"
	StatusVoid    Status = "void"
)

// Round is one round's public state.
type Round struct {
	ID        int64           `json:"id"`
	OpenMs    int64           `json:"open"`
	LockMs    int64           `json:"lock"`
	CloseMs   int64           `json:"close"`
	Status    Status          `json:"status"`
	OpenPrice float64         `json:"openPrice"`
	Sigma     float64         `json:"sigma"`
	Band      float64         `json:"band"`
	Centre    float64         `json:"centre"`
	Edges     [NB - 1]float64 `json:"edges"`
	LockPrice float64         `json:"lockPrice,omitempty"`
	Baseline  *[NB]float64    `json:"baseline,omitempty"`
	// Set when the round ends.
	ClosePrice float64 `json:"closePrice,omitempty"`
	Landed     int     `json:"landed"`
	VoidReason string  `json:"voidReason,omitempty"`
}

// Score is one player's result for a settled round.
type Score struct {
	Player string  `json:"p"`
	Chips  [NB]int `json:"chips"`
	Placed int     `json:"placed"`
	Points int     `json:"pts"`
}

type roundState struct {
	Round
	chips map[string]*[NB]int
}

// Game holds every live round and the chips on it. It is not safe for
// concurrent use; the caller serializes access.
type Game struct {
	rounds map[int64]*roundState
}

func NewGame() *Game { return &Game{rounds: map[int64]*roundState{}} }

// Open starts round id from the reference price at its open time and the
// sigma measured there.
func (g *Game) Open(id int64, openPrice, sigma float64) Round {
	band := BandWidth(sigma)
	centre := Centre(openPrice, band)
	open, lock, cls := Times(id)
	rs := &roundState{
		Round: Round{
			ID: id, OpenMs: open, LockMs: lock, CloseMs: cls, Status: StatusOpen,
			OpenPrice: openPrice, Sigma: sigma, Band: band, Centre: centre,
			Edges: Edges(centre, band), Landed: -1,
		},
		chips: map[string]*[NB]int{},
	}
	g.rounds[id] = rs
	return rs.Round
}

// Get returns a round, if it is still held.
func (g *Game) Get(id int64) (Round, bool) {
	rs, ok := g.rounds[id]
	if !ok {
		return Round{}, false
	}
	return rs.Round, true
}

// Rounds lists the held rounds, oldest first.
func (g *Game) Rounds() []Round {
	out := make([]Round, 0, len(g.rounds))
	for _, rs := range g.rounds {
		out = append(out, rs.Round)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Chips returns what a player has on a round.
func (g *Game) Chips(id int64, player string) [NB]int {
	if rs, ok := g.rounds[id]; ok {
		if c := rs.chips[player]; c != nil {
			return *c
		}
	}
	return [NB]int{}
}

func (g *Game) openRound(nowMs, id int64) (*roundState, string) {
	rs, ok := g.rounds[id]
	if !ok {
		return nil, ReasonUnknown
	}
	// The clock decides, not the status: a placement at or after the lock time
	// is refused even if Lock has not been called yet.
	if nowMs >= rs.LockMs || rs.Status != StatusOpen {
		return nil, ReasonLocked
	}
	if nowMs < rs.OpenMs {
		return nil, ReasonUnknown
	}
	return rs, ""
}

// Set replaces a player's chips on a round. chips must hold 12 non-negative
// counts that sum to at most 100. It returns "" when accepted.
func (g *Game) Set(nowMs int64, player string, id int64, chips []int) ([NB]int, string) {
	rs, reason := g.openRound(nowMs, id)
	if reason != "" {
		return [NB]int{}, reason
	}
	if len(chips) != NB {
		return [NB]int{}, ReasonBadBand
	}
	var c [NB]int
	sum := 0
	for i, v := range chips {
		if v < 0 {
			return [NB]int{}, ReasonBadBand
		}
		if v > ChipsPerRound {
			return [NB]int{}, ReasonOver100
		}
		c[i] = v
		sum += v
	}
	if sum > ChipsPerRound {
		return [NB]int{}, ReasonOver100
	}
	rs.chips[player] = &c
	return c, ""
}

// Add moves delta chips onto (or, when negative, off) one band. Taking off
// more than is there empties the band, as in the mockup; putting on more than
// is left in hand is refused.
func (g *Game) Add(nowMs int64, player string, id int64, band, delta int) ([NB]int, string) {
	rs, reason := g.openRound(nowMs, id)
	if reason != "" {
		return [NB]int{}, reason
	}
	if band < 0 || band >= NB {
		return [NB]int{}, ReasonBadBand
	}
	if delta > ChipsPerRound || delta < -ChipsPerRound {
		return [NB]int{}, ReasonOver100
	}
	var c [NB]int
	if cur := rs.chips[player]; cur != nil {
		c = *cur
	}
	c[band] += delta
	if c[band] < 0 {
		c[band] = 0
	}
	if Sum(c) > ChipsPerRound {
		return [NB]int{}, ReasonOver100
	}
	rs.chips[player] = &c
	return c, ""
}

// Lock fixes the baseline around the lock price. Chips can no longer change.
func (g *Game) Lock(id int64, lockPrice float64) (Round, bool) {
	rs, ok := g.rounds[id]
	if !ok || rs.Status != StatusOpen {
		return Round{}, false
	}
	b := Baseline(rs.Edges, lockPrice, BaselineSD(rs.Sigma))
	rs.Status, rs.LockPrice, rs.Baseline = StatusLocked, lockPrice, &b
	return rs.Round, true
}

// Close settles a locked round at closePrice and returns a score for every
// player with chips on it, ordered by player id. The round is then dropped.
func (g *Game) Close(id int64, closePrice float64) (Round, []Score, bool) {
	rs, ok := g.rounds[id]
	if !ok || rs.Status != StatusLocked {
		return Round{}, nil, false
	}
	rs.Status, rs.ClosePrice = StatusSettled, closePrice
	rs.Landed = BandOf(rs.Edges, rs.Band, closePrice)
	scores := make([]Score, 0, len(rs.chips))
	for p, c := range rs.chips {
		placed := Sum(*c)
		if placed == 0 {
			continue // took every chip back: same as not playing
		}
		scores = append(scores, Score{
			Player: p, Chips: *c, Placed: placed,
			Points: Points(Shares(*c, *rs.Baseline), *rs.Baseline, rs.Landed),
		})
	}
	sort.Slice(scores, func(i, j int) bool { return scores[i].Player < scores[j].Player })
	delete(g.rounds, id)
	return rs.Round, scores, true
}

// Void ends a round with no scores and drops it.
func (g *Game) Void(id int64, reason string) (Round, bool) {
	rs, ok := g.rounds[id]
	if !ok {
		return Round{}, false
	}
	rs.Status, rs.VoidReason = StatusVoid, reason
	delete(g.rounds, id)
	return rs.Round, true
}

// Players lists who has chips recorded on a round (including emptied boards).
func (g *Game) Players(id int64) []string {
	rs, ok := g.rounds[id]
	if !ok {
		return nil
	}
	out := make([]string, 0, len(rs.chips))
	for p := range rs.chips {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}
