//go:build linux || darwin

package disk

import "testing"

func TestUsagePercentValidPath(t *testing.T) {
	usage, err := UsagePercent(t.TempDir())
	if err != nil {
		t.Fatalf("UsagePercent() failed: %v", err)
	}
	if usage < 0 || usage > 100 {
		t.Errorf("usage %.2f out of range [0, 100]", usage)
	}
}

func TestUsagePercentNonexistentPath(t *testing.T) {
	if _, err := UsagePercent("/does/not/exist/zzzz-test"); err == nil {
		t.Error("expected error for nonexistent path")
	}
}

func TestUsagePercentRelativePath(t *testing.T) {
	if _, err := UsagePercent("relative/nonexistent"); err == nil {
		t.Error("expected error for nonexistent relative path")
	}
}
