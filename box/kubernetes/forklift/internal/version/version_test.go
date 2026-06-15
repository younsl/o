package version

import (
	"strings"
	"testing"
)

func TestString(t *testing.T) {
	s := String()
	if !strings.Contains(s, Version) || !strings.Contains(s, Commit) {
		t.Fatalf("String() = %q, want it to contain version and commit", s)
	}
}
