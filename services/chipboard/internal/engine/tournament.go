package engine

import (
	"sort"
	"time"
	_ "time/tzdata" // the day boundary must not depend on the host having zoneinfo
)

// TournamentZone is where the tournament day turns over.
const TournamentZone = "America/Mexico_City"

var mxZone = func() *time.Location {
	loc, err := time.LoadLocation(TournamentZone)
	if err != nil {
		panic(err)
	}
	return loc
}()

// DayOf returns the tournament day (YYYY-MM-DD in Mexico City) holding ms.
func DayOf(ms int64) string { return time.UnixMilli(ms).In(mxZone).Format("2006-01-02") }

// Standing is one player's line for one day.
type Standing struct {
	Player    string `json:"player"`
	Points    int    `json:"points"`
	Rounds    int    `json:"rounds"`
	Qualified bool   `json:"qualified"`
	Rank      int    `json:"rank"`
}

type tally struct{ points, rounds int }

// Tournament sums points per player per Mexico City day. A round counts for
// the day it closes in. Not safe for concurrent use.
type Tournament struct {
	QualifyRounds int
	days          map[string]map[string]*tally
}

func NewTournament(qualifyRounds int) *Tournament {
	return &Tournament{QualifyRounds: qualifyRounds, days: map[string]map[string]*tally{}}
}

// Record adds one settled round's points for a player on the given day.
func (t *Tournament) Record(day, player string, points int) {
	d := t.days[day]
	if d == nil {
		d = map[string]*tally{}
		t.days[day] = d
	}
	e := d[player]
	if e == nil {
		e = &tally{}
		d[player] = e
	}
	e.points += points
	e.rounds++
}

// Restore sets a player's totals for a day (standings rebuilt from the event log).
func (t *Tournament) Restore(day, player string, points, rounds int) {
	d := t.days[day]
	if d == nil {
		d = map[string]*tally{}
		t.days[day] = d
	}
	d[player] = &tally{points: points, rounds: rounds}
}

// Leaderboard returns the day's standings, best first. Ties share nothing:
// more points first, then the player id, so the order is always the same.
func (t *Tournament) Leaderboard(day string) []Standing {
	d := t.days[day]
	out := make([]Standing, 0, len(d))
	for p, e := range d {
		out = append(out, Standing{Player: p, Points: e.points, Rounds: e.rounds, Qualified: e.rounds >= t.QualifyRounds})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Points != out[j].Points {
			return out[i].Points > out[j].Points
		}
		return out[i].Player < out[j].Player
	})
	for i := range out {
		out[i].Rank = i + 1
	}
	return out
}

// Prune forgets every day before keepFrom (YYYY-MM-DD).
func (t *Tournament) Prune(keepFrom string) {
	for day := range t.days {
		if day < keepFrom {
			delete(t.days, day)
		}
	}
}
