//! Category / service filtering for AWS Health events.
//!
//! Allow lists are inclusive: empty means "allow everything".
//! Deny lists always win — an entry in deny is dropped even if allow lists it.
//! Service matching is case-insensitive; category matching is exact since
//! AWS uses fixed camelCase values (`issue`, `scheduledChange`, ...).

use std::collections::HashSet;

use crate::health::HealthEvent;

/// Fixed set of `eventTypeCategory` values defined by AWS Health.
/// Source: <https://docs.aws.amazon.com/health/latest/APIReference/API_EventType.html>
pub const VALID_CATEGORIES: &[&str] = &[
    "issue",
    "accountNotification",
    "scheduledChange",
    "investigation",
];

/// Outcome of validating a single allow/deny list, split into known and
/// unknown entries (preserving the operator's original casing).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ListValidation {
    pub valid: Vec<String>,
    pub invalid: Vec<String>,
}

impl ListValidation {
    pub const fn is_ok(&self) -> bool {
        self.invalid.is_empty()
    }
}

/// Full validation result for all four filter lists.
#[derive(Debug, Default, Clone)]
pub struct ValidationReport {
    pub allow_services: ListValidation,
    pub deny_services: ListValidation,
    pub allow_categories: ListValidation,
    pub deny_categories: ListValidation,
}

impl ValidationReport {
    pub const fn is_ok(&self) -> bool {
        self.allow_services.is_ok()
            && self.deny_services.is_ok()
            && self.allow_categories.is_ok()
            && self.deny_categories.is_ok()
    }

    /// All invalid values across every list, prefixed by their list name.
    pub fn all_invalid(&self) -> Vec<String> {
        let mut out = Vec::new();
        for v in &self.allow_services.invalid {
            out.push(format!("allow_services '{v}'"));
        }
        for v in &self.deny_services.invalid {
            out.push(format!("deny_services '{v}'"));
        }
        for v in &self.allow_categories.invalid {
            out.push(format!("allow_categories '{v}'"));
        }
        for v in &self.deny_categories.invalid {
            out.push(format!("deny_categories '{v}'"));
        }
        out
    }
}

/// Validates configured allow/deny lists against the AWS Health catalog.
///
/// Services are matched case-insensitively against `service_catalog`
/// (fetched at startup via `DescribeEventTypes`). Categories are matched
/// case-sensitively against `VALID_CATEGORIES`.
pub fn validate_filters(
    allow_categories: &[String],
    deny_categories: &[String],
    allow_services: &[String],
    deny_services: &[String],
    service_catalog: &HashSet<String>,
) -> ValidationReport {
    let catalog_ci: HashSet<String> = service_catalog
        .iter()
        .map(|s| s.to_ascii_lowercase())
        .collect();
    let valid_cats: HashSet<&str> = VALID_CATEGORIES.iter().copied().collect();

    let split_services = |list: &[String]| -> ListValidation {
        let mut r = ListValidation::default();
        for v in list {
            let trimmed = v.trim();
            if trimmed.is_empty() {
                continue;
            }
            if catalog_ci.contains(&trimmed.to_ascii_lowercase()) {
                r.valid.push(trimmed.to_string());
            } else {
                r.invalid.push(trimmed.to_string());
            }
        }
        r
    };
    let split_categories = |list: &[String]| -> ListValidation {
        let mut r = ListValidation::default();
        for v in list {
            let trimmed = v.trim();
            if trimmed.is_empty() {
                continue;
            }
            if valid_cats.contains(trimmed) {
                r.valid.push(trimmed.to_string());
            } else {
                r.invalid.push(trimmed.to_string());
            }
        }
        r
    };

    ValidationReport {
        allow_services: split_services(allow_services),
        deny_services: split_services(deny_services),
        allow_categories: split_categories(allow_categories),
        deny_categories: split_categories(deny_categories),
    }
}

#[derive(Debug, Clone, Default)]
pub struct EventFilter {
    allow_categories: Vec<String>,
    deny_categories: Vec<String>,
    allow_services: Vec<String>,
    deny_services: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilterDecision {
    Allow,
    DenyCategory,
    NotInAllowedCategories,
    DenyService,
    NotInAllowedServices,
}

impl FilterDecision {
    pub const fn reason(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::DenyCategory => "deny_category",
            Self::NotInAllowedCategories => "category_not_allowed",
            Self::DenyService => "deny_service",
            Self::NotInAllowedServices => "service_not_allowed",
        }
    }

    pub const fn is_allowed(self) -> bool {
        matches!(self, Self::Allow)
    }
}

impl EventFilter {
    pub fn new(
        allow_categories: &[String],
        deny_categories: &[String],
        allow_services: &[String],
        deny_services: &[String],
    ) -> Self {
        Self {
            allow_categories: normalize(allow_categories),
            deny_categories: normalize(deny_categories),
            allow_services: normalize(allow_services),
            deny_services: normalize(deny_services),
        }
    }

    pub fn evaluate(&self, event: &HealthEvent) -> FilterDecision {
        let category = event.detail.event_type_category.as_deref().unwrap_or("");
        let service = event.detail.service.as_deref().unwrap_or("");

        if contains_ci(&self.deny_categories, category) {
            return FilterDecision::DenyCategory;
        }
        if contains_ci(&self.deny_services, service) {
            return FilterDecision::DenyService;
        }
        if !self.allow_categories.is_empty() && !contains_ci(&self.allow_categories, category) {
            return FilterDecision::NotInAllowedCategories;
        }
        if !self.allow_services.is_empty() && !contains_ci(&self.allow_services, service) {
            return FilterDecision::NotInAllowedServices;
        }
        FilterDecision::Allow
    }
}

fn normalize(values: &[String]) -> Vec<String> {
    values
        .iter()
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty())
        .collect()
}

fn contains_ci(haystack: &[String], needle: &str) -> bool {
    let needle = needle.trim().to_ascii_lowercase();
    if needle.is_empty() {
        return false;
    }
    haystack.iter().any(|v| v == &needle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::health::{HealthDetail, HealthEvent};

    fn event(category: &str, service: &str) -> HealthEvent {
        HealthEvent {
            account: None,
            region: None,
            detail: HealthDetail {
                event_arn: None,
                service: Some(service.into()),
                event_type_code: None,
                event_type_category: Some(category.into()),
                start_time: None,
                end_time: None,
                last_updated_time: None,
                status_code: None,
                event_description: vec![],
                affected_entities: vec![],
            },
        }
    }

    #[test]
    fn empty_filter_allows_everything() {
        let f = EventFilter::default();
        assert!(f.evaluate(&event("issue", "EC2")).is_allowed());
    }

    #[test]
    fn deny_wins_over_allow() {
        let f = EventFilter::new(&["issue".into()], &["issue".into()], &[], &[]);
        assert_eq!(
            f.evaluate(&event("issue", "EC2")),
            FilterDecision::DenyCategory
        );
    }

    #[test]
    fn allow_list_restricts_categories() {
        let f = EventFilter::new(
            &["issue".into(), "securityNotification".into()],
            &[],
            &[],
            &[],
        );
        assert!(f.evaluate(&event("issue", "EC2")).is_allowed());
        assert_eq!(
            f.evaluate(&event("accountNotification", "EC2")),
            FilterDecision::NotInAllowedCategories
        );
    }

    #[test]
    fn service_match_is_case_insensitive() {
        let f = EventFilter::new(&[], &[], &["ec2".into()], &[]);
        assert!(f.evaluate(&event("issue", "EC2")).is_allowed());
        assert_eq!(
            f.evaluate(&event("issue", "RDS")),
            FilterDecision::NotInAllowedServices
        );
    }

    fn catalog(items: &[&str]) -> HashSet<String> {
        items.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn validate_passes_for_known_values() {
        let cat = catalog(&["EC2", "RDS", "KAFKA"]);
        let r = validate_filters(
            &["issue".into()],
            &["accountNotification".into()],
            &["ec2".into(), "KAFKA".into()],
            &["rds".into()],
            &cat,
        );
        assert!(r.is_ok(), "expected ok, got {:?}", r.all_invalid());
        assert_eq!(r.allow_services.valid, vec!["ec2", "KAFKA"]);
        assert_eq!(r.deny_services.valid, vec!["rds"]);
    }

    #[test]
    fn validate_splits_known_and_unknown_services() {
        let cat = catalog(&["EC2", "KAFKA"]);
        let r = validate_filters(
            &[],
            &[],
            &["EC2".into(), "MSK".into(), "KAFKA".into()],
            &["BOGUS".into()],
            &cat,
        );
        assert!(!r.is_ok());
        assert_eq!(r.allow_services.valid, vec!["EC2", "KAFKA"]);
        assert_eq!(r.allow_services.invalid, vec!["MSK"]);
        assert_eq!(r.deny_services.invalid, vec!["BOGUS"]);
        assert_eq!(
            r.all_invalid(),
            vec!["allow_services 'MSK'", "deny_services 'BOGUS'"]
        );
    }

    #[test]
    fn validate_flags_unknown_category() {
        let cat = catalog(&["EC2"]);
        let r = validate_filters(&["bogus".into()], &[], &[], &[], &cat);
        assert!(!r.is_ok());
        assert_eq!(r.allow_categories.invalid, vec!["bogus"]);
    }

    #[test]
    fn validate_ignores_empty_entries() {
        let cat = catalog(&["EC2"]);
        let r = validate_filters(&[String::new()], &[], &["  ".into()], &[], &cat);
        assert!(r.is_ok());
        assert!(r.allow_services.valid.is_empty());
    }
}
