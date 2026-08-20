# Shared setup for the e2e scripts.
#
# Everything here exists to keep the test off the developer's real kubeconfig.
# `kind create cluster` writes a context into ~/.kube/config and switches the
# current context to it, which on a machine that also talks to real clusters is
# an unpleasant surprise waiting to happen. A dedicated file per mode means the
# real config is never opened, let alone modified.

: "${CLUSTER:?CLUSTER must be set before sourcing common.sh}"

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${E2E_DIR}/../.." && pwd)"

# One kubeconfig per cluster, kept out of the repo.
KUBECONFIG_FILE="${KUBECONFIG_FILE:-${E2E_DIR}/.kubeconfig-${CLUSTER}}"
export KUBECONFIG="${KUBECONFIG_FILE}"

CTX="kind-${CLUSTER}"
KUBECTL=(kubectl --context "${CTX}")
HELM=(helm --kube-context "${CTX}")

# kind talks to podman on machines without a docker daemon, which is the common
# case here since docker is an alias rather than a running engine. A working
# docker is used as-is, and the builder follows the provider so that
# cluster_exists and build_and_load_image look at the same engine kind uses.
if [[ -z "${KIND_EXPERIMENTAL_PROVIDER:-}" ]]; then
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    KIND_EXPERIMENTAL_PROVIDER=docker
  else
    KIND_EXPERIMENTAL_PROVIDER=podman
  fi
fi
export KIND_EXPERIMENTAL_PROVIDER

BUILDER="${BUILDER:-${KIND_EXPERIMENTAL_PROVIDER}}"
IMAGE="${IMAGE:-localhost/argocd-promotion-gate:e2e}"

log() { printf '\n=== %s\n' "$*"; }

# Refuses to run against anything that is not the local kind cluster. A stray
# KUBECONFIG or a typo in CLUSTER should stop the script, not reconfigure a real
# cluster.
require_local_cluster() {
  local server
  server=$(kubectl --context "${CTX}" config view --minify \
    -o jsonpath='{.clusters[0].cluster.server}' 2>/dev/null || true)
  case "${server}" in
    https://127.0.0.1:* | https://localhost:* | https://0.0.0.0:*) ;;
    *)
      printf 'refusing to continue: context %s points at %s, which is not a local cluster\n' \
        "${CTX}" "${server:-<unknown>}" >&2
      exit 1
      ;;
  esac
}

# `kind get clusters` is unusable with podman 5.8: kind formats the listing with
# `index .Labels "..."` and this podman returns Labels as a slice, so the command
# exits 125 and kind reports no clusters even when nodes exist. Asking the
# builder for the node container directly sidesteps that entirely.
cluster_exists() {
  "${BUILDER}" ps -a --format '{{.Names}}' 2>/dev/null |
    grep -qx "${CLUSTER}-control-plane"
}

create_cluster() {
  if cluster_exists; then
    if [[ ! -s "${KUBECONFIG_FILE}" ]]; then
      # Nodes without a kubeconfig means a previous run was interrupted. There
      # is no way to recover credentials for it, so start clean.
      echo "cluster ${CLUSTER} exists but its kubeconfig is gone, recreating"
      kind delete cluster --name "${CLUSTER}" >/dev/null 2>&1 || true
    else
      echo "cluster ${CLUSTER} already exists, reusing"
      require_local_cluster
      return 0
    fi
  fi
  kind create cluster --name "${CLUSTER}" --kubeconfig "${KUBECONFIG_FILE}" --wait 180s
  require_local_cluster
}

build_and_load_image() {
  log "building and loading ${IMAGE}"
  "${BUILDER}" build \
    --build-arg VERSION=e2e \
    --build-arg COMMIT="$(git -C "${REPO_ROOT}" rev-parse --short HEAD 2>/dev/null || echo none)" \
    -t "${IMAGE}" "${REPO_ROOT}"
  local archive
  archive="$(mktemp -t apg-image-XXXXXX).tar"
  "${BUILDER}" save -o "${archive}" "${IMAGE}"
  kind load image-archive "${archive}" --name "${CLUSTER}"
  rm -f "${archive}"
}

print_kubeconfig_hint() {
  cat <<EOF

The real kubeconfig was not touched. To drive this cluster by hand:

  export KUBECONFIG=${KUBECONFIG_FILE}
  kubectl config current-context
EOF
}
