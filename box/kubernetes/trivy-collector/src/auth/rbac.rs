//! ArgoCD-style RBAC engine
//!
//! CSV policy format (same as ArgoCD):
//! ```csv
//! p, role:admin, *, *, allow
//! p, role:readonly, reports, get, allow
//! g, security-team, role:readonly
//! ```

use serde::Serialize;
use tracing::debug;

/// Policy effect
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    Allow,
    Deny,
}

/// A single policy rule: p, <subject>, <resource>, <action>, <effect>
#[derive(Debug, Clone)]
pub struct PolicyRule {
    pub subject: String,
    pub resource: String,
    pub action: String,
    pub effect: Effect,
}

/// Group-to-role binding: g, <group>, <role>
#[derive(Debug, Clone)]
pub struct GroupBinding {
    pub group: String,
    pub role: String,
}

/// Permission pair for frontend
#[derive(Debug, Clone, Serialize)]
pub struct Permission {
    pub resource: String,
    pub action: String,
}

/// RBAC policy engine
#[derive(Debug, Clone)]
pub struct RbacPolicy {
    rules: Vec<PolicyRule>,
    groups: Vec<GroupBinding>,
    default_policy: String,
}

impl RbacPolicy {
    /// Parse RBAC policy from CSV string
    pub fn from_csv(csv: &str, default_policy: &str) -> Result<Self, String> {
        let mut rules = Vec::new();
        let mut groups = Vec::new();

        for line in csv.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }

            let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();

            match parts.first().copied() {
                Some("p") => {
                    if parts.len() < 5 {
                        return Err(format!("Invalid policy rule (need 5 fields): {}", line));
                    }
                    let effect = match parts[4].to_lowercase().as_str() {
                        "allow" => Effect::Allow,
                        "deny" => Effect::Deny,
                        other => return Err(format!("Invalid effect '{}': {}", other, line)),
                    };
                    rules.push(PolicyRule {
                        subject: parts[1].to_string(),
                        resource: parts[2].to_string(),
                        action: parts[3].to_string(),
                        effect,
                    });
                }
                Some("g") => {
                    if parts.len() < 3 {
                        return Err(format!("Invalid group binding (need 3 fields): {}", line));
                    }
                    groups.push(GroupBinding {
                        group: parts[1].to_string(),
                        role: parts[2].to_string(),
                    });
                }
                _ => {
                    // Skip unknown line types
                }
            }
        }

        debug!(
            rules = rules.len(),
            groups = groups.len(),
            default_policy = %default_policy,
            "RBAC policy parsed"
        );

        Ok(Self {
            rules,
            groups,
            default_policy: default_policy.to_string(),
        })
    }

    /// Built-in default policy CSV
    pub fn default_csv() -> &'static str {
        r#"p, role:readonly, reports, get, allow
p, role:readonly, clusters, get, allow
p, role:readonly, stats, get, allow
p, role:readonly, tokens, get, allow
p, role:readonly, tokens, create, allow
p, role:admin, *, *, allow"#
    }

    /// Resolve roles for user groups (including default policy)
    fn resolve_roles(&self, user_groups: &[String]) -> Vec<String> {
        let mut roles = Vec::new();

        // Map user groups to roles via group bindings
        for binding in &self.groups {
            if user_groups.iter().any(|g| g == &binding.group) && !roles.contains(&binding.role) {
                roles.push(binding.role.clone());
            }
        }

        // If no explicit roles found, apply default policy
        if roles.is_empty() && !self.default_policy.is_empty() {
            roles.push(self.default_policy.clone());
        }

        roles
    }

    /// Check if user with given groups is allowed to access resource/action
    pub fn is_allowed(&self, user_groups: &[String], resource: &str, action: &str) -> bool {
        let roles = self.resolve_roles(user_groups);

        for rule in &self.rules {
            if !roles.contains(&rule.subject) {
                continue;
            }
            if matches_wildcard(&rule.resource, resource) && matches_wildcard(&rule.action, action)
            {
                return rule.effect == Effect::Allow;
            }
        }

        false
    }

    /// Get the default policy name
    pub fn default_policy_name(&self) -> &str {
        &self.default_policy
    }

    /// Get the effective RBAC policy for a user's groups
    pub fn get_effective_policy(&self, user_groups: &[String]) -> EffectivePolicy {
        let resolved_roles = self.resolve_roles(user_groups);

        let rules: Vec<EffectivePolicyRule> = self
            .rules
            .iter()
            .filter(|r| resolved_roles.contains(&r.subject))
            .map(|r| EffectivePolicyRule {
                subject: r.subject.clone(),
                resource: r.resource.clone(),
                action: r.action.clone(),
                effect: match r.effect {
                    Effect::Allow => "allow".to_string(),
                    Effect::Deny => "deny".to_string(),
                },
            })
            .collect();

        let bindings: Vec<EffectiveGroupBinding> = self
            .groups
            .iter()
            .filter(|b| user_groups.iter().any(|g| g == &b.group))
            .map(|b| EffectiveGroupBinding {
                group: b.group.clone(),
                role: b.role.clone(),
            })
            .collect();

        EffectivePolicy {
            resolved_roles,
            default_policy: self.default_policy.clone(),
            rules,
            bindings,
        }
    }

    /// Get all permissions for frontend UI rendering
    pub fn get_permissions(&self, user_groups: &[String]) -> UserPermissions {
        UserPermissions {
            can_admin: self.is_allowed(user_groups, "admin", "get"),
            can_delete_reports: self.is_allowed(user_groups, "reports", "delete"),
            can_manage_tokens: self.is_allowed(user_groups, "tokens", "delete"),
        }
    }
}

/// Permissions summary for frontend
#[derive(Debug, Clone, Serialize)]
pub struct UserPermissions {
    pub can_admin: bool,
    pub can_delete_reports: bool,
    pub can_manage_tokens: bool,
}

/// A single effective policy rule for frontend display
#[derive(Debug, Clone, Serialize)]
pub struct EffectivePolicyRule {
    pub subject: String,
    pub resource: String,
    pub action: String,
    pub effect: String,
}

/// A group-to-role binding for frontend display
#[derive(Debug, Clone, Serialize)]
pub struct EffectiveGroupBinding {
    pub group: String,
    pub role: String,
}

/// Resolved RBAC policy for a user
#[derive(Debug, Clone, Serialize)]
pub struct EffectivePolicy {
    pub resolved_roles: Vec<String>,
    pub default_policy: String,
    pub rules: Vec<EffectivePolicyRule>,
    pub bindings: Vec<EffectiveGroupBinding>,
}

/// Wildcard matching: "*" matches anything, otherwise exact match
fn matches_wildcard(pattern: &str, value: &str) -> bool {
    pattern == "*" || pattern == value
}

/// Map an API endpoint (method, path) to (resource, action)
pub fn resolve_endpoint(method: &str, path: &str) -> Option<(&'static str, &'static str)> {
    match method {
        "GET" => resolve_get(path),
        "POST" => resolve_post(path),
        "PUT" => resolve_put(path),
        "DELETE" => resolve_delete(path),
        _ => None,
    }
}

fn resolve_get(path: &str) -> Option<(&'static str, &'static str)> {
    // Reports
    if path.starts_with("/api/v1/vulnerabilityreports") || path.starts_with("/api/v1/sbomreports") {
        return Some(("reports", "get"));
    }
    // Clusters & namespaces
    if path == "/api/v1/clusters" || path == "/api/v1/namespaces" {
        return Some(("clusters", "get"));
    }
    // Stats & system info
    if path == "/api/v1/stats"
        || path.starts_with("/api/v1/dashboard/trends")
        || path == "/api/v1/watcher/status"
        || path == "/api/v1/version"
        || path == "/api/v1/status"
        || path == "/api/v1/config"
    {
        return Some(("stats", "get"));
    }
    // Admin
    if path.starts_with("/api/v1/admin/") {
        return Some(("admin", "get"));
    }
    // Tokens
    if path == "/api/v1/auth/tokens" {
        return Some(("tokens", "get"));
    }
    None
}

fn resolve_post(path: &str) -> Option<(&'static str, &'static str)> {
    if path == "/api/v1/auth/tokens" {
        return Some(("tokens", "create"));
    }
    None
}

fn resolve_put(path: &str) -> Option<(&'static str, &'static str)> {
    if path.starts_with("/api/v1/reports/") && path.ends_with("/notes") {
        return Some(("reports", "update"));
    }
    None
}

fn resolve_delete(path: &str) -> Option<(&'static str, &'static str)> {
    if path.starts_with("/api/v1/reports/") {
        return Some(("reports", "delete"));
    }
    if path.starts_with("/api/v1/admin/") {
        return Some(("admin", "delete"));
    }
    if path.starts_with("/api/v1/auth/tokens/") {
        return Some(("tokens", "delete"));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_policy() -> RbacPolicy {
        let csv = r#"
p, role:readonly, reports, get, allow
p, role:readonly, clusters, get, allow
p, role:readonly, stats, get, allow
p, role:readonly, tokens, get, allow
p, role:readonly, tokens, create, allow
p, role:admin, *, *, allow

g, security-team, role:readonly
g, platform-team, role:admin
"#;
        RbacPolicy::from_csv(csv, "role:readonly").unwrap()
    }

    #[test]
    fn test_parse_csv() {
        let policy = test_policy();
        assert_eq!(policy.rules.len(), 6);
        assert_eq!(policy.groups.len(), 2);
    }

    #[test]
    fn test_parse_empty() {
        let policy = RbacPolicy::from_csv("", "").unwrap();
        assert!(policy.rules.is_empty());
        assert!(policy.groups.is_empty());
    }

    #[test]
    fn test_parse_comments_and_blank_lines() {
        let csv = r#"
# This is a comment

p, role:admin, *, *, allow
# Another comment
"#;
        let policy = RbacPolicy::from_csv(csv, "").unwrap();
        assert_eq!(policy.rules.len(), 1);
    }

    #[test]
    fn test_parse_invalid_effect() {
        let csv = "p, role:admin, *, *, maybe";
        let result = RbacPolicy::from_csv(csv, "");
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_insufficient_fields() {
        let csv = "p, role:admin, *";
        let result = RbacPolicy::from_csv(csv, "");
        assert!(result.is_err());
    }

    #[test]
    fn test_admin_wildcard_access() {
        let policy = test_policy();
        let groups = vec!["platform-team".to_string()];
        assert!(policy.is_allowed(&groups, "reports", "get"));
        assert!(policy.is_allowed(&groups, "reports", "delete"));
        assert!(policy.is_allowed(&groups, "admin", "get"));
        assert!(policy.is_allowed(&groups, "admin", "delete"));
        assert!(policy.is_allowed(&groups, "tokens", "delete"));
    }

    #[test]
    fn test_readonly_access() {
        let policy = test_policy();
        let groups = vec!["security-team".to_string()];
        assert!(policy.is_allowed(&groups, "reports", "get"));
        assert!(policy.is_allowed(&groups, "clusters", "get"));
        assert!(policy.is_allowed(&groups, "stats", "get"));
        assert!(policy.is_allowed(&groups, "tokens", "get"));
        assert!(policy.is_allowed(&groups, "tokens", "create"));
        // Should deny
        assert!(!policy.is_allowed(&groups, "reports", "delete"));
        assert!(!policy.is_allowed(&groups, "admin", "get"));
        assert!(!policy.is_allowed(&groups, "tokens", "delete"));
    }

    #[test]
    fn test_default_policy_fallback() {
        let policy = test_policy();
        // User with no matching group bindings gets default_policy (role:readonly)
        let groups = vec!["unknown-team".to_string()];
        assert!(policy.is_allowed(&groups, "reports", "get"));
        assert!(!policy.is_allowed(&groups, "admin", "get"));
    }

    #[test]
    fn test_empty_groups_default_policy() {
        let policy = test_policy();
        let groups: Vec<String> = vec![];
        assert!(policy.is_allowed(&groups, "reports", "get"));
        assert!(!policy.is_allowed(&groups, "reports", "delete"));
    }

    #[test]
    fn test_no_default_policy_denies_all() {
        let csv = r#"
p, role:admin, *, *, allow
g, platform-team, role:admin
"#;
        let policy = RbacPolicy::from_csv(csv, "").unwrap();
        let groups = vec!["unknown-team".to_string()];
        assert!(!policy.is_allowed(&groups, "reports", "get"));
    }

    #[test]
    fn test_deny_effect() {
        let csv = r#"
p, role:test, reports, delete, deny
p, role:test, reports, get, allow
"#;
        let policy = RbacPolicy::from_csv(csv, "role:test").unwrap();
        let groups: Vec<String> = vec![];
        assert!(!policy.is_allowed(&groups, "reports", "delete"));
        assert!(policy.is_allowed(&groups, "reports", "get"));
    }

    #[test]
    fn test_get_permissions() {
        let policy = test_policy();

        let admin_groups = vec!["platform-team".to_string()];
        let admin_perms = policy.get_permissions(&admin_groups);
        assert!(admin_perms.can_admin);
        assert!(admin_perms.can_delete_reports);
        assert!(admin_perms.can_manage_tokens);

        let readonly_groups = vec!["security-team".to_string()];
        let readonly_perms = policy.get_permissions(&readonly_groups);
        assert!(!readonly_perms.can_admin);
        assert!(!readonly_perms.can_delete_reports);
        assert!(!readonly_perms.can_manage_tokens);
    }

    // resolve_endpoint tests
    // ───── get_effective_policy tests ─────

    #[test]
    fn test_effective_policy_admin() {
        let policy = test_policy();
        let groups = vec!["platform-team".to_string()];
        let ep = policy.get_effective_policy(&groups);

        assert_eq!(ep.resolved_roles, vec!["role:admin"]);
        assert_eq!(ep.bindings.len(), 1);
        assert_eq!(ep.bindings[0].group, "platform-team");
        assert_eq!(ep.bindings[0].role, "role:admin");
        // Only the wildcard admin rule should match
        assert_eq!(ep.rules.len(), 1);
        assert_eq!(ep.rules[0].subject, "role:admin");
        assert_eq!(ep.rules[0].resource, "*");
        assert_eq!(ep.rules[0].action, "*");
        assert_eq!(ep.rules[0].effect, "allow");
    }

    #[test]
    fn test_effective_policy_readonly() {
        let policy = test_policy();
        let groups = vec!["security-team".to_string()];
        let ep = policy.get_effective_policy(&groups);

        assert_eq!(ep.resolved_roles, vec!["role:readonly"]);
        assert_eq!(ep.bindings.len(), 1);
        assert_eq!(ep.bindings[0].group, "security-team");
        assert_eq!(ep.bindings[0].role, "role:readonly");
        // 5 readonly rules
        assert_eq!(ep.rules.len(), 5);
        assert!(ep.rules.iter().all(|r| r.subject == "role:readonly"));
        assert!(ep.rules.iter().all(|r| r.effect == "allow"));
    }

    #[test]
    fn test_effective_policy_default_fallback() {
        let policy = test_policy();
        let groups = vec!["unknown-team".to_string()];
        let ep = policy.get_effective_policy(&groups);

        // Falls back to default_policy "role:readonly"
        assert_eq!(ep.resolved_roles, vec!["role:readonly"]);
        // No matching group bindings
        assert!(ep.bindings.is_empty());
        // Still gets readonly rules via default role
        assert_eq!(ep.rules.len(), 5);
    }

    #[test]
    fn test_effective_policy_empty_groups() {
        let policy = test_policy();
        let groups: Vec<String> = vec![];
        let ep = policy.get_effective_policy(&groups);

        assert_eq!(ep.resolved_roles, vec!["role:readonly"]);
        assert!(ep.bindings.is_empty());
        assert_eq!(ep.rules.len(), 5);
    }

    #[test]
    fn test_effective_policy_no_default_no_match() {
        let csv = r#"
p, role:admin, *, *, allow
g, platform-team, role:admin
"#;
        let policy = RbacPolicy::from_csv(csv, "").unwrap();
        let groups = vec!["unknown-team".to_string()];
        let ep = policy.get_effective_policy(&groups);

        assert!(ep.resolved_roles.is_empty());
        assert!(ep.bindings.is_empty());
        assert!(ep.rules.is_empty());
    }

    #[test]
    fn test_effective_policy_deny_effect() {
        let csv = r#"
p, role:mixed, reports, delete, deny
p, role:mixed, reports, get, allow
g, test-team, role:mixed
"#;
        let policy = RbacPolicy::from_csv(csv, "").unwrap();
        let groups = vec!["test-team".to_string()];
        let ep = policy.get_effective_policy(&groups);

        assert_eq!(ep.resolved_roles, vec!["role:mixed"]);
        assert_eq!(ep.rules.len(), 2);
        let deny_rule = ep.rules.iter().find(|r| r.action == "delete").unwrap();
        assert_eq!(deny_rule.effect, "deny");
        let allow_rule = ep.rules.iter().find(|r| r.action == "get").unwrap();
        assert_eq!(allow_rule.effect, "allow");
    }

    #[test]
    fn test_effective_policy_multiple_groups() {
        let csv = r#"
p, role:viewer, reports, get, allow
p, role:editor, reports, update, allow
g, viewers, role:viewer
g, editors, role:editor
"#;
        let policy = RbacPolicy::from_csv(csv, "").unwrap();
        let groups = vec!["viewers".to_string(), "editors".to_string()];
        let ep = policy.get_effective_policy(&groups);

        assert_eq!(ep.resolved_roles.len(), 2);
        assert!(ep.resolved_roles.contains(&"role:viewer".to_string()));
        assert!(ep.resolved_roles.contains(&"role:editor".to_string()));
        assert_eq!(ep.bindings.len(), 2);
        assert_eq!(ep.rules.len(), 2);
    }

    #[test]
    fn test_effective_policy_duplicate_role_binding() {
        let csv = r#"
p, role:readonly, reports, get, allow
g, team-a, role:readonly
g, team-b, role:readonly
"#;
        let policy = RbacPolicy::from_csv(csv, "").unwrap();
        let groups = vec!["team-a".to_string(), "team-b".to_string()];
        let ep = policy.get_effective_policy(&groups);

        // resolve_roles deduplicates
        assert_eq!(ep.resolved_roles, vec!["role:readonly"]);
        // Both bindings still shown
        assert_eq!(ep.bindings.len(), 2);
        // Rules not duplicated
        assert_eq!(ep.rules.len(), 1);
    }

    // ───── resolve_endpoint tests ─────

    #[test]
    fn test_resolve_get_reports() {
        assert_eq!(
            resolve_endpoint("GET", "/api/v1/vulnerabilityreports"),
            Some(("reports", "get"))
        );
        assert_eq!(
            resolve_endpoint("GET", "/api/v1/vulnerabilityreports/vulnerabilities/search"),
            Some(("reports", "get"))
        );
        assert_eq!(
            resolve_endpoint("GET", "/api/v1/sbomreports"),
            Some(("reports", "get"))
        );
        assert_eq!(
            resolve_endpoint("GET", "/api/v1/sbomreports/components/search"),
            Some(("reports", "get"))
        );
    }

    #[test]
    fn test_resolve_get_clusters() {
        assert_eq!(
            resolve_endpoint("GET", "/api/v1/clusters"),
            Some(("clusters", "get"))
        );
        assert_eq!(
            resolve_endpoint("GET", "/api/v1/namespaces"),
            Some(("clusters", "get"))
        );
    }

    #[test]
    fn test_resolve_get_stats() {
        assert_eq!(
            resolve_endpoint("GET", "/api/v1/stats"),
            Some(("stats", "get"))
        );
        assert_eq!(
            resolve_endpoint("GET", "/api/v1/dashboard/trends"),
            Some(("stats", "get"))
        );
        assert_eq!(
            resolve_endpoint("GET", "/api/v1/version"),
            Some(("stats", "get"))
        );
        assert_eq!(
            resolve_endpoint("GET", "/api/v1/status"),
            Some(("stats", "get"))
        );
        assert_eq!(
            resolve_endpoint("GET", "/api/v1/config"),
            Some(("stats", "get"))
        );
    }

    #[test]
    fn test_resolve_get_admin() {
        assert_eq!(
            resolve_endpoint("GET", "/api/v1/admin/logs"),
            Some(("admin", "get"))
        );
        assert_eq!(
            resolve_endpoint("GET", "/api/v1/admin/logs/stats"),
            Some(("admin", "get"))
        );
        assert_eq!(
            resolve_endpoint("GET", "/api/v1/admin/info"),
            Some(("admin", "get"))
        );
    }

    #[test]
    fn test_resolve_tokens() {
        assert_eq!(
            resolve_endpoint("GET", "/api/v1/auth/tokens"),
            Some(("tokens", "get"))
        );
        assert_eq!(
            resolve_endpoint("POST", "/api/v1/auth/tokens"),
            Some(("tokens", "create"))
        );
        assert_eq!(
            resolve_endpoint("DELETE", "/api/v1/auth/tokens/123"),
            Some(("tokens", "delete"))
        );
    }

    #[test]
    fn test_resolve_delete_reports() {
        assert_eq!(
            resolve_endpoint(
                "DELETE",
                "/api/v1/reports/prod/vulnerabilityreport/default/nginx"
            ),
            Some(("reports", "delete"))
        );
    }

    #[test]
    fn test_resolve_put_notes() {
        assert_eq!(
            resolve_endpoint(
                "PUT",
                "/api/v1/reports/prod/vulnerabilityreport/default/nginx/notes"
            ),
            Some(("reports", "update"))
        );
    }

    #[test]
    fn test_resolve_delete_admin() {
        assert_eq!(
            resolve_endpoint("DELETE", "/api/v1/admin/logs"),
            Some(("admin", "delete"))
        );
    }

    #[test]
    fn test_resolve_unknown() {
        assert_eq!(resolve_endpoint("GET", "/healthz"), None);
        assert_eq!(resolve_endpoint("GET", "/"), None);
        assert_eq!(resolve_endpoint("PATCH", "/api/v1/stats"), None);
    }
}
