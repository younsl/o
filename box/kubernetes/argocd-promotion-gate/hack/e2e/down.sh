#!/usr/bin/env bash
set -euo pipefail

# Never let a stray KUBECONFIG from the caller point this at anything real.
unset KUBECONFIG

# Whether the caller picked one cluster has to be recorded before common.sh is
# sourced, because that file requires CLUSTER to hold something.
ONLY="${CLUSTER:-}"

# Sourced for the container engine detection and BUILDER, so a teardown looks for
# node containers with the same engine kind created them with.
CLUSTER="${ONLY:-apg-e2e}"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
unset KUBECONFIG

remove() {
  local name=$1
  local config="${E2E_DIR}/.kubeconfig-${name}"
  # `kind get clusters` is broken with podman 5.8, so the node container is the
  # thing to look for. See the note in common.sh.
  if "${BUILDER}" ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "${name}-control-plane"; then
    KUBECONFIG="${config}" kind delete cluster --name "${name}"
  fi
  rm -f "${config}"
}

if [[ -n "${ONLY}" ]]; then
  remove "${ONLY}"
  exit 0
fi

# Both modes run in their own cluster, so with no CLUSTER given remove whichever
# of them exist.
for name in apg-e2e apg-ui; do
  remove "${name}"
done
