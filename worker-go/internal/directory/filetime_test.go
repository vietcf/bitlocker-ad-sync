package directory

import (
	"testing"
	"time"
)

func TestParseFileTime(t *testing.T) {
	// 2026-10-01T08:00:00Z as AD ticks: (unix + 11644473600) * 10^7
	want := time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC)
	ticks := (want.Unix() + 11644473600) * 10_000_000
	got := ParseFileTime(itoa(ticks))
	if got == nil || !got.Equal(want) {
		t.Fatalf("ParseFileTime = %v, want %v", got, want)
	}
	for _, v := range []string{"", "0", "9223372036854775807", "abc", "-5"} {
		if r := ParseFileTime(v); r != nil {
			t.Errorf("ParseFileTime(%q) = %v, want nil", v, r)
		}
	}
}

func itoa(n int64) string {
	b := [20]byte{}
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
