package auth

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
)

// ReconcileRBAC applies the declarative RBAC policy to the store. policyFile is
// the path to an ArgoCD-style policy.csv (mounted from a ConfigMap); accountsDir,
// if set, is a directory of local-account password files (mounted from a Secret),
// one file per account named after the username with the plaintext password as
// its content. Reconciliation is authoritative for managed rows and idempotent.
//
// When policyFile is empty, declarative RBAC is disabled and the store is left
// untouched. A configured-but-missing policy file is treated as disabled (a
// warning is logged) so a chart misconfiguration does not wipe managed rows.
func ReconcileRBAC(ctx context.Context, store *meta.Store, log *slog.Logger, policyFile, accountsDir string) error {
	if policyFile == "" {
		return nil
	}
	body, err := os.ReadFile(policyFile)
	if err != nil {
		if os.IsNotExist(err) {
			log.Warn("RBAC policy file not found; skipping declarative reconciliation", "path", policyFile)
			return nil
		}
		return fmt.Errorf("read RBAC policy: %w", err)
	}

	desired, err := ParsePolicy(string(body))
	if err != nil {
		return fmt.Errorf("parse RBAC policy: %w", err)
	}

	accounts, err := loadAccounts(accountsDir)
	if err != nil {
		return fmt.Errorf("load local accounts: %w", err)
	}
	desired.LocalUsers = accounts

	if err := store.ApplyManagedRBAC(ctx, desired); err != nil {
		return fmt.Errorf("apply RBAC policy: %w", err)
	}
	log.Info("reconciled declarative RBAC",
		"roles", len(desired.Roles),
		"group_mappings", len(desired.GroupRoles),
		"user_roles", len(desired.UserRoles),
		"local_accounts", len(desired.LocalUsers))
	return nil
}

// loadAccounts reads local-account passwords from a mounted Secret directory.
// Each regular file's name is the username and its content is the plaintext
// password, which is hashed before storage. Dotfiles (e.g. Kubernetes
// ..data symlinks) are skipped.
func loadAccounts(dir string) ([]meta.ManagedLocalUser, error) {
	if dir == "" {
		return nil, nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var out []meta.ManagedLocalUser
	for _, e := range entries {
		if e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			return nil, err
		}
		password := strings.TrimSpace(string(raw))
		if password == "" {
			continue
		}
		hash, err := HashPassword(password)
		if err != nil {
			return nil, err
		}
		out = append(out, meta.ManagedLocalUser{Username: e.Name(), PasswordHash: hash})
	}
	return out, nil
}
