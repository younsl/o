package policy

import (
	"testing"

	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/config"
)

// baseCfg returns a config carrying the global defaults, with no policies. Set
// its Policies field per test.
func baseCfg() *config.Config {
	return &config.Config{
		UsageThresholdPercent: 80,
		GrowMode:              config.GrowModePercent,
		GrowPercent:           10,
		GrowAmountGiB:         10,
		MaxVolumeSizeGiB:      1000,
	}
}

func ptrInt(n int) *int       { return &n }
func ptrStr(s string) *string { return &s }

func TestResolveNoPolicies(t *testing.T) {
	r, err := New(baseCfg())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	eff := r.Resolve("web-1", map[string]string{"Name": "web-1"})
	if eff.Policy != DefaultPolicyName {
		t.Errorf("Policy = %q, want %q", eff.Policy, DefaultPolicyName)
	}
	if eff.UsageThresholdPercent != 80 || eff.GrowPercent != 10 {
		t.Errorf("eff = %+v, want defaults", eff)
	}
}

func TestResolveTagMatch(t *testing.T) {
	cfg := baseCfg()
	cfg.Policies = []config.ResizePolicy{{
		Name:             "db",
		InstanceSelector: config.InstanceSelector{Tags: map[string]string{"Role": "database"}},
		Resize: config.ResizeSpec{
			UsageThresholdPercent: ptrInt(70),
			GrowMode:              ptrStr(config.GrowModeAbsolute),
			GrowAmount:            ptrStr("50GiB"),
		},
	}}
	r, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	eff := r.Resolve("prod-db-1", map[string]string{"Role": "database", "Name": "prod-db-1"})
	if eff.Policy != "db" {
		t.Fatalf("Policy = %q, want db", eff.Policy)
	}
	if eff.UsageThresholdPercent != 70 {
		t.Errorf("UsageThresholdPercent = %d, want 70", eff.UsageThresholdPercent)
	}
	if eff.GrowMode != config.GrowModeAbsolute || eff.GrowAmountGiB != 50 {
		t.Errorf("grow = %s/%d, want absolute/50", eff.GrowMode, eff.GrowAmountGiB)
	}
	// Unset fields inherit defaults.
	if eff.MaxVolumeSizeGiB != 1000 {
		t.Errorf("MaxVolumeSizeGiB = %d, want 1000 (inherited)", eff.MaxVolumeSizeGiB)
	}

	// No matching tag -> defaults.
	if eff := r.Resolve("web-1", map[string]string{"Role": "web"}); eff.Policy != DefaultPolicyName {
		t.Errorf("non-matching instance got policy %q, want default", eff.Policy)
	}
}

func TestResolveNameRegex(t *testing.T) {
	cfg := baseCfg()
	cfg.Policies = []config.ResizePolicy{{
		Name:             "batch",
		InstanceSelector: config.InstanceSelector{NameRegex: "^batch-.*"},
		Resize:           config.ResizeSpec{GrowPercent: ptrInt(30)},
	}}
	r, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if eff := r.Resolve("batch-worker-1", nil); eff.Policy != "batch" || eff.GrowPercent != 30 {
		t.Errorf("batch match eff = %+v, want batch/30", eff)
	}
	if eff := r.Resolve("web-1", nil); eff.Policy != DefaultPolicyName {
		t.Errorf("web-1 got %q, want default", eff.Policy)
	}
}

func TestResolveTagAndRegexAND(t *testing.T) {
	cfg := baseCfg()
	cfg.Policies = []config.ResizePolicy{{
		Name: "prod-db",
		InstanceSelector: config.InstanceSelector{
			Tags:      map[string]string{"Env": "prod"},
			NameRegex: "^db-",
		},
		Resize: config.ResizeSpec{UsageThresholdPercent: ptrInt(60)},
	}}
	r, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	// Both match.
	if eff := r.Resolve("db-1", map[string]string{"Env": "prod", "Name": "db-1"}); eff.Policy != "prod-db" {
		t.Errorf("both-match got %q, want prod-db", eff.Policy)
	}
	// Tag matches, name does not.
	if eff := r.Resolve("web-1", map[string]string{"Env": "prod"}); eff.Policy != DefaultPolicyName {
		t.Errorf("regex-miss got %q, want default", eff.Policy)
	}
	// Name matches, tag does not.
	if eff := r.Resolve("db-1", map[string]string{"Env": "staging"}); eff.Policy != DefaultPolicyName {
		t.Errorf("tag-miss got %q, want default", eff.Policy)
	}
}

func TestResolveWeightWins(t *testing.T) {
	cfg := baseCfg()
	cfg.Policies = []config.ResizePolicy{
		{
			Name:             "broad",
			Weight:           1,
			InstanceSelector: config.InstanceSelector{NameRegex: ".*"},
			Resize:           config.ResizeSpec{UsageThresholdPercent: ptrInt(90)},
		},
		{
			Name:             "specific",
			Weight:           10,
			InstanceSelector: config.InstanceSelector{Tags: map[string]string{"Role": "db"}},
			Resize:           config.ResizeSpec{UsageThresholdPercent: ptrInt(60)},
		},
	}
	r, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	// Both match; higher weight (specific) wins.
	eff := r.Resolve("db-1", map[string]string{"Role": "db", "Name": "db-1"})
	if eff.Policy != "specific" || eff.UsageThresholdPercent != 60 {
		t.Errorf("eff = %+v, want specific/60", eff)
	}
	// Only broad matches.
	if eff := r.Resolve("web-1", map[string]string{"Role": "web"}); eff.Policy != "broad" {
		t.Errorf("web-1 got %q, want broad", eff.Policy)
	}
}

func TestResolveWeightTieFileOrder(t *testing.T) {
	cfg := baseCfg()
	cfg.Policies = []config.ResizePolicy{
		{Name: "first", Weight: 5, InstanceSelector: config.InstanceSelector{NameRegex: ".*"}},
		{Name: "second", Weight: 5, InstanceSelector: config.InstanceSelector{NameRegex: ".*"}},
	}
	r, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if eff := r.Resolve("x", nil); eff.Policy != "first" {
		t.Errorf("tie got %q, want first (file order)", eff.Policy)
	}
}

func TestNewValidationErrors(t *testing.T) {
	cases := map[string][]config.ResizePolicy{
		"empty name": {{
			InstanceSelector: config.InstanceSelector{NameRegex: ".*"},
		}},
		"reserved name": {{
			Name: DefaultPolicyName, InstanceSelector: config.InstanceSelector{NameRegex: ".*"},
		}},
		"empty selector": {{
			Name: "x",
		}},
		"bad regex": {{
			Name: "x", InstanceSelector: config.InstanceSelector{NameRegex: "[unclosed"},
		}},
		"bad grow mode": {{
			Name: "x", InstanceSelector: config.InstanceSelector{NameRegex: ".*"}, Resize: config.ResizeSpec{GrowMode: ptrStr("linear")},
		}},
		"threshold out of range": {{
			Name: "x", InstanceSelector: config.InstanceSelector{NameRegex: ".*"}, Resize: config.ResizeSpec{UsageThresholdPercent: ptrInt(150)},
		}},
		"grow percent zero": {{
			Name: "x", InstanceSelector: config.InstanceSelector{NameRegex: ".*"}, Resize: config.ResizeSpec{GrowPercent: ptrInt(0)},
		}},
		"bad grow amount": {{
			Name: "x", InstanceSelector: config.InstanceSelector{NameRegex: ".*"}, Resize: config.ResizeSpec{GrowAmount: ptrStr("10TB")},
		}},
		"max size zero": {{
			Name: "x", InstanceSelector: config.InstanceSelector{NameRegex: ".*"}, Resize: config.ResizeSpec{MaxVolumeSizeGiB: ptrInt(0)},
		}},
		"duplicate name": {
			{Name: "dup", InstanceSelector: config.InstanceSelector{NameRegex: ".*"}},
			{Name: "dup", InstanceSelector: config.InstanceSelector{NameRegex: ".*"}},
		},
		"empty tag value": {{
			Name: "x", InstanceSelector: config.InstanceSelector{Tags: map[string]string{"Role": ""}},
		}},
	}
	for name, policies := range cases {
		t.Run(name, func(t *testing.T) {
			cfg := baseCfg()
			cfg.Policies = policies
			if _, err := New(cfg); err == nil {
				t.Errorf("New(%s) = nil error, want validation error", name)
			}
		})
	}
}

func TestCompileAbsoluteInheritsDefaultAmount(t *testing.T) {
	// Switching to absolute mode without a growAmount inherits the default
	// GrowAmountGiB, so it must validate.
	cfg := baseCfg()
	cfg.Policies = []config.ResizePolicy{{
		Name: "abs", InstanceSelector: config.InstanceSelector{NameRegex: ".*"}, Resize: config.ResizeSpec{GrowMode: ptrStr(config.GrowModeAbsolute)},
	}}
	r, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	eff := r.Resolve("x", nil)
	if eff.GrowMode != config.GrowModeAbsolute || eff.GrowAmountGiB != 10 {
		t.Errorf("eff = %+v, want absolute/10 (inherited default amount)", eff)
	}
}

func TestCompileAbsoluteRejectsZeroDefaultAmount(t *testing.T) {
	// Absolute mode with neither a policy growAmount nor a usable default is a
	// misconfiguration.
	cfg := baseCfg()
	cfg.GrowAmountGiB = 0
	cfg.Policies = []config.ResizePolicy{{
		Name: "abs", InstanceSelector: config.InstanceSelector{NameRegex: ".*"}, Resize: config.ResizeSpec{GrowMode: ptrStr(config.GrowModeAbsolute)},
	}}
	if _, err := New(cfg); err == nil {
		t.Error("absolute mode with zero default amount = nil error, want error")
	}
}

func TestResolvePause(t *testing.T) {
	cfg := baseCfg()
	cfg.Paused = true // default policy paused
	cfg.Policies = []config.ResizePolicy{{
		Name:             "active-db",
		InstanceSelector: config.InstanceSelector{Tags: map[string]string{"Role": "db"}},
		Resize:           config.ResizeSpec{Paused: ptrBool(false)}, // un-pause this group
	}}
	r, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	// Default bucket inherits the paused default.
	if eff := r.Resolve("web-1", nil); !eff.Paused {
		t.Error("default policy Paused = false, want true (inherited)")
	}
	// Named policy overrides to un-paused.
	if eff := r.Resolve("db-1", map[string]string{"Role": "db"}); eff.Paused {
		t.Error("active-db Paused = true, want false (override)")
	}
}

func ptrBool(b bool) *bool { return &b }

func TestSummaries(t *testing.T) {
	cfg := baseCfg()
	cfg.Policies = []config.ResizePolicy{
		{Name: "a", Weight: 5, InstanceSelector: config.InstanceSelector{NameRegex: ".*"}},
		{Name: "b", Weight: 2, InstanceSelector: config.InstanceSelector{NameRegex: ".*"}},
	}
	r, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	got := r.Summaries()
	want := []string{"a(weight=5)", "b(weight=2)"}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("Summaries[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestResolverAccessors(t *testing.T) {
	cfg := baseCfgForAccessors()
	r, err := New(cfg)
	if err != nil {
		t.Fatalf("New error: %v", err)
	}
	if r.Len() != 2 {
		t.Errorf("Len() = %d, want 2", r.Len())
	}
	names := r.Names()
	if len(names) != 2 || names[0] != "bastion" || names[1] != "shared" {
		t.Errorf("Names() = %v, want [bastion shared] in file order", names)
	}
	def := r.Default()
	if def.Policy != DefaultPolicyName || def.UsageThresholdPercent != 80 {
		t.Errorf("Default() = %+v, want default policy at threshold 80", def)
	}
	eff, ok := r.EffectiveOf("bastion")
	if !ok || eff.UsageThresholdPercent != 60 {
		t.Errorf("EffectiveOf(bastion) = (%+v, %t), want threshold 60, true", eff, ok)
	}
	if _, ok := r.EffectiveOf("missing"); ok {
		t.Error("EffectiveOf(missing) = true, want false")
	}
}

func baseCfgForAccessors() *config.Config {
	threshold := 60
	return &config.Config{
		UsageThresholdPercent: 80,
		GrowMode:              config.GrowModePercent,
		GrowPercent:           10,
		MaxVolumeSizeGiB:      1000,
		Policies: []config.ResizePolicy{
			{Name: "bastion", InstanceSelector: config.InstanceSelector{NameRegex: "bastion"},
				Resize: config.ResizeSpec{UsageThresholdPercent: &threshold}},
			{Name: "shared", InstanceSelector: config.InstanceSelector{NameRegex: "^shared-"}},
		},
	}
}
