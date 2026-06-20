package vuln

import "testing"

func TestCVSSBaseScore(t *testing.T) {
	cases := []struct {
		vector string
		want   float64
		ok     bool
	}{
		// AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H -> 9.8 critical.
		{"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", 9.8, true},
		// Low-impact ReDoS (only availability, low) -> 5.3.
		{"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L", 5.3, true},
		// Scope changed raises the score.
		{"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H", 10.0, true},
		// Not a CVSS v3 vector.
		{"CVSS:2.0/AV:N", 0, false},
		{"not-a-vector", 0, false},
		// Missing metrics.
		{"CVSS:3.1/AV:N/AC:L", 0, false},
	}
	for _, c := range cases {
		got, ok := cvssBaseScore(c.vector)
		if ok != c.ok || (ok && got != c.want) {
			t.Errorf("cvssBaseScore(%q) = (%v, %v), want (%v, %v)", c.vector, got, ok, c.want, c.ok)
		}
	}
}

func TestScoreOf(t *testing.T) {
	// CVSS vector -> computed base score.
	v := osvVuln{Severity: []struct {
		Type  string `json:"type"`
		Score string `json:"score"`
	}{{Type: "CVSS_V3", Score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"}}}
	if got := scoreOf(v); got != "9.8" {
		t.Fatalf("scoreOf(vector) = %q, want 9.8", got)
	}
	// No severity entries -> empty.
	if got := scoreOf(osvVuln{}); got != "" {
		t.Fatalf("scoreOf(empty) = %q, want empty", got)
	}
}
