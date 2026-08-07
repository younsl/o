# Design: Karpenter NodePool Node Replacement

## Status

Proposed. Target: v1 (replace strategy only).

## Background

kuo currently upgrades only EKS Managed Node Groups (MNG). The `UpgradingNodeGroups` phase calls the AWS `UpdateNodegroupVersion` API and lets EKS handle the node roll internally, so kuo never touches Nodes or Pods directly.

Karpenter-managed nodes are out of scope today. After a control plane upgrade, operators must replace Karpenter nodes manually. This feature adds a dedicated phase that rolls Karpenter NodePool nodes inside the kuo pipeline, so MNG and Karpenter can be driven by a single `EKSUpgrade` custom resource.

## Goals

- Roll Karpenter NodePool nodes after the control plane upgrade completes.
- Let kuo own the replacement order, pace, and workload-stability checks (replace strategy).
- Keep node-disruption safety on par with a manual, careful `kubectl drain` roll.
- Reuse the existing phase state machine, status merge-patch, and non-blocking requeue patterns.

## Non-Goals (v1)

- `drift` strategy (delegating replacement to the Karpenter Disruption controller). Deferred to v2.
- Dynamic `maxUnavailable: "auto"` based on PDB budgets. Deferred to v2.
- Rollback of Karpenter nodes. Node version downgrade is not practical when EC2NodeClass points at `@latest`.
- Self-managed and manually provisioned nodes.

## Requirements

| Requirement | Detail |
|-------------|--------|
| Karpenter API | v1 only (`karpenter.sh/v1`, `karpenter.k8s.aws/v1`, Karpenter 1.0+). v1beta1 and earlier are unsupported. |
| AMI selector | Target NodePools must resolve their EC2NodeClass AMI via `alias: <family>@latest`. Pinned AMIs (`id:` or `@vYYYYMMDD`) are rejected in preflight, because replacing a node would return the same old AMI. |
| Ordering | Runs after `UpgradingNodeGroups`. Control plane must already be at `targetVersion`. |

## Phase Flow

```
Pending -> Planning -> PreflightChecking -> UpgradingControlPlane
  -> UpgradingAddons -> UpgradingNodeGroups -> UpgradingKarpenterNodePools -> Completed
```

`UpgradingKarpenterNodePools` is forward-only and is not part of the rollback path. When `karpenterNodePools.enabled` is false, or no stale nodes exist, the phase passes through immediately.

## Custom Resource Spec

These fields belong to the existing `EKSUpgrade` custom resource (`kuo.io/v1alpha1`), under a new `spec.karpenterNodePools` block. Only the Karpenter-related fields are shown here; the rest of the `EKSUpgrade` spec (`clusterName`, `targetVersion`, `region`, `upgradeMode`, ...) is unchanged.

```yaml
apiVersion: kuo.io/v1alpha1
kind: EKSUpgrade
metadata:
  name: cluster-upgrade
spec:
  clusterName: sb-mpay-cluster
  targetVersion: "1.36"
  region: ap-northeast-2
  upgradeMode: Forward
  # New block added by this feature:
  karpenterNodePools:
    enabled: true
    nodePools: []                  # empty or ["ALL"] = all NodePools; otherwise the named subset, processed in listed order
    strategy: Replace              # v1 is fixed to Replace
    maxUnavailable: "1"            # integer or "10%" (static in v1); "auto" is v2
    nodeDrainTimeoutMinutes: 15    # max wait for the old node to drain and be removed
    controllerStableTimeoutMinutes: 10  # max wait for evicted pods' controllers to become Ready again
```

## Replace Algorithm

```
Precondition: control plane at targetVersion, preflight passed

for np in target NodePools:
  claims = NodeClaims where label karpenter.sh/nodepool == np
  stale  = claims where kubeletVersion.minor < targetVersion.minor
  for batch of size maxUnavailable:
    for c in batch:
      snapshot = controllers owning the pods on c's node   # captured BEFORE delete
      delete NodeClaim c                                    # Karpenter cordons, drains, provisions
    wait until old node removed         (bounded by nodeDrainTimeout)
    wait until new node Ready and kubelet == targetVersion
    wait until snapshot controllers stable (bounded by controllerStableTimeout)
    record completed NodeClaim in status
```

Staleness is decided by `Node.status.nodeInfo.kubeletVersion` minor, not by AMI or NodeClaim age. This makes the decision idempotent: after an operator restart, kuo re-derives which nodes still need work from live cluster state.

## Stable Replacement Design

The core safety idea is that a node is not "done" when its replacement Node becomes Ready. It is done only when the workloads that were evicted from it are running and Ready again somewhere else. kuo therefore treats each node replacement as a three-stage wait: drain the old node, bring up the new node, and confirm the affected controllers recovered, before touching the next node.

To make "affected controllers recovered" precise and cheap, kuo does not watch the whole cluster. Before deleting a NodeClaim it snapshots the pods on that node and promotes each to its top-level owning controller (Deployment/StatefulSet/DaemonSet), deduplicated. Only those controllers are polled for recovery. This is more targeted than a cluster-wide stability wait: unrelated churn does not block progress, and the causal link (this node's eviction to these controllers) stays clear.

Two properties make the process safe to interrupt and resume:

- Idempotent staleness. The replacement target is derived from live `kubeletVersion`, not from a persisted work list. After a crash, kuo re-lists nodes and recomputes what remains, so a restart mid-roll never double-replaces or skips.
- Bounded waits. Every wait has a timeout. A stuck drain (PDB deadlock) or an unschedulable replacement (insufficient capacity, affinity) fails the phase with a specific reason instead of hanging forever.

## Node-Disruption Safety Guardrails

1. Wait for owning controllers to recover before the next node. Node Ready does not mean the service recovered.
2. Snapshot the node's pods before `delete`. Once drain starts the pods scatter and cannot be traced.
3. Check `status.observedGeneration == metadata.generation` so a stale controller status is not read as stable.
4. Require N consecutive stable polls (default 3 over 30s) to avoid flapping during HPA scaling.
5. Subtract a baseline: controllers already unhealthy before the delete are excluded, so a pre-existing CrashLoop does not block forever.
6. Delegate eviction to Karpenter, which honors PodDisruptionBudgets. kuo only deletes the NodeClaim.
7. Dual timeouts: `nodeDrainTimeout` (leaving side) and `controllerStableTimeout` (recovery side). Either one exceeded fails the phase.
8. `maxUnavailable` caps concurrency to bound the blast radius.
9. Stop if a replacement node does not come up. Never keep evicting into a shrinking cluster.
10. kubelet-version staleness plus a preflight check that `@latest` already resolves to the target AMI, preventing an infinite replace loop.

Pods with no controller (static or bare pods) are skipped and logged.

## Preflight Checks

Run only when `karpenterNodePools.enabled` is true.

| Check | Fails when |
|-------|-----------|
| Karpenter v1 API served | `NodePool`/`NodeClaim`/`EC2NodeClass` v1 not present |
| EC2NodeClass AMI selector | any target NodePool's `amiSelectorTerms` is pinned (`id:` or `@vYYYYMMDD`) instead of `alias: <family>@latest` |
| AMI resolution | `@latest` has not yet resolved to the target-version AMI |

## Status

```yaml
status:
  phase: UpgradingKarpenterNodePools
  karpenterNodePools:
    strategy: replace
    activePool: spot               # NodePool currently being processed
    totalNodes: 8
    replacedNodes: 3
    pools:
      - name: default
        status: Completed
        totalNodes: 5
        replacedNodes: 5
      - name: spot
        status: InProgress
        totalNodes: 3
        replacedNodes: 0
        completedNodeClaims: []    # crash-recovery record, most recent N retained
        currentBatch:
          - nodeClaim: spot-ghi56
            nodeName: ip-10-0-1-23.ap-northeast-2.compute.internal
            providerID: aws:///ap-northeast-2a/i-0abc123   # optional
            state: WaitingControllerStable   # Draining | WaitingNodeReady | WaitingControllerStable
            startedAt: "2026-07-23T06:20:00Z"
    conditions: []
```

`currentBatch` records both the NodeClaim name and the Node resource name so operators can cross-reference `kubectl get nodes` without an extra lookup. `nodeName` is omitted while empty; `providerID` is optional.

The top-level `status.progress` string stays component-grained. Each NodePool counts as one unit, matching how each managed node group counts as one regardless of node count:

```
total = controlPlaneSteps + addons + nodegroups + karpenterPools
done  = cpDone + addonsDone + ngDone + karpenterPoolsDone   # pools with status Completed
```

Node-level progress (for example 3/8 nodes within a pool) lives in `pools[].replacedNodes/totalNodes`, not in the top-level ratio.

## Slack Notifications

On entering the phase, the started message Phases line gains `-> KarpenterNodePools`, plus a dedicated block:

```
Karpenter NodePool Upgrade
NodePools     default, spot
Strategy      replace
Concurrency   maxUnavailable 1
Progress      3/8 nodes replaced
Current       replacing spot-ghi56 (node ip-10-0-1-23, waiting controllers)
```

Events: start, complete, fail, and optional 25/50/75% milestones. Per-node alerts are intentionally suppressed to avoid spam. Failure alerts include the reason (which timeout) and the blocking PDB or node.

## RBAC

| API group | Resources | Verbs |
|-----------|-----------|-------|
| `karpenter.sh` | nodepools, nodeclaims | get, list, delete |
| `karpenter.k8s.aws` | ec2nodeclasses | get, list |
| core | nodes, pods | get, list |
| policy | poddisruptionbudgets | get, list |

## v1 / v2 Roadmap

| Version | Scope |
|---------|-------|
| v1 | replace strategy, static `maxUnavailable`, snapshot-controller stability checks, dual timeouts, preflight, status with `activePool`/`currentBatch`, Slack, forward-only |
| v2 | drift strategy, `maxUnavailable: "auto"` (PDB `disruptionsAllowed` plus non-overlapping node batching), adaptive concurrency, temporary relaxing of Karpenter `disruptionBudgets` |

## Limitations

- Karpenter v1 API only (Karpenter 1.0+). Clusters on v1beta1 or earlier are rejected in preflight.
- AMI must be resolved through `alias: <family>@latest`. Pinned AMIs are rejected, because replacing a node would reprovision the same version and loop. Teams that intentionally pin an AMI must upgrade those nodes outside kuo.
- Forward-only. Karpenter nodes are not rolled back. A rollback `EKSUpgrade` skips the Karpenter phase; node version downgrade is not supported.
- kuo deletes NodeClaims but does not itself cordon, drain, or evict. Actual pod eviction, PDB enforcement, and provisioning remain owned by Karpenter. If Karpenter is unhealthy or its `disruptionBudgets` block disruption, replacement stalls until `nodeDrainTimeout` and the phase fails.
- Karpenter `disruptionBudgets` and kuo `maxUnavailable` are two independent throttles. The effective pace is whichever is stricter. v1 does not adjust Karpenter budgets; if a budget is more restrictive than `maxUnavailable`, kuo waits on Karpenter.
- Workloads without a controller (static pods, bare pods) cannot be tracked for recovery and are skipped. Their availability during replacement is not guaranteed by kuo.
- Stability is judged per owning controller, not per individual pod. A Deployment that is already at `readyReplicas == replicas` for reasons unrelated to the replaced node is treated as stable.
- Cluster-scoped: one `EKSUpgrade` per cluster, so Karpenter replacement runs for the whole cluster's target NodePools in a single resource, not per-team.
