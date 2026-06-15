package repo

import (
	"testing"
	"time"

	"github.com/younsl/o/box/kubernetes/forklift/internal/repoconfig"
)

func TestEvaluateAge(t *testing.T) {
	now := time.Date(2025, 6, 10, 0, 0, 0, 0, time.UTC)
	recent := now.Add(-24 * time.Hour)
	old := now.Add(-100 * 24 * time.Hour)

	cases := []struct {
		name string
		cfg  repoconfig.AgePolicyConfig
		pub  *time.Time
		want ageDecision
	}{
		{"disabled", repoconfig.AgePolicyConfig{Enabled: false, MinAge: repoconfig.Duration(time.Hour)}, &recent, ageAllow},
		{"no publish time", repoconfig.AgePolicyConfig{Enabled: true, MinAge: repoconfig.Duration(time.Hour)}, nil, ageAllow},
		{"too new block", repoconfig.AgePolicyConfig{Enabled: true, MinAge: repoconfig.Duration(7 * 24 * time.Hour), Action: repoconfig.ActionBlock}, &recent, ageBlock},
		{"too new warn", repoconfig.AgePolicyConfig{Enabled: true, MinAge: repoconfig.Duration(7 * 24 * time.Hour), Action: repoconfig.ActionWarn}, &recent, ageWarn},
		{"old enough", repoconfig.AgePolicyConfig{Enabled: true, MinAge: repoconfig.Duration(7 * 24 * time.Hour), Action: repoconfig.ActionBlock}, &old, ageAllow},
		{"too old block", repoconfig.AgePolicyConfig{Enabled: true, MaxAge: repoconfig.Duration(30 * 24 * time.Hour), Action: repoconfig.ActionBlock}, &old, ageBlock},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, _ := evaluateAge(c.cfg, c.pub, now)
			if got != c.want {
				t.Fatalf("evaluateAge = %v, want %v", got, c.want)
			}
		})
	}
}

func TestNegCache(t *testing.T) {
	c := newNegCache()
	base := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)
	c.now = func() time.Time { return base }

	// Zero TTL is ignored.
	c.set("a", 0)
	if c.has("a") {
		t.Fatal("zero ttl should not cache")
	}

	c.set("b", time.Minute)
	if !c.has("b") {
		t.Fatal("b should be cached")
	}
	// Advance past expiry.
	c.now = func() time.Time { return base.Add(2 * time.Minute) }
	if c.has("b") {
		t.Fatal("b should have expired")
	}

	c.now = func() time.Time { return base }
	c.set("c", time.Minute)
	c.clear("c")
	if c.has("c") {
		t.Fatal("c should be cleared")
	}
}

func TestItoa(t *testing.T) {
	cases := map[int64]string{0: "0", 5: "5", 42: "42", 1024: "1024"}
	for in, want := range cases {
		if got := itoa(in); got != want {
			t.Fatalf("itoa(%d) = %q, want %q", in, got, want)
		}
	}
}

func TestMavenHelpers(t *testing.T) {
	if mavenKind("g/a/maven-metadata.xml") != kindMetadata {
		t.Fatal("metadata not classified")
	}
	if mavenKind("g/a/1.0/a-1.0.jar") != kindArtifact {
		t.Fatal("artifact not classified")
	}
	if v := mavenVersion("com/ex/app/1.2.3/app-1.2.3.jar"); v != "1.2.3" {
		t.Fatalf("version = %q", v)
	}
	if v := mavenVersion("com/ex/app/maven-metadata.xml"); v != "" {
		t.Fatalf("metadata version = %q, want empty", v)
	}
	if joinUpstream("https://repo/", "/g/a") != "https://repo/g/a" {
		t.Fatal("joinUpstream slash handling")
	}
}
