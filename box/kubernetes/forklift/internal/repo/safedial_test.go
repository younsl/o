package repo

import (
	"net/url"
	"testing"
)

func TestPublicOnlyDialControl(t *testing.T) {
	blocked := []string{
		"127.0.0.1:80", "10.0.0.5:443", "172.16.1.1:80", "192.168.1.1:8080",
		"169.254.169.254:80", "0.0.0.0:80", "[::1]:80", "[fd00::1]:443",
		"[fe80::1]:80", "[::ffff:127.0.0.1]:80",
	}
	for _, addr := range blocked {
		if err := publicOnlyDialControl("tcp", addr, nil); err == nil {
			t.Errorf("dial to %s allowed, want blocked", addr)
		}
	}
	allowed := []string{"93.184.216.34:443", "[2606:2800:220:1:248:1893:25c8:1946]:443"}
	for _, addr := range allowed {
		if err := publicOnlyDialControl("tcp", addr, nil); err != nil {
			t.Errorf("dial to %s blocked: %v", addr, err)
		}
	}
}

func TestSameHost(t *testing.T) {
	mustParse := func(s string) *url.URL {
		u, err := url.Parse(s)
		if err != nil {
			t.Fatalf("parse %s: %v", s, err)
		}
		return u
	}
	if !sameHost(mustParse("https://PyPI.org/packages/x.whl"), "https://pypi.org/simple") {
		t.Error("case-insensitive same host rejected")
	}
	if sameHost(mustParse("https://files.pythonhosted.org/x.whl"), "https://pypi.org/simple") {
		t.Error("different host accepted as same")
	}
	if sameHost(mustParse("https://pypi.org/x.whl"), "://bad") {
		t.Error("unparseable upstream accepted")
	}
}
