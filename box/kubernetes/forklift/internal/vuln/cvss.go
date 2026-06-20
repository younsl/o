package vuln

import (
	"math"
	"strings"
)

// CVSS v3.x base metric weights (per the v3.1 specification).
var (
	cvssAV  = map[string]float64{"N": 0.85, "A": 0.62, "L": 0.55, "P": 0.2}
	cvssAC  = map[string]float64{"L": 0.77, "H": 0.44}
	cvssUI  = map[string]float64{"N": 0.85, "R": 0.62}
	cvssCIA = map[string]float64{"H": 0.56, "L": 0.22, "N": 0}
)

// cvssPR returns the Privileges Required weight, which depends on whether the
// scope changed.
func cvssPR(v string, scopeChanged bool) (float64, bool) {
	switch v {
	case "N":
		return 0.85, true
	case "L":
		if scopeChanged {
			return 0.68, true
		}
		return 0.62, true
	case "H":
		if scopeChanged {
			return 0.5, true
		}
		return 0.27, true
	}
	return 0, false
}

// cvssBaseScore computes the CVSS v3.x base score from a vector string such as
// "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H". It returns false when the
// string is not a parseable CVSS v3 base vector.
func cvssBaseScore(vector string) (float64, bool) {
	if !strings.HasPrefix(vector, "CVSS:3") {
		return 0, false
	}
	m := map[string]string{}
	for _, part := range strings.Split(vector, "/") {
		if k, val, ok := strings.Cut(part, ":"); ok {
			m[k] = val
		}
	}
	scopeChanged := m["S"] == "C"
	av, ok1 := cvssAV[m["AV"]]
	ac, ok2 := cvssAC[m["AC"]]
	pr, ok3 := cvssPR(m["PR"], scopeChanged)
	ui, ok4 := cvssUI[m["UI"]]
	c, ok5 := cvssCIA[m["C"]]
	i, ok6 := cvssCIA[m["I"]]
	a, ok7 := cvssCIA[m["A"]]
	if !(ok1 && ok2 && ok3 && ok4 && ok5 && ok6 && ok7) {
		return 0, false
	}
	iss := 1 - (1-c)*(1-i)*(1-a)
	var impact float64
	if scopeChanged {
		impact = 7.52*(iss-0.029) - 3.25*math.Pow(iss-0.02, 15)
	} else {
		impact = 6.42 * iss
	}
	if impact <= 0 {
		return 0, true
	}
	expl := 8.22 * av * ac * pr * ui
	if scopeChanged {
		return cvssRoundup(math.Min(1.08*(impact+expl), 10)), true
	}
	return cvssRoundup(math.Min(impact+expl, 10)), true
}

// cvssRoundup rounds up to the nearest 0.1, as defined by the CVSS v3.1 spec.
func cvssRoundup(x float64) float64 {
	i := int(math.Round(x * 100000))
	if i%10000 == 0 {
		return float64(i) / 100000.0
	}
	return (math.Floor(float64(i)/10000.0) + 1) / 10.0
}
