package uiextension

import (
	"archive/tar"
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestScriptSubstitutesTheExtensionName(t *testing.T) {
	script, err := Script("promotion-gate")
	if err != nil {
		t.Fatalf("Script() error = %v", err)
	}
	body := string(script)
	if strings.Contains(body, namePlaceholder) {
		t.Error("the placeholder survived substitution, so the script would call a path that does not exist")
	}
	if !strings.Contains(body, "/extensions/promotion-gate/api/v1/gate") {
		t.Error("the script does not call the proxied gate endpoint")
	}
}

func TestScriptHonoursACustomName(t *testing.T) {
	script, err := Script("my-gate")
	if err != nil {
		t.Fatalf("Script() error = %v", err)
	}
	if !strings.Contains(string(script), "/extensions/my-gate/api/v1/gate") {
		t.Error("a custom extension name was not applied")
	}
}

func TestScriptFallsBackToTheDefaultName(t *testing.T) {
	for _, name := range []string{"", "   "} {
		script, err := Script(name)
		if err != nil {
			t.Fatalf("Script(%q) error = %v", name, err)
		}
		if !strings.Contains(string(script), "/extensions/"+DefaultName+"/") {
			t.Errorf("Script(%q) did not fall back to %q", name, DefaultName)
		}
	}
}

func TestScriptRegistersWithTheArgoCDExtensionAPI(t *testing.T) {
	// These two symbols are the whole contract with Argo CD. If either is
	// renamed the panel silently never appears, which no other test would catch.
	script, err := Script(DefaultName)
	if err != nil {
		t.Fatalf("Script() error = %v", err)
	}
	body := string(script)
	for _, want := range []string{
		"window.extensionsAPI.registerStatusPanelExtension",
		"window.React",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("the script does not reference %q", want)
		}
	}
}

func TestInstallWritesTheLayoutArgoCDWalks(t *testing.T) {
	root := t.TempDir()
	path, err := Install(root, DefaultName)
	if err != nil {
		t.Fatalf("Install() error = %v", err)
	}

	want := filepath.Join(root, "resources", DirName, FileName)
	if path != want {
		t.Errorf("Install() wrote %q, want %q", path, want)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat() error = %v", err)
	}
	if info.Size() == 0 {
		t.Error("the installed script is empty")
	}
	// argocd-server runs as a different user than the init container that
	// writes this file, so it has to stay world readable.
	if info.Mode().Perm()&0o044 == 0 {
		t.Errorf("mode = %v, want the file readable by other users", info.Mode().Perm())
	}
}

func TestInstallIsIdempotent(t *testing.T) {
	root := t.TempDir()
	first, err := Install(root, DefaultName)
	if err != nil {
		t.Fatalf("Install() error = %v", err)
	}
	second, err := Install(root, DefaultName)
	if err != nil {
		t.Fatalf("second Install() error = %v", err)
	}
	if first != second {
		t.Errorf("Install() paths differ between runs: %q and %q", first, second)
	}
}

func TestInstallFailsOnAnUnwritableRoot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "blocked")
	if err := os.WriteFile(root, []byte("not a directory"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	if _, err := Install(root, DefaultName); err == nil {
		t.Fatal("Install() into a file = nil error, want failure")
	}
}

func TestTarUnpacksToTheExpectedPath(t *testing.T) {
	archive, err := Tar(DefaultName, time.Unix(0, 0).UTC())
	if err != nil {
		t.Fatalf("Tar() error = %v", err)
	}

	reader := tar.NewReader(bytes.NewReader(archive))
	header, err := reader.Next()
	if err != nil {
		t.Fatalf("reading the archive: %v", err)
	}
	want := filepath.Join("resources", DirName, FileName)
	if header.Name != want {
		t.Errorf("archive entry = %q, want %q", header.Name, want)
	}

	body, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("reading the entry: %v", err)
	}
	if !strings.Contains(string(body), "/extensions/"+DefaultName+"/api/v1/gate") {
		t.Error("the archived script does not call the proxied gate endpoint")
	}
	if int64(len(body)) != header.Size {
		t.Errorf("entry size = %d, want %d", header.Size, len(body))
	}

	if _, err := reader.Next(); err != io.EOF {
		t.Errorf("the archive holds more than one entry: %v", err)
	}
}

func TestTarIsByteStableForTheSameInput(t *testing.T) {
	// The installer may checksum or cache what it fetches, so identical input
	// has to produce identical bytes.
	stamp := time.Unix(0, 0).UTC()
	first, err := Tar(DefaultName, stamp)
	if err != nil {
		t.Fatalf("Tar() error = %v", err)
	}
	second, err := Tar(DefaultName, stamp)
	if err != nil {
		t.Fatalf("second Tar() error = %v", err)
	}
	if !bytes.Equal(first, second) {
		t.Error("Tar() produced different bytes for the same input")
	}
}
