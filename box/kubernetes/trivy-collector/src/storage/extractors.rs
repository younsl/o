//! JSON metadata extraction helpers

use serde_json::Value;

/// Extract app, image, and registry from report JSON string
/// Parses JSON on-demand and extracts only necessary fields
pub fn extract_metadata_from_str(data_json: &str) -> (String, String, String) {
    match serde_json::from_str::<Value>(data_json) {
        Ok(data) => extract_metadata_from_value(&data),
        Err(_) => (String::new(), String::new(), String::new()),
    }
}

/// Extract app, image, and registry from report JSON Value
fn extract_metadata_from_value(data: &Value) -> (String, String, String) {
    let app = data
        .get("metadata")
        .and_then(|m| m.get("labels"))
        .and_then(|l| {
            l.get("trivy-operator.resource.name")
                .or_else(|| l.get("app.kubernetes.io/name"))
                .or_else(|| l.get("app"))
        })
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let artifact = data.get("report").and_then(|r| r.get("artifact"));
    let image = artifact
        .map(|a| {
            let repo = a.get("repository").and_then(|v| v.as_str()).unwrap_or("");
            let tag = a.get("tag").and_then(|v| v.as_str()).unwrap_or("");
            if tag.is_empty() {
                repo.to_string()
            } else {
                format!("{}:{}", repo, tag)
            }
        })
        .unwrap_or_default();

    let registry = data
        .get("report")
        .and_then(|r| r.get("registry"))
        .and_then(|r| r.get("server"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    (app, image, registry)
}

/// Extract vulnerability summary counts from report JSON string
pub fn extract_vuln_summary_from_str(data_json: &str) -> (i64, i64, i64, i64, i64) {
    match serde_json::from_str::<Value>(data_json) {
        Ok(data) => extract_vuln_summary_from_value(&data),
        Err(_) => (0, 0, 0, 0, 0),
    }
}

/// Extract vulnerability summary counts from report JSON Value
fn extract_vuln_summary_from_value(data: &Value) -> (i64, i64, i64, i64, i64) {
    let summary = data.get("report").and_then(|r| r.get("summary"));
    if let Some(s) = summary {
        (
            s.get("criticalCount").and_then(|v| v.as_i64()).unwrap_or(0),
            s.get("highCount").and_then(|v| v.as_i64()).unwrap_or(0),
            s.get("mediumCount").and_then(|v| v.as_i64()).unwrap_or(0),
            s.get("lowCount").and_then(|v| v.as_i64()).unwrap_or(0),
            s.get("unknownCount").and_then(|v| v.as_i64()).unwrap_or(0),
        )
    } else {
        (0, 0, 0, 0, 0)
    }
}

/// Extract components count from SBOM report JSON string
pub fn extract_components_count_from_str(data_json: &str) -> i64 {
    match serde_json::from_str::<Value>(data_json) {
        Ok(data) => extract_components_count_from_value(&data),
        Err(_) => 0,
    }
}

/// Extract components count from SBOM report JSON Value
fn extract_components_count_from_value(data: &Value) -> i64 {
    data.get("report")
        .and_then(|r| r.get("summary"))
        .and_then(|s| s.get("componentsCount"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_extract_metadata_with_trivy_operator_label() {
        let data = json!({
            "metadata": {
                "labels": {
                    "trivy-operator.resource.name": "nginx-deployment"
                }
            },
            "report": {
                "artifact": {
                    "repository": "nginx",
                    "tag": "1.25"
                },
                "registry": {
                    "server": "docker.io"
                }
            }
        });

        let (app, image, registry) = extract_metadata_from_str(&data.to_string());
        assert_eq!(app, "nginx-deployment");
        assert_eq!(image, "nginx:1.25");
        assert_eq!(registry, "docker.io");
    }

    #[test]
    fn test_extract_metadata_with_app_kubernetes_label() {
        let data = json!({
            "metadata": {
                "labels": {
                    "app.kubernetes.io/name": "my-app"
                }
            },
            "report": {
                "artifact": {
                    "repository": "my-repo/my-app",
                    "tag": "v1.0.0"
                },
                "registry": {
                    "server": "ghcr.io"
                }
            }
        });

        let (app, image, registry) = extract_metadata_from_str(&data.to_string());
        assert_eq!(app, "my-app");
        assert_eq!(image, "my-repo/my-app:v1.0.0");
        assert_eq!(registry, "ghcr.io");
    }

    #[test]
    fn test_extract_metadata_with_app_label() {
        let data = json!({
            "metadata": {
                "labels": {
                    "app": "legacy-app"
                }
            },
            "report": {
                "artifact": {
                    "repository": "legacy/app",
                    "tag": ""
                },
                "registry": {
                    "server": "ecr.aws"
                }
            }
        });

        let (app, image, registry) = extract_metadata_from_str(&data.to_string());
        assert_eq!(app, "legacy-app");
        assert_eq!(image, "legacy/app");
        assert_eq!(registry, "ecr.aws");
    }

    #[test]
    fn test_extract_metadata_missing_fields() {
        let data = json!({});

        let (app, image, registry) = extract_metadata_from_str(&data.to_string());
        assert_eq!(app, "");
        assert_eq!(image, "");
        assert_eq!(registry, "");
    }

    #[test]
    fn test_extract_metadata_invalid_json() {
        let (app, image, registry) = extract_metadata_from_str("invalid json");
        assert_eq!(app, "");
        assert_eq!(image, "");
        assert_eq!(registry, "");
    }

    #[test]
    fn test_extract_vuln_summary_full() {
        let data = json!({
            "report": {
                "summary": {
                    "criticalCount": 5,
                    "highCount": 10,
                    "mediumCount": 20,
                    "lowCount": 15,
                    "unknownCount": 3
                }
            }
        });

        let (critical, high, medium, low, unknown) = extract_vuln_summary_from_str(&data.to_string());
        assert_eq!(critical, 5);
        assert_eq!(high, 10);
        assert_eq!(medium, 20);
        assert_eq!(low, 15);
        assert_eq!(unknown, 3);
    }

    #[test]
    fn test_extract_vuln_summary_partial() {
        let data = json!({
            "report": {
                "summary": {
                    "criticalCount": 2,
                    "highCount": 5
                }
            }
        });

        let (critical, high, medium, low, unknown) = extract_vuln_summary_from_str(&data.to_string());
        assert_eq!(critical, 2);
        assert_eq!(high, 5);
        assert_eq!(medium, 0);
        assert_eq!(low, 0);
        assert_eq!(unknown, 0);
    }

    #[test]
    fn test_extract_vuln_summary_missing() {
        let data = json!({});

        let (critical, high, medium, low, unknown) = extract_vuln_summary_from_str(&data.to_string());
        assert_eq!(critical, 0);
        assert_eq!(high, 0);
        assert_eq!(medium, 0);
        assert_eq!(low, 0);
        assert_eq!(unknown, 0);
    }

    #[test]
    fn test_extract_components_count_present() {
        let data = json!({
            "report": {
                "summary": {
                    "componentsCount": 150
                }
            }
        });

        assert_eq!(extract_components_count_from_str(&data.to_string()), 150);
    }

    #[test]
    fn test_extract_components_count_missing() {
        let data = json!({});
        assert_eq!(extract_components_count_from_str(&data.to_string()), 0);
    }
}
