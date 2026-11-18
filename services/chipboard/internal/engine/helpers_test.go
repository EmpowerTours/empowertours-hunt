package engine

import "time"

func timeParse(s string) (int64, error) {
	t, err := time.Parse(time.RFC3339Nano, s)
	return t.UnixMilli(), err
}
