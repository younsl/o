// Package config loads and validates the gate configuration.
//
// Everything that varies per deployment lives in a YAML file mounted from a
// ConfigMap; the process flags cover only wiring (listen addresses, TLS
// material, log settings).
package config

import (
	"bytes"
	"fmt"
	"os"
	"slices"
	"strings"

	"gopkg.in/yaml.v3"
)

// OnError decides the verdict when a check cannot be evaluated because a
// dependency failed.
type OnError string

const (
	OnErrorAllow OnError = "allow"
	OnErrorDeny  OnError = "deny"
)

// ImageTagMode decides whether a failing image comparison denies the sync.
type ImageTagMode string

const (
	// ImageTagModeEnforce denies the sync on a tag mismatch.
	ImageTagModeEnforce ImageTagMode = "enforce"
	// ImageTagModeWarn allows the sync, attaches a warning, and counts the
	// mismatch. Use it to observe the blast radius before enforcing.
	ImageTagModeWarn ImageTagMode = "warn"
)

// Require lists the upstream status conditions that must hold.
type Require struct {
	// Sync requires the upstream to report status.sync.status: Synced.
	Sync bool `yaml:"sync"`
	// Health requires the upstream to report status.health.status: Healthy.
	Health bool `yaml:"health"`
}

// ImageTag configures the image tag comparison.
type ImageTag struct {
	// Enabled compares image tags on top of the upstream sync and health checks.
	Enabled bool `yaml:"enabled"`
	// Mode is enforce or warn.
	Mode ImageTagMode `yaml:"mode"`
	// Kinds are the workload kinds queried for desired images.
	Kinds []string `yaml:"kinds"`
	// IgnoreRepos excludes repository basenames from comparison. A trailing
	// "*" globs, so "autoinstrumentation-*" covers a sidecar family.
	IgnoreRepos []string `yaml:"ignoreRepos"`
	// OnError is the verdict when the desired image lookup fails.
	OnError OnError `yaml:"onError"`
}

// Rollback configures the rollback allowance.
type Rollback struct {
	// AllowPreviouslyDeployedRevision lets a sync through when its target
	// revision is one this Application has already deployed, which is what a
	// rollback is.
	//
	// This cannot introduce anything new into the environment: the revision was
	// running here before, so every image it carries has already been through
	// whatever checks applied at the time. Refusing it would leave an incident
	// with no way back except an annotation, which is the wrong thing to ask of
	// somebody at 3am.
	AllowPreviouslyDeployedRevision bool `yaml:"allowPreviouslyDeployedRevision"`
}

// Exempt lists the ways a sync bypasses the gate.
type Exempt struct {
	// Usernames are principals whose sync requests bypass the gate. The Argo
	// CD application controller belongs here so an auto-sync is never blocked
	// mid-reconcile, where the denial would only produce a retry loop.
	Usernames []string `yaml:"usernames"`
	// Automated bypasses the gate when Argo CD marks the operation automated.
	Automated bool `yaml:"automated"`
	// Annotation opts one Application out of the gate when set to "true".
	Annotation string `yaml:"annotation"`
}

// ArgoCD points at the Argo CD installation the gate reads.
type ArgoCD struct {
	// Namespace holds the Application resources.
	Namespace string `yaml:"namespace"`
	// ServerAddress is the base URL of argocd-server, used for the desired
	// image lookup that the Kubernetes API cannot answer.
	//
	// Argo CD's self-signed serving certificate carries SANs for "localhost"
	// and "argocd-server" only, so the in-namespace short name verifies while
	// the fully qualified service name does not.
	ServerAddress string `yaml:"serverAddress"`
	// CAFile is the PEM bundle that signs the argocd-server certificate.
	// Mounting argocd-secret's tls.crt is enough, since that certificate is
	// its own issuer.
	CAFile string `yaml:"caFile"`
	// InsecureSkipVerify disables TLS verification against argocd-server. It
	// exists only for clusters that terminate TLS elsewhere; prefer CAFile,
	// because the token this client sends is a full Argo CD API credential.
	InsecureSkipVerify bool `yaml:"insecureSkipVerify"`
	// TokenPath is the file holding the Argo CD API token.
	TokenPath string `yaml:"tokenPath"`
	// TimeoutSeconds bounds each argocd-server call. It must stay well under
	// the webhook's own timeout.
	TimeoutSeconds int `yaml:"timeoutSeconds"`
	// CacheTTLSeconds is how long a desired image lookup is reused.
	CacheTTLSeconds int `yaml:"cacheTtlSeconds"`
}

// Config is the full gate configuration.
type Config struct {
	// Chain is the promotion order, lowest environment first. The upstream of
	// an environment is its predecessor in this list.
	Chain []string `yaml:"chain"`
	// GatedEnvs are the environments the gate enforces. Empty means every
	// environment in the chain except the head.
	GatedEnvs []string `yaml:"gatedEnvs"`
	Require   Require  `yaml:"require"`
	ImageTag  ImageTag `yaml:"imageTag"`
	Rollback  Rollback `yaml:"rollback"`
	Exempt    Exempt   `yaml:"exempt"`
	ArgoCD    ArgoCD   `yaml:"argocd"`
}

// Default returns the configuration before the file is applied.
//
// imageTag.mode defaults to warn rather than enforce: turning tag equality on
// in an estate that has never enforced it can block every pending production
// sync at once, so the safe default reports first.
func Default() Config {
	return Config{
		Require: Require{
			Sync:   true,
			Health: true,
		},
		ImageTag: ImageTag{
			Enabled: true,
			Mode:    ImageTagModeWarn,
			Kinds:   []string{"Deployment", "StatefulSet", "DaemonSet", "CronJob", "Rollout"},
			OnError: OnErrorDeny,
		},
		Rollback: Rollback{
			AllowPreviouslyDeployedRevision: true,
		},
		Exempt: Exempt{
			Usernames:  []string{"system:serviceaccount:argocd:argocd-application-controller"},
			Automated:  true,
			Annotation: "promotion-gate.younsl.github.io/skip",
		},
		ArgoCD: ArgoCD{
			Namespace:          "argocd",
			ServerAddress:      "https://argocd-server",
			CAFile:             "/etc/argocd-promotion-gate/argocd-ca/tls.crt",
			InsecureSkipVerify: false,
			TokenPath:          "/etc/argocd-promotion-gate/token/token",
			TimeoutSeconds:     3,
			CacheTTLSeconds:    30,
		},
	}
}

// Load reads and validates the configuration file.
func Load(path string) (Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return Config{}, fmt.Errorf("read gate config %s: %w", path, err)
	}
	cfg, err := Parse(raw)
	if err != nil {
		return Config{}, fmt.Errorf("gate config %s: %w", path, err)
	}
	return cfg, nil
}

// Parse decodes the configuration on top of the defaults and validates it.
//
// Unknown fields are rejected so a misspelled key surfaces at startup instead
// of silently leaving a check disabled.
func Parse(raw []byte) (Config, error) {
	cfg := Default()
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	dec.KnownFields(true)
	if err := dec.Decode(&cfg); err != nil {
		return Config{}, fmt.Errorf("parse: %w", err)
	}
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// Validate rejects configurations that cannot enforce anything, so a typo
// fails startup instead of quietly allowing every sync.
func (c Config) Validate() error {
	if len(c.Chain) < 2 {
		return fmt.Errorf("chain needs at least two environments, got %d: a chain without a predecessor has no upstream to gate on", len(c.Chain))
	}

	seen := make(map[string]struct{}, len(c.Chain))
	for _, env := range c.Chain {
		if strings.TrimSpace(env) == "" {
			return fmt.Errorf("chain contains an empty entry")
		}
		if _, dup := seen[env]; dup {
			return fmt.Errorf("chain contains duplicate env %q", env)
		}
		seen[env] = struct{}{}
	}

	for _, env := range c.GatedEnvs {
		if _, ok := seen[env]; !ok {
			return fmt.Errorf("gatedEnvs entry %q is not present in chain %v", env, c.Chain)
		}
		if env == c.Chain[0] {
			return fmt.Errorf("gatedEnvs entry %q is the chain head and has no upstream to gate on", env)
		}
	}

	if c.ImageTag.Enabled {
		switch c.ImageTag.Mode {
		case ImageTagModeEnforce, ImageTagModeWarn:
		default:
			return fmt.Errorf("imageTag.mode must be enforce or warn, got %q", c.ImageTag.Mode)
		}
		switch c.ImageTag.OnError {
		case OnErrorAllow, OnErrorDeny:
		default:
			return fmt.Errorf("imageTag.onError must be allow or deny, got %q", c.ImageTag.OnError)
		}
		if len(c.ImageTag.Kinds) == 0 {
			return fmt.Errorf("imageTag.kinds must not be empty when imageTag.enabled is true")
		}
		if strings.TrimSpace(c.ArgoCD.ServerAddress) == "" {
			return fmt.Errorf("argocd.serverAddress is required when imageTag.enabled is true")
		}
	}

	if strings.TrimSpace(c.Exempt.Annotation) == "" {
		return fmt.Errorf("exempt.annotation must not be empty")
	}
	if strings.TrimSpace(c.ArgoCD.Namespace) == "" {
		return fmt.Errorf("argocd.namespace must not be empty")
	}
	if c.ArgoCD.TimeoutSeconds <= 0 {
		return fmt.Errorf("argocd.timeoutSeconds must be greater than 0, got %d", c.ArgoCD.TimeoutSeconds)
	}
	if c.ArgoCD.CacheTTLSeconds < 0 {
		return fmt.Errorf("argocd.cacheTtlSeconds must not be negative, got %d", c.ArgoCD.CacheTTLSeconds)
	}
	return nil
}

// UpstreamEnv returns the environment that must be promoted before env may
// sync, and false when env is outside the chain or is the chain head.
func (c Config) UpstreamEnv(env string) (string, bool) {
	for i, candidate := range c.Chain {
		if candidate != env {
			continue
		}
		if i == 0 {
			return "", false
		}
		return c.Chain[i-1], true
	}
	return "", false
}

// IsGated reports whether the gate enforces anything for env.
//
// An empty GatedEnvs means "every environment in the chain except the head",
// which is the useful reading for a fully ordered promotion chain.
func (c Config) IsGated(env string) bool {
	if _, ok := c.UpstreamEnv(env); !ok {
		return false
	}
	if len(c.GatedEnvs) == 0 {
		return true
	}
	return slices.Contains(c.GatedEnvs, env)
}
