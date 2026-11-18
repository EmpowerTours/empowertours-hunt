// replay rebuilds every round's scores from event logs and checks them against
// the logged ones.
//
//	replay [-top N] events-2026-11-17.jsonl [events-2026-11-18.jsonl ...]
//	replay -dir ./eventlog          (every events-*.jsonl in the directory, oldest first)
//
// Exit status 0: every rebuilt value matches. 1: a mismatch. 2: could not read.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"github.com/EmpowerTours/empowertours-hunt/services/chipboard/internal/replay"
)

func main() {
	dir := flag.String("dir", "", "replay every events-*.jsonl in this directory")
	top := flag.Int("top", 5, "standings to print per day")
	flag.Parse()
	paths := flag.Args()
	if *dir != "" {
		m, err := filepath.Glob(filepath.Join(*dir, "events-*.jsonl"))
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		sort.Strings(m)
		paths = append(paths, m...)
	}
	if len(paths) == 0 {
		fmt.Fprintln(os.Stderr, "usage: replay [-top N] [-dir DIR] [file.jsonl ...]")
		os.Exit(2)
	}
	rep, err := replay.Run(paths...)
	if err != nil {
		fmt.Fprintln(os.Stderr, "replay:", err)
		os.Exit(2)
	}
	fmt.Printf("files %d · events %d · boots %d\n", rep.Files, rep.Events, rep.Boots)
	fmt.Printf("rounds: opened %d · settled %d · voided %d · never closed %d · opened before the log starts %d\n", rep.Opened, rep.Settled, rep.Voided, rep.Incomplete, rep.Unseen)
	fmt.Printf("placements re-applied %d · scores recomputed %d · torn last lines %d\n", rep.Placements, rep.Scores, rep.TornLines)
	for _, day := range rep.Days() {
		fmt.Printf("day %s (Mexico City): %d players\n", day, len(rep.Totals[day]))
		for _, s := range rep.Top(day, *top) {
			fmt.Printf("  %3d. %-24s %+6d pts  %3d rounds\n", s.Rank, s.Player, s.Points, s.Rounds)
		}
	}
	if !rep.OK() {
		fmt.Printf("MISMATCH: %d problem(s)\n", len(rep.Mismatches))
		for _, m := range rep.Mismatches {
			fmt.Println("  " + m)
		}
		os.Exit(1)
	}
	fmt.Println("OK: every rebuilt band, baseline, landed band and score matches the log")
}
