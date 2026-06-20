// Package config loads forklift configuration from environment variables with
// sensible defaults. Every value can be overridden via env; CLI flags in main
// take final precedence.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config holds all runtime configuration.
type Config struct {
	// DataDir is the root directory backed by a (RWX) PersistentVolume. It holds
	// the SQLite metadata database and the content-addressed blob store.
	DataDir string

	// HTTPAddr is the listen address for the API + UI + package protocols.
	HTTPAddr string
	// MetricsAddr is the listen address for Prometheus metrics.
	MetricsAddr string
	// ExternalURL, when set (e.g. https://forklift.example.com), is used as the
	// base for URLs synthesised in package metadata instead of deriving it from
	// request Host/X-Forwarded-* headers.
	ExternalURL string

	// LogLevel is one of debug, info, warn, error.
	LogLevel string
	// LogFormat is one of json, text.
	LogFormat string

	// ShutdownTimeout bounds graceful shutdown.
	ShutdownTimeout time.Duration

	// HA enables Kubernetes Lease leader election. When false the process always
	// considers itself the leader (single-instance mode).
	HA HAConfig

	// Replication enables PV-based active/standby replication: each pod keeps
	// its own (RWO) PersistentVolume and the standby continuously pulls the
	// leader's SQLite snapshot and blobs, promoting that copy when it acquires
	// leadership. Use instead of a shared RWX volume.
	Replication ReplicationConfig

	// Auth configures authentication and authorization.
	Auth AuthConfig

	// Audit configures the per-repository audit log.
	Audit AuditConfig

	// Vuln configures background vulnerability scanning (OSV). Scanning is
	// disabled when OSVURL is empty; per-repository policy gates enforcement.
	Vuln VulnConfig

	// SeedDefaultRepos, on first run, creates default repositories: a proxy of
	// each public registry (Maven Central, npm, crates.io, Go proxy) plus a local
	// hosted repository per format, like a fresh Nexus install. Idempotent.
	SeedDefaultRepos bool
}

// VulnConfig configures OSV-based vulnerability scanning.
type VulnConfig struct {
	// OSVURL is the OSV API base (e.g. https://api.osv.dev). Empty disables
	// scanning entirely.
	OSVURL string
	// RescanInterval is how often stale scan results are re-queried.
	RescanInterval time.Duration
	// TTL marks a scan result stale (eligible for re-scan) once older than this.
	TTL time.Duration
}

// AuthConfig configures local users, sessions, OIDC and anonymous access.
type AuthConfig struct {
	// SessionSecret signs stateless session cookies. Must be shared across
	// replicas in HA mode; if empty an ephemeral secret is generated.
	SessionSecret string
	SessionTTL    time.Duration
	// AnonymousRead allows unauthenticated read access to repositories.
	AnonymousRead bool
	// BootstrapAdminUser/Password seed an initial admin on first run when no
	// users exist. The password should be rotated after first login.
	BootstrapAdminUser     string
	BootstrapAdminPassword string

	OIDC OIDCConfig
	RBAC RBACConfig
}

// RBACConfig configures declarative, ArgoCD-style RBAC reconciled from the
// chart on startup. When PolicyFile is empty, declarative RBAC is disabled and
// authorization relies solely on roles managed through the API/UI.
type RBACConfig struct {
	// PolicyFile is the path to an ArgoCD-style policy.csv (ConfigMap mount).
	PolicyFile string
	// DefaultRole grants its permissions to every authenticated principal,
	// regardless of explicit assignments (ArgoCD policy.default). Empty means
	// no default access (deny-all until a role is granted).
	DefaultRole string
	// AccountsDir is a directory of local-account password files (Secret mount),
	// one file per account named after the username.
	AccountsDir string
}

// OIDCConfig configures Keycloak (or any OIDC provider) login.
type OIDCConfig struct {
	Enabled       bool
	IssuerURL     string
	ClientID      string
	ClientSecret  string
	RedirectURL   string
	UsernameClaim string
	GroupsClaim   string
}

// AuditConfig configures the per-repository audit log.
type AuditConfig struct {
	// Enabled turns audit logging on (artifact traffic and repository
	// configuration changes are recorded per repository).
	Enabled bool
	// Retention is how long audit entries are kept before the leader prunes
	// them. Zero disables pruning (keep forever).
	Retention time.Duration
}

// ReplicationConfig configures PV-based replication between two replicas.
type ReplicationConfig struct {
	Enabled bool
	// Token authenticates the internal replication endpoints. Must be shared by
	// all replicas.
	Token string
	// PeerService is the headless Service domain used to address peer pods, e.g.
	// "forklift-headless.tools.svc.cluster.local". The leader URL is built as
	// http://<lease-holder>.<PeerService>:<PeerPort>.
	PeerService string
	// PeerPort is the HTTP port peers listen on.
	PeerPort int
	// Interval is the standby's pull cadence. Writes within one interval can be
	// lost on failover (asynchronous replication).
	Interval time.Duration
	// LeaderURL statically overrides leader discovery (testing / non-Kubernetes).
	LeaderURL string
	// PodName/PodNamespace identify this pod for the leader role label patch.
	PodName      string
	PodNamespace string
}

// HAConfig configures leader election for active/standby high availability.
type HAConfig struct {
	Enabled        bool
	LeaseName      string
	LeaseNamespace string
	Identity       string
	LeaseDuration  time.Duration
	RenewDeadline  time.Duration
	RetryPeriod    time.Duration
}

// Load builds a Config from the environment, applying defaults.
func Load() (*Config, error) {
	c := &Config{
		DataDir:         env("FORKLIFT_DATA_DIR", "/data"),
		HTTPAddr:        env("FORKLIFT_HTTP_ADDR", ":8080"),
		MetricsAddr:     env("FORKLIFT_METRICS_ADDR", ":8081"),
		ExternalURL:     env("FORKLIFT_EXTERNAL_URL", ""),
		LogLevel:        env("FORKLIFT_LOG_LEVEL", "info"),
		LogFormat:       env("FORKLIFT_LOG_FORMAT", "json"),
		ShutdownTimeout: envDuration("FORKLIFT_SHUTDOWN_TIMEOUT", 15*time.Second),
		HA: HAConfig{
			Enabled:        envBool("FORKLIFT_HA_ENABLED", false),
			LeaseName:      env("FORKLIFT_HA_LEASE_NAME", "forklift-leader"),
			LeaseNamespace: env("FORKLIFT_HA_LEASE_NAMESPACE", env("POD_NAMESPACE", "default")),
			Identity:       env("FORKLIFT_HA_IDENTITY", env("POD_NAME", hostname())),
			LeaseDuration:  envDuration("FORKLIFT_HA_LEASE_DURATION", 15*time.Second),
			RenewDeadline:  envDuration("FORKLIFT_HA_RENEW_DEADLINE", 10*time.Second),
			RetryPeriod:    envDuration("FORKLIFT_HA_RETRY_PERIOD", 2*time.Second),
		},
		Replication: ReplicationConfig{
			Enabled:      envBool("FORKLIFT_REPLICATION_ENABLED", false),
			Token:        env("FORKLIFT_REPLICATION_TOKEN", ""),
			PeerService:  env("FORKLIFT_REPLICATION_PEER_SERVICE", ""),
			PeerPort:     envInt("FORKLIFT_REPLICATION_PEER_PORT", 8080),
			Interval:     envDuration("FORKLIFT_REPLICATION_INTERVAL", 30*time.Second),
			LeaderURL:    env("FORKLIFT_REPLICATION_LEADER_URL", ""),
			PodName:      env("POD_NAME", ""),
			PodNamespace: env("POD_NAMESPACE", ""),
		},
		Auth: AuthConfig{
			SessionSecret:          env("FORKLIFT_SESSION_SECRET", ""),
			SessionTTL:             envDuration("FORKLIFT_SESSION_TTL", 12*time.Hour),
			AnonymousRead:          envBool("FORKLIFT_ANONYMOUS_READ", false),
			BootstrapAdminUser:     env("FORKLIFT_BOOTSTRAP_ADMIN_USER", "admin"),
			BootstrapAdminPassword: env("FORKLIFT_BOOTSTRAP_ADMIN_PASSWORD", ""),
			OIDC: OIDCConfig{
				Enabled:       envBool("FORKLIFT_OIDC_ENABLED", false),
				IssuerURL:     env("FORKLIFT_OIDC_ISSUER_URL", ""),
				ClientID:      env("FORKLIFT_OIDC_CLIENT_ID", ""),
				ClientSecret:  env("FORKLIFT_OIDC_CLIENT_SECRET", ""),
				RedirectURL:   env("FORKLIFT_OIDC_REDIRECT_URL", ""),
				UsernameClaim: env("FORKLIFT_OIDC_USERNAME_CLAIM", "preferred_username"),
				GroupsClaim:   env("FORKLIFT_OIDC_GROUPS_CLAIM", "groups"),
			},
			RBAC: RBACConfig{
				PolicyFile:  env("FORKLIFT_RBAC_POLICY_FILE", ""),
				DefaultRole: env("FORKLIFT_RBAC_DEFAULT_ROLE", ""),
				AccountsDir: env("FORKLIFT_RBAC_ACCOUNTS_DIR", ""),
			},
		},
		Audit: AuditConfig{
			Enabled:   envBool("FORKLIFT_AUDIT_ENABLED", true),
			Retention: envDuration("FORKLIFT_AUDIT_RETENTION", 90*24*time.Hour),
		},
		Vuln: VulnConfig{
			OSVURL:         env("FORKLIFT_OSV_URL", "https://api.osv.dev"),
			RescanInterval: envDuration("FORKLIFT_VULN_RESCAN_INTERVAL", 6*time.Hour),
			TTL:            envDuration("FORKLIFT_VULN_TTL", 24*time.Hour),
		},
		SeedDefaultRepos: envBool("FORKLIFT_SEED_DEFAULT_REPOS", true),
	}
	return c, c.validate()
}

func (c *Config) validate() error {
	if c.DataDir == "" {
		return fmt.Errorf("data dir must not be empty")
	}
	switch c.LogLevel {
	case "debug", "info", "warn", "error":
	default:
		return fmt.Errorf("invalid log level %q", c.LogLevel)
	}
	switch c.LogFormat {
	case "json", "text":
	default:
		return fmt.Errorf("invalid log format %q", c.LogFormat)
	}
	if c.HA.Enabled && c.HA.Identity == "" {
		return fmt.Errorf("HA enabled but identity is empty")
	}
	if c.Replication.Enabled {
		if !c.HA.Enabled {
			return fmt.Errorf("replication requires HA leader election")
		}
		if c.Replication.Token == "" {
			return fmt.Errorf("replication enabled but token is empty")
		}
		if c.Replication.PeerService == "" && c.Replication.LeaderURL == "" {
			return fmt.Errorf("replication enabled but neither peer service nor leader URL is set")
		}
		if c.Replication.Interval <= 0 {
			return fmt.Errorf("replication interval must be positive")
		}
	}
	return nil
}

func env(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && strings.TrimSpace(v) != "" {
		return v
	}
	return def
}

func envBool(key string, def bool) bool {
	if v, ok := os.LookupEnv(key); ok {
		b, err := strconv.ParseBool(strings.TrimSpace(v))
		if err == nil {
			return b
		}
	}
	return def
}

func envInt(key string, def int) int {
	if v, ok := os.LookupEnv(key); ok {
		n, err := strconv.Atoi(strings.TrimSpace(v))
		if err == nil {
			return n
		}
	}
	return def
}

func envDuration(key string, def time.Duration) time.Duration {
	if v, ok := os.LookupEnv(key); ok {
		d, err := time.ParseDuration(strings.TrimSpace(v))
		if err == nil {
			return d
		}
	}
	return def
}

func hostname() string {
	h, err := os.Hostname()
	if err != nil {
		return "forklift"
	}
	return h
}
