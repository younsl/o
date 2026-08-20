// Package gate holds the promotion rules: how an Application maps onto the
// promotion chain, how container images are compared across environments, and
// the verdict itself.
//
// Everything here is pure. The facts a verdict depends on are gathered by the
// engine and passed in, so the rules can be tested without a cluster.
package gate

// Status values Argo CD publishes on an Application.
const (
	SyncSynced    = "Synced"
	HealthHealthy = "Healthy"
	StatusUnknown = "Unknown"
)

// AppSnapshot is one Argo CD Application reduced to the fields the gate
// reasons about.
type AppSnapshot struct {
	// Name is metadata.name, for example "prd-payment-api".
	Name string
	// Project is spec.project, which doubles as the environment name.
	Project string
	// Identity is the environment-independent app identity, "payment-api".
	Identity string
	// SyncStatus is status.sync.status, empty when Argo CD has not reconciled.
	SyncStatus string
	// HealthStatus is status.health.status, empty when not reconciled.
	HealthStatus string
	// LiveImages is status.summary.images, the images currently running.
	LiveImages []ImageRef
	// SkipRequested is true when the app carries the skip annotation.
	SkipRequested bool
	// PendingRevision is operation.sync.revision on a pending sync, empty when
	// the object carries no operation.
	PendingRevision string
	// DeployedRevisions are the revisions from status.history, which is what
	// makes a rollback recognisable without asking Argo CD anything.
	DeployedRevisions []string
	// CurrentRevision is status.sync.revision, the revision already live here.
	CurrentRevision string
}

// IsRollback reports whether the pending sync goes back to a revision this
// application has already deployed.
//
// Two conditions, and the second one matters. The target must appear in this
// application's own history, and it must not be the revision already live here.
// Without that second test an application whose revision is a chart version
// rather than a git commit would look like a rollback on every sync, because
// its revision never changes even when the desired state does.
func (a AppSnapshot) IsRollback() bool {
	if a.PendingRevision == "" || a.PendingRevision == a.CurrentRevision {
		return false
	}
	for _, deployed := range a.DeployedRevisions {
		if deployed == a.PendingRevision {
			return true
		}
	}
	return false
}

// IsSynced reports whether Argo CD considers the app in sync with git.
func (a AppSnapshot) IsSynced() bool { return a.SyncStatus == SyncSynced }

// IsHealthy reports whether Argo CD considers the app's resources healthy.
func (a AppSnapshot) IsHealthy() bool { return a.HealthStatus == HealthHealthy }

// SyncOrUnknown is SyncStatus with a printable fallback.
func (a AppSnapshot) SyncOrUnknown() string {
	if a.SyncStatus == "" {
		return StatusUnknown
	}
	return a.SyncStatus
}

// HealthOrUnknown is HealthStatus with a printable fallback.
func (a AppSnapshot) HealthOrUnknown() string {
	if a.HealthStatus == "" {
		return StatusUnknown
	}
	return a.HealthStatus
}

// ImageRef is a parsed container image reference.
//
// Environments in one estate routinely pull the same application image from
// different registries, one account per environment, so the comparable part of
// a reference is the repository's last path segment rather than the fully
// qualified repository.
type ImageRef struct {
	// Raw is the reference exactly as it appeared in the manifest.
	Raw string
	// Repository is the fully qualified repository without tag or digest.
	Repository string
	// Basename is the last path segment of Repository, "payment-api".
	Basename string
	// Tag is empty when the reference is digest-pinned.
	Tag string
	// Digest is empty when the reference is tag-based.
	Digest string
}

// Ref is the comparable identifier: the tag when present, else the digest.
func (i ImageRef) Ref() string {
	if i.Tag != "" {
		return i.Tag
	}
	return i.Digest
}

// ImageComparison is the outcome of comparing one repository basename across
// two environments.
type ImageComparison struct {
	Repository  string `json:"repository"`
	DesiredTag  string `json:"desiredTag"`
	UpstreamTag string `json:"upstreamTag"`
	Matched     bool   `json:"matched"`
}

// UpstreamStatus is the upstream environment summary reported to callers.
type UpstreamStatus struct {
	App          string `json:"app"`
	Env          string `json:"env"`
	Exists       bool   `json:"exists"`
	SyncStatus   string `json:"syncStatus,omitempty"`
	HealthStatus string `json:"healthStatus,omitempty"`
}

// Code is the machine-readable reason for a verdict.
type Code string

const (
	// CodeNotGated means the environment is outside the chain, or is its head.
	CodeNotGated Code = "NotGated"
	// CodeExempt means the principal or the Application opted out.
	CodeExempt Code = "Exempt"
	// CodeRollback means the sync targets a revision this environment has
	// already deployed.
	CodeRollback Code = "Rollback"
	// CodeUpstreamMissing means no upstream Application exists for this identity.
	CodeUpstreamMissing Code = "UpstreamMissing"
	// CodeUpstreamOutOfSync means the upstream exists but is not Synced.
	CodeUpstreamOutOfSync Code = "UpstreamOutOfSync"
	// CodeUpstreamUnhealthy means the upstream is Synced but not Healthy.
	CodeUpstreamUnhealthy Code = "UpstreamUnhealthy"
	// CodeImageTagMismatch means the upstream runs a different image tag than
	// this sync would deploy.
	CodeImageTagMismatch Code = "ImageTagMismatch"
	// CodeLookupFailed means a fact the verdict needs could not be read.
	CodeLookupFailed Code = "LookupFailed"
	// CodePassed means every configured check passed.
	CodePassed Code = "Passed"
)

// Decision is the gate verdict, shared by the admission webhook and the UI
// extension API so both always agree.
type Decision struct {
	App      string `json:"app"`
	Env      string `json:"env"`
	Identity string `json:"identity"`
	// Gated is false when the environment is outside the configured chain.
	Gated    bool              `json:"gated"`
	Allowed  bool              `json:"allowed"`
	Code     Code              `json:"code"`
	Message  string            `json:"message"`
	Upstream *UpstreamStatus   `json:"upstream,omitempty"`
	Images   []ImageComparison `json:"images,omitempty"`
	Warnings []string          `json:"warnings,omitempty"`
}

// NotGated is the verdict for an environment the gate does not cover.
func NotGated(app, env, identity string) Decision {
	return Decision{
		App:      app,
		Env:      env,
		Identity: identity,
		Gated:    false,
		Allowed:  true,
		Code:     CodeNotGated,
		Message: "Sync of " + app + " is allowed. The environment " + env +
			" is not gated by the promotion gate either because it is absent from the configured promotion chain or because it sits at the head of that chain and so has no upstream environment to wait for. No upstream state was read and no image tag was compared.",
	}
}
