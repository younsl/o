package config

import (
	"slices"
	"testing"
	"time"
)

// requiredEnv sets the two variables Load refuses to default.
func requiredEnv(t *testing.T) {
	t.Helper()
	t.Setenv("SLACK_BOT_TOKEN", "xoxb-test")
	t.Setenv("SLACK_DEFAULT_CHANNEL", "alerts")
}

func TestLoadDefaults(t *testing.T) {
	requiredEnv(t)

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.KagentURL != "http://kagent-controller.kagent:8083" {
		t.Errorf("KagentURL = %q", cfg.KagentURL)
	}
	if cfg.KagentTimeout != 120*time.Second {
		t.Errorf("KagentTimeout = %s", cfg.KagentTimeout)
	}
	if cfg.DedupeTTL != 12*time.Hour {
		t.Errorf("DedupeTTL = %s", cfg.DedupeTTL)
	}
	if !cfg.AnalyzeSeverities["critical"] || len(cfg.AnalyzeSeverities) != 1 {
		t.Errorf("AnalyzeSeverities = %v, want only critical", cfg.AnalyzeSeverities)
	}
	if cfg.AnalyzeResolved {
		t.Error("AnalyzeResolved should default to false")
	}
	if cfg.Instructions != DefaultInstructions {
		t.Error("Instructions should default to DefaultInstructions")
	}
	// Alertmanager keeps its own slack_configs by default, so the gateway only
	// threads under a notification it did not send.
	if cfg.ParentMode != ParentModeLookup {
		t.Errorf("ParentMode = %q, want %q", cfg.ParentMode, ParentModeLookup)
	}
	if cfg.LookupWindow != 15*time.Minute || cfg.LookupAttempts != 3 {
		t.Errorf("lookup settings = %s/%d", cfg.LookupWindow, cfg.LookupAttempts)
	}
	if cfg.WebhookPath != "/alert" {
		t.Errorf("WebhookPath = %q", cfg.WebhookPath)
	}
	if cfg.ListenPort != 8080 || cfg.MetricsPort != 8081 {
		t.Errorf("ports = %d/%d", cfg.ListenPort, cfg.MetricsPort)
	}
}

func TestLoadRequiredFields(t *testing.T) {
	t.Run("missing token", func(t *testing.T) {
		t.Setenv("SLACK_BOT_TOKEN", "")
		t.Setenv("SLACK_DEFAULT_CHANNEL", "alerts")
		if _, err := Load(); err == nil {
			t.Fatal("expected an error when SLACK_BOT_TOKEN is unset")
		}
	})
	t.Run("missing channel", func(t *testing.T) {
		t.Setenv("SLACK_BOT_TOKEN", "xoxb-test")
		t.Setenv("SLACK_DEFAULT_CHANNEL", "")
		if _, err := Load(); err == nil {
			t.Fatal("expected an error when SLACK_DEFAULT_CHANNEL is unset")
		}
	})
}

func TestLoadOverrides(t *testing.T) {
	requiredEnv(t)
	t.Setenv("KAGENT_URL", "http://controller:9000/")
	t.Setenv("KAGENT_NAMESPACE", "ops")
	t.Setenv("KAGENT_AGENT", "triage")
	t.Setenv("KAGENT_TIMEOUT", "45s")
	t.Setenv("KAGENT_REQUEST_TIMEOUT", "10s")
	t.Setenv("KAGENT_POLL_INTERVAL", "2s")
	t.Setenv("ANALYZE_SEVERITIES", "critical, warning ,")
	t.Setenv("ANALYZE_RESOLVED", "true")
	t.Setenv("DEDUPE_TTL", "0s")
	t.Setenv("MAX_CONCURRENT_ANALYSES", "5")
	t.Setenv("MAX_ALERTS_IN_PROMPT", "2")
	t.Setenv("SLACK_CHANNEL_MAP", "test-route=alerts-test, infra-alerts=infra-alerts")
	t.Setenv("ANALYSIS_INSTRUCTIONS", "answer in korean")
	t.Setenv("SLACK_PARENT_MODE", "post")
	t.Setenv("SLACK_LOOKUP_WINDOW", "30m")
	t.Setenv("SLACK_LOOKUP_ATTEMPTS", "5")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.KagentURL != "http://controller:9000/" || cfg.KagentNamespace != "ops" || cfg.KagentAgent != "triage" {
		t.Errorf("kagent target = %s/%s/%s", cfg.KagentURL, cfg.KagentNamespace, cfg.KagentAgent)
	}
	if cfg.KagentTimeout != 45*time.Second {
		t.Errorf("KagentTimeout = %s", cfg.KagentTimeout)
	}
	if cfg.KagentRequestTimeout != 10*time.Second || cfg.KagentPollInterval != 2*time.Second {
		t.Errorf("kagent client settings = %s/%s", cfg.KagentRequestTimeout, cfg.KagentPollInterval)
	}
	if !cfg.AnalyzeSeverities["warning"] || len(cfg.AnalyzeSeverities) != 2 {
		t.Errorf("AnalyzeSeverities = %v", cfg.AnalyzeSeverities)
	}
	if !cfg.AnalyzeResolved {
		t.Error("AnalyzeResolved = false, want true")
	}
	if cfg.DedupeTTL != 0 {
		t.Errorf("DedupeTTL = %s, want 0", cfg.DedupeTTL)
	}
	if cfg.MaxConcurrent != 5 || cfg.MaxAlertsInPrompt != 2 {
		t.Errorf("limits = %d/%d", cfg.MaxConcurrent, cfg.MaxAlertsInPrompt)
	}
	if cfg.SlackChannelMap["test-route"] != "alerts-test" {
		t.Errorf("SlackChannelMap = %v", cfg.SlackChannelMap)
	}
	if cfg.Instructions != "answer in korean" {
		t.Errorf("Instructions = %q", cfg.Instructions)
	}
	if cfg.ParentMode != ParentModePost {
		t.Errorf("ParentMode = %q", cfg.ParentMode)
	}
	if cfg.LookupWindow != 30*time.Minute || cfg.LookupAttempts != 5 {
		t.Errorf("lookup settings = %s/%d", cfg.LookupWindow, cfg.LookupAttempts)
	}
}

// An empty ANALYZE_SEVERITIES is the documented way to analyse every alert,
// so it must survive as an empty set rather than falling back to the default.
func TestLoadEmptySeverityListMeansAll(t *testing.T) {
	requiredEnv(t)
	t.Setenv("ANALYZE_SEVERITIES", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(cfg.AnalyzeSeverities) != 0 {
		t.Errorf("AnalyzeSeverities = %v, want empty", cfg.AnalyzeSeverities)
	}
}

func TestLoadInvalid(t *testing.T) {
	tests := []struct {
		name  string
		key   string
		value string
	}{
		{"timeout", "KAGENT_TIMEOUT", "abc"},
		{"timeout too small", "KAGENT_TIMEOUT", "10ms"},
		{"request timeout too small", "KAGENT_REQUEST_TIMEOUT", "100ms"},
		{"poll interval", "KAGENT_POLL_INTERVAL", "fast"},
		{"ttl", "DEDUPE_TTL", "12"},
		{"concurrency", "MAX_CONCURRENT_ANALYSES", "0"},
		{"concurrency not a number", "MAX_CONCURRENT_ANALYSES", "many"},
		{"prompt alerts", "MAX_ALERTS_IN_PROMPT", "1000"},
		{"slack max text", "SLACK_MAX_TEXT", "10"},
		{"listen port", "LISTEN_PORT", "70000"},
		{"metrics port", "METRICS_PORT", "-1"},
		{"resolved flag", "ANALYZE_RESOLVED", "yes please"},
		{"channel map", "SLACK_CHANNEL_MAP", "broken-entry"},
		{"webhook path", "WEBHOOK_PATH", "alert"},
		{"parent mode", "SLACK_PARENT_MODE", "thread"},
		{"lookup window", "SLACK_LOOKUP_WINDOW", "10s"},
		{"lookup attempts", "SLACK_LOOKUP_ATTEMPTS", "0"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			requiredEnv(t)
			t.Setenv(tt.key, tt.value)
			if _, err := Load(); err == nil {
				t.Fatalf("expected an error for %s=%q", tt.key, tt.value)
			}
		})
	}
}

func TestLoadRejectsIdenticalPorts(t *testing.T) {
	requiredEnv(t)
	t.Setenv("LISTEN_PORT", "9090")
	t.Setenv("METRICS_PORT", "9090")

	if _, err := Load(); err == nil {
		t.Fatal("expected an error when both servers share a port")
	}
}

// The agent map lets one gateway feed several specialised agents, and the label
// it is keyed by defaults to the one that already routes Slack channels.
func TestLoadAgentRouting(t *testing.T) {
	requiredEnv(t)
	t.Setenv("KAGENT_AGENT_ROUTING_MAP", "infra-alerts=aws-alert-triage-agent, security-alerts=security-alert-triage-agent")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.KagentAgentRoutingLabel != cfg.ChannelLabel {
		t.Errorf("KagentAgentRoutingLabel = %q, want the channel label %q", cfg.KagentAgentRoutingLabel, cfg.ChannelLabel)
	}
	if cfg.KagentAgentRoutingMap["security-alerts"] != "security-alert-triage-agent" {
		t.Errorf("KagentAgentRoutingMap = %v", cfg.KagentAgentRoutingMap)
	}
	// Agents() drives the startup log, which is the only place the operator
	// sees every reachable agent listed.
	want := []string{"alert-triage-agent", "aws-alert-triage-agent", "security-alert-triage-agent"}
	if got := cfg.Agents(); !slices.Equal(got, want) {
		t.Errorf("Agents() = %v, want %v", got, want)
	}
}

// Routing by a label of its own lets the agent split differ from the channel
// split, for a deployment that posts several categories to one channel.
func TestLoadAgentLabelOverride(t *testing.T) {
	requiredEnv(t)
	t.Setenv("KAGENT_AGENT_ROUTING_LABEL", "team")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.KagentAgentRoutingLabel != "team" {
		t.Errorf("KagentAgentRoutingLabel = %q", cfg.KagentAgentRoutingLabel)
	}
}

func TestLoadRejectsMalformedAgentRoutingMap(t *testing.T) {
	requiredEnv(t)
	t.Setenv("KAGENT_AGENT_ROUTING_MAP", "security-alerts")

	if _, err := Load(); err == nil {
		t.Fatal("expected a malformed KAGENT_AGENT_ROUTING_MAP entry to fail")
	}
}

func TestChatDisabledWithoutAnAppToken(t *testing.T) {
	requiredEnv(t)

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.ChatEnabled() {
		t.Error("mention invocation is on without SLACK_APP_TOKEN")
	}
	// The chat settings still carry their defaults, so enabling the feature
	// later needs one variable rather than a block of them.
	if cfg.ChatAgent != cfg.KagentAgent {
		t.Errorf("ChatAgent = %q, want the alert agent", cfg.ChatAgent)
	}
	if cfg.ChatTimeout != 180*time.Second || cfg.ChatSessionTTL != 2*time.Hour {
		t.Errorf("chat deadlines = %s / %s", cfg.ChatTimeout, cfg.ChatSessionTTL)
	}
	if cfg.ChatStatusInterval != 10*time.Second {
		t.Errorf("ChatStatusInterval = %s", cfg.ChatStatusInterval)
	}
	if cfg.MaxConcurrentChats != 2 {
		t.Errorf("MaxConcurrentChats = %d", cfg.MaxConcurrentChats)
	}
	if cfg.ChatInstructions != DefaultChatInstructions {
		t.Error("ChatInstructions should default to DefaultChatInstructions")
	}
	if cfg.ChatThreadHint != DefaultThreadHint || cfg.ChatDeniedHint != DefaultDeniedHint {
		t.Errorf("hints = %q / %q", cfg.ChatThreadHint, cfg.ChatDeniedHint)
	}
}

func TestChatOverrides(t *testing.T) {
	requiredEnv(t)
	t.Setenv("SLACK_APP_TOKEN", "xapp-test")
	t.Setenv("CHAT_AGENT", "chat-agent")
	t.Setenv("CHAT_AGENT_MAP", "security-alerts=security-agent")
	t.Setenv("CHAT_CHANNELS", " alerts-test , C01234567 ")
	t.Setenv("CHAT_ALLOWED_USERS", "U111,U222")
	t.Setenv("CHAT_TIMEOUT", "90s")
	t.Setenv("CHAT_SESSION_TTL", "30m")
	t.Setenv("CHAT_STATUS_INTERVAL", "5s")
	t.Setenv("MAX_CONCURRENT_CHATS", "4")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if !cfg.ChatEnabled() {
		t.Fatal("SLACK_APP_TOKEN did not enable mention invocation")
	}
	if cfg.ChatAgent != "chat-agent" || cfg.ChatAgentMap["security-alerts"] != "security-agent" {
		t.Errorf("agent = %q, map = %v", cfg.ChatAgent, cfg.ChatAgentMap)
	}
	if !slices.Equal(cfg.ChatChannels, []string{"alerts-test", "C01234567"}) {
		t.Errorf("ChatChannels = %v, want the trimmed entries in order", cfg.ChatChannels)
	}
	if !cfg.ChatAllowedUsers["U111"] || !cfg.ChatAllowedUsers["U222"] {
		t.Errorf("ChatAllowedUsers = %v", cfg.ChatAllowedUsers)
	}
	if cfg.ChatTimeout != 90*time.Second || cfg.ChatSessionTTL != 30*time.Minute {
		t.Errorf("deadlines = %s / %s", cfg.ChatTimeout, cfg.ChatSessionTTL)
	}
	if cfg.ChatStatusInterval != 5*time.Second {
		t.Errorf("ChatStatusInterval = %s", cfg.ChatStatusInterval)
	}
	if cfg.MaxConcurrentChats != 4 {
		t.Errorf("MaxConcurrentChats = %d", cfg.MaxConcurrentChats)
	}
	// The chat agent and its routing table join the startup agent list.
	if agents := cfg.Agents(); !slices.Contains(agents, "chat-agent") || !slices.Contains(agents, "security-agent") {
		t.Errorf("Agents() = %v, want the chat agents listed", agents)
	}
}

// An explicitly empty hint or reaction turns that one off, while an unset
// variable keeps the default.
func TestChatEmptyValuesDisableTheirFeature(t *testing.T) {
	requiredEnv(t)
	t.Setenv("SLACK_APP_TOKEN", "xapp-test")
	t.Setenv("CHAT_THREAD_HINT", "")
	t.Setenv("CHAT_DENIED_HINT", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.ChatThreadHint != "" || cfg.ChatDeniedHint != "" {
		t.Errorf("empty values did not disable: %q %q", cfg.ChatThreadHint, cfg.ChatDeniedHint)
	}
}

func TestChatRejectsInvalidValues(t *testing.T) {
	tests := map[string]string{
		"CHAT_TIMEOUT":         "nope",
		"CHAT_STATUS_INTERVAL": "10ms",
		"MAX_CONCURRENT_CHATS": "0",
		"CHAT_AGENT_MAP":       "no-equals-sign",
	}
	for key, value := range tests {
		t.Run(key, func(t *testing.T) {
			requiredEnv(t)
			t.Setenv("SLACK_APP_TOKEN", "xapp-test")
			t.Setenv(key, value)
			if _, err := Load(); err == nil {
				t.Fatalf("Load() accepted %s=%q", key, value)
			}
		})
	}
}
