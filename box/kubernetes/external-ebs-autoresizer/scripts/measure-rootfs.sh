#!/bin/sh
# Print the used percentage of the root filesystem as a bare integer (0-100).
# Read-only: this only inspects mount usage and never modifies anything.
set -eu
df --output=pcent / | tail -n1 | tr -dc '0-9'
echo
