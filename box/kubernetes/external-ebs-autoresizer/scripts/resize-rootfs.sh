#!/bin/sh
# Grow the root partition and extend its filesystem in place.
# Handles both Nitro (nvme0n1p1) and Xen (xvda1) device naming, and both
# ext2/3/4 (resize2fs) and XFS (xfs_growfs) root filesystems. Amazon Linux 2
# and 2023 default to XFS, where resize2fs fails with "Bad magic number in
# super-block".
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

fstype=$(findmnt -no FSTYPE /)
echo "root part=$part disk=$disk partnum=$partnum fstype=$fstype"

# growpart is non-zero when the partition is already at max size; tolerate that.
$SUDO growpart "$disk" "$partnum" || echo "growpart reported no change"

# resize2fs takes the partition device; xfs_growfs takes the mountpoint.
case "$fstype" in
ext2 | ext3 | ext4)
	$SUDO resize2fs "$part"
	;;
xfs)
	$SUDO xfs_growfs /
	;;
*)
	echo "unsupported root filesystem type: $fstype" >&2
	exit 1
	;;
esac

echo "after:"
df -h /
