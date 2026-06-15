package auth

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
)

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestReconcileRBACDisabled(t *testing.T) {
	_, store := newTestService(t)
	// Empty policy file path is a no-op (declarative RBAC disabled).
	if err := ReconcileRBAC(context.Background(), store, discardLogger(), "", ""); err != nil {
		t.Fatalf("disabled reconcile should succeed: %v", err)
	}
	roles, _ := store.ListRoles(context.Background())
	if len(roles) != 0 {
		t.Fatalf("no roles expected, got %d", len(roles))
	}
}

func TestReconcileRBACMissingFile(t *testing.T) {
	_, store := newTestService(t)
	// A configured-but-missing file is tolerated (warn + skip), not an error.
	err := ReconcileRBAC(context.Background(), store, discardLogger(), filepath.Join(t.TempDir(), "nope.csv"), "")
	if err != nil {
		t.Fatalf("missing file should not error: %v", err)
	}
}

func TestReconcileRBACEndToEnd(t *testing.T) {
	_, store := newTestService(t)
	ctx := context.Background()

	dir := t.TempDir()
	policyPath := filepath.Join(dir, "policy.csv")
	policy := "p, readonly, repo, read, *, allow\np, dev, repo, write, team-*, allow\ng, user:ci-bot, dev\n"
	if err := os.WriteFile(policyPath, []byte(policy), 0o600); err != nil {
		t.Fatal(err)
	}

	accountsDir := filepath.Join(dir, "accounts")
	if err := os.MkdirAll(accountsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(accountsDir, "ci-bot"), []byte("s3cr3t\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// A Kubernetes-style dotfile must be ignored.
	if err := os.WriteFile(filepath.Join(accountsDir, ".hidden"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := ReconcileRBAC(ctx, store, discardLogger(), policyPath, accountsDir); err != nil {
		t.Fatalf("reconcile: %v", err)
	}

	bot, err := store.GetUserByUsername(ctx, "ci-bot")
	if err != nil {
		t.Fatalf("ci-bot not provisioned: %v", err)
	}
	// Local account: password hashed and stored, source local.
	if bot.Source != "local" || !VerifyPassword(bot.PasswordHash, "s3cr3t") {
		t.Fatalf("ci-bot password not set correctly: %+v", bot)
	}
	if _, err := store.GetUserByUsername(ctx, ".hidden"); err == nil {
		t.Fatal("dotfile should not create a user")
	}
}

func TestReconcileRBACInvalidPolicy(t *testing.T) {
	_, store := newTestService(t)
	path := filepath.Join(t.TempDir(), "bad.csv")
	if err := os.WriteFile(path, []byte("p, r, repo, bogus, *, allow"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := ReconcileRBAC(context.Background(), store, discardLogger(), path, ""); err == nil {
		t.Fatal("invalid policy should error")
	}
}

func TestDefaultRoleGrantsPermissions(t *testing.T) {
	_, store := newTestService(t)
	ctx := context.Background()

	// Reconcile a readonly role and configure it as the default.
	policy := "p, readonly, repo, read, *, allow\n"
	path := filepath.Join(t.TempDir(), "policy.csv")
	if err := os.WriteFile(path, []byte(policy), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := ReconcileRBAC(ctx, store, discardLogger(), path, ""); err != nil {
		t.Fatal(err)
	}

	svc := NewService(store, discardLogger(), Options{
		SessionSecret: []byte("test-secret-test-secret-test-secret"),
		DefaultRole:   "readonly",
	})

	// A brand-new local user with no explicit roles inherits readonly.
	hash, _ := HashPassword("pw")
	if _, err := store.CreateUser(ctx, meta.User{Username: "nobody", PasswordHash: hash, Source: meta.SourceLocal}); err != nil {
		t.Fatal(err)
	}
	p, err := svc.principalFromPassword(ctx, "nobody", "pw")
	if err != nil || p == nil {
		t.Fatalf("resolve: %v, %v", p, err)
	}
	if !p.Can("anyrepo", ActionRead) {
		t.Fatal("default role should grant read")
	}
	if p.Can("anyrepo", ActionWrite) {
		t.Fatal("default role must not grant write")
	}
}
