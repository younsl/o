//go:build linux || darwin

// Package disk reports filesystem usage for a given path.
package disk

import "syscall"

// UsagePercent returns the used-space percentage (0-100) of the filesystem
// containing path. Usage is computed as (total - available) / total, where
// available is the space usable by unprivileged processes, matching the
// behavior of the previous Rust implementation (sysinfo available_space).
func UsagePercent(path string) (float64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, err
	}

	total := st.Blocks * uint64(st.Bsize)
	if total == 0 {
		return 0, nil
	}
	available := st.Bavail * uint64(st.Bsize)
	used := total - available
	return float64(used) / float64(total) * 100, nil
}
