package tunnels

import "testing"

func TestClampJournalLines(t *testing.T) {
	cases := map[int]int{
		0:     200,
		-5:    200,
		1:     1,
		200:   200,
		2000:  2000,
		2001:  2000,
		50000: 2000,
	}
	for in, want := range cases {
		if got := clampJournalLines(in); got != want {
			t.Errorf("clampJournalLines(%d) = %d, want %d", in, got, want)
		}
	}
}
