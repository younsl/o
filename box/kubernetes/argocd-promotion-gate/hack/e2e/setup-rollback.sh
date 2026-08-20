#!/usr/bin/env bash
# Drive the local Argo CD to the state right before a rollback test.
#
# The interesting scenario is the one that looks safe and is not: beta and prd
# both running the same version, prd turns out broken, and prd has to go back
# while beta stays where it is. That is a downgrade from the gate's point of
# view, so without the rollback allowance it would be refused.
#
# Leaves the cluster like this:
#
#   beta-sample-app   6.7.1  Synced Healthy
#   prd-sample-app    6.7.1  Synced Healthy   history: 6.7.0 then 6.7.1
#   gate              imageTag enforce, rollback allowance on
#
# From there, History and Rollback on prd-sample-app targets 6.7.0, which is a
# revision prd has already deployed, and the gate lets it through.
set -uo pipefail

CLUSTER="${CLUSTER:-apg-ui}"
OLD_VERSION="${OLD_VERSION:-6.7.0}"
NEW_VERSION="${NEW_VERSION:-6.7.1}"
UI_PORT="${UI_PORT:-18080}"

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
require_local_cluster
KUBECTL=(kubectl --context "${CTX}" -n argocd)

BASE="http://localhost:${UI_PORT}"

api() {
  local method=$1 path=$2 body=${3:-}
  if [[ -n "${body}" ]]; then
    curl -sS -X "${method}" "${BASE}${path}" \
      -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json' -d "${body}"
  else
    curl -sS -X "${method}" "${BASE}${path}" -H "Authorization: Bearer ${TOKEN}"
  fi
}

wait_for_healthy() {
  local app=$1
  for _ in $(seq 1 48); do
    local state
    state=$("${KUBECTL[@]}" get application "${app}" \
      -o jsonpath='{.status.sync.status}/{.status.health.status}' 2>/dev/null)
    [[ "${state}" == "Synced/Healthy" ]] && return 0
    sleep 5
  done
  echo "timed out waiting for ${app} to be Synced and Healthy" >&2
  return 1
}

set_version() {
  local app=$1 version=$2
  "${KUBECTL[@]}" patch application "${app}" --type merge \
    -p "{\"spec\":{\"source\":{\"targetRevision\":\"${version}\"}}}" >/dev/null
  # The gate reads Argo CD's cached comparison, so the refresh is what makes the
  # new desired state visible rather than the patch itself.
  api GET "/api/v1/applications/${app}?refresh=hard" >/dev/null
  sleep 4
}

deploy() {
  local app=$1 version=$2
  log "deploying ${app} at ${version}"
  set_version "${app}" "${version}"
  api POST "/api/v1/applications/${app}/sync" '{}' >/dev/null
  wait_for_healthy "${app}"
}

log "checking the local Argo CD on ${BASE}"
if ! curl -sf -o /dev/null "${BASE}/api/version"; then
  cat >&2 <<EOF
Argo CD is not reachable on ${BASE}. Start a port-forward first:

  KUBECONFIG=${KUBECONFIG_FILE} kubectl -n argocd port-forward svc/argocd-server ${UI_PORT}:80
EOF
  exit 1
fi

PASSWORD=$("${KUBECTL[@]}" get secret argocd-initial-admin-secret \
  -o jsonpath='{.data.password}' | base64 -d)
TOKEN=$(curl -sS "${BASE}/api/v1/session" -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"${PASSWORD}\"}" | jq -r .token)
if [[ -z "${TOKEN}" || "${TOKEN}" == "null" ]]; then
  echo "could not log in to Argo CD" >&2
  exit 1
fi

log "applying projects and applications"
"${KUBECTL[@]}" apply -f "${E2E_DIR}/projects.yaml" >/dev/null
kubectl --context "${CTX}" apply -f "${REPO_ROOT}/examples/sample-applications.yaml" 2>&1 | grep -v Warning

log "enabling the image tag check in enforce mode with the rollback allowance"
"${HELM[@]}" upgrade argocd-promotion-gate "${REPO_ROOT}/charts/argocd-promotion-gate" \
  -n argocd -f "${E2E_DIR}/values.yaml" \
  --set gate.imageTag.enabled=true \
  --set gate.imageTag.mode=enforce \
  --set gate.rollback.allowPreviouslyDeployedRevision=true \
  --set gate.argocd.serverAddress=http://argocd-server \
  --set gate.argocd.caSecret.enabled=false \
  --wait --timeout 180s >/dev/null
"${KUBECTL[@]}" rollout status deploy/argocd-promotion-gate --timeout=120s | tail -1

# The upstream goes first, because the gate would refuse prd otherwise and this
# script is meant to leave a clean starting point rather than prove a denial.
deploy beta-sample-app "${NEW_VERSION}" || exit 1

# prd gets the old version first purely to put it in the history. That entry is
# what the rollback will target.
deploy prd-sample-app "${OLD_VERSION}" || exit 1
deploy prd-sample-app "${NEW_VERSION}" || exit 1

log "state"
"${KUBECTL[@]}" get applications
for app in beta-sample-app prd-sample-app; do
  "${KUBECTL[@]}" get application "${app}" -o jsonpath="${app}: live={.status.summary.images[*]} revision={.status.sync.revision} history={range .status.history[*]}{.revision}({.id}) {end}{\"\\n\"}"
done

cat <<EOF

=== ready

Both environments run ${NEW_VERSION}. prd has ${OLD_VERSION} in its history, so a
rollback has somewhere to go.

Try it in the UI at ${BASE}
  user: admin
  pass: ${PASSWORD}

  1. Open prd-sample-app, HISTORY AND ROLLBACK, pick the ${OLD_VERSION} entry, ROLLBACK.
     The gate allows it: the revision ran here before, so the image cannot be
     one this environment has never run. The panel reads Rollback.

  2. For the contrast, set prd forward to a version beta is not running:

       kubectl --context ${CTX} -n argocd patch application prd-sample-app --type merge \\
         -p '{"spec":{"source":{"targetRevision":"6.6.2"}}}'

     Then press SYNC. That revision is not in prd's history, so it is a
     promotion and the gate refuses it.

  3. Watch the verdicts:

       KUBECONFIG=${KUBECONFIG_FILE} kubectl -n argocd logs -f deploy/argocd-promotion-gate | grep "promotion gate"
EOF
