// Package scripts embeds the shell scripts executed on target instances via
// SSM, keeping them as standalone files for readability while shipping them
// inside the static binary.
package scripts

import _ "embed"

// MeasureRootFS prints the root filesystem used percentage (read-only).
//
//go:embed measure-rootfs.sh
var MeasureRootFS string

// ResizeRootFS grows the root partition and extends the ext4 filesystem.
//
//go:embed resize-rootfs.sh
var ResizeRootFS string
