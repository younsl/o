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
}
