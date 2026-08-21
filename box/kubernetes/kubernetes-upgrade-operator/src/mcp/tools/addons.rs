//! `get_addon_plan`: per-addon compatibility toward the target minor.

use serde_json::json;

use crate::eks::addon::AddonPlanResult;
use crate::mcp::result::{LIST_CAP, ToolResult, Verdict};

/// Shape a computed plan into the tool result.
///
/// A skipped add-on is one the planner found nothing to do for: already
/// compatible, already at the pinned version, or without a compatible
/// version. The plan result does not distinguish those cases, so the row
/// carries the planner's counts and the recorded status is the place a
/// per-addon failure shows up.
pub fn render(cluster: &str, target_version: &str, plan: &AddonPlanResult) -> ToolResult {
    let truncated = plan.upgrades.len() > LIST_CAP;
    let rows: Vec<serde_json::Value> = plan
        .upgrades
        .iter()
        .take(LIST_CAP)
        .map(|(addon, target)| {
            json!({
                "name": addon.name,
                "installedVersion": addon.current_version,
                "plannedVersion": target,
            })
        })
        .collect();

    let mut result = ToolResult::new(
        format!(
            "{cluster}: {} add-on(s) need an update for {target_version}, {} already fit",
            plan.upgrades.len(),
            plan.skipped_count()
        ),
        Verdict::Ok,
        json!({
            "targetVersion": target_version,
            "toUpgrade": rows,
            "skippedCount": plan.skipped_count(),
        }),
    );
    result.cluster = Some(cluster.to_string());
    result.truncated = truncated;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::eks::addon::AddonInfo;

    #[test]
    fn test_render_plan() {
        let mut plan = AddonPlanResult::new();
        plan.add_upgrade((
            AddonInfo {
                name: "vpc-cni".to_string(),
                current_version: "v1.18.0-eksbuild.1".to_string(),
            },
            "v1.19.2-eksbuild.1".to_string(),
        ));
        plan.add_skipped();

        let result = render("prod", "1.34", &plan);
        assert_eq!(result.verdict, Verdict::Ok);
        assert_eq!(result.details["toUpgrade"][0]["name"], "vpc-cni");
        assert_eq!(result.details["skippedCount"], 1);
        assert!(result.summary.contains("1 add-on(s)"));
    }
}
