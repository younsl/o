//! HTML report generation for kup upgrade plans.

use std::fmt::Write;
use std::path::PathBuf;

use anyhow::Result;
use chrono::Local;

use crate::eks::insights::InsightsSummary;
use crate::eks::nodegroup::format_rolling_strategy;
use crate::eks::preflight::{
    CheckKind, CheckStatus, PreflightCheckResult, format_ami_selector_term,
};
use crate::eks::upgrade::{UpgradePlan, calculate_estimated_time};

/// Timing data for a single upgrade phase.
#[derive(Debug, Clone)]
pub struct PhaseTiming {
    pub phase_name: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub duration_secs: Option<u64>,
    pub status: PhaseStatus,
}

/// Status of a single upgrade phase.
#[derive(Debug, Clone)]
pub enum PhaseStatus {
    Completed,
    Skipped,
    Estimated(u64),
}

/// Aggregated data for HTML report generation.
pub struct ReportData {
    pub cluster_name: String,
    pub current_version: String,
    pub target_version: String,
    pub current_version_eos: Option<String>,
    pub target_version_eos: Option<String>,
    pub platform_version: Option<String>,
    pub region: String,
    pub kup_version: String,
    pub insights: Option<InsightsSummary>,
    pub plan: UpgradePlan,
    pub phase_timings: Vec<PhaseTiming>,
    pub skip_control_plane: bool,
    pub dry_run: bool,
    pub executed: bool,
    pub generated_at: String,
}

/// Generate a self-contained HTML report string from report data.
pub fn generate_report(data: &ReportData) -> Result<String> {
    let mut html = String::with_capacity(8192);

    write_header(&mut html, data)?;
    write_cluster_overview(&mut html, data)?;
    write_insights_section(&mut html, data)?;
    write_upgrade_plan_section(&mut html, data)?;
    write_timeline_section(&mut html, data)?;
    write_preflight_section(&mut html, data)?;
    write_status_section(&mut html, data)?;
    write_footer(&mut html)?;

    Ok(html)
}

/// Save the HTML report to the current directory.
///
/// Filename format: `kup-report-{cluster_name}-{YYYYMMDD-HHMMSS}.html`
pub fn save_report(html: &str, cluster_name: &str) -> Result<PathBuf> {
    let timestamp = Local::now().format("%Y%m%d-%H%M%S");
    let filename = format!("kup-report-{}-{}.html", cluster_name, timestamp);
    let path = PathBuf::from(&filename);
    std::fs::write(&path, html)?;
    let path = path.canonicalize().unwrap_or(path);
    Ok(path)
}

// ---------------------------------------------------------------------------
// HTML sections
// ---------------------------------------------------------------------------

fn write_header(html: &mut String, data: &ReportData) -> Result<()> {
    write!(
        html,
        r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>kup Report - {cluster}</title>
<style>
:root {{
  --bg: #0d1117;
  --surface: #161b22;
  --border: #30363d;
  --text: #e6edf3;
  --text-muted: #8b949e;
  --red: #f85149;
  --yellow: #d29922;
  --green: #3fb950;
  --blue: #58a6ff;
  --cyan: #39c5cf;
}}
* {{ margin: 0; padding: 0; box-sizing: border-box; }}
body {{
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.6;
  padding: 2rem;
  max-width: 960px;
  margin: 0 auto;
}}
h1 {{ color: var(--cyan); margin-bottom: 0.25rem; font-size: 1.5rem; }}
h2 {{
  color: var(--cyan);
  font-size: 1.1rem;
  margin: 1.5rem 0 0.75rem;
  padding-bottom: 0.3rem;
  border-bottom: 1px solid var(--border);
}}
.subtitle {{ color: var(--text-muted); font-size: 0.85rem; margin-bottom: 1.5rem; }}
table {{
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 1rem;
  font-size: 0.9rem;
}}
th, td {{
  text-align: left;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border);
}}
th {{ background: var(--surface); color: var(--text-muted); font-weight: 600; }}
td {{ background: var(--bg); }}
.badge {{
  display: inline-block;
  padding: 0.15rem 0.5rem;
  border-radius: 3px;
  font-size: 0.8rem;
  font-weight: 600;
}}
.badge-critical {{ background: var(--red); color: #fff; }}
.badge-fail {{ background: var(--red); color: #fff; }}
.badge-warning {{ background: var(--yellow); color: #000; }}
.badge-info {{ background: var(--blue); color: #fff; }}
.badge-ok {{ background: var(--green); color: #000; }}
.badge-dry {{ background: var(--yellow); color: #000; }}
.badge-skipped {{ background: var(--border); color: var(--text-muted); }}
.status-box {{
  margin-top: 1.5rem;
  padding: 1rem;
  border-radius: 6px;
  text-align: center;
  font-weight: 600;
  font-size: 1rem;
}}
.status-completed {{ background: rgba(63,185,80,0.15); border: 1px solid var(--green); color: var(--green); }}
.status-dry {{ background: rgba(210,153,34,0.15); border: 1px solid var(--yellow); color: var(--yellow); }}
.status-planned {{ background: rgba(88,166,255,0.15); border: 1px solid var(--blue); color: var(--blue); }}
.status-noop {{ background: rgba(139,148,158,0.15); border: 1px solid var(--text-muted); color: var(--text-muted); }}
.note {{ color: var(--text-muted); font-size: 0.85rem; margin-top: 0.5rem; }}
.dimmed {{ color: var(--text-muted); }}
.tooltip {{ position: relative; display: inline-block; cursor: help; margin-left: 0.4rem; }}
.tooltip .tip-icon {{
  display: inline-flex; align-items: center; justify-content: center;
  width: 1.1rem; height: 1.1rem; border-radius: 50%;
  border: 1px solid var(--text-muted); color: var(--text-muted);
  font-size: 0.7rem; font-weight: 700; vertical-align: middle;
}}
.tooltip .tip-text {{
  visibility: hidden; opacity: 0;
  position: absolute; left: 50%; transform: translateX(-50%);
  top: 1.6rem; z-index: 10;
  width: max-content; max-width: 320px;
  padding: 0.5rem 0.75rem; border-radius: 4px;
  background: var(--surface); border: 1px solid var(--border);
  color: var(--text); font-size: 0.8rem; font-weight: 400;
  line-height: 1.4; white-space: normal;
  transition: opacity 0.15s;
}}
.tooltip:hover .tip-text {{ visibility: visible; opacity: 1; }}
footer {{ margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--border); color: var(--text-muted); font-size: 0.8rem; text-align: center; }}
</style>
</head>
<body>
<h1>kup Upgrade Report</h1>
<p class="subtitle">{version} | Generated: {time}</p>
"#,
        cluster = esc(&data.cluster_name),
        version = esc(&data.kup_version),
        time = esc(&data.generated_at),
    )?;
    Ok(())
}

fn write_cluster_overview(html: &mut String, data: &ReportData) -> Result<()> {
    let current_display = match &data.current_version_eos {
        Some(eos) => format!(
            "{} <span class=\"dimmed\">(Standard Support ends on {})</span>",
            esc(&data.current_version),
            esc(eos)
        ),
        None => esc(&data.current_version),
    };

    let target_label = if data.current_version == data.target_version {
        format!(
            "{} <span class=\"dimmed\">(sync mode)</span>",
            esc(&data.target_version)
        )
    } else {
        match &data.target_version_eos {
            Some(eos) => format!(
                "{} <span class=\"dimmed\">(Standard Support ends on {})</span>",
                esc(&data.target_version),
                esc(eos)
            ),
            None => esc(&data.target_version),
        }
    };

    let platform = data.platform_version.as_deref().unwrap_or("N/A");

    write!(
        html,
        r#"<h2>Cluster Overview <span class="tooltip"><span class="tip-icon">?</span><span class="tip-text">EKS cluster metadata including current and target Kubernetes versions.</span></span></h2>
<table>
<tr><th>Cluster</th><td>{cluster}</td></tr>
<tr><th>Region</th><td>{region}</td></tr>
<tr><th>Current Kubernetes Version</th><td>{current}</td></tr>
<tr><th>Current Platform Version</th><td>{platform}</td></tr>
<tr><th>Target Kubernetes Version</th><td>{target}</td></tr>
</table>
"#,
        cluster = esc(&data.cluster_name),
        region = esc(&data.region),
        current = current_display,
        platform = esc(platform),
        target = target_label,
    )?;
    Ok(())
}

fn write_insights_section(html: &mut String, data: &ReportData) -> Result<()> {
    html.push_str("<h2>Cluster Insights <span class=\"tooltip\"><span class=\"tip-icon\">?</span><span class=\"tip-text\">Results from EKS Cluster Insights API. Identifies deprecated APIs, add-on incompatibilities, and other upgrade blockers.</span></span></h2>\n");

    let Some(ref insights) = data.insights else {
        html.push_str("<p class=\"dimmed\">Insights not available.</p>\n");
        return Ok(());
    };

    if insights.findings.is_empty() {
        html.push_str("<p><span class=\"badge badge-ok\">PASS</span> No findings</p>\n");
        return Ok(());
    }

    // Summary counts
    write!(
        html,
        "<p>Total: {} finding(s) &mdash; ",
        insights.total_findings
    )?;
    if insights.critical_count > 0 {
        write!(
            html,
            "<span class=\"badge badge-critical\">{} critical</span> ",
            insights.critical_count
        )?;
    }
    if insights.warning_count > 0 {
        write!(
            html,
            "<span class=\"badge badge-warning\">{} warning</span> ",
            insights.warning_count
        )?;
    }
    if insights.passing_count > 0 {
        write!(
            html,
            "<span class=\"badge badge-ok\">{} passing</span> ",
            insights.passing_count
        )?;
    }
    if insights.info_count > 0 {
        write!(
            html,
            "<span class=\"badge badge-info\">{} info</span> ",
            insights.info_count
        )?;
    }
    html.push_str("</p>\n");

    // Findings table
    html.push_str(
        "<table><tr><th>Status</th><th>Category</th><th>Description</th><th>Resources</th></tr>\n",
    );
    for f in &insights.findings {
        let badge_class = match f.severity.as_str() {
            "ERROR" | "CRITICAL" => "badge-critical",
            "WARNING" => "badge-warning",
            "PASSING" => "badge-ok",
            _ => "badge-info",
        };
        let resources: Vec<String> = f
            .resources
            .iter()
            .map(|r| format!("{}/{}", r.resource_type, r.resource_id))
            .collect();
        let resources_str = if resources.is_empty() {
            "-".to_string()
        } else {
            resources.join(", ")
        };
        writeln!(
            html,
            "<tr><td><span class=\"badge {bc}\">{sev}</span></td><td>{cat}</td><td>{desc}{rec}</td><td>{res}</td></tr>",
            bc = badge_class,
            sev = esc(&f.severity),
            cat = esc(&f.category),
            desc = esc(&f.description),
            rec = f
                .recommendation
                .as_ref()
                .map(|r| format!(
                    "<br><span class=\"dimmed\"><strong>Recommendation:</strong> {}</span>",
                    esc(r)
                ))
                .unwrap_or_default(),
            res = esc(&resources_str),
        )?;
    }
    html.push_str("</table>\n");

    Ok(())
}

fn write_upgrade_plan_section(html: &mut String, data: &ReportData) -> Result<()> {
    html.push_str("<h2>Upgrade Plan <span class=\"tooltip\"><span class=\"tip-icon\">?</span><span class=\"tip-text\">Planned upgrade steps. Control plane upgrades are sequential (1 minor version at a time). Add-ons and node groups follow after.</span></span></h2>\n");

    // Phase 1: Control Plane
    if data.skip_control_plane {
        html.push_str(
            "<h3 style=\"color:var(--cyan);font-size:0.95rem;\">Phase 1: Control Plane <span class=\"badge badge-skipped\">SKIPPED</span></h3>\n",
        );
        writeln!(
            html,
            "<p class=\"dimmed\">Current version: {} (sync mode, no upgrade needed)</p>",
            esc(&data.current_version)
        )?;
    } else if data.plan.upgrade_path.is_empty() {
        html.push_str(
            "<h3 style=\"color:var(--cyan);font-size:0.95rem;\">Phase 1: Control Plane <span class=\"badge badge-skipped\">SKIPPED</span></h3>\n",
        );
        writeln!(
            html,
            "<p class=\"dimmed\">Already at target version {}</p>",
            esc(&data.target_version)
        )?;
    } else {
        html.push_str(
            "<h3 style=\"color:var(--cyan);font-size:0.95rem;\">Phase 1: Control Plane Upgrade</h3>\n",
        );
        html.push_str("<table><tr><th>Step</th><th>From</th><th>To</th><th>Est. Time</th></tr>\n");
        let mut prev = data.current_version.clone();
        for (i, version) in data.plan.upgrade_path.iter().enumerate() {
            writeln!(
                html,
                "<tr><td>{}</td><td>{}</td><td>{}</td><td>~10 min</td></tr>",
                i + 1,
                esc(&prev),
                esc(version),
            )?;
            prev = version.clone();
        }
        html.push_str("</table>\n");
    }

    // Phase 2: Add-ons
    if data.plan.addon_upgrades.is_empty() {
        html.push_str(
            "<h3 style=\"color:var(--cyan);font-size:0.95rem;\">Phase 2: Add-on Upgrade <span class=\"badge badge-skipped\">SKIPPED</span></h3>\n",
        );
    } else {
        html.push_str(
            "<h3 style=\"color:var(--cyan);font-size:0.95rem;\">Phase 2: Add-on Upgrade [sequential]</h3>\n",
        );
        html.push_str(
            "<table><tr><th>Step</th><th>Add-on</th><th>Current</th><th>Target</th></tr>\n",
        );
        for (i, (addon, target_ver)) in data.plan.addon_upgrades.iter().enumerate() {
            writeln!(
                html,
                "<tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>",
                i + 1,
                esc(&addon.name),
                esc(&addon.current_version),
                esc(target_ver),
            )?;
        }
        html.push_str("</table>\n");
    }
    // Skipped addons
    if !data.plan.skipped_addons.is_empty() {
        html.push_str("<p class=\"dimmed\">Skipped add-ons: ");
        let skipped: Vec<String> = data
            .plan
            .skipped_addons
            .iter()
            .map(|s| format!("{} ({})", s.info.name, s.reason))
            .collect();
        html.push_str(&esc(&skipped.join(", ")));
        html.push_str("</p>\n");
    }

    // Phase 3: Managed Node Groups
    if data.plan.nodegroup_upgrades.is_empty() {
        html.push_str(
            "<h3 style=\"color:var(--cyan);font-size:0.95rem;\">Phase 3: Managed Node Group Upgrade <span class=\"badge badge-skipped\">SKIPPED</span></h3>\n",
        );
    } else {
        html.push_str(
            "<h3 style=\"color:var(--cyan);font-size:0.95rem;\">Phase 3: Managed Node Group Upgrade</h3>\n",
        );
        html.push_str(
            "<table><tr><th>Node Group</th><th>Current</th><th>Target</th><th>Nodes</th><th>Rolling Strategy</th></tr>\n",
        );
        for ng in &data.plan.nodegroup_upgrades {
            let strategy = format_rolling_strategy(ng);
            writeln!(
                html,
                "<tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>",
                esc(&ng.name),
                esc(ng.version.as_deref().unwrap_or("unknown")),
                esc(&data.target_version),
                ng.desired_size,
                esc(&strategy),
            )?;
        }
        html.push_str("</table>\n");
    }
    // Skipped nodegroups
    if !data.plan.skipped_nodegroups.is_empty() {
        html.push_str("<p class=\"dimmed\">Skipped node groups: ");
        let skipped: Vec<String> = data
            .plan
            .skipped_nodegroups
            .iter()
            .map(|s| format!("{} ({})", s.info.name, s.reason))
            .collect();
        html.push_str(&esc(&skipped.join(", ")));
        html.push_str("</p>\n");
    }

    Ok(())
}

fn write_timeline_section(html: &mut String, data: &ReportData) -> Result<()> {
    if data.phase_timings.is_empty() {
        return Ok(());
    }

    html.push_str("<h2>Execution Timeline <span class=\"tooltip\"><span class=\"tip-icon\">?</span><span class=\"tip-text\">Per-phase timing breakdown. Shows actual start/end times for executed upgrades, or estimated durations for dry-run and planned reports.</span></span></h2>\n");
    html.push_str(
        "<table><tr><th>Phase</th><th>Status</th><th>Started</th><th>Completed</th><th>Duration</th></tr>\n",
    );

    for pt in &data.phase_timings {
        let (status_badge, started, completed, duration) = match &pt.status {
            PhaseStatus::Completed => {
                let dur = pt
                    .duration_secs
                    .map(format_duration)
                    .unwrap_or_else(|| "-".to_string());
                (
                    "<span class=\"badge badge-ok\">COMPLETED</span>".to_string(),
                    pt.started_at.clone().unwrap_or_else(|| "-".to_string()),
                    pt.completed_at.clone().unwrap_or_else(|| "-".to_string()),
                    dur,
                )
            }
            PhaseStatus::Skipped => (
                "<span class=\"badge badge-skipped\">SKIPPED</span>".to_string(),
                "N/A".to_string(),
                "N/A".to_string(),
                "-".to_string(),
            ),
            PhaseStatus::Estimated(mins) => (
                "<span class=\"badge badge-info\">ESTIMATED</span>".to_string(),
                "N/A".to_string(),
                "N/A".to_string(),
                format!("~{} min", mins),
            ),
        };

        writeln!(
            html,
            "<tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>",
            esc(&pt.phase_name),
            status_badge,
            esc(&started),
            esc(&completed),
            esc(&duration),
        )?;
    }

    html.push_str("</table>\n");

    // Total duration for executed phases
    let total_secs: u64 = data
        .phase_timings
        .iter()
        .filter_map(|pt| pt.duration_secs)
        .sum();
    if total_secs > 0 {
        writeln!(
            html,
            "<p class=\"note\">Total execution time: {}</p>",
            esc(&format_duration(total_secs)),
        )?;
    }

    Ok(())
}

/// Format seconds into a human-readable duration string.
fn format_duration(secs: u64) -> String {
    if secs < 60 {
        format!("{}s", secs)
    } else if secs < 3600 {
        format!("{}m {}s", secs / 60, secs % 60)
    } else {
        format!("{}h {}m {}s", secs / 3600, (secs % 3600) / 60, secs % 60)
    }
}

fn write_preflight_section(html: &mut String, data: &ReportData) -> Result<()> {
    html.push_str("<h2>Preflight Checks <span class=\"tooltip\"><span class=\"tip-icon\">?</span><span class=\"tip-text\">Pre-upgrade validation checks run before the actual upgrade begins.</span></span></h2>\n");

    let preflight = &data.plan.preflight;

    // --- Mandatory ---
    html.push_str(
        "<h3 style=\"color:var(--red);font-size:1rem;margin-top:1rem;\">Mandatory</h3>\n",
    );
    for check in preflight.mandatory_checks() {
        write_preflight_item_html(html, check, &data.target_version)?;
    }
    for skip in preflight.mandatory_skipped() {
        writeln!(
            html,
            "<h4 style=\"color:var(--yellow);font-size:0.95rem;\">{}</h4>",
            esc(skip.name),
        )?;
        writeln!(
            html,
            "<p class=\"dimmed\">Skipped ({})</p>",
            esc(&skip.reason),
        )?;
    }

    // --- Informational ---
    html.push_str(
        "<h3 style=\"color:var(--dimmed);font-size:1rem;margin-top:1.5rem;\">Informational</h3>\n",
    );
    for check in preflight.informational_checks() {
        write_preflight_item_html(html, check, &data.target_version)?;
    }
    for skip in preflight.informational_skipped() {
        writeln!(
            html,
            "<h4 style=\"color:var(--yellow);font-size:0.95rem;\">{}</h4>",
            esc(skip.name),
        )?;
        writeln!(
            html,
            "<p class=\"dimmed\">Skipped ({})</p>",
            esc(&skip.reason),
        )?;
    }

    Ok(())
}

/// Write a single preflight check result as HTML.
fn write_preflight_item_html(
    html: &mut String,
    check: &PreflightCheckResult,
    target_version: &str,
) -> Result<()> {
    writeln!(
        html,
        "<h4 style=\"color:var(--yellow);font-size:0.95rem;\">{}</h4>",
        esc(check.name),
    )?;

    let badge = match check.status {
        CheckStatus::Pass => "<span class=\"badge badge-ok\">PASS</span>",
        CheckStatus::Fail => "<span class=\"badge badge-fail\">FAIL</span>",
        CheckStatus::Info => "<span class=\"badge badge-info\">INFO</span>",
    };

    write_check_html_details(html, check, badge, target_version)
}

/// Write check-kind-specific HTML details.
fn write_check_html_details(
    html: &mut String,
    check: &PreflightCheckResult,
    badge: &str,
    target_version: &str,
) -> Result<()> {
    match &check.kind {
        CheckKind::DeletionProtection { enabled } => {
            let msg = if *enabled {
                "Deletion protection is enabled"
            } else {
                "Deletion protection is disabled"
            };
            writeln!(html, "<p>{} {}</p>", badge, esc(msg))?;
        }
        CheckKind::PdbDrainDeadlock { summary } => {
            if summary.has_blocking_pdbs() {
                writeln!(
                    html,
                    "<p>{} {}/{} PDB(s) may block node drain</p>",
                    badge, summary.blocking_count, summary.total_pdbs,
                )?;
                html.push_str("<table><tr><th>Namespace</th><th>PDB</th><th>Details</th></tr>\n");
                for f in &summary.findings {
                    writeln!(
                        html,
                        "<tr><td>{}</td><td>{}</td><td>{}</td></tr>",
                        esc(&f.namespace),
                        esc(&f.name),
                        esc(&f.reason()),
                    )?;
                }
                html.push_str("</table>\n");
            } else {
                writeln!(
                    html,
                    "<p>{} No drain deadlock detected ({} PDBs checked)</p>",
                    badge, summary.total_pdbs,
                )?;
            }
        }
        CheckKind::KarpenterAmiConfig { summary } => {
            writeln!(
                html,
                "<p>{} {} EC2NodeClass(es) detected</p>",
                badge,
                summary.node_classes.len(),
            )?;
            let api_ver = format!("karpenter.k8s.aws/{}", summary.api_version);
            html.push_str("<table><tr><th>API Version</th><th>EC2NodeClass</th><th>AMI Selector Terms</th></tr>\n");
            for nc in &summary.node_classes {
                let terms: Vec<String> = if nc.ami_selector_terms.is_empty() {
                    vec!["(no amiSelectorTerms)".to_string()]
                } else {
                    nc.ami_selector_terms
                        .iter()
                        .map(format_ami_selector_term)
                        .collect()
                };
                writeln!(
                    html,
                    "<tr><td>{}</td><td>{}</td><td>{}</td></tr>",
                    esc(&api_ver),
                    esc(&nc.name),
                    esc(&terms.join("; ")),
                )?;
            }
            html.push_str("</table>\n");
            writeln!(
                html,
                "<p class=\"note\">Verify amiSelectorTerms compatibility with {} before upgrading.</p>",
                esc(target_version),
            )?;
        }
    }
    Ok(())
}

fn write_status_section(html: &mut String, data: &ReportData) -> Result<()> {
    let estimated = calculate_estimated_time(&data.plan, data.skip_control_plane);

    let (class, label) = if data.plan.is_empty() {
        ("status-noop", "Nothing to Upgrade")
    } else if data.dry_run {
        ("status-dry", "Dry Run")
    } else if data.executed {
        ("status-completed", "Completed")
    } else {
        ("status-planned", "Planned (not executed)")
    };

    writeln!(
        html,
        "<div class=\"status-box {class}\">{label}</div>",
        class = class,
        label = label,
    )?;

    if estimated > 0 {
        writeln!(
            html,
            "<p class=\"note\" style=\"text-align:center;\">Estimated total time: ~{} min</p>",
            estimated,
        )?;
    }

    Ok(())
}

fn write_footer(html: &mut String) -> Result<()> {
    html.push_str(
        "<footer>Generated by <strong>kup</strong> — EKS cluster upgrade support CLI tool</footer>\n</body>\n</html>\n",
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// HTML-escape a string.
fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::eks::addon::AddonInfo;
    use crate::eks::nodegroup::NodeGroupInfo;
    use crate::eks::preflight::{PreflightCheckResult, PreflightResults};
    use crate::eks::upgrade::UpgradePlan;

    fn sample_plan() -> UpgradePlan {
        UpgradePlan {
            cluster_name: "test-cluster".to_string(),
            current_version: "1.32".to_string(),
            target_version: "1.34".to_string(),
            upgrade_path: vec!["1.33".to_string(), "1.34".to_string()],
            addon_upgrades: vec![(
                AddonInfo {
                    name: "coredns".to_string(),
                    current_version: "v1.11.1-eksbuild.1".to_string(),
                },
                "v1.11.3-eksbuild.2".to_string(),
            )],
            skipped_addons: vec![],
            nodegroup_upgrades: vec![NodeGroupInfo {
                name: "ng-system".to_string(),
                version: Some("1.32".to_string()),
                desired_size: 3,
                max_unavailable: None,
                max_unavailable_percentage: Some(33),
                asg_name: None,
            }],
            skipped_nodegroups: vec![],
            preflight: PreflightResults::default(),
        }
    }

    fn sample_report_data(plan: UpgradePlan) -> ReportData {
        ReportData {
            cluster_name: plan.cluster_name.clone(),
            current_version: plan.current_version.clone(),
            target_version: plan.target_version.clone(),
            current_version_eos: None,
            target_version_eos: None,
            platform_version: Some("eks.18".to_string()),
            region: "ap-northeast-2".to_string(),
            kup_version: "kup 0.3.0 (commit: abc1234, build date: 2026-02-13)".to_string(),
            insights: None,
            plan,
            phase_timings: vec![],
            skip_control_plane: false,
            dry_run: false,
            executed: false,
            generated_at: "2026-02-13 15:30:00".to_string(),
        }
    }

    #[test]
    fn test_generate_report_contains_cluster_name() {
        let data = sample_report_data(sample_plan());
        let html = generate_report(&data).unwrap();
        assert!(html.contains("test-cluster"));
    }

    #[test]
    fn test_generate_report_contains_version_info() {
        let data = sample_report_data(sample_plan());
        let html = generate_report(&data).unwrap();
        assert!(html.contains("1.32"));
        assert!(html.contains("1.34"));
    }

    #[test]
    fn test_generate_report_contains_addon_info() {
        let data = sample_report_data(sample_plan());
        let html = generate_report(&data).unwrap();
        assert!(html.contains("coredns"));
        assert!(html.contains("v1.11.1-eksbuild.1"));
        assert!(html.contains("v1.11.3-eksbuild.2"));
    }

    #[test]
    fn test_generate_report_contains_nodegroup_info() {
        let data = sample_report_data(sample_plan());
        let html = generate_report(&data).unwrap();
        assert!(html.contains("ng-system"));
    }

    #[test]
    fn test_generate_report_dry_run_status() {
        let mut data = sample_report_data(sample_plan());
        data.dry_run = true;
        let html = generate_report(&data).unwrap();
        assert!(html.contains("Dry Run"));
    }

    #[test]
    fn test_generate_report_completed_status() {
        let mut data = sample_report_data(sample_plan());
        data.executed = true;
        let html = generate_report(&data).unwrap();
        assert!(html.contains("Completed"));
    }

    #[test]
    fn test_generate_report_noop_status() {
        let mut plan = sample_plan();
        plan.upgrade_path = vec![];
        plan.addon_upgrades = vec![];
        plan.nodegroup_upgrades = vec![];
        let data = sample_report_data(plan);
        let html = generate_report(&data).unwrap();
        assert!(html.contains("Nothing to Upgrade"));
    }

    #[test]
    fn test_generate_report_is_valid_html() {
        let data = sample_report_data(sample_plan());
        let html = generate_report(&data).unwrap();
        assert!(html.starts_with("<!DOCTYPE html>"));
        assert!(html.contains("</html>"));
    }

    #[test]
    fn test_esc_html_entities() {
        assert_eq!(esc("<script>"), "&lt;script&gt;");
        assert_eq!(esc("a & b"), "a &amp; b");
        assert_eq!(esc("\"quoted\""), "&quot;quoted&quot;");
    }

    #[test]
    fn test_generate_report_with_insights() {
        use crate::eks::insights::{InsightFinding, InsightsSummary};

        let mut data = sample_report_data(sample_plan());
        data.insights = Some(InsightsSummary {
            total_findings: 2,
            critical_count: 1,
            warning_count: 1,
            passing_count: 0,
            info_count: 0,
            findings: vec![
                InsightFinding {
                    category: "UPGRADE_READINESS".to_string(),
                    description: "Deprecated API usage".to_string(),
                    severity: "ERROR".to_string(),
                    recommendation: Some("Update API version".to_string()),
                    resources: vec![],
                },
                InsightFinding {
                    category: "UPGRADE_READINESS".to_string(),
                    description: "Add-on compatibility".to_string(),
                    severity: "WARNING".to_string(),
                    recommendation: None,
                    resources: vec![],
                },
            ],
        });

        let html = generate_report(&data).unwrap();
        assert!(html.contains("Deprecated API usage"));
        assert!(html.contains("badge-critical"));
        assert!(html.contains("badge-warning"));
    }

    #[test]
    fn test_generate_report_with_pdb_findings() {
        use crate::k8s::pdb::{PdbFinding, PdbSummary};

        let mut plan = sample_plan();
        plan.preflight = PreflightResults {
            checks: vec![PreflightCheckResult::pdb_drain_deadlock(PdbSummary {
                total_pdbs: 5,
                blocking_count: 1,
                findings: vec![PdbFinding {
                    namespace: "kube-system".to_string(),
                    name: "coredns-pdb".to_string(),
                    min_available: Some("1".to_string()),
                    max_unavailable: None,
                    current_healthy: 1,
                    expected_pods: 1,
                    disruptions_allowed: 0,
                }],
            })],
            skipped: vec![],
        };

        let data = sample_report_data(plan);
        let html = generate_report(&data).unwrap();
        assert!(html.contains("coredns-pdb"));
        assert!(html.contains("kube-system"));
    }

    #[test]
    fn test_generate_report_with_karpenter() {
        use crate::k8s::karpenter::{AmiSelectorTerm, Ec2NodeClassInfo, KarpenterSummary};

        let mut plan = sample_plan();
        plan.preflight = PreflightResults {
            checks: vec![PreflightCheckResult::karpenter_ami_config(
                KarpenterSummary {
                    node_classes: vec![Ec2NodeClassInfo {
                        name: "default".to_string(),
                        ami_selector_terms: vec![AmiSelectorTerm {
                            alias: Some("al2023@latest".to_string()),
                            id: None,
                            name: None,
                            owner: None,
                            tags: None,
                        }],
                    }],
                    api_version: "v1".to_string(),
                },
            )],
            skipped: vec![],
        };

        let data = sample_report_data(plan);
        let html = generate_report(&data).unwrap();
        assert!(html.contains("default"));
        assert!(html.contains("al2023@latest"));
    }

    #[test]
    fn test_generate_report_skip_control_plane() {
        let mut data = sample_report_data(sample_plan());
        data.skip_control_plane = true;
        let html = generate_report(&data).unwrap();
        assert!(html.contains("sync mode"));
    }

    #[test]
    fn test_generate_report_with_timeline() {
        let mut data = sample_report_data(sample_plan());
        data.phase_timings = vec![
            PhaseTiming {
                phase_name: "Control Plane".to_string(),
                started_at: Some("2026-02-13 15:30:00".to_string()),
                completed_at: Some("2026-02-13 15:42:30".to_string()),
                duration_secs: Some(750),
                status: PhaseStatus::Completed,
            },
            PhaseTiming {
                phase_name: "Add-ons".to_string(),
                started_at: None,
                completed_at: None,
                duration_secs: None,
                status: PhaseStatus::Skipped,
            },
            PhaseTiming {
                phase_name: "Node Groups".to_string(),
                started_at: None,
                completed_at: None,
                duration_secs: None,
                status: PhaseStatus::Estimated(20),
            },
        ];
        let html = generate_report(&data).unwrap();
        assert!(html.contains("Execution Timeline"));
        assert!(html.contains("Control Plane"));
        assert!(html.contains("COMPLETED"));
        assert!(html.contains("SKIPPED"));
        assert!(html.contains("ESTIMATED"));
        assert!(html.contains("12m 30s"));
        assert!(html.contains("~20 min"));
    }

    #[test]
    fn test_generate_report_no_timeline_when_empty() {
        let data = sample_report_data(sample_plan());
        let html = generate_report(&data).unwrap();
        assert!(!html.contains("Execution Timeline"));
    }

    #[test]
    fn test_format_duration() {
        assert_eq!(format_duration(30), "30s");
        assert_eq!(format_duration(90), "1m 30s");
        assert_eq!(format_duration(3661), "1h 1m 1s");
    }
}
