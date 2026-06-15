package config

import (
	"testing"
	"time"
)

func setReplicationEnv(t *testing.T) {
	t.Helper()
	t.Setenv("FORKLIFT_HA_ENABLED", "true")
	t.Setenv("FORKLIFT_REPLICATION_ENABLED", "true")
	t.Setenv("FORKLIFT_REPLICATION_TOKEN", "secret")
	t.Setenv("FORKLIFT_REPLICATION_PEER_SERVICE", "forklift-headless.tools.svc")
}

func TestReplicationLoad(t *testing.T) {
	setReplicationEnv(t)
	t.Setenv("FORKLIFT_REPLICATION_PEER_PORT", "9090")
	t.Setenv("FORKLIFT_REPLICATION_INTERVAL", "10s")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	r := c.Replication
	if !r.Enabled || r.Token != "secret" || r.PeerPort != 9090 || r.Interval != 10*time.Second {
		t.Fatalf("unexpected replication config: %+v", r)
	}
}

func TestReplicationRequiresHA(t *testing.T) {
	setReplicationEnv(t)
	t.Setenv("FORKLIFT_HA_ENABLED", "false")
	if _, err := Load(); err == nil {
		t.Fatal("expected error: replication without HA")
	}
}

func TestReplicationRequiresToken(t *testing.T) {
	setReplicationEnv(t)
	t.Setenv("FORKLIFT_REPLICATION_TOKEN", "")
	if _, err := Load(); err == nil {
		t.Fatal("expected error: replication without token")
	}
}

func TestReplicationRequiresPeerOrLeaderURL(t *testing.T) {
	setReplicationEnv(t)
	t.Setenv("FORKLIFT_REPLICATION_PEER_SERVICE", "")
	if _, err := Load(); err == nil {
		t.Fatal("expected error: no peer service and no leader URL")
	}
	t.Setenv("FORKLIFT_REPLICATION_LEADER_URL", "http://leader:8080")
	if _, err := Load(); err != nil {
		t.Fatalf("leader URL override should satisfy validation: %v", err)
	}
}
