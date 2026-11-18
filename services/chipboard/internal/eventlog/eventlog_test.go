package eventlog

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/EmpowerTours/empowertours-hunt/services/chipboard/internal/engine"
)

func TestOneFilePerUTCDayAndAppendOnly(t *testing.T) {
	dir := t.TempDir()
	w, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	last := time.Date(2026, 11, 17, 23, 59, 59, 999e6, time.UTC).UnixMilli()
	chips := [engine.NB]int{6: 100}
	px := 100000.5
	for i, ev := range []Event{
		{Ev: EvPlace, T: last, Round: 7, Player: "ana", Chips: &chips},
		{Ev: EvClose, T: last + 1, Round: 7, Price: &px},
		{Ev: EvScores, T: last + 2, Round: 7, Day: "2026-11-17", Scores: []engine.Score{{Player: "ana", Chips: chips, Placed: 100, Points: 76}}},
	} {
		if err := w.Append(ev); err != nil {
			t.Fatalf("append %d: %v", i, err)
		}
	}
	w.Close()
	// Reopening appends; it never truncates.
	w2, _ := Open(dir)
	w2.Append(Event{Ev: EvScores, T: last + 3, Round: 8, Day: "2026-11-17", Scores: []engine.Score{{Player: "ana", Points: -24, Placed: 10}, {Player: "beto", Points: 5, Placed: 5}}})
	w2.Close()

	day1, day2 := filepath.Join(dir, "events-2026-11-17.jsonl"), filepath.Join(dir, "events-2026-11-18.jsonl")
	if FileFor(dir, last) != day1 || FileFor(dir, last+1) != day2 {
		t.Fatal("file names")
	}
	var got []Event
	for _, f := range []string{day1, day2} {
		if torn, err := Read(f, func(e Event) error { got = append(got, e); return nil }); err != nil || torn {
			t.Fatalf("%s: torn %v err %v", f, torn, err)
		}
	}
	if len(got) != 4 || got[0].Player != "ana" || *got[0].Chips != chips || *got[1].Price != px || got[2].Scores[0].Points != 76 {
		t.Fatalf("round trip: %+v", got)
	}
	st, _ := os.Stat(day1)
	if st.Mode().Perm()&0o007 != 0 {
		t.Errorf("log file is world-accessible: %v", st.Mode())
	}

	// Standings for a tournament day are summed across both UTC files; a missing file is fine.
	pts, rounds, err := DayTotals("2026-11-17", filepath.Join(dir, "events-2026-11-16.jsonl"), day1, day2)
	if err != nil || pts["ana"] != 52 || rounds["ana"] != 2 || pts["beto"] != 5 || rounds["beto"] != 1 {
		t.Fatalf("totals %v %v %v", pts, rounds, err)
	}
	if pts, _, _ := DayTotals("2026-11-18", day1, day2); len(pts) != 0 {
		t.Fatal("another day picked up these scores")
	}

	// A bad line in the middle is an error, not something to skip quietly.
	bad := filepath.Join(dir, "bad.jsonl")
	os.WriteFile(bad, []byte("{\"ev\":\"boot\",\"t\":1}\n{oops\n{\"ev\":\"boot\",\"t\":2}\n"), 0o600)
	if _, err := Read(bad, func(Event) error { return nil }); err == nil {
		t.Fatal("corrupt middle line accepted")
	}
}

// A log that cannot be written reports it: the flush fails and so does every
// later append, which is what makes the server stop.
func TestWriteErrorIsSticky(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	dir := t.TempDir()
	w, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	os.Chmod(dir, 0o500) // the day's file can no longer be created
	defer os.Chmod(dir, 0o700)
	if err := w.Append(Event{Ev: EvBoot, T: 1}); err != nil {
		t.Fatalf("append only queues: %v", err)
	}
	if err := w.Flush(); err == nil {
		t.Fatal("flush hid the write error")
	}
	if err := w.Append(Event{Ev: EvBoot, T: 2}); err == nil {
		t.Fatal("append after a failed write returned no error")
	}
	w.Close()
	if err := w.Append(Event{Ev: EvBoot, T: 3}); err != ErrClosed {
		t.Fatalf("append after close: %v", err)
	}
	if _, err := Open(filepath.Join(dir, "sub")); err == nil {
		t.Fatal("opened a log in a directory that cannot be written")
	}
}
