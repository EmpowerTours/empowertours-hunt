// Package eventlog is the append-only record of everything the judge decided:
// one JSON object per line, one file per UTC day. cmd/replay rebuilds every
// score from it.
package eventlog

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/EmpowerTours/empowertours-hunt/services/chipboard/internal/engine"
	"github.com/EmpowerTours/empowertours-hunt/services/chipboard/internal/price"
)

// Event kinds.
const (
	EvBoot   = "boot"   // the server started: rule and thresholds in force
	EvOpen   = "open"   // a round opened: open price, sigma, band, centre
	EvLock   = "lock"   // a round locked: lock price, baseline
	EvPlace  = "place"  // an ACCEPTED placement: player, round, chips after
	EvClose  = "close"  // a round closed: all four candidates, chosen rule, landed band or void + reason
	EvVoid   = "void"   // a round was voided before its close (at open or at lock)
	EvScores = "scores" // every player's score for a settled round
)

// Event is one line of the log. Fields that do not apply to a kind are left out.
type Event struct {
	Ev    string `json:"ev"`
	T     int64  `json:"t"` // server time, ms UTC epoch
	Round int64  `json:"round,omitempty"`

	Rule   string         `json:"rule,omitempty"`   // the configured settlement rule
	Config map[string]any `json:"config,omitempty"` // boot: thresholds (never secrets)

	OpenPrice *float64 `json:"openPrice,omitempty"`
	Sigma     *float64 `json:"sigma,omitempty"`
	SigmaN    int      `json:"sigmaN,omitempty"` // 1-second differences behind sigma
	Band      *float64 `json:"band,omitempty"`
	Centre    *float64 `json:"centre,omitempty"`

	LockPrice *float64            `json:"lockPrice,omitempty"`
	Baseline  *[engine.NB]float64 `json:"baseline,omitempty"`

	Player string          `json:"player,omitempty"`
	Chips  *[engine.NB]int `json:"chips,omitempty"`

	Px     *price.Snapshot `json:"px,omitempty"`     // all four candidate prices at this instant
	Price  *float64        `json:"price,omitempty"`  // the chosen rule's price (absent when void)
	Landed *int            `json:"landed,omitempty"` // band holding the closing price
	Void   string          `json:"void,omitempty"`   // void reason
	Phase  string          `json:"phase,omitempty"`  // which step voided the round: open | lock | close

	Day    string         `json:"day,omitempty"` // tournament day (Mexico City) the scores count for
	Scores []engine.Score `json:"scores,omitempty"`
}

// Writer appends events. Safe for concurrent use.
//
// Append only queues the event; one goroutine marshals and writes, in order.
// The caller (the game, holding its lock) therefore never waits on the disk.
// If the queue ever fills because the disk has stalled, Append blocks: the
// judge slows down rather than decide things it cannot record.
type Writer struct {
	dir  string
	ch   chan item
	done chan struct{}

	mu     sync.Mutex // guards closed and err
	closed bool
	err    error // first write error; every later Append and Flush returns it

	// owned by the writing goroutine
	day string
	f   *os.File
	w   *bufio.Writer
}

type item struct {
	ev   Event
	sync chan error // non-nil: flush, then report (a barrier, not an event)
	stop bool       // with sync: also fsync and close the file
}

const queueSize = 16384

// Open creates dir if needed and returns a writer into it.
func Open(dir string) (*Writer, error) {
	if dir == "" {
		return nil, errors.New("eventlog: empty directory")
	}
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, err
	}
	// Fail now, not at the first event, if the directory cannot be written.
	probe, err := os.CreateTemp(dir, ".probe-*")
	if err != nil {
		return nil, err
	}
	probe.Close()
	os.Remove(probe.Name())
	w := &Writer{dir: dir, ch: make(chan item, queueSize), done: make(chan struct{})}
	go w.run()
	return w, nil
}

// FileFor is the log file for the UTC day holding ms.
func FileFor(dir string, ms int64) string {
	return filepath.Join(dir, "events-"+time.UnixMilli(ms).UTC().Format("2006-01-02")+".jsonl")
}

// ErrClosed is returned by Append after Close.
var ErrClosed = errors.New("eventlog: closed")

// Append queues one event for the file of its UTC day. Events are written in
// the order they are appended. The event (and what it points to) must not be
// changed afterwards. It returns the first write error seen so far, if any.
func (w *Writer) Append(ev Event) error {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return ErrClosed
	}
	err := w.err
	w.mu.Unlock()
	if err != nil {
		return err
	}
	w.ch <- item{ev: ev}
	return nil
}

func (w *Writer) barrier(stop bool) error {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return nil
	}
	if stop {
		w.closed = true
	}
	w.mu.Unlock()
	c := make(chan error, 1)
	w.ch <- item{sync: c, stop: stop}
	return <-c
}

// Flush returns once everything appended so far is in the file.
func (w *Writer) Flush() error { return w.barrier(false) }

// Close writes what is queued, syncs and closes the file. Later Appends fail.
func (w *Writer) Close() error {
	err := w.barrier(true)
	<-w.done
	return err
}

func (w *Writer) fail(err error) {
	w.mu.Lock()
	if w.err == nil {
		w.err = err
	}
	w.mu.Unlock()
}

func (w *Writer) firstErr() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.err
}

func (w *Writer) run() {
	defer close(w.done)
	for it := range w.ch {
		if it.sync != nil {
			if w.w != nil {
				if err := w.w.Flush(); err != nil {
					w.fail(err)
				}
			}
			if it.stop {
				if err := w.closeFile(); err != nil {
					w.fail(err)
				}
			}
			it.sync <- w.firstErr()
			if it.stop {
				return
			}
			continue
		}
		if err := w.write(it.ev); err != nil {
			w.fail(err)
			continue
		}
		// Nothing else waiting: put it on disk now, so the file is never more
		// than a moment behind the game.
		if len(w.ch) == 0 {
			if err := w.w.Flush(); err != nil {
				w.fail(err)
			}
		}
	}
}

func (w *Writer) write(ev Event) error {
	line, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	day := time.UnixMilli(ev.T).UTC().Format("2006-01-02")
	if day != w.day {
		if err := w.closeFile(); err != nil {
			return err
		}
		f, err := os.OpenFile(FileFor(w.dir, ev.T), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o640)
		if err != nil {
			return err
		}
		w.f, w.w, w.day = f, bufio.NewWriterSize(f, 64<<10), day
	}
	if _, err := w.w.Write(line); err != nil {
		return err
	}
	return w.w.WriteByte('\n')
}

func (w *Writer) closeFile() error {
	if w.f == nil {
		return nil
	}
	err := w.w.Flush()
	if e := w.f.Sync(); err == nil {
		err = e
	}
	if e := w.f.Close(); err == nil {
		err = e
	}
	w.f, w.w, w.day = nil, nil, ""
	return err
}

// Read calls fn for every event in a log file, in order. A last line cut off
// by a crash is skipped and reported as torn; a bad line anywhere else is an error.
func Read(path string, fn func(Event) error) (torn bool, err error) {
	f, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer f.Close()
	r := bufio.NewReaderSize(f, 1<<20)
	for n := 1; ; n++ {
		line, rerr := r.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			var ev Event
			if jerr := json.Unmarshal(line, &ev); jerr != nil {
				if rerr == io.EOF {
					return true, nil
				}
				return false, fmt.Errorf("%s line %d: %w", path, n, jerr)
			}
			if err := fn(ev); err != nil {
				return false, err
			}
		}
		if rerr == io.EOF {
			return false, nil
		}
		if rerr != nil {
			return false, rerr
		}
	}
}

// DayTotals sums the logged scores of one tournament day from the given files
// (missing files are skipped). It is how standings survive a restart.
func DayTotals(day string, paths ...string) (points map[string]int, rounds map[string]int, err error) {
	points, rounds = map[string]int{}, map[string]int{}
	for _, p := range paths {
		_, err := Read(p, func(ev Event) error {
			if ev.Ev == EvScores && ev.Day == day {
				for _, s := range ev.Scores {
					points[s.Player] += s.Points
					rounds[s.Player]++
				}
			}
			return nil
		})
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, nil, err
		}
	}
	return points, rounds, nil
}
