// Package bytesize formats byte counts as human-readable strings.
package bytesize

import "fmt"

// Human formats n bytes using binary (1024-based) units, e.g. "1.5 MiB".
func Human(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}
