#!/usr/bin/env bash
# Stand up a local Argo CD with the gate wired in, for pressing Sync by hand.
#
# This is the slow path. hack/e2e/up.sh installs only the Application CRD and
# is what the scripted assertions use, because a real controller keeps rewriting
# the statuses those tests set. Use this one when the point is to log into the
# UI, see the Promotion Gate panel, and watch a denial arrive as a toast.
set -euo pipefail

# A separate cluster from up.sh on purpose. That one installs a minimal
# Application CRD, and the Argo CD chart brings its own, so sharing a cluster
# would collide over ownership of the same CRD.
CLUSTER="${CLUSTER:-apg-ui}"
ARGOCD_CHART_VERSION="${ARGOCD_CHART_VERSION:-10.2.1}" # appVersion v3.4.5
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

log "cluster ${CLUSTER}"
create_cluster
build_and_load_image

log "installing Argo CD ${ARGOCD_CHART_VERSION}"
helm repo add argo https://argoproj.github.io/argo-helm >/dev/null 2>&1 || true
helm repo update argo >/dev/null
"${KUBECTL[@]}" create namespace argocd --dry-run=client -o yaml | "${KUBECTL[@]}" apply -f -
# Without the extension init container on the first pass, because it fetches
# from a gate that does not exist yet.
"${HELM[@]}" upgrade --install argocd argo/argo-cd \
  --version "${ARGOCD_CHART_VERSION}" \
  --namespace argocd \
  --values "${E2E_DIR}/argocd-values.yaml" \
  --wait --timeout 600s

log "installing the gate"
"${HELM[@]}" upgrade --install argocd-promotion-gate \
  "${REPO_ROOT}/charts/argocd-promotion-gate" \
  --namespace argocd \
  --values "${E2E_DIR}/values.yaml" \
  --wait --timeout 180s

log "adding the UI extension to argocd-server"
"${HELM[@]}" upgrade argocd argo/argo-cd \
  --version "${ARGOCD_CHART_VERSION}" \
  --namespace argocd \
  --values "${E2E_DIR}/argocd-values.yaml" \
  --values "${E2E_DIR}/argocd-extension.yaml" \
  --wait --timeout 300s

log "projects and applications"
"${KUBECTL[@]}" apply -f "${E2E_DIR}/projects.yaml"
"${KUBECTL[@]}" apply -f "${REPO_ROOT}/examples/sample-applications.yaml"

log "waiting for Argo CD to reconcile the pair"
for _ in $(seq 1 60); do
  ready=$("${KUBECTL[@]}" -n argocd get application beta-sample-app prd-sample-app \
    -o jsonpath='{range .items[*]}{.status.sync.status}{"\n"}{end}' 2>/dev/null | grep -c . || true)
  [[ "${ready}" -ge 2 ]] && break
  sleep 5
done

log "state"
"${KUBECTL[@]}" -n argocd get applications
"${KUBECTL[@]}" -n argocd get pods

password=$("${KUBECTL[@]}" -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath='{.data.password}' 2>/dev/null | base64 -d || echo '<not created>')

cat <<EOF

=== log in

  kubectl --context ${CTX} -n argocd port-forward svc/argocd-server 8080:80

  http://localhost:8080
  user: admin
  pass: ${password}

=== what to try

1. Open prd-sample-app. The Promotion Gate tile shows why it is blocked.
   beta-sample-app has not been synced yet, so prd has nothing promoted upstream.

2. Press SYNC on prd-sample-app. The gate refuses and Argo CD shows the reason
   in a red toast.

3. Sync beta-sample-app first and wait for Healthy.

4. Press SYNC on prd-sample-app again. It goes through.

5. Turn the image tag check on to see the interesting denial. Both environments
   ship 6.7.1, so put them on different tags first:

     kubectl --context ${CTX} -n argocd patch application prd-sample-app --type merge \\
       -p '{"spec":{"source":{"targetRevision":"6.7.0"}}}'

   The check needs an Argo CD API token, which is two steps:

     kubectl --context ${CTX} -n argocd patch cm argocd-cm --type merge \\
       -p '{"data":{"accounts.promotion-gate":"apiKey"}}'
     kubectl --context ${CTX} -n argocd rollout restart deploy/argocd-server

     # with the port-forward from above still running
     argocd login localhost:8080 --username admin --password '${password}' --plaintext
     TOKEN=\$(argocd account generate-token --account promotion-gate --plaintext)

     kubectl --context ${CTX} -n argocd create secret generic argocd-promotion-gate-token \\
       --from-literal=token="\$TOKEN"

     helm --kube-context ${CTX} upgrade argocd-promotion-gate \\
       ${REPO_ROOT}/charts/argocd-promotion-gate -n argocd -f ${E2E_DIR}/values.yaml \\
       --set gate.imageTag.enabled=true \\
       --set gate.imageTag.mode=enforce \\
       --set gate.argocd.serverAddress=http://argocd-server \\
       --set gate.argocd.caSecret.enabled=false

   Then press SYNC on prd-sample-app again. It is refused on the tag even
   though beta-sample-app is Synced and Healthy.

=== tear down

  ${E2E_DIR}/down.sh

=== kubeconfig

This cluster lives in its own file, so the real kubeconfig was never touched.

  export KUBECONFIG=${KUBECONFIG_FILE}
EOF
