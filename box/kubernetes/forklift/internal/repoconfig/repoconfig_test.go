package repoconfig

import (
	"testing"
	"time"
)

func TestParseDuration(t *testing.T) {
	cases := map[string]time.Duration{
		"":     0,
		"0":    0,
		"30m":  30 * time.Minute,
		"72h":  72 * time.Hour,
		"3d":   3 * 24 * time.Hour,
		"2w":   2 * 7 * 24 * time.Hour,
		"1.5d": 36 * time.Hour,
	}
	for in, want := range cases {
		got, err := ParseDuration(in)
		if err != nil {
			t.Fatalf("ParseDuration(%q): %v", in, err)
		}
		if got != want {
			t.Fatalf("ParseDuration(%q) = %v, want %v", in, got, want)
		}
	}
	if _, err := ParseDuration("nonsense"); err == nil {
		t.Fatal("expected error for invalid duration")
	}
}

func TestParseAppliesDefaults(t *testing.T) {
	c, err := Parse("")
	if err != nil {
		t.Fatal(err)
	}
	if !c.Cache.Enabled {
		t.Fatal("cache should default enabled")
	}
	if c.Cache.MetadataTTL.D() != 15*time.Minute {
		t.Fatalf("metadata ttl default = %v", c.Cache.MetadataTTL.D())
	}
	if c.AgePolicy.Action != ActionBlock {
		t.Fatalf("age policy action default = %q", c.AgePolicy.Action)
	}
}

func TestParseRoundTrip(t *testing.T) {
	in := `{"cache":{"enabled":true,"artifact_ttl":"1h","max_size_bytes":1048576,"eviction":"lru"},"age_policy":{"enabled":true,"min_age":"3d","action":"block"}}`
	c, err := Parse(in)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if c.Cache.MaxSizeBytes != 1048576 {
		t.Fatalf("max size = %d", c.Cache.MaxSizeBytes)
	}
	if c.AgePolicy.MinAge.D() != 3*24*time.Hour {
		t.Fatalf("min age = %v", c.AgePolicy.MinAge.D())
	}
	out, err := c.JSON()
	if err != nil {
		t.Fatal(err)
	}
	c2, err := Parse(out)
	if err != nil {
		t.Fatalf("reparse: %v", err)
	}
	if c2.AgePolicy.MinAge.D() != c.AgePolicy.MinAge.D() {
		t.Fatal("round trip lost min_age")
	}
}

func TestValidate(t *testing.T) {
	bad := Config{Cache: CacheConfig{Eviction: "fifo"}}
	if err := bad.Validate(); err == nil {
		t.Fatal("expected eviction validation error")
	}
	bad = Config{Cache: CacheConfig{MaxSizeBytes: -1}}
	if err := bad.Validate(); err == nil {
		t.Fatal("expected negative size error")
	}
	bad = Config{AgePolicy: AgePolicyConfig{Action: "drop"}}
	if err := bad.Validate(); err == nil {
		t.Fatal("expected action validation error")
	}
	bad = Config{Approval: ApprovalConfig{Mode: "quarantine"}}
	if err := bad.Validate(); err == nil {
		t.Fatal("expected approval mode validation error")
	}
	bad = Config{Approval: ApprovalConfig{AutoApprove: []string{"[invalid"}}}
	if err := bad.Validate(); err == nil {
		t.Fatal("expected auto_approve pattern validation error")
	}
	bad = Config{Retention: RetentionConfig{IdleTTL: -1}}
	if err := bad.Validate(); err == nil {
		t.Fatal("expected negative idle_ttl error")
	}
}

func TestRetentionConfigRoundTrip(t *testing.T) {
	c, err := Parse(`{"retention":{"idle_ttl":"7d"}}`)
	if err != nil {
		t.Fatal(err)
	}
	if c.Retention.IdleTTL.D() != 7*24*time.Hour {
		t.Fatalf("idle_ttl = %v, want 168h", c.Retention.IdleTTL.D())
	}
	raw, err := c.JSON()
	if err != nil {
		t.Fatal(err)
	}
	again, err := Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if again.Retention.IdleTTL != c.Retention.IdleTTL {
		t.Fatalf("round-trip idle_ttl = %v, want %v", again.Retention.IdleTTL, c.Retention.IdleTTL)
	}
}

func TestApprovalConfig(t *testing.T) {
	in := `{"approval":{"enabled":true,"mode":"audit","auto_approve":["@company/*","left-*"]}}`
	c, err := Parse(in)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !c.Approval.Enabled || c.Approval.EffectiveMode() != ModeAudit {
		t.Fatalf("approval = %+v", c.Approval)
	}
	if len(c.Approval.AutoApprove) != 2 {
		t.Fatalf("auto_approve = %v", c.Approval.AutoApprove)
	}
	out, err := c.JSON()
	if err != nil {
		t.Fatal(err)
	}
	c2, err := Parse(out)
	if err != nil {
		t.Fatalf("reparse: %v", err)
	}
	if c2.Approval.Mode != ModeAudit || len(c2.Approval.AutoApprove) != 2 {
		t.Fatal("round trip lost approval config")
	}
	// Defaults: disabled, effective mode enforce.
	d, err := Parse("")
	if err != nil {
		t.Fatal(err)
	}
	if d.Approval.Enabled || d.Approval.EffectiveMode() != ModeEnforce {
		t.Fatalf("approval default = %+v", d.Approval)
	}
}
