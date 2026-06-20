package meta

import "time"

// Repository is a Hosted, Proxy (cached upstream) or Group repository for one
// package format.
type Repository struct {
	ID          int64
	Name        string
	Format      string // maven | npm | cargo | go | pypi
	Type        string // hosted | proxy | group
	UpstreamURL string
	ConfigJSON  string
	CreatedAt   time.Time
	UpdatedAt   time.Time
	// Disabled takes the repository offline: it stops serving the package
	// protocols while keeping its config and stored artifacts.
	Disabled bool
}

// Artifact is a stored path within a repository pointing at a content-addressed
// blob, plus caching/age-policy metadata.
type Artifact struct {
	ID             int64
	RepoID         int64
	Path           string
	Version        string
	BlobSHA256     string
	Size           int64
	ContentType    string
	MetadataJSON   string
	PublishedAt    *time.Time // upstream original release time, may be nil
	CachedAt       time.Time
	LastAccessedAt time.Time
	UpdatedAt      time.Time
}

// Blob is the reference-counted record for a content-addressed blob.
type Blob struct {
	SHA256    string
	Size      int64
	RefCount  int64
	CreatedAt time.Time
}

// User is a local (password) or OIDC-sourced principal.
type User struct {
	ID           int64
	Username     string
	PasswordHash string
	Source       string // local | oidc
	Email        string
	Disabled     bool
	CreatedAt    time.Time
	UpdatedAt    time.Time
	LastLoginAt  time.Time // zero when the user has never logged in
	// LockoutEnabled opts the account into failed-password lockout. When on,
	// FailedLoginCount consecutive local-password failures (reset on success)
	// crossing the threshold set LockedAt, after which the account cannot
	// authenticate until an admin unlocks it.
	LockoutEnabled   bool
	FailedLoginCount int
	LockedAt         time.Time // zero when not locked
}

// Locked reports whether the account is currently locked out.
func (u User) Locked() bool { return !u.LockedAt.IsZero() }

// Role is a named bundle of repository permissions.
type Role struct {
	ID          int64
	Name        string
	Description string
	CreatedAt   time.Time
	// Managed marks roles owned by the declarative RBAC policy. Managed roles
	// are reconciled from the chart on startup and are read-only via the API.
	Managed bool
}

// Permission grants a set of actions on repositories matching a glob pattern.
type Permission struct {
	ID          int64
	RoleID      int64
	RepoPattern string // glob: * or maven-*
	Actions     string // csv: read,write,delete,admin
	Managed     bool
}

// GroupMapping maps a Keycloak group name to a role.
type GroupMapping struct {
	ID        int64
	GroupName string
	RoleID    int64
	Managed   bool
}

// Token is a personal access token (PAT). Only the SHA-256 hash is stored.
type Token struct {
	ID          int64
	UserID      int64
	Name        string
	Description string
	Hash        string
	ScopesJSON  string
	ExpiresAt   *time.Time
	LastUsedAt  *time.Time
	CreatedAt   time.Time
}

// Source constants for users.
const (
	SourceLocal = "local"
	SourceOIDC  = "oidc"
)

// Repository format and type constants.
const (
	FormatMaven = "maven"
	FormatNPM   = "npm"
	FormatCargo = "cargo"
	FormatGo    = "go"
	FormatPyPI  = "pypi"

	TypeHosted = "hosted"
	TypeProxy  = "proxy"
	TypeGroup  = "group"
)

func parseTime(s string) time.Time {
	t, _ := time.Parse(time.RFC3339Nano, s)
	return t
}

func parseTimePtr(s *string) *time.Time {
	if s == nil || *s == "" {
		return nil
	}
	t := parseTime(*s)
	return &t
}

func formatTimePtr(t *time.Time) any {
	if t == nil {
		return nil
	}
	return t.UTC().Format(time.RFC3339Nano)
}
