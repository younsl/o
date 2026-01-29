//! Table formatting for CLI output.

use colored::Colorize;

use crate::eks::insights::InsightsSummary;

/// Print insights summary.
pub fn print_insights_summary(summary: &InsightsSummary) {
    println!();
    println!("{}", "Cluster Insights:".bold());
    println!("{}", "-".repeat(40));

    if summary.findings.is_empty() {
        println!("  {} No findings", "✓".green());
        return;
    }

    for finding in &summary.findings {
        let icon = match finding.severity.as_str() {
            "ERROR" | "CRITICAL" => "✗".red(),
            "WARNING" => "⚠".yellow(),
            _ => "ℹ".blue(),
        };
        println!(
            "  {} {}: {}",
            icon,
            finding.category.bold(),
            finding.description
        );

        // Show affected resources with details
        if !finding.resources.is_empty() {
            let resource_list: Vec<String> = finding
                .resources
                .iter()
                .map(|r| format!("{}/{}", r.resource_type, r.resource_id))
                .collect();
            println!(
                "    {} resource(s) affected: {}",
                finding.resources.len().to_string().yellow(),
                resource_list.join(", ")
            );
        }

        // Show recommendation if available
        if let Some(rec) = &finding.recommendation {
            println!("    Recommendation: {}", rec.dimmed());
        }
    }

    println!();
    println!("Summary:");
    if summary.critical_count > 0 {
        println!(
            "  {} Critical: {}",
            "✗".red(),
            summary.critical_count.to_string().red()
        );
    }
    if summary.warning_count > 0 {
        println!(
            "  {} Warnings: {}",
            "⚠".yellow(),
            summary.warning_count.to_string().yellow()
        );
    }
    if summary.info_count > 0 {
        println!("  {} Info: {}", "ℹ".blue(), summary.info_count);
    }

    if !summary.has_critical_blockers() {
        println!();
        println!("  {} No critical blockers found", "✓".green());
    }
}
