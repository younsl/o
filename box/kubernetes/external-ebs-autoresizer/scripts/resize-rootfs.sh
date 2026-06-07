#!/bin/sh
# Grow the root partition and extend its ext4 filesystem in place.
# Handles both Nitro (nvme0n1p1) and Xen (xvda1) device naming.
#
# Invoked via SSM Run Command (AWS-RunShellScript), which the SSM Agent runs as
# root by default (unlike interactive Session Manager, which uses ssm-user).
# We still fall back to sudo for hardened AMIs that run commands as a non-root
# but sudo-capable user.
set -eu

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
	if command -v sudo >/dev/null 2>&1; then
		SUDO="sudo"
	else
		echo "not running as root and sudo is unavailable; cannot resize" >&2
		exit 1
	fi
fi

part=$(findmnt -no SOURCE /)
if [ -z "$part" ]; then
	echo "could not resolve root device" >&2
	exit 1
fi

disk="/dev/$(lsblk -no PKNAME "$part" | head -n1)"
partnum=$(echo "$part" | grep -oE '[0-9]+$')
if [ -z "$partnum" ]; then
	echo "could not derive partition number from $part" >&2
	exit 1
fi

echo "root part=$part disk=$disk partnum=$partnum"

# growpart is non-zero when the partition is already at max size; tolerate that.
$SUDO growpart "$disk" "$partnum" || echo "growpart reported no change"
$SUDO resize2fs "$part"

echo "after:"
df -h /
