package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// validYAML is a minimal config that passes validation, so each test can break one
// field at a time.
const validYAML = `
region: ap-northeast-2
targets:
  tagFilters:
    - key: managed
      value: "true"
approval:
  slackUserIDs:
    - U0123456789
`

// writeConfig writes body to a temp file and sets the environment a Pod would have.
func writeConfig(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	t.Setenv("SLACK_BOT_TOKEN", "xoxb-test")
	t.Setenv("SLACK_APP_TOKEN", "xapp-test")
	t.Setenv("POD_NAME", "aws-vpn-maintenance-handler-0")
	t.Setenv("POD_NAMESPACE", "ops")
	t.Setenv("POD_UID", "uid-1")
	return path
}

func TestLoadAppliesDefaults(t *testing.T) {
	cfg, err := Load(writeConfig(t, validYAML))
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}

	// Dry run defaults on: an operator must opt in to irreversible replacements.
	if !cfg.DryRun {
		t.Fatal("dryRun must default to true")
	}
	if cfg.Safety.PerConnectionCooldown.D() != 24*time.Hour {
		t.Fatalf("cooldown default = %s, want 24h", cfg.Safety.PerConnectionCooldown)
	}
	if cfg.Safety.PeerMinStableFor.D() != 5*time.Minute {
		t.Fatalf("peerMinStableFor default = %s, want 5m", cfg.Safety.PeerMinStableFor)
	}
	if cfg.Safety.PeerMinAcceptedRoutes != 1 {
		t.Fatalf("peerMinAcceptedRoutes default = %d, want 1", cfg.Safety.PeerMinAcceptedRoutes)
	}
	if !cfg.LeaderElect {
		t.Fatal("leaderElect must default to true")
	}
	if cfg.SlackBotToken != "xoxb-test" || cfg.SlackAppToken != "xapp-test" {
		t.Fatal("Slack tokens must come from the environment, not the file")
	}
	if cfg.PodNamespace != "ops" {
		t.Fatalf("PodNamespace = %q, want ops (downward API)", cfg.PodNamespace)
	}
}

func TestLoadParsesDurationStrings(t *testing.T) {
	// minRemaining is raised alongside verifyTimeout: the two are validated against
	// each other, so a longer verification needs a longer required window remainder.
	cfg, err := Load(writeConfig(t, validYAML+`
reconcileInterval: "90s"
maintenanceWindow:
  duration: "4h"
  minRemaining: "2h"
safety:
  verifyTimeout: "1h30m"
`))
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if got, want := cfg.ReconcileInterval.D(), 90*time.Second; got != want {
		t.Fatalf("reconcileInterval = %s, want %s", got, want)
	}
	if got, want := cfg.Safety.VerifyTimeout.D(), 90*time.Minute; got != want {
		t.Fatalf("verifyTimeout = %s, want %s", got, want)
	}
}

// The Helm chart declares the tunable durations as an explicit null so they are
// visible in values.yaml without being set. That has to mean "keep the default"
// rather than "zero", which would drop the flapping check entirely.
func TestLoadTreatsAnExplicitNullDurationAsUnset(t *testing.T) {
	for _, body := range []string{`
safety:
  peerMinStableFor: ~
`, `
safety:
  peerMinStableFor: null
`, `
safety:
  peerMinStableFor: ""
`} {
		cfg, err := Load(writeConfig(t, validYAML+body))
		if err != nil {
			t.Fatalf("Load returned error for %q: %v", body, err)
		}
		if got, want := cfg.Safety.PeerMinStableFor.D(), 5*time.Minute; got != want {
			t.Fatalf("peerMinStableFor = %s for %q, want the %s default", got, body, want)
		}
	}
}

func TestLoadRejectsAMalformedDuration(t *testing.T) {
	_, err := Load(writeConfig(t, validYAML+`
reconcileInterval: "5 minutes"
`))
	if err == nil {
		t.Fatal("a malformed duration must fail at startup")
	}
	if !strings.Contains(err.Error(), "invalid duration") {
		t.Fatalf("error = %v, want it to name the invalid duration", err)
	}
}

// A typo in a safety threshold must fail rather than silently leave the default in
// place, which would look like the setting had been applied.
func TestLoadRejectsUnknownKeys(t *testing.T) {
	_, err := Load(writeConfig(t, validYAML+`
safety:
  peerMinStabelFor: "1m"
`))
	if err == nil {
		t.Fatal("an unknown key must fail at startup")
	}
}

func TestLoadRejectsAMissingFile(t *testing.T) {
	t.Setenv("POD_NAMESPACE", "ops")
	if _, err := Load(filepath.Join(t.TempDir(), "absent.yaml")); err == nil {
		t.Fatal("a missing config file must fail")
	}
}

func TestValidateRequiredFields(t *testing.T) {
	tests := []struct {
		name    string
		body    string
		env     map[string]string
		wantErr string
	}{
		{
			name:    "region missing",
			body:    strings.Replace(validYAML, "region: ap-northeast-2", "", 1),
			wantErr: "region is required",
		},
		{
			name: "no tag filters",
			body: `
region: ap-northeast-2
approval:
  slackUserIDs: [U0123456789]
`,
			wantErr: "targets.tagFilters",
		},
		{
			name: "tag filter without a key",
			body: `
region: ap-northeast-2
targets:
  tagFilters:
    - value: "true"
approval:
  slackUserIDs: [U0123456789]
`,
			wantErr: "targets.tagFilters[0].key",
		},
		{
			name: "no approvers",
			body: `
region: ap-northeast-2
targets:
  tagFilters:
    - key: managed
`,
			wantErr: "approval.slackUserIDs",
		},
		{
			name: "approver given as a display name",
			body: `
region: ap-northeast-2
targets:
  tagFilters:
    - key: managed
approval:
  slackUserIDs: ["@younsl"]
`,
			wantErr: "is not a Slack user ID",
		},
		{
			name:    "bot token missing",
			body:    validYAML,
			env:     map[string]string{"SLACK_BOT_TOKEN": ""},
			wantErr: "SLACK_BOT_TOKEN is required",
		},
		{
			name:    "app token is not an app-level token",
			body:    validYAML,
			env:     map[string]string{"SLACK_APP_TOKEN": "xoxb-not-an-app-token"},
			wantErr: "must be an app-level token",
		},
		{
			name:    "namespace missing",
			body:    validYAML,
			env:     map[string]string{"POD_NAMESPACE": ""},
			wantErr: "POD_NAMESPACE is required",
		},
		{
			name:    "pod name missing while leader electing",
			body:    validYAML,
			env:     map[string]string{"POD_NAME": ""},
			wantErr: "leaderElect requires POD_NAME",
		},
		{
			name: "verify poll interval not shorter than the timeout",
			body: validYAML + `
safety:
  verifyTimeout: "30s"
  verifyPollInterval: "30s"
`,
			wantErr: "must be shorter than",
		},
		{
			name: "minRemaining longer than the window duration",
			body: validYAML + `
maintenanceWindow:
  duration: "1h"
  minRemaining: "2h"
`,
			wantErr: "exceeds maintenanceWindow.duration",
		},
		{
			name: "verifyTimeout longer than the window duration",
			body: validYAML + `
maintenanceWindow:
  duration: "10m"
  minRemaining: "1m"
safety:
  verifyTimeout: "30m"
`,
			wantErr: "verification could not finish inside the window",
		},
		{
			name: "malformed cron schedule",
			body: validYAML + `
maintenanceWindow:
  cronSchedule: "0 2 * *"
`,
			wantErr: "maintenanceWindow.cronSchedule",
		},
		{
			name: "zero window duration",
			body: validYAML + `
maintenanceWindow:
  duration: "0s"
`,
			wantErr: "maintenanceWindow.duration must be positive",
		},
		{
			name: "unknown timezone",
			body: validYAML + `
maintenanceWindow:
  timezone: Mars/Olympus
`,
			wantErr: "not a valid IANA name",
		},
		{
			name: "health and metrics on the same port",
			body: validYAML + `
healthPort: 9090
metricsPort: 9090
`,
			wantErr: "must differ",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			path := writeConfig(t, tc.body)
			for k, v := range tc.env {
				t.Setenv(k, v)
			}
			_, err := Load(path)
			if err == nil {
				t.Fatalf("expected an error mentioning %q", tc.wantErr)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("error = %v, want it to mention %q", err, tc.wantErr)
			}
		})
	}
}

func TestLoadUsesAWSRegionEnvOnlyAsAFallback(t *testing.T) {
	path := writeConfig(t, `
targets:
  tagFilters:
    - key: managed
approval:
  slackUserIDs: [U0123456789]
`)
	t.Setenv("AWS_REGION", "eu-west-1")

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.Region != "eu-west-1" {
		t.Fatalf("Region = %q, want the AWS_REGION fallback", cfg.Region)
	}

	explicit := writeConfig(t, validYAML)
	t.Setenv("AWS_REGION", "eu-west-1")
	cfg, err = Load(explicit)
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.Region != "ap-northeast-2" {
		t.Fatalf("Region = %q, want the file value to win over AWS_REGION", cfg.Region)
	}
}

func TestLogSettingsFromEnvOverrideTheFile(t *testing.T) {
	path := writeConfig(t, validYAML+`
logLevel: info
logFormat: json
`)
	t.Setenv("LOG_LEVEL", "debug")
	t.Setenv("LOG_FORMAT", "text")

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.LogLevel != "debug" || cfg.LogFormat != "text" {
		t.Fatalf("log settings = %s/%s, want the env overrides", cfg.LogLevel, cfg.LogFormat)
	}
}

func TestLoadParsesTheCronWindow(t *testing.T) {
	cfg, err := Load(writeConfig(t, validYAML+`
maintenanceWindow:
  timezone: Asia/Seoul
  cronSchedule: "0 2 * * 2,3,4"
  duration: "3h"
  minRemaining: "45m"
`))
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	w := cfg.MaintenanceWindow
	if w.CronSchedule != "0 2 * * 2,3,4" {
		t.Fatalf("cronSchedule = %q", w.CronSchedule)
	}
	if w.Duration.D() != 3*time.Hour || w.MinRemaining.D() != 45*time.Minute {
		t.Fatalf("window durations = %s/%s", w.Duration, w.MinRemaining)
	}
}

// minRemaining exists to keep verification inside the window, so a value shorter than
// verifyTimeout defeats its own purpose and must not start up.
func TestValidateRejectsMinRemainingShorterThanVerifyTimeout(t *testing.T) {
	_, err := Load(writeConfig(t, validYAML+`
maintenanceWindow:
  duration: "3h"
  minRemaining: "5m"
safety:
  verifyTimeout: "30m"
`))
	if err == nil {
		t.Fatal("minRemaining shorter than verifyTimeout must fail at startup")
	}
	if !strings.Contains(err.Error(), "verify past the close") {
		t.Fatalf("error = %v, want it to explain the spill", err)
	}
}
