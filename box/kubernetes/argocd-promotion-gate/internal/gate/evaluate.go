package gate

import (
	"fmt"
	"strings"

	"github.com/younsl/o/box/kubernetes/argocd-promotion-gate/internal/config"
)

// Input is everything a verdict depends on, gathered before evaluation so the
// decision itself stays pure.
type Input struct {
	// App is the Application whose sync is being judged.
	App AppSnapshot
	// Upstream is the upstream Application, nil when it does not exist.
	Upstream *AppSnapshot
	// DesiredImages are the images the pending sync would deploy, nil when the
	// lookup was skipped or failed.
	DesiredImages []ImageRef
	// LookupError explains why a fact could not be read.
	LookupError string
}

// Evaluate applies the configured checks and returns the verdict.
//
// The order is deliberate: structural checks first, then upstream status, then
// the image comparison, which is the only check that depends on a remote
// lookup. A denial therefore never costs an Argo CD API call it did not need.
//
// Every message is written for the person who pressed Sync and reads it in the
// Argo CD error toast. It names the application, the upstream it is waiting on,
// the observed state, and what to do next, because that toast is usually the
// only explanation anyone gets.
func Evaluate(in Input, cfg config.Config) Decision {
	app := in.App

	if !cfg.IsGated(app.Project) {
		return NotGated(app.Name, app.Project, app.Identity)
	}

	// IsGated is true only for an env with a predecessor in the chain, so the
	// upstream env always resolves from here on.
	upstreamEnv, _ := cfg.UpstreamEnv(app.Project)
	upstreamApp := AppNameFor(upstreamEnv, app.Identity)

	base := Decision{
		App:      app.Name,
		Env:      app.Project,
		Identity: app.Identity,
		Gated:    true,
	}

	if app.SkipRequested {
		base.Allowed = true
		base.Code = CodeExempt
		base.Message = fmt.Sprintf(
			"Sync of %s is allowed. The Application carries the annotation %s set to true which opts it out of the promotion gate entirely. No upstream environment was checked and no image tag was compared. Remove that annotation to bring %s back under enforcement.",
			app.Name, cfg.Exempt.Annotation, app.Name)
		return base
	}

	// A rollback is judged before anything upstream is consulted. The revision
	// ran here before, so nothing new can enter the environment, and an incident
	// must not depend on the upstream being healthy enough to satisfy a gate.
	if cfg.Rollback.AllowPreviouslyDeployedRevision && app.IsRollback() {
		base.Allowed = true
		base.Code = CodeRollback
		base.Message = fmt.Sprintf(
			"Sync of %s is allowed. It targets revision %s which this environment has already deployed so this is a rollback rather than a promotion. A revision that ran here before cannot introduce an image this environment has never run. The upstream state and the image tags were therefore not checked.",
			app.Name, app.PendingRevision)
		return base
	}

	if in.Upstream == nil {
		// A failed read must not look like an absent upstream: that would open
		// the gate on every Kubernetes hiccup.
		if in.LookupError != "" {
			base.Allowed = cfg.ImageTag.OnError == config.OnErrorAllow
			base.Code = CodeLookupFailed
			base.Message = fmt.Sprintf(
				"Sync of %s is %s. The promotion gate could not read its upstream counterpart %s from the Kubernetes API so it cannot tell whether %s has been promoted yet. The underlying error was %s. A read failure is never treated as an absent upstream because that would silently open the gate. Retry the sync once the API is healthy or set imageTag.onError to allow if a lookup failure should not stand in the way of a deploy.",
				app.Name, verb(base.Allowed), upstreamApp, upstreamEnv, in.LookupError)
			base.Warnings = []string{in.LookupError}
			return base
		}
		// An absent upstream is always allowed, and this is not configurable on
		// purpose. An application that exists in no upstream environment has
		// nothing to be promoted from, so refusing it would leave it
		// permanently undeployable rather than governed. In the estate this was
		// built for that describes roughly a quarter of production apps.
		base.Allowed = true
		base.Code = CodeUpstreamMissing
		base.Message = fmt.Sprintf(
			"Sync of %s is allowed. No Application named %s exists in the %s environment so this application has no upstream counterpart to be promoted from and nothing to wait for. The promotion gate only compares an application against an upstream that actually exists. If %s is created later the gate starts enforcing on the next sync of %s.",
			app.Name, upstreamApp, upstreamEnv, upstreamApp, app.Name)
		return base
	}

	upstream := *in.Upstream

	if cfg.Require.Sync && !upstream.IsSynced() {
		base.Allowed = false
		base.Code = CodeUpstreamOutOfSync
		base.Message = fmt.Sprintf(
			"Sync of %s is blocked. Its upstream counterpart %s reports sync status %s. Promotion into %s requires the %s environment to be Synced first so that whatever reaches %s has already been applied one environment earlier. Sync %s and wait for it to settle then retry this sync.",
			app.Name, upstreamApp, upstream.SyncOrUnknown(), app.Project, upstreamEnv, app.Project, upstreamApp)
		return base
	}

	if cfg.Require.Health && !upstream.IsHealthy() {
		base.Allowed = false
		base.Code = CodeUpstreamUnhealthy
		base.Message = fmt.Sprintf(
			"Sync of %s is blocked. Its upstream counterpart %s is Synced but reports health status %s. Promotion into %s requires the %s environment to be Healthy so that a release which is already failing upstream cannot move any further. Fix %s until it reports Healthy then retry this sync.",
			app.Name, upstreamApp, upstream.HealthOrUnknown(), app.Project, upstreamEnv, upstreamApp)
		return base
	}

	if !cfg.ImageTag.Enabled {
		base.Allowed = true
		base.Code = CodePassed
		base.Message = fmt.Sprintf(
			"Sync of %s is allowed. Its upstream counterpart %s is Synced and Healthy. Image tag comparison is disabled in this deployment so nothing was checked about which image this sync would deploy.",
			app.Name, upstreamApp)
		return base
	}

	if in.DesiredImages == nil {
		reason := in.LookupError
		if reason == "" {
			reason = "the desired image lookup returned nothing at all"
		}
		base.Allowed = cfg.ImageTag.OnError == config.OnErrorAllow
		base.Code = CodeLookupFailed
		base.Message = fmt.Sprintf(
			"Sync of %s is %s. Its upstream counterpart %s is Synced and Healthy but the promotion gate could not resolve which images this sync would actually deploy so it cannot compare them against what %s is running. The underlying error was %s. Check that the Argo CD API token is mounted and that argocd-server is reachable from the gate or set imageTag.onError to allow if a lookup failure should not stand in the way of a deploy.",
			app.Name, verb(base.Allowed), upstreamApp, upstreamEnv, reason)
		base.Warnings = []string{reason}
		return base
	}

	comparisons := CompareImages(in.DesiredImages, upstream.LiveImages, cfg.ImageTag.IgnoreRepos)
	base.Images = comparisons

	if len(comparisons) == 0 {
		base.Allowed = true
		base.Code = CodePassed
		base.Message = fmt.Sprintf(
			"Sync of %s is allowed. Its upstream counterpart %s is Synced and Healthy. No image repository could be compared between the two so no image tag was verified.",
			app.Name, upstreamApp)
		base.Warnings = []string{fmt.Sprintf(
			"No image repository is comparable between %s and %s so image tags were not checked at all. This happens when the two environments share no repository basename which is normal if a sidecar or an agent exists on one side only. Add the repositories that differ by design to imageTag.ignoreRepos if you want that stated explicitly.",
			app.Name, upstreamApp)}
		return base
	}

	mismatches := mismatchSentences(comparisons, app.Project, upstreamEnv, upstreamApp)

	if len(mismatches) == 0 {
		base.Allowed = true
		base.Code = CodePassed
		base.Message = fmt.Sprintf(
			"Sync of %s is allowed. Its upstream counterpart %s is Synced and Healthy and already runs the same image %s that this sync would deploy.",
			app.Name, upstreamApp, plural("tag", len(comparisons)))
		return base
	}

	detail := strings.Join(mismatches, " ")
	base.Code = CodeImageTagMismatch
	if cfg.ImageTag.Mode == config.ImageTagModeEnforce {
		base.Allowed = false
		base.Message = fmt.Sprintf(
			"Sync of %s is blocked. Its upstream counterpart %s is Synced and Healthy but this sync would deploy an image %s that the %s environment is not running. %s Promote the same %s through %s first so that every image reaching %s has already run one environment earlier.",
			app.Name, upstreamApp, plural("tag", len(mismatches)), upstreamEnv, detail,
			plural("tag", len(mismatches)), upstreamEnv, app.Project)
		return base
	}
	base.Allowed = true
	base.Message = fmt.Sprintf(
		"Sync of %s is allowed with a warning. Its upstream counterpart %s is Synced and Healthy but this sync would deploy an image %s that the %s environment is not running. %s The gate is running with imageTag.mode set to warn so the mismatch is only reported.",
		app.Name, upstreamApp, plural("tag", len(mismatches)), upstreamEnv, detail)
	base.Warnings = []string{fmt.Sprintf(
		"Image tag mismatch was allowed because imageTag.mode is set to warn. %s Switching imageTag.mode to enforce would block this sync.",
		detail)}
	return base
}

// mismatchSentences turns each failing comparison into one self-contained
// sentence, so a multi-image mismatch reads as prose rather than a list the
// Argo CD toast would flatten anyway.
func mismatchSentences(comparisons []ImageComparison, env, upstreamEnv, upstreamApp string) []string {
	var out []string
	for _, cmp := range comparisons {
		if cmp.Matched {
			continue
		}
		out = append(out, fmt.Sprintf(
			"Repository %s would be deployed to %s with %s while %s in %s is running with %s.",
			cmp.Repository, env, refPhrase(cmp.DesiredTag), upstreamApp, upstreamEnv, refPhrase(cmp.UpstreamTag)))
	}
	return out
}

// refPhrase describes a tag or digest in a form that reads inside a sentence.
func refPhrase(ref string) string {
	if ref == "" {
		return "no resolvable tag or digest"
	}
	if strings.Contains(ref, ":") {
		return "digest " + ref
	}
	return "tag " + ref
}

func plural(word string, count int) string {
	if count > 1 {
		return word + "s"
	}
	return word
}

func verb(allowed bool) string {
	if allowed {
		return "allowed"
	}
	return "blocked"
}

// WithUpstream attaches the upstream summary to a verdict for the API and log
// surfaces.
func WithUpstream(verdict Decision, upstreamEnv, upstreamApp string, upstream *AppSnapshot) Decision {
	status := &UpstreamStatus{
		App:    upstreamApp,
		Env:    upstreamEnv,
		Exists: upstream != nil,
	}
	if upstream != nil {
		status.SyncStatus = upstream.SyncStatus
		status.HealthStatus = upstream.HealthStatus
	}
	verdict.Upstream = status
	return verdict
}
