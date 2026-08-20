package gate

import "testing"

func TestIdentityOf(t *testing.T) {
	cases := []struct {
		name    string
		app     string
		project string
		want    string
	}{
		{"strips the project prefix", "prd-payment-api", "prd", "payment-api"},
		{"strips only the leading prefix", "prd-prd-tools", "prd", "prd-tools"},
		{"keeps a name without the prefix", "payment-api", "prd", "payment-api"},
		{"keeps a name equal to the project", "shared", "shared", "shared"},
		{"is not fooled by a partial prefix", "prdtools", "prd", "prdtools"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := IdentityOf(tc.app, tc.project); got != tc.want {
				t.Errorf("IdentityOf(%q, %q) = %q, want %q", tc.app, tc.project, got, tc.want)
			}
		})
	}
}

func TestAppNameFor(t *testing.T) {
	if got := AppNameFor("stg", "payment-api"); got != "stg-payment-api" {
		t.Errorf("AppNameFor() = %q, want stg-payment-api", got)
	}
}

func TestIdentityRoundTrip(t *testing.T) {
	// The two helpers are inverses for the naming convention the gate assumes,
	// which is what lets an upstream app name be derived rather than configured.
	for _, env := range []string{"dev", "sb", "stg", "prd"} {
		name := AppNameFor(env, "payment-api")
		if got := IdentityOf(name, env); got != "payment-api" {
			t.Errorf("IdentityOf(AppNameFor(%q, payment-api)) = %q, want payment-api", env, got)
		}
	}
}

func TestAppSnapshotStatusHelpers(t *testing.T) {
	synced := AppSnapshot{SyncStatus: SyncSynced, HealthStatus: HealthHealthy}
	if !synced.IsSynced() || !synced.IsHealthy() {
		t.Error("a Synced/Healthy snapshot did not report as such")
	}
	if synced.SyncOrUnknown() != SyncSynced || synced.HealthOrUnknown() != HealthHealthy {
		t.Error("status helpers changed a populated value")
	}

	var empty AppSnapshot
	if empty.IsSynced() || empty.IsHealthy() {
		t.Error("an unreconciled snapshot reported as Synced or Healthy")
	}
	if empty.SyncOrUnknown() != StatusUnknown || empty.HealthOrUnknown() != StatusUnknown {
		t.Errorf("empty status = %q/%q, want Unknown", empty.SyncOrUnknown(), empty.HealthOrUnknown())
	}

	degraded := AppSnapshot{SyncStatus: "OutOfSync", HealthStatus: "Degraded"}
	if degraded.IsSynced() || degraded.IsHealthy() {
		t.Error("an OutOfSync/Degraded snapshot reported as Synced or Healthy")
	}
}

func TestNotGated(t *testing.T) {
	verdict := NotGated("dev-payment-api", "dev", "payment-api")
	if !verdict.Allowed {
		t.Error("NotGated().Allowed = false, want true")
	}
	if verdict.Gated {
		t.Error("NotGated().Gated = true, want false")
	}
	if verdict.Code != CodeNotGated {
		t.Errorf("NotGated().Code = %q, want %q", verdict.Code, CodeNotGated)
	}
}
