#!/usr/bin/env bash
# Stand up a local cluster with the gate installed and nothing else.
#
# Deliberately not an Argo CD install. The gate only reads Applications, and a
# running Argo CD controller would keep rewriting the statuses these tests set,
# so the CRD alone gives a faster and far more predictable environment.
set -euo pipefail

CLUSTER="${CLUSTER:-apg-e2e}"
NAMESPACE="${NAMESPACE:-argocd}"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

log "cluster ${CLUSTER}"
create_cluster
build_and_load_image

log "namespace and CRD"
"${KUBECTL[@]}" create namespace "${NAMESPACE}" --dry-run=client -o yaml | "${KUBECTL[@]}" apply -f -
"${KUBECTL[@]}" apply -f "${E2E_DIR}/application-crd.yaml"
"${KUBECTL[@]}" wait --for=condition=Established crd/applications.argoproj.io --timeout=60s

log "fixtures"
"${KUBECTL[@]}" apply -f "${E2E_DIR}/applications.yaml"
"${KUBECTL[@]}" apply -f "${E2E_DIR}/rbac.yaml"

log "installing the gate"
"${HELM[@]}" upgrade --install argocd-promotion-gate \
  "${REPO_ROOT}/charts/argocd-promotion-gate" \
  --namespace "${NAMESPACE}" \
  --values "${E2E_DIR}/values.yaml" \
  --wait --timeout 120s

log "ready"
"${KUBECTL[@]}" -n "${NAMESPACE}" get pods,svc
"${KUBECTL[@]}" get validatingwebhookconfiguration argocd-promotion-gate \
  -o jsonpath='{range .webhooks[0].matchConditions[*]}{.name}{": "}{.expression}{"\n"}{end}'
printf '\nnext: hack/e2e/test.sh\n'
print_kubeconfig_hint
