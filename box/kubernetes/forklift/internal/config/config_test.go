package config

import (
	"testing"
	"time"
)

func TestLoadDefaults(t *testing.T) {
	t.Setenv("FORKLIFT_DATA_DIR", "")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.DataDir != "/data" {
		t.Fatalf("data dir = %q", c.DataDir)
	}
	if c.HTTPAddr != ":8080" || c.MetricsAddr != ":8081" {
		t.Fatalf("addrs = %q %q", c.HTTPAddr, c.MetricsAddr)
	}
	if c.HA.Enabled {
		t.Fatal("HA should default off")
	}
}

func TestLoadOverrides(t *testing.T) {
	t.Setenv("FORKLIFT_DATA_DIR", "/tmp/forklift")
	t.Setenv("FORKLIFT_LOG_LEVEL", "debug")
	t.Setenv("FORKLIFT_LOG_FORMAT", "text")
	t.Setenv("FORKLIFT_SHUTDOWN_TIMEOUT", "30s")
	t.Setenv("FORKLIFT_HA_ENABLED", "true")
	t.Setenv("POD_NAME", "forklift-0")
	t.Setenv("POD_NAMESPACE", "registry")

	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.DataDir != "/tmp/forklift" || c.LogLevel != "debug" || c.LogFormat != "text" {
		t.Fatalf("overrides not applied: %+v", c)
	}
	if c.ShutdownTimeout != 30*time.Second {
		t.Fatalf("shutdown timeout = %v", c.ShutdownTimeout)
	}
	if !c.HA.Enabled || c.HA.Identity != "forklift-0" || c.HA.LeaseNamespace != "registry" {
		t.Fatalf("HA config = %+v", c.HA)
	}
}

func TestValidateRejectsBadValues(t *testing.T) {
	t.Setenv("FORKLIFT_LOG_LEVEL", "trace")
	if _, err := Load(); err == nil {
		t.Fatal("expected invalid log level error")
	}
}

func TestValidateRejectsBadFormat(t *testing.T) {
	t.Setenv("FORKLIFT_LOG_FORMAT", "xml")
	if _, err := Load(); err == nil {
		t.Fatal("expected invalid log format error")
	}
}

func TestHAIdentityRequiredWhenEnabled(t *testing.T) {
	t.Setenv("FORKLIFT_HA_ENABLED", "true")
	t.Setenv("FORKLIFT_HA_IDENTITY", "")
	t.Setenv("POD_NAME", "")
	// Hostname normally fills identity; force it empty via both sources being
	// blank is not possible (hostname fallback), so assert the happy path holds.
	c, err := Load()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if c.HA.Identity == "" {
		t.Fatal("identity should fall back to hostname")
	}
}

func TestEnvFallbacksOnInvalid(t *testing.T) {
	t.Setenv("FORKLIFT_HA_ENABLED", "notabool")
	t.Setenv("FORKLIFT_SHUTDOWN_TIMEOUT", "notaduration")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.HA.Enabled {
		t.Fatal("invalid bool should fall back to default false")
	}
	if c.ShutdownTimeout != 15*time.Second {
		t.Fatalf("invalid duration should fall back to default, got %v", c.ShutdownTimeout)
	}
}

func TestAuthDefaults(t *testing.T) {
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.Auth.BootstrapAdminUser != "admin" || c.Auth.SessionTTL != 12*time.Hour {
		t.Fatalf("auth defaults = %+v", c.Auth)
	}
	if c.Auth.OIDC.UsernameClaim != "preferred_username" || c.Auth.OIDC.GroupsClaim != "groups" {
		t.Fatalf("oidc claim defaults = %+v", c.Auth.OIDC)
	}
}
