package gate

import (
	"strings"
	"testing"

	"github.com/younsl/o/box/kubernetes/argocd-promotion-gate/internal/config"
)

func baseConfig() config.Config {
	cfg := config.Default()
	cfg.Chain = []string{"dev", "sb", "stg", "prd"}
	cfg.GatedEnvs = []string{"prd"}
	cfg.ImageTag.Enabled = false
	return cfg
}

func imageConfig(mode config.ImageTagMode) config.Config {
	cfg := baseConfig()
	cfg.ImageTag.Enabled = true
	cfg.ImageTag.Mode = mode
	cfg.ImageTag.IgnoreRepos = []string{"nginx"}
	return cfg
}

func app(name, project, sync, health string) AppSnapshot {
	return AppSnapshot{
		Name:         name,
		Project:      project,
		Identity:     IdentityOf(name, project),
		SyncStatus:   sync,
		HealthStatus: health,
	}
}

func promoted(name, project string) AppSnapshot {
	return app(name, project, SyncSynced, HealthHealthy)
}

func TestEvaluateUngatedEnvironments(t *testing.T) {
	cfg := baseConfig()

	// The chain head has nothing upstream, so it can never be gated.
	head := Evaluate(Input{App: promoted("dev-payment-api", "dev")}, cfg)
	if !head.Allowed || head.Gated || head.Code != CodeNotGated {
		t.Errorf("chain head verdict = %+v, want an ungated allow", head)
	}

	// stg sits in the chain but is not listed in GatedEnvs.
	unlisted := Evaluate(Input{App: promoted("stg-payment-api", "stg")}, cfg)
	if !unlisted.Allowed || unlisted.Code != CodeNotGated {
		t.Errorf("unlisted env verdict = %+v, want an ungated allow", unlisted)
	}

	// An env outside the chain entirely.
	outside := Evaluate(Input{App: promoted("shared-tools", "shared")}, cfg)
	if !outside.Allowed || outside.Code != CodeNotGated {
		t.Errorf("out-of-chain verdict = %+v, want an ungated allow", outside)
	}
}

func TestEvaluateMissingUpstream(t *testing.T) {
	// The exception the gate is explicitly required to honour: an app with no
	// counterpart upstream is not promotable, so it must not be blocked. In the
	// estate this was built for that covers roughly a quarter of prd apps.
	allow := Evaluate(Input{App: promoted("prd-payment-api", "prd")}, baseConfig())
	if !allow.Allowed {
		t.Errorf("missing upstream denied by default: %s", allow.Message)
	}
	if allow.Code != CodeUpstreamMissing || !allow.Gated {
		t.Errorf("verdict = %+v, want a gated UpstreamMissing allow", allow)
	}
	if !strings.Contains(allow.Message, "stg-payment-api") {
		t.Errorf("message %q does not name the upstream it looked for", allow.Message)
	}

	// The allowance is not configurable, and that is the point. Enforcing here
	// would leave every application without an upstream counterpart permanently
	// undeployable instead of governed.
	strict := baseConfig()
	strict.ImageTag.Enabled = true
	strict.ImageTag.Mode = config.ImageTagModeEnforce
	strict.ImageTag.OnError = config.OnErrorDeny
	if got := Evaluate(Input{App: promoted("prd-payment-api", "prd")}, strict); !got.Allowed {
		t.Errorf("an absent upstream was denied under the strictest settings: %s", got.Message)
	}
}

func TestEvaluateUpstreamLookupFailureIsNotTreatedAsMissing(t *testing.T) {
	// A failed read must never look like an absent upstream, which would open
	// the gate on any Kubernetes hiccup.
	cfg := baseConfig()
	cfg.ImageTag.OnError = config.OnErrorDeny
	verdict := Evaluate(Input{
		App:         promoted("prd-payment-api", "prd"),
		LookupError: "etcdserver: request timed out",
	}, cfg)
	if verdict.Allowed {
		t.Error("a failed upstream lookup allowed the sync")
	}
	if verdict.Code != CodeLookupFailed {
		t.Errorf("Code = %q, want %q", verdict.Code, CodeLookupFailed)
	}

	cfg.ImageTag.OnError = config.OnErrorAllow
	if got := Evaluate(Input{
		App:         promoted("prd-payment-api", "prd"),
		LookupError: "etcdserver: request timed out",
	}, cfg); !got.Allowed {
		t.Error("onError: allow still denied a failed lookup")
	}
}

func TestEvaluateUpstreamStatus(t *testing.T) {
	cases := []struct {
		name     string
		upstream AppSnapshot
		wantCode Code
	}{
		{"out of sync", app("stg-payment-api", "stg", "OutOfSync", HealthHealthy), CodeUpstreamOutOfSync},
		{"unreconciled", app("stg-payment-api", "stg", "", ""), CodeUpstreamOutOfSync},
		{"degraded", app("stg-payment-api", "stg", SyncSynced, "Degraded"), CodeUpstreamUnhealthy},
		{"progressing", app("stg-payment-api", "stg", SyncSynced, "Progressing"), CodeUpstreamUnhealthy},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			verdict := Evaluate(Input{
				App:      promoted("prd-payment-api", "prd"),
				Upstream: &tc.upstream,
			}, baseConfig())
			if verdict.Allowed {
				t.Errorf("verdict allowed the sync: %s", verdict.Message)
			}
			if verdict.Code != tc.wantCode {
				t.Errorf("Code = %q, want %q", verdict.Code, tc.wantCode)
			}
		})
	}
}

func TestEvaluateRequirementsCanBeRelaxed(t *testing.T) {
	cfg := baseConfig()
	cfg.Require.Health = false
	upstream := app("stg-payment-api", "stg", SyncSynced, "Degraded")
	verdict := Evaluate(Input{App: promoted("prd-payment-api", "prd"), Upstream: &upstream}, cfg)
	if !verdict.Allowed || verdict.Code != CodePassed {
		t.Errorf("verdict = %+v, want a pass with health checking off", verdict)
	}

	cfg = baseConfig()
	cfg.Require.Sync = false
	outOfSync := app("stg-payment-api", "stg", "OutOfSync", HealthHealthy)
	verdict = Evaluate(Input{App: promoted("prd-payment-api", "prd"), Upstream: &outOfSync}, cfg)
	if !verdict.Allowed {
		t.Errorf("verdict = %+v, want a pass with sync checking off", verdict)
	}
}

func TestEvaluateSkipAnnotation(t *testing.T) {
	target := promoted("prd-payment-api", "prd")
	target.SkipRequested = true
	upstream := app("stg-payment-api", "stg", "OutOfSync", "Degraded")
	verdict := Evaluate(Input{App: target, Upstream: &upstream}, baseConfig())
	if !verdict.Allowed || verdict.Code != CodeExempt {
		t.Errorf("verdict = %+v, want an Exempt allow", verdict)
	}
	if !strings.Contains(verdict.Message, baseConfig().Exempt.Annotation) {
		t.Errorf("message %q does not name the annotation", verdict.Message)
	}
}

// A rollback has to get through. The revision ran in this environment before,
// so it cannot introduce an image the environment has not run, and an incident
// must not depend on the upstream being healthy enough to satisfy a gate.
func TestEvaluateRollbackIsAllowed(t *testing.T) {
	cfg := imageConfig(config.ImageTagModeEnforce)

	// The upstream is deliberately in the worst possible state.
	upstream := app("beta-payment-api", "beta", "OutOfSync", "Degraded")
	upstream.LiveImages = []ImageRef{ParseImage("b.example/payment-api:0.2.0")}

	target := promoted("prd-payment-api", "prd")
	target.PendingRevision = "abc1234"
	target.CurrentRevision = "def5678"
	target.DeployedRevisions = []string{"def5678", "abc1234"}

	verdict := Evaluate(Input{
		App:           target,
		Upstream:      &upstream,
		DesiredImages: []ImageRef{ParseImage("a.example/payment-api:0.1.0")},
	}, cfg)

	if !verdict.Allowed {
		t.Fatalf("a rollback was denied: %s", verdict.Message)
	}
	if verdict.Code != CodeRollback {
		t.Errorf("Code = %q, want %q", verdict.Code, CodeRollback)
	}
	if !strings.Contains(verdict.Message, "abc1234") {
		t.Errorf("message %q does not name the revision", verdict.Message)
	}
}

func TestEvaluateForwardSyncIsNotARollback(t *testing.T) {
	cfg := imageConfig(config.ImageTagModeEnforce)
	upstream := promoted("beta-payment-api", "beta")
	upstream.LiveImages = []ImageRef{ParseImage("b.example/payment-api:0.1.0")}

	target := promoted("prd-payment-api", "prd")
	// A revision this environment has never deployed is a promotion, not a
	// rollback, however much it looks like one.
	target.PendingRevision = "newsha1"
	target.DeployedRevisions = []string{"def5678", "abc1234"}

	verdict := Evaluate(Input{
		App:           target,
		Upstream:      &upstream,
		DesiredImages: []ImageRef{ParseImage("a.example/payment-api:0.2.0")},
	}, cfg)

	if verdict.Allowed {
		t.Error("a forward sync was treated as a rollback")
	}
	if verdict.Code != CodeImageTagMismatch {
		t.Errorf("Code = %q, want %q", verdict.Code, CodeImageTagMismatch)
	}
}

func TestEvaluateRollbackAllowanceCanBeDisabled(t *testing.T) {
	cfg := imageConfig(config.ImageTagModeEnforce)
	cfg.Rollback.AllowPreviouslyDeployedRevision = false

	upstream := promoted("beta-payment-api", "beta")
	upstream.LiveImages = []ImageRef{ParseImage("b.example/payment-api:0.2.0")}

	target := promoted("prd-payment-api", "prd")
	target.PendingRevision = "abc1234"
	target.CurrentRevision = "def5678"
	target.DeployedRevisions = []string{"def5678", "abc1234"}

	verdict := Evaluate(Input{
		App:           target,
		Upstream:      &upstream,
		DesiredImages: []ImageRef{ParseImage("a.example/payment-api:0.1.0")},
	}, cfg)

	if verdict.Allowed {
		t.Error("the rollback allowance was disabled but the sync was still allowed")
	}
}

func TestIsRollback(t *testing.T) {
	cases := []struct {
		name     string
		pending  string
		deployed []string
		want     bool
	}{
		{"revision was deployed here", "abc", []string{"xyz", "abc"}, true},
		{"revision is new", "abc", []string{"xyz"}, false},
		{"no pending revision", "", []string{"abc"}, false},
		{"no history", "abc", nil, false},
		// A chart version source keeps the same revision across desired states,
		// so targeting what is already live is a normal sync and not a rollback.
		{"revision is the one already live", "live", []string{"live"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			current := "live"
			snap := AppSnapshot{PendingRevision: tc.pending, CurrentRevision: current, DeployedRevisions: tc.deployed}
			if got := snap.IsRollback(); got != tc.want {
				t.Errorf("IsRollback() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestEvaluateImageTagComparison(t *testing.T) {
	upstream := promoted("stg-payment-api", "stg")
	upstream.LiveImages = []ImageRef{
		ParseImage("210987654321.dkr.ecr.example/payment-api:tag-old"),
		ParseImage("210987654321.dkr.ecr.example/nginx:1.21-alpine"),
	}

	t.Run("matching tag passes", func(t *testing.T) {
		matching := promoted("stg-payment-api", "stg")
		matching.LiveImages = []ImageRef{ParseImage("210987654321.dkr.ecr.example/payment-api:tag-new")}
		verdict := Evaluate(Input{
			App:           promoted("prd-payment-api", "prd"),
			Upstream:      &matching,
			DesiredImages: []ImageRef{ParseImage("123456789012.dkr.ecr.example/payment-api:tag-new")},
		}, imageConfig(config.ImageTagModeEnforce))
		if !verdict.Allowed || verdict.Code != CodePassed {
			t.Errorf("verdict = %+v, want a pass", verdict)
		}
		if len(verdict.Images) != 1 || !verdict.Images[0].Matched {
			t.Errorf("Images = %+v, want one match", verdict.Images)
		}
	})

	t.Run("enforce denies a mismatch", func(t *testing.T) {
		verdict := Evaluate(Input{
			App:           promoted("prd-payment-api", "prd"),
			Upstream:      &upstream,
			DesiredImages: []ImageRef{ParseImage("123456789012.dkr.ecr.example/payment-api:tag-new")},
		}, imageConfig(config.ImageTagModeEnforce))
		if verdict.Allowed {
			t.Error("enforce mode allowed a tag mismatch")
		}
		if verdict.Code != CodeImageTagMismatch {
			t.Errorf("Code = %q, want %q", verdict.Code, CodeImageTagMismatch)
		}
		for _, want := range []string{"tag-new", "tag-old", "payment-api"} {
			if !strings.Contains(verdict.Message, want) {
				t.Errorf("message %q is missing %q, which the operator needs to act", verdict.Message, want)
			}
		}
	})

	t.Run("warn allows a mismatch but reports it", func(t *testing.T) {
		verdict := Evaluate(Input{
			App:           promoted("prd-payment-api", "prd"),
			Upstream:      &upstream,
			DesiredImages: []ImageRef{ParseImage("123456789012.dkr.ecr.example/payment-api:tag-new")},
		}, imageConfig(config.ImageTagModeWarn))
		if !verdict.Allowed {
			t.Error("warn mode denied a tag mismatch")
		}
		if verdict.Code != CodeImageTagMismatch {
			t.Errorf("Code = %q, want %q", verdict.Code, CodeImageTagMismatch)
		}
		if len(verdict.Warnings) != 1 {
			t.Errorf("Warnings = %v, want exactly one", verdict.Warnings)
		}
	})

	t.Run("an ignored sidecar cannot block", func(t *testing.T) {
		verdict := Evaluate(Input{
			App:      promoted("prd-payment-api", "prd"),
			Upstream: &upstream,
			DesiredImages: []ImageRef{
				ParseImage("123456789012.dkr.ecr.example/payment-api:tag-old"),
				ParseImage("123456789012.dkr.ecr.example/nginx:1.20-alpine"),
			},
		}, imageConfig(config.ImageTagModeEnforce))
		if !verdict.Allowed {
			t.Errorf("an ignored sidecar blocked the sync: %s", verdict.Message)
		}
		if len(verdict.Images) != 1 {
			t.Errorf("Images = %+v, want only the application image", verdict.Images)
		}
	})

	t.Run("no comparable repository passes with a warning", func(t *testing.T) {
		otel := promoted("stg-payment-api", "stg")
		otel.LiveImages = []ImageRef{ParseImage("ghcr.io/example/otel-agent:1.0.0")}
		verdict := Evaluate(Input{
			App:           promoted("prd-payment-api", "prd"),
			Upstream:      &otel,
			DesiredImages: []ImageRef{ParseImage("123456789012.dkr.ecr.example/payment-api:tag-new")},
		}, imageConfig(config.ImageTagModeEnforce))
		if !verdict.Allowed || verdict.Code != CodePassed {
			t.Errorf("verdict = %+v, want a pass", verdict)
		}
		if len(verdict.Warnings) != 1 {
			t.Errorf("Warnings = %v, want one explaining that nothing was comparable", verdict.Warnings)
		}
	})

	t.Run("an empty desired set is a real answer", func(t *testing.T) {
		// A workload-less app (a bare ConfigMap tree) resolves to zero images.
		// That is a successful lookup, not a failure.
		verdict := Evaluate(Input{
			App:           promoted("prd-payment-api", "prd"),
			Upstream:      &upstream,
			DesiredImages: []ImageRef{},
		}, imageConfig(config.ImageTagModeEnforce))
		if !verdict.Allowed || verdict.Code != CodePassed {
			t.Errorf("verdict = %+v, want a pass", verdict)
		}
	})

	t.Run("image lookup failure follows onError", func(t *testing.T) {
		cfg := imageConfig(config.ImageTagModeEnforce)
		cfg.ImageTag.OnError = config.OnErrorDeny
		deny := Evaluate(Input{
			App:         promoted("prd-payment-api", "prd"),
			Upstream:    &upstream,
			LookupError: "argocd api returned 503",
		}, cfg)
		if deny.Allowed {
			t.Error("onError: deny allowed a failed image lookup")
		}
		if deny.Code != CodeLookupFailed || !strings.Contains(deny.Message, "503") {
			t.Errorf("verdict = %+v, want a LookupFailed denial naming the cause", deny)
		}

		cfg.ImageTag.OnError = config.OnErrorAllow
		allow := Evaluate(Input{
			App:         promoted("prd-payment-api", "prd"),
			Upstream:    &upstream,
			LookupError: "timeout",
		}, cfg)
		if !allow.Allowed {
			t.Error("onError: allow denied a failed image lookup")
		}
	})

	t.Run("missing lookup error still reports a reason", func(t *testing.T) {
		cfg := imageConfig(config.ImageTagModeEnforce)
		verdict := Evaluate(Input{
			App:      promoted("prd-payment-api", "prd"),
			Upstream: &upstream,
		}, cfg)
		if verdict.Code != CodeLookupFailed || verdict.Message == "" {
			t.Errorf("verdict = %+v, want a LookupFailed with a message", verdict)
		}
	})

	t.Run("multiple images pluralize the pass message", func(t *testing.T) {
		multi := promoted("stg-payment-api", "stg")
		multi.LiveImages = []ImageRef{
			ParseImage("b.example/payment-api:v1"),
			ParseImage("b.example/worker:v1"),
		}
		verdict := Evaluate(Input{
			App:      promoted("prd-payment-api", "prd"),
			Upstream: &multi,
			DesiredImages: []ImageRef{
				ParseImage("a.example/payment-api:v1"),
				ParseImage("a.example/worker:v1"),
			},
		}, imageConfig(config.ImageTagModeEnforce))
		if !verdict.Allowed {
			t.Errorf("verdict = %+v, want a pass", verdict)
		}
		if !strings.Contains(verdict.Message, "tags") {
			t.Errorf("message %q should read as plural for two images", verdict.Message)
		}
	})
}

func TestEvaluateSkipsImageCheckWhenDisabled(t *testing.T) {
	upstream := promoted("stg-payment-api", "stg")
	upstream.LiveImages = []ImageRef{ParseImage("b.example/payment-api:old")}
	verdict := Evaluate(Input{
		App:           promoted("prd-payment-api", "prd"),
		Upstream:      &upstream,
		DesiredImages: []ImageRef{ParseImage("a.example/payment-api:new")},
	}, baseConfig())
	if !verdict.Allowed || verdict.Code != CodePassed {
		t.Errorf("verdict = %+v, want a pass when imageTag.enabled is false", verdict)
	}
	if len(verdict.Images) != 0 {
		t.Errorf("Images = %+v, want none when the check is disabled", verdict.Images)
	}
}

func TestWithUpstream(t *testing.T) {
	upstream := promoted("stg-payment-api", "stg")
	verdict := WithUpstream(Decision{}, "stg", "stg-payment-api", &upstream)
	if verdict.Upstream == nil {
		t.Fatal("Upstream = nil, want a summary")
	}
	if !verdict.Upstream.Exists || verdict.Upstream.SyncStatus != SyncSynced {
		t.Errorf("Upstream = %+v, want an existing Synced summary", verdict.Upstream)
	}

	absent := WithUpstream(Decision{}, "stg", "stg-payment-api", nil)
	if absent.Upstream.Exists {
		t.Error("Upstream.Exists = true for a nil upstream")
	}
	if absent.Upstream.App != "stg-payment-api" || absent.Upstream.Env != "stg" {
		t.Errorf("Upstream = %+v, want the app and env named even when absent", absent.Upstream)
	}
}

func TestRefPhrase(t *testing.T) {
	cases := map[string]string{
		"":            "no resolvable tag or digest",
		"tag-abc":     "tag tag-abc",
		"sha256:aaaa": "digest sha256:aaaa",
	}
	for ref, want := range cases {
		if got := refPhrase(ref); got != want {
			t.Errorf("refPhrase(%q) = %q, want %q", ref, got, want)
		}
	}
}

func TestPluralAndVerb(t *testing.T) {
	if got := plural("tag", 1); got != "tag" {
		t.Errorf("plural(tag, 1) = %q, want tag", got)
	}
	if got := plural("tag", 2); got != "tags" {
		t.Errorf("plural(tag, 2) = %q, want tags", got)
	}
	if got := verb(true); got != "allowed" {
		t.Errorf("verb(true) = %q, want allowed", got)
	}
	if got := verb(false); got != "blocked" {
		t.Errorf("verb(false) = %q, want blocked", got)
	}
}

// Every verdict message is read by a person in an Argo CD toast, so the wording
// rules are part of the contract: no comma, no semicolon, and no middle dot.
func TestMessagesFollowTheWordingRules(t *testing.T) {
	upstreamOutOfSync := app("stg-payment-api", "stg", "OutOfSync", HealthHealthy)
	upstreamDegraded := app("stg-payment-api", "stg", SyncSynced, "Degraded")
	promotedUpstream := promoted("stg-payment-api", "stg")
	promotedUpstream.LiveImages = []ImageRef{ParseImage("210987654321.dkr.ecr.example/payment-api:tag-old")}
	skipped := promoted("prd-payment-api", "prd")
	skipped.SkipRequested = true

	multi := promoted("stg-payment-api", "stg")
	multi.LiveImages = []ImageRef{
		ParseImage("210987654321.dkr.ecr.example/payment-api:tag-old"),
		ParseImage("210987654321.dkr.ecr.example/worker:tag-old"),
	}

	rollback := promoted("prd-payment-api", "prd")
	rollback.PendingRevision = "abc1234"
	rollback.CurrentRevision = "def5678"
	rollback.DeployedRevisions = []string{"def5678", "abc1234"}

	verdicts := []Decision{
		Evaluate(Input{App: promoted("dev-payment-api", "dev")}, baseConfig()),
		Evaluate(Input{App: rollback, Upstream: &promotedUpstream}, baseConfig()),
		Evaluate(Input{App: promoted("prd-payment-api", "prd")}, baseConfig()),
		Evaluate(Input{App: skipped}, baseConfig()),
		Evaluate(Input{App: promoted("prd-payment-api", "prd"), Upstream: &upstreamOutOfSync}, baseConfig()),
		Evaluate(Input{App: promoted("prd-payment-api", "prd"), Upstream: &upstreamDegraded}, baseConfig()),
		Evaluate(Input{App: promoted("prd-payment-api", "prd"), Upstream: &promotedUpstream}, baseConfig()),
		Evaluate(Input{
			App:           promoted("prd-payment-api", "prd"),
			Upstream:      &promotedUpstream,
			DesiredImages: []ImageRef{ParseImage("123456789012.dkr.ecr.example/payment-api:tag-new")},
		}, imageConfig(config.ImageTagModeEnforce)),
		Evaluate(Input{
			App:           promoted("prd-payment-api", "prd"),
			Upstream:      &promotedUpstream,
			DesiredImages: []ImageRef{ParseImage("123456789012.dkr.ecr.example/payment-api:tag-new")},
		}, imageConfig(config.ImageTagModeWarn)),
		Evaluate(Input{
			App:      promoted("prd-payment-api", "prd"),
			Upstream: &multi,
			DesiredImages: []ImageRef{
				ParseImage("123456789012.dkr.ecr.example/payment-api:tag-new"),
				ParseImage("123456789012.dkr.ecr.example/worker:tag-new"),
			},
		}, imageConfig(config.ImageTagModeEnforce)),
		Evaluate(Input{
			App:           promoted("prd-payment-api", "prd"),
			Upstream:      &promotedUpstream,
			DesiredImages: []ImageRef{ParseImage("123456789012.dkr.ecr.example/payment-api:tag-old")},
		}, imageConfig(config.ImageTagModeEnforce)),
	}

	banned := []string{",", ";", "\u00b7"}
	for _, verdict := range verdicts {
		texts := append([]string{verdict.Message}, verdict.Warnings...)
		for _, text := range texts {
			if text == "" {
				t.Errorf("verdict %s produced an empty message", verdict.Code)
				continue
			}
			for _, char := range banned {
				if strings.Contains(text, char) {
					t.Errorf("verdict %s message contains %q: %s", verdict.Code, char, text)
				}
			}
			// A one-clause message tells nobody what to do next.
			if len(strings.Fields(text)) < 12 {
				t.Errorf("verdict %s message is too terse to act on: %s", verdict.Code, text)
			}
		}
	}
}

// The blocked messages have to name the things an operator needs in order to
// act, because the toast is usually the only explanation they get.
func TestBlockedMessagesNameTheUpstreamAndTheFix(t *testing.T) {
	upstream := promoted("stg-payment-api", "stg")
	upstream.LiveImages = []ImageRef{ParseImage("210987654321.dkr.ecr.example/payment-api:tag-old")}

	verdict := Evaluate(Input{
		App:           promoted("prd-payment-api", "prd"),
		Upstream:      &upstream,
		DesiredImages: []ImageRef{ParseImage("123456789012.dkr.ecr.example/payment-api:tag-new")},
	}, imageConfig(config.ImageTagModeEnforce))

	for _, want := range []string{"prd-payment-api", "stg-payment-api", "payment-api", "tag-new", "tag-old", "stg", "prd"} {
		if !strings.Contains(verdict.Message, want) {
			t.Errorf("message is missing %q: %s", want, verdict.Message)
		}
	}
}
