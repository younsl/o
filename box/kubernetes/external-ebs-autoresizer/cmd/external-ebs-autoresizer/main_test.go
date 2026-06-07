package main

import "testing"

func TestNewLogger(t *testing.T) {
	cases := []struct {
		level  string
		format string
	}{
		{"debug", "json"},
		{"warn", "text"},
		{"error", "json"},
		{"info", "text"},
		{"unknown", "unknown"},
	}
	for _, tc := range cases {
		if got := newLogger(tc.level, tc.format); got == nil {
			t.Errorf("newLogger(%q, %q) = nil", tc.level, tc.format)
		}
	}
}
