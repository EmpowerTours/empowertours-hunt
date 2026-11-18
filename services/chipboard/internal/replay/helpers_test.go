package replay_test

import (
	"encoding/json"
	"testing"

	"github.com/EmpowerTours/empowertours-hunt/services/chipboard/internal/eventlog"
)

type eventlogEvent struct{ eventlog.Event }

func (e *eventlogEvent) decode(t *testing.T, line []byte) {
	t.Helper()
	if err := json.Unmarshal(line, &e.Event); err != nil {
		t.Fatal(err)
	}
}

func (e *eventlogEvent) encode(t *testing.T) []byte {
	t.Helper()
	b, err := json.Marshal(e.Event)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
