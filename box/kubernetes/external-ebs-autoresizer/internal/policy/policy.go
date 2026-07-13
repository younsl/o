// Package policy resolves per-instance resize settings from the list of
// per-group policies in the config file. Each policy selects a group of
// instances via an instanceSelector (tag equality and/or a Name regex) and
// overrides a subset of the global resize settings for that group. When
// several policies match an instance, the highest weight wins; instances
// matching no policy use the global defaults.
package policy

import (
	"fmt"
	"regexp"

	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/config"
)

// DefaultPolicyName labels the effective settings of instances that match no
// policy, in logs and metrics.
const DefaultPolicyName = "default"

// Effective is the fully resolved resize settings applied to one instance.
type Effective struct {
	// Policy is the name of the matched policy, or DefaultPolicyName.
	Policy string
	// Paused, when true, means the resizer must not touch matching instances.
	Paused                bool
	UsageThresholdPercent int
	GrowMode              string
	GrowPercent           int
	GrowAmountGiB         int32
	MaxVolumeSizeGiB      int
}

// compiled is a validated policy with its regex compiled and grow amount
// parsed once at load time.
type compiled struct {
	policy    config.ResizePolicy
	nameRe    *regexp.Regexp
	effective Effective
}

// Resolver maps an instance to its effective resize settings.
type Resolver struct {
	defaults Effective
	policies []compiled
}

// FromConfig builds the default effective settings from the global config.
func FromConfig(cfg *config.Config) Effective {
	return Effective{
		Policy:                DefaultPolicyName,
		Paused:                cfg.Paused,
		UsageThresholdPercent: cfg.UsageThresholdPercent,
		GrowMode:              cfg.GrowMode,
		GrowPercent:           cfg.GrowPercent,
		GrowAmountGiB:         cfg.GrowAmountGiB,
		MaxVolumeSizeGiB:      cfg.MaxVolumeSizeGiB,
	}
}

// New builds a resolver for a config: it derives the defaults from the global
// settings and validates and compiles the per-group policies. Nil or empty
// policies yield a resolver where every instance resolves to defaults.
func New(cfg *config.Config) (*Resolver, error) {
	defaults := FromConfig(cfg)
	r := &Resolver{defaults: defaults}
	seen := make(map[string]bool, len(cfg.Policies))
	for i, p := range cfg.Policies {
		c, err := compile(p, defaults)
		if err != nil {
			return nil, fmt.Errorf("policy %d (%q): %w", i, p.Name, err)
		}
		if p.Name == DefaultPolicyName {
			return nil, fmt.Errorf("policy %d: name %q is reserved", i, DefaultPolicyName)
		}
		if seen[p.Name] {
			return nil, fmt.Errorf("policy %d: duplicate name %q", i, p.Name)
		}
		seen[p.Name] = true
		r.policies = append(r.policies, c)
	}
	return r, nil
}

// compile validates one policy against the defaults it overlays and
// pre-computes its regex, parsed grow amount, and effective settings.
func compile(p config.ResizePolicy, defaults Effective) (compiled, error) {
	c := compiled{policy: p}
	if p.Name == "" {
		return c, fmt.Errorf("name is required")
	}
	if len(p.InstanceSelector.Tags) == 0 && p.InstanceSelector.NameRegex == "" {
		return c, fmt.Errorf("instanceSelector requires tags and/or nameRegex (use nameRegex: \".*\" for a catch-all)")
	}
	for k, v := range p.InstanceSelector.Tags {
		if k == "" || v == "" {
			return c, fmt.Errorf("instanceSelector.tags entries need a non-empty key and value")
		}
	}
	if p.InstanceSelector.NameRegex != "" {
		re, err := regexp.Compile(p.InstanceSelector.NameRegex)
		if err != nil {
			return c, fmt.Errorf("invalid instanceSelector.nameRegex: %w", err)
		}
		c.nameRe = re
	}

	eff := defaults
	eff.Policy = p.Name
	rs := p.Resize
	if rs.Paused != nil {
		eff.Paused = *rs.Paused
	}
	if rs.UsageThresholdPercent != nil {
		if *rs.UsageThresholdPercent < 0 || *rs.UsageThresholdPercent > 100 {
			return c, fmt.Errorf("resize.usageThresholdPercent must be between 0 and 100, got %d", *rs.UsageThresholdPercent)
		}
		eff.UsageThresholdPercent = *rs.UsageThresholdPercent
	}
	if rs.GrowMode != nil {
		switch *rs.GrowMode {
		case config.GrowModePercent, config.GrowModeAbsolute:
			eff.GrowMode = *rs.GrowMode
		default:
			return c, fmt.Errorf("resize.growMode must be one of %s, %s, got %q", config.GrowModePercent, config.GrowModeAbsolute, *rs.GrowMode)
		}
	}
	if rs.GrowPercent != nil {
		if *rs.GrowPercent <= 0 {
			return c, fmt.Errorf("resize.growPercent must be greater than 0, got %d", *rs.GrowPercent)
		}
		eff.GrowPercent = *rs.GrowPercent
	}
	if rs.GrowAmount != nil {
		gib, err := config.ParseGrowAmount(*rs.GrowAmount)
		if err != nil {
			return c, fmt.Errorf("invalid resize.growAmount: %w", err)
		}
		eff.GrowAmountGiB = gib
	}
	if rs.MaxVolumeSizeGiB != nil {
		if *rs.MaxVolumeSizeGiB <= 0 {
			return c, fmt.Errorf("resize.maxVolumeSizeGiB must be greater than 0, got %d", *rs.MaxVolumeSizeGiB)
		}
		eff.MaxVolumeSizeGiB = *rs.MaxVolumeSizeGiB
	}
	if eff.GrowMode == config.GrowModeAbsolute && eff.GrowAmountGiB <= 0 {
		return c, fmt.Errorf("resize.growMode is absolute but no growAmount resolves (set resize.growAmount here or globally)")
	}
	c.effective = eff
	return c, nil
}

// matches reports whether the selector matches an instance's Name tag and tags.
func (c *compiled) matches(name string, tags map[string]string) bool {
	for k, v := range c.policy.InstanceSelector.Tags {
		if tags[k] != v {
			return false
		}
	}
	if c.nameRe != nil && !c.nameRe.MatchString(name) {
		return false
	}
	return true
}

// Resolve returns the effective settings for an instance identified by its
// Name tag and full tag set. Among matching policies the highest weight wins;
// ties resolve to the policy listed first. No match returns the defaults.
func (r *Resolver) Resolve(name string, tags map[string]string) Effective {
	best := -1
	for i := range r.policies {
		if !r.policies[i].matches(name, tags) {
			continue
		}
		if best == -1 || r.policies[i].policy.Weight > r.policies[best].policy.Weight {
			best = i
		}
	}
	if best == -1 {
		return r.defaults
	}
	return r.policies[best].effective
}

// Summaries returns one "name(weight=N)" string per policy in file order, for
// startup logging.
func (r *Resolver) Summaries() []string {
	out := make([]string, len(r.policies))
	for i, c := range r.policies {
		out[i] = fmt.Sprintf("%s(weight=%d)", c.policy.Name, c.policy.Weight)
	}
	return out
}

// Len returns the number of loaded policies.
func (r *Resolver) Len() int {
	return len(r.policies)
}

// Names returns the policy names in file order, for stable metric and log
// enumeration. It excludes the implicit default bucket.
func (r *Resolver) Names() []string {
	out := make([]string, len(r.policies))
	for i, c := range r.policies {
		out[i] = c.policy.Name
	}
	return out
}

// Default returns the effective settings applied to instances matching no
// named policy.
func (r *Resolver) Default() Effective {
	return r.defaults
}

// EffectiveOf returns the compiled effective settings of the named policy.
func (r *Resolver) EffectiveOf(name string) (Effective, bool) {
	for _, c := range r.policies {
		if c.policy.Name == name {
			return c.effective, true
		}
	}
	return Effective{}, false
}
