#!/usr/bin/env bash
# Exercise the image tag comparison.
#
# The gate runs on the host here rather than in the cluster, because the only
# extra dependency is an Argo CD API to ask about desired images and a stub on
# localhost is far less machinery than getting cluster networking to reach back
# out. The webhook path is already covered by test.sh; what is under test here
# is the comparison and the enforce and warn modes.
set -uo pipefail

CLUSTER="${CLUSTER:-apg-e2e}"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
require_local_cluster
WORK="$(mktemp -d -t apg-tag-XXXXXX)"
KUBECTL=(kubectl --context "${CTX}" -n argocd)

pass=0
fail=0
ok()  { printf '  PASS  %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; fail=$((fail + 1)); }

cleanup() {
  [[ -n "${STUB_PID:-}" ]] && kill "${STUB_PID}" 2>/dev/null
  [[ -n "${GATE_PID:-}" ]] && kill "${GATE_PID}" 2>/dev/null
  rm -rf "${WORK}"
}
trap cleanup EXIT

echo "building the gate for the host"
(cd "${REPO_ROOT}" && go build -o "${WORK}/gate" ./cmd/argocd-promotion-gate) || exit 1

openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=localhost' \
  -keyout "${WORK}/tls.key" -out "${WORK}/tls.crt" 2>/dev/null
printf 'stub-token' > "${WORK}/token"

# The upstream runs 6.7.1, so a desired tag of 6.7.0 is a mismatch and 6.7.1 is
# a match. The fixture already puts 6.7.1 into the upstream summary.
"${KUBECTL[@]}" patch application beta-sample-app --type merge -p '{"status":{
  "sync":{"status":"Synced"},"health":{"status":"Healthy"},
  "summary":{"images":["ghcr.io/stefanprodan/podinfo:6.7.1"]}}}' >/dev/null

run_gate() {
  local mode=$1
  cat > "${WORK}/config.yaml" <<YAML
chain: [beta, prd]
gatedEnvs: [prd]
require:
  sync: true
  health: true
imageTag:
  enabled: true
  mode: ${mode}
  kinds: [Deployment]
  onError: deny
argocd:
  namespace: argocd
  serverAddress: http://127.0.0.1:18081
  caFile: ""
  tokenPath: ${WORK}/token
  timeoutSeconds: 3
  # No caching, so a changed desired tag takes effect on the next request.
  cacheTtlSeconds: 0
YAML
  "${WORK}/gate" --config "${WORK}/config.yaml" \
    --kubeconfig "${KUBECONFIG_FILE}" \
    --admin-addr 127.0.0.1:18080 --webhook-addr 127.0.0.1:18443 \
    --tls-cert-file "${WORK}/tls.crt" --tls-key-file "${WORK}/tls.key" \
    --log-format text > "${WORK}/gate-${mode}.log" 2>&1 &
  GATE_PID=$!
  for _ in $(seq 1 20); do
    curl -sf -o /dev/null localhost:18080/healthz && return 0
    sleep 0.5
  done
  return 1
}

start_stub() {
  DESIRED_TAG="$1" TOKEN=stub-token PORT=18081 \
    python3 "${E2E_DIR}/stub-argocd-server.py" > "${WORK}/stub.log" 2>&1 &
  STUB_PID=$!
  sleep 1
}

verdict_for() {
  curl -sf "localhost:18080/api/v1/gate?app=prd-sample-app" 2>/dev/null
}

assert_verdict() {
  local label=$1 want_code=$2 want_allowed=$3
  local body code allowed
  body=$(verdict_for)
  code=$(printf '%s' "${body}" | jq -r '.code // "none"')
  allowed=$(printf '%s' "${body}" | jq -r 'if has("allowed") then (.allowed | tostring) else "none" end')
  if [[ "${code}" == "${want_code}" && "${allowed}" == "${want_allowed}" ]]; then
    ok "${label}"
  else
    bad "${label}: got code=${code} allowed=${allowed}, want ${want_code} and ${want_allowed}"
    printf '        %s\n' "$(printf '%s' "${body}" | jq -r '.message // "no message"')"
  fi
}

printf '\nenforce mode\n'
start_stub 6.7.0
run_gate enforce || { bad "the gate did not start"; cat "${WORK}/gate-enforce.log"; exit 1; }
assert_verdict "a desired tag the upstream is not running is denied" ImageTagMismatch false
kill "${STUB_PID}" 2>/dev/null

start_stub 6.7.1
assert_verdict "a matching tag passes" Passed true
kill "${GATE_PID}" 2>/dev/null; kill "${STUB_PID}" 2>/dev/null

printf '\nwarn mode\n'
start_stub 6.7.0
run_gate warn || { bad "the gate did not start"; exit 1; }
assert_verdict "the same mismatch is allowed and reported" ImageTagMismatch true
if verdict_for | jq -e '.warnings | length > 0' >/dev/null; then
  ok "the mismatch is attached as a warning"
else
  bad "warn mode produced no warning"
fi
kill "${GATE_PID}" 2>/dev/null; kill "${STUB_PID}" 2>/dev/null

printf '\nlookup failure\n'
# No stub at all, so the Argo CD API is unreachable and onError decides.
run_gate enforce || { bad "the gate did not start"; exit 1; }
assert_verdict "an unreachable Argo CD API is denied under onError deny" LookupFailed false
kill "${GATE_PID}" 2>/dev/null

printf '\n%d passed, %d failed\n' "${pass}" "${fail}"
[[ "${fail}" -eq 0 ]]
