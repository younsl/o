// Package uiextension carries the Argo CD UI extension script inside the
// binary.
//
// Shipping the script as a ConfigMap works, but it lets the panel and the API
// it talks to drift apart: a chart upgrade that forgets the ConfigMap leaves an
// old script calling a contract that has moved. Embedding it means one artifact
// carries both halves and they can only ever be the same version.
//
// argocd-server serves extensions from its own filesystem rather than fetching
// them over HTTP, so the script still has to land on disk. `install-extension`
// does that from an init container sharing argocd-server's extensions volume.
package uiextension

import (
	"archive/tar"
	"bytes"
	"embed"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

//go:embed extension.js
var files embed.FS

// namePlaceholder is substituted with the name argocd-server proxies the
// backend under, so the script and argocd-cm cannot disagree about the path.
const namePlaceholder = "__EXTENSION_NAME__"

// DefaultName is the proxy extension name assumed when none is given.
const DefaultName = "promotion-gate"

// FileName is what the script must be called on disk. Argo CD serves every .js
// file it finds under its extensions directory; the name only shows up in the
// browser's network tab.
const FileName = "extensions-PromotionGate.js"

// DirName is the per-extension directory Argo CD expects inside
// <extensions>/resources.
const DirName = "extension-PromotionGate.js"

// Script returns the extension script with the proxy extension name applied.
func Script(extensionName string) ([]byte, error) {
	if strings.TrimSpace(extensionName) == "" {
		extensionName = DefaultName
	}
	raw, err := files.ReadFile("extension.js")
	if err != nil {
		return nil, fmt.Errorf("read embedded extension script: %w", err)
	}
	rendered := strings.ReplaceAll(string(raw), namePlaceholder, extensionName)
	if strings.Contains(rendered, namePlaceholder) {
		return nil, fmt.Errorf("embedded extension script still contains %s", namePlaceholder)
	}
	return []byte(rendered), nil
}

// Tar packs the script in the layout argocd-extension-installer unpacks.
//
// Serving this lets argocd-server keep the upstream wiring, the standard
// installer image pointed at an EXTENSION_URL, while the script still comes
// from the same build as the API it calls. modTime is passed in because a
// timestamp taken from the clock would make the archive differ on every
// request for no reason.
func Tar(extensionName string, modTime time.Time) ([]byte, error) {
	script, err := Script(extensionName)
	if err != nil {
		return nil, err
	}

	var buf bytes.Buffer
	writer := tar.NewWriter(&buf)
	header := &tar.Header{
		Name:    filepath.Join("resources", DirName, FileName),
		Mode:    0o644,
		Size:    int64(len(script)),
		ModTime: modTime,
		Format:  tar.FormatPAX,
	}
	if err := writer.WriteHeader(header); err != nil {
		return nil, fmt.Errorf("write tar header: %w", err)
	}
	if _, err := writer.Write(script); err != nil {
		return nil, fmt.Errorf("write tar body: %w", err)
	}
	if err := writer.Close(); err != nil {
		return nil, fmt.Errorf("close tar: %w", err)
	}
	return buf.Bytes(), nil
}

// Install writes the script into an Argo CD extensions directory.
//
// The layout matches what argocd-server walks:
// <root>/resources/extension-PromotionGate.js/extensions-PromotionGate.js.
func Install(root, extensionName string) (string, error) {
	script, err := Script(extensionName)
	if err != nil {
		return "", err
	}
	dir := filepath.Join(root, "resources", DirName)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("create extension directory %s: %w", dir, err)
	}
	path := filepath.Join(dir, FileName)
	// World readable on purpose: argocd-server runs as a different user than
	// the init container that writes this.
	if err := os.WriteFile(path, script, 0o644); err != nil {
		return "", fmt.Errorf("write extension script %s: %w", path, err)
	}
	return path, nil
}
