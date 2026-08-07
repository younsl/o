//! Kubernetes version parsing and upgrade path calculation.

use anyhow::Result;

use crate::error::KuoError;

/// Parse a Kubernetes version string into major and minor components.
pub fn parse_k8s_version(version: &str) -> Result<(u32, u32)> {
    let parts: Vec<&str> = version.split('.').collect();
    if parts.len() < 2 {
        return Err(KuoError::InvalidVersion(version.to_string()).into());
    }

    let major: u32 = parts[0]
        .parse()
        .map_err(|_| KuoError::InvalidVersion(version.to_string()))?;
    let minor: u32 = parts[1]
        .parse()
        .map_err(|_| KuoError::InvalidVersion(version.to_string()))?;

    Ok((major, minor))
}

/// Calculate the upgrade path from current to target version.
/// Returns empty Vec if target equals current (sync mode).
/// Returns error if target is lower than current (downgrade not supported).
pub fn calculate_upgrade_path(current: &str, target: &str) -> Result<Vec<String>> {
    let (curr_major, curr_minor) = parse_k8s_version(current)?;
    let (target_major, target_minor) = parse_k8s_version(target)?;

    if curr_major != target_major {
        return Err(KuoError::UpgradeNotPossible(
            "Cross-major version upgrades are not supported".to_string(),
        )
        .into());
    }

    // Same version: sync mode - return empty path (no CP upgrade needed)
    if target_minor == curr_minor {
        return Ok(Vec::new());
    }

    // Downgrade not supported
    if target_minor < curr_minor {
        return Err(KuoError::UpgradeNotPossible(format!(
            "Target version {target} is lower than current version {current} (downgrade not supported)"
        ))
        .into());
    }

    let mut path = Vec::new();
    for minor in (curr_minor + 1)..=target_minor {
        path.push(format!("{curr_major}.{minor}"));
    }

    Ok(path)
}

/// Calculate the rollback path from current to target version.
///
/// AWS EKS only permits rolling back a single minor version (N to N-1), and
/// only to a version the cluster was previously in-place upgraded from within a
/// 7-day window. Multi-minor rollbacks are therefore rejected here (matching
/// the EKS API), so the target must be exactly one minor below the current
/// version.
///
/// Returns empty Vec if target equals current (nothing to roll back).
/// Returns error for cross-major changes, upgrades, or multi-minor rollbacks.
pub fn calculate_rollback_path(current: &str, target: &str) -> Result<Vec<String>> {
    let (curr_major, curr_minor) = parse_k8s_version(current)?;
    let (target_major, target_minor) = parse_k8s_version(target)?;

    if curr_major != target_major {
        return Err(KuoError::UpgradeNotPossible(
            "Cross-major version rollbacks are not supported".to_string(),
        )
        .into());
    }

    // Same version: nothing to roll back
    if target_minor == curr_minor {
        return Ok(Vec::new());
    }

    if target_minor > curr_minor {
        return Err(KuoError::UpgradeNotPossible(format!(
            "Target version {target} is higher than current version {current} (use Forward mode to upgrade)"
        ))
        .into());
    }

    // EKS supports rolling back a single minor version only (N to N-1).
    if target_minor + 1 != curr_minor {
        return Err(KuoError::UpgradeNotPossible(format!(
            "Rollback supports only a single minor version (N-1): cannot roll back from {current} to {target}. Roll back one minor at a time."
        ))
        .into());
    }

    Ok(vec![target.to_string()])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_k8s_version() {
        assert_eq!(parse_k8s_version("1.28").unwrap(), (1, 28));
        assert_eq!(parse_k8s_version("1.32").unwrap(), (1, 32));
        assert!(parse_k8s_version("invalid").is_err());
    }

    #[test]
    fn test_calculate_upgrade_path() {
        let path = calculate_upgrade_path("1.28", "1.30").unwrap();
        assert_eq!(path, vec!["1.29", "1.30"]);

        let path = calculate_upgrade_path("1.32", "1.34").unwrap();
        assert_eq!(path, vec!["1.33", "1.34"]);

        // Downgrade not supported
        assert!(calculate_upgrade_path("1.30", "1.28").is_err());
    }

    #[test]
    fn test_calculate_upgrade_path_same_version() {
        // Sync mode: same version returns empty path
        let path = calculate_upgrade_path("1.32", "1.32").unwrap();
        assert!(path.is_empty());

        let path = calculate_upgrade_path("1.33", "1.33").unwrap();
        assert!(path.is_empty());
    }

    #[test]
    fn test_calculate_upgrade_path_single_step() {
        let path = calculate_upgrade_path("1.32", "1.33").unwrap();
        assert_eq!(path, vec!["1.33"]);
    }

    #[test]
    fn test_calculate_upgrade_path_cross_major() {
        let result = calculate_upgrade_path("1.32", "2.0");
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_k8s_version_with_patch() {
        // Version with patch number should still parse major.minor
        let (major, minor) = parse_k8s_version("1.32.0").unwrap();
        assert_eq!((major, minor), (1, 32));
    }

    #[test]
    fn test_parse_k8s_version_empty() {
        assert!(parse_k8s_version("").is_err());
    }

    #[test]
    fn test_parse_k8s_version_non_numeric() {
        assert!(parse_k8s_version("a.b").is_err());
    }

    #[test]
    fn test_calculate_upgrade_path_many_steps() {
        let path = calculate_upgrade_path("1.28", "1.34").unwrap();
        assert_eq!(path, vec!["1.29", "1.30", "1.31", "1.32", "1.33", "1.34"]);
    }

    #[test]
    fn test_calculate_rollback_path_single_minor() {
        let path = calculate_rollback_path("1.33", "1.32").unwrap();
        assert_eq!(path, vec!["1.32"]);
    }

    #[test]
    fn test_calculate_rollback_path_multi_minor_rejected() {
        // EKS forbids multi-minor rollback; must go one minor at a time.
        assert!(calculate_rollback_path("1.36", "1.34").is_err());
        assert!(calculate_rollback_path("1.34", "1.30").is_err());
    }

    #[test]
    fn test_calculate_rollback_path_same_version() {
        let path = calculate_rollback_path("1.32", "1.32").unwrap();
        assert!(path.is_empty());
    }

    #[test]
    fn test_calculate_rollback_path_upgrade_rejected() {
        assert!(calculate_rollback_path("1.32", "1.33").is_err());
    }

    #[test]
    fn test_calculate_rollback_path_cross_major_rejected() {
        assert!(calculate_rollback_path("2.0", "1.33").is_err());
    }
}
