#!/usr/bin/env bash
# Exercise the gate through the real admission path.
#
# Every case here goes through the API server, so the CEL match conditions, the
# TLS the chart generated, and the webhook itself are all under test. A sync is
# a patch that sets the Application's top-level operation field, which is
# exactly what argocd-server does when somebody presses Sync.
set -uo pipefail

CLUSTER="${CLUSTER:-apg-e2e}"
NAMESPACE="${NAMESPACE:-argocd}"
CONTROLLER_SA="system:serviceaccount:argocd:argocd-application-controller"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
require_local_cluster
KUBECTL=(kubectl --context "${CTX}" -n "${NAMESPACE}")

pass=0
fail=0

ok()   { printf '  PASS  %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  FAIL  %s\n' "$1"; fail=$((fail + 1)); }
case_() { printf '\n%s\n' "$1"; }

# Argo CD clears the operation field once it has processed the sync. Nothing
# does that here, and a still-set operation reads as "not a new sync", so it has
# to be cleared between attempts.
clear_operation() {
  "${KUBECTL[@]}" patch application "$1" --type json \
    -p '[{"op":"remove","path":"/operation"}]' >/dev/null 2>&1 || true
}

set_status() {
  local app=$1 sync=$2 health=$3
  "${KUBECTL[@]}" patch application "${app}" --type merge \
    -p "{\"status\":{\"sync\":{\"status\":\"${sync}\"},\"health\":{\"status\":\"${health}\"}}}" >/dev/null
}

# Attempts a sync and echoes either "ALLOWED" or the denial message.
try_sync() {
  local app=$1
  shift
  clear_operation "${app}"
  local out
  if out=$("${KUBECTL[@]}" patch application "${app}" --type merge \
      -p '{"operation":{"sync":{"revision":"HEAD"},"initiatedBy":{"username":"tester@example.com"}}}' "$@" 2>&1); then
    echo "ALLOWED"
  else
    echo "${out}"
  fi
}

expect_denied() {
  local label=$1 result=$2 needle=$3
  if [[ "${result}" == "ALLOWED" ]]; then
    bad "${label}: the sync was allowed"
  elif [[ "${result}" != *"${needle}"* ]]; then
    bad "${label}: denied but the message never mentions ${needle}"
    printf '        %s\n' "${result}"
  else
    ok "${label}"
  fi
}

expect_allowed() {
  local label=$1 result=$2
  if [[ "${result}" == "ALLOWED" ]]; then
    ok "${label}"
  else
    bad "${label}: the sync was denied"
    printf '        %s\n' "${result}"
  fi
}

case_ "upstream is OutOfSync"
set_status beta-sample-app OutOfSync Healthy
expect_denied "prd sync is refused and names the upstream" \
  "$(try_sync prd-sample-app)" "beta-sample-app"

case_ "upstream is Synced but Degraded"
set_status beta-sample-app Synced Degraded
expect_denied "prd sync is refused on health" \
  "$(try_sync prd-sample-app)" "Healthy"

case_ "upstream is promoted"
set_status beta-sample-app Synced Healthy
expect_allowed "prd sync goes through" "$(try_sync prd-sample-app)"

case_ "no upstream counterpart"
expect_allowed "an app with nothing upstream is not blocked" "$(try_sync prd-orphan-app)"

case_ "chain head"
expect_allowed "beta is never gated" "$(try_sync beta-sample-app)"

case_ "the application controller is exempt"
set_status beta-sample-app OutOfSync Degraded
expect_allowed "an auto-sync from the controller service account is left alone" \
  "$(try_sync prd-sample-app --as "${CONTROLLER_SA}")"

case_ "an automated operation is exempt"
clear_operation prd-sample-app
if out=$("${KUBECTL[@]}" patch application prd-sample-app --type merge \
    -p '{"operation":{"sync":{},"initiatedBy":{"automated":true}}}' 2>&1); then
  ok "an operation Argo CD marked automated is left alone"
else
  bad "an automated operation was blocked"
  printf '        %s\n' "${out}"
fi

case_ "the skip annotation"
"${KUBECTL[@]}" annotate application prd-sample-app \
  promotion-gate.younsl.github.io/skip=true --overwrite >/dev/null
expect_allowed "an annotated app opts out" "$(try_sync prd-sample-app)"
"${KUBECTL[@]}" annotate application prd-sample-app \
  promotion-gate.younsl.github.io/skip- >/dev/null

case_ "writes that are not syncs"
# The match conditions must keep the webhook off ordinary traffic. With the
# upstream broken, anything that reached the gate would be denied.
set_status beta-sample-app OutOfSync Degraded
if "${KUBECTL[@]}" label application prd-sample-app e2e-probe=1 --overwrite >/dev/null 2>&1; then
  ok "a label change is not intercepted"
else
  bad "a label change was intercepted"
fi
if set_status prd-sample-app OutOfSync Healthy 2>/dev/null; then
  ok "a status write is not intercepted"
else
  bad "a status write was intercepted"
fi

case_ "the panel agrees with the webhook"
# The read-only API behind the UI extension has to return the same verdict the
# webhook just enforced. If these two ever disagree the panel is lying.
set_status beta-sample-app OutOfSync Healthy
"${KUBECTL[@]}" port-forward svc/argocd-promotion-gate 18080:8080 >/dev/null 2>&1 &
pf_pid=$!
trap 'kill "${pf_pid}" 2>/dev/null' EXIT
for _ in $(seq 1 20); do
  curl -sf -o /dev/null localhost:18080/healthz && break
  sleep 0.5
done

verdict=$(curl -sf "localhost:18080/api/v1/gate?app=prd-sample-app" 2>/dev/null)
code=$(printf '%s' "${verdict}" | jq -r '.code // "none"' 2>/dev/null)
allowed=$(printf '%s' "${verdict}" | jq -r 'if has("allowed") then (.allowed | tostring) else "none" end' 2>/dev/null)
if [[ "${code}" == "UpstreamOutOfSync" && "${allowed}" == "false" ]]; then
  ok "the API reports UpstreamOutOfSync and a denial"
else
  bad "the API reported code=${code} allowed=${allowed}, want UpstreamOutOfSync and false"
fi

# And the webhook must reach the same conclusion on the same state.
expect_denied "the webhook denies the same state" \
  "$(try_sync prd-sample-app)" "beta-sample-app"

ungated=$(curl -sf "localhost:18080/api/v1/gate?app=beta-sample-app" 2>/dev/null | jq -r '.code // "none"')
if [[ "${ungated}" == "NotGated" ]]; then
  ok "the API marks the chain head ungated"
else
  bad "the API reported ${ungated} for the chain head, want NotGated"
fi

case_ "metrics"
metrics=$(curl -sf localhost:18080/metrics 2>/dev/null)
if printf '%s' "${metrics}" | grep -q 'argocd_promotion_gate_decisions_total{.*code="UpstreamOutOfSync".*} [1-9]'; then
  ok "denials are counted"
else
  bad "no counted denial in the metric output"
fi
if printf '%s' "${metrics}" | grep -q 'argocd_promotion_gate_admission_requests_total{outcome="denied"} [1-9]'; then
  ok "admission outcomes are counted"
else
  bad "no counted admission denial in the metric output"
fi

kill "${pf_pid}" 2>/dev/null
trap - EXIT

clear_operation prd-sample-app
clear_operation prd-orphan-app
clear_operation beta-sample-app

printf '\n%d passed, %d failed\n' "${pass}" "${fail}"
[[ "${fail}" -eq 0 ]]
