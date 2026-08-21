//! `explain_phase`: static descriptions of every upgrade phase.
//!
//! Deliberately compiled-in text rather than a live read. The most common
//! class of agent hallucination is inventing plausible-sounding kuo
//! semantics; a fixed answer per phase removes it and costs nothing to serve.

use serde_json::json;

use crate::mcp::result::{ToolResult, Verdict};

/// One phase's story: what it does, what it waits on, what makes it fail,
/// and what the operator can do about it.
struct PhaseStory {
    name: &'static str,
    does: &'static str,
    waits_on: &'static str,
    fails_when: &'static str,
    operator_action: &'static str,
}

/// Every phase in `crate::crd::UpgradePhase`, same order. A unit test keeps
/// the two lists from drifting apart.
const STORIES: &[PhaseStory] = &[
    PhaseStory {
        name: "Pending",
        does: "The resource exists but reconciliation has not picked it up yet.",
        waits_on: "The controller's next reconcile pass.",
        fails_when: "It never fails by itself.",
        operator_action: "Nothing. If it sits here for minutes, check the operator Pod is running and its logs.",
    },
    PhaseStory {
        name: "Planning",
        does: "Verifies AWS identity, reads the cluster's current version, and computes the minor-by-minor upgrade or rollback path with per-component counts.",
        waits_on: "EKS DescribeCluster and STS GetCallerIdentity.",
        fails_when: "The AWS credentials cannot be resolved, the cluster does not exist in the region, or the requested transition is invalid (for example a rollback with no eligible target).",
        operator_action: "Check status.identity and the AWSAuthenticated condition, then spec.clusterName, spec.region, and spec.assumeRoleArn.",
    },
    PhaseStory {
        name: "PreflightChecking",
        does: "Runs the pre-upgrade checks: deletion protection, EKS cluster insights, PDB drain deadlock, and the Karpenter v1 API plus AMI selector checks when Karpenter replacement is enabled.",
        waits_on: "EKS insights listing and target-cluster reads.",
        fails_when: "A mandatory check fails. Advisory failures are recorded but never block; only mandatory ones do.",
        operator_action: "Read status.phases.preflight, fix what the mandatory failure names (get_preflight_report shows which ones block), then let the retry re-run the checks.",
    },
    PhaseStory {
        name: "UpgradingControlPlane",
        does: "Submits the EKS control plane update for the next minor step and polls it, one minor at a time until targetVersion.",
        waits_on: "The EKS update reaching Successful, typically 10 to 15 minutes per minor.",
        fails_when: "EKS reports the update Failed or the configured control plane timeout elapses.",
        operator_action: "Check the update id in status.phases.controlPlane against the EKS console. Timeouts are configurable under spec.timeouts.",
    },
    PhaseStory {
        name: "UpgradingAddons",
        does: "Updates each managed add-on to a version compatible with the new control plane minor, honoring spec.addonVersions pins.",
        waits_on: "Each add-on update reaching Active.",
        fails_when: "An add-on has no compatible version for the target minor, or its update degrades.",
        operator_action: "get_addon_plan shows the per-addon plan. Pin a known-good version in spec.addonVersions if the latest compatible one misbehaves.",
    },
    PhaseStory {
        name: "UpgradingNodeGroups",
        does: "Rolls managed node groups to the new version through the EKS UpdateNodegroupVersion API; EKS handles the node cycling internally.",
        waits_on: "Each node group update completing, which drains and replaces nodes.",
        fails_when: "The EKS update fails (commonly PodEvictionFailure from a tight PodDisruptionBudget) or times out.",
        operator_action: "get_pdb_risks lists drain-deadlocking PDBs. Fix the budget or the stuck workload, then retry.",
    },
    PhaseStory {
        name: "UpgradingKarpenterNodePools",
        does: "Replaces Karpenter-provisioned nodes whose kubelet is behind the target minor, pool by pool, deleting NodeClaims at the configured pace and waiting for workloads to stabilize.",
        waits_on: "Replacement nodes joining at the new version and the disrupted workloads' controllers reporting ready.",
        fails_when: "Node drains exceed nodeDrainTimeoutMinutes, workloads stay unstable past the stability window, or NodeClaim deletes are forbidden by RBAC.",
        operator_action: "get_karpenter_state shows per-pool progress. Check PDBs, the flagged workloads, and that the operator can delete NodeClaims on the target cluster.",
    },
    PhaseStory {
        name: "RollingBackNodeGroups",
        does: "First rollback step: returns managed node groups to the previous minor.",
        waits_on: "The same node group update mechanics as the forward phase.",
        fails_when: "Same failure modes as UpgradingNodeGroups.",
        operator_action: "Same as UpgradingNodeGroups: check PDBs and the update status in EKS.",
    },
    PhaseStory {
        name: "RollingBackAddons",
        does: "Second rollback step: moves add-ons to versions compatible with the previous minor.",
        waits_on: "Each add-on update reaching Active.",
        fails_when: "No compatible version exists for the previous minor.",
        operator_action: "Pin a compatible version in spec.addonVersions.",
    },
    PhaseStory {
        name: "RollingBackControlPlane",
        does: "Final rollback step: moves the control plane back one minor. EKS only permits this toward the version the cluster was recently upgraded from.",
        waits_on: "The EKS update reaching Successful.",
        fails_when: "EKS refuses the downgrade (no eligible target) or the update fails.",
        operator_action: "status.lastTransition records what the cluster can roll back to. A second consecutive rollback is never possible.",
    },
    PhaseStory {
        name: "Completed",
        does: "Terminal. The transition finished and status.lastTransition records it.",
        waits_on: "Nothing.",
        fails_when: "Never.",
        operator_action: "Nothing. A new spec change starts a fresh run.",
    },
    PhaseStory {
        name: "Failed",
        does: "Terminal for this attempt. status.message and the conditions carry the cause.",
        waits_on: "Nothing.",
        fails_when: "Already has.",
        operator_action: "diagnose_upgrade names the failing component and the next action. Fix the cause; a spec change or retry annotation starts a new attempt.",
    },
];

/// Answer `explain_phase` for one phase name. Unknown names return a
/// `unknown` verdict listing the valid ones instead of an error, so the agent
/// self-corrects on its next call.
pub fn explain(phase: &str) -> ToolResult {
    let requested = phase.trim();
    STORIES
        .iter()
        .find(|story| story.name.eq_ignore_ascii_case(requested))
        .map_or_else(
            || {
                let names: Vec<&str> = STORIES.iter().map(|s| s.name).collect();
                ToolResult::new(
                    format!("{requested:?} is not an upgrade phase"),
                    Verdict::Unknown,
                    json!({ "valid_phases": names }),
                )
            },
            |story| {
                ToolResult::new(
                    format!("{}: {}", story.name, story.does),
                    Verdict::Ok,
                    json!({
                        "phase": story.name,
                        "does": story.does,
                        "waits_on": story.waits_on,
                        "fails_when": story.fails_when,
                        "operator_action": story.operator_action,
                    }),
                )
            },
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crd::UpgradePhase;

    /// Every `UpgradePhase` variant must have a story, and every story must
    /// name a real variant, so the static text cannot drift from the enum.
    #[test]
    fn test_stories_cover_every_phase() {
        let variants = [
            UpgradePhase::Pending,
            UpgradePhase::Planning,
            UpgradePhase::PreflightChecking,
            UpgradePhase::UpgradingControlPlane,
            UpgradePhase::UpgradingAddons,
            UpgradePhase::UpgradingNodeGroups,
            UpgradePhase::UpgradingKarpenterNodePools,
            UpgradePhase::RollingBackNodeGroups,
            UpgradePhase::RollingBackAddons,
            UpgradePhase::RollingBackControlPlane,
            UpgradePhase::Completed,
            UpgradePhase::Failed,
        ];
        assert_eq!(STORIES.len(), variants.len());
        for variant in variants {
            let name = variant.to_string();
            assert!(
                STORIES.iter().any(|s| s.name == name),
                "no story for phase {name}"
            );
        }
    }

    #[test]
    fn test_explain_known_phase() {
        let result = explain("PreflightChecking");
        assert_eq!(result.verdict, Verdict::Ok);
        assert!(result.summary.starts_with("PreflightChecking:"));
        assert_eq!(result.details["phase"], "PreflightChecking");
        assert!(
            result.details["fails_when"]
                .as_str()
                .unwrap()
                .contains("mandatory")
        );
    }

    #[test]
    fn test_explain_is_case_insensitive() {
        let result = explain("preflightchecking");
        assert_eq!(result.verdict, Verdict::Ok);
    }

    #[test]
    fn test_explain_unknown_phase_lists_valid_names() {
        let result = explain("Exploding");
        assert_eq!(result.verdict, Verdict::Unknown);
        let names = result.details["valid_phases"].as_array().unwrap();
        assert_eq!(names.len(), STORIES.len());
    }
}
