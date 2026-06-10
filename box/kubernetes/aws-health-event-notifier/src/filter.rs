//! Category / service / event-type-code filtering for AWS Health events.
//!
//! Allow lists are inclusive: empty means "allow everything".
//! Deny lists always win — an entry in deny is dropped even if allow lists it.
//! Service and event-type-code matching is case-insensitive; category matching
//! is exact since AWS uses fixed camelCase values (`issue`, `scheduledChange`, ...).
//!
//! Event-type-code filters are written as `SERVICE/EVENT_TYPE_CODE` pairs
//! (e.g. `VPN/AWS_VPN_REDUNDANCY_LOSS`) and sit below service filters: deny a
//! noisy code while still receiving every other event from the same service.

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

/// Full validation result for all six filter lists.
#[derive(Debug, Default, Clone)]
pub struct ValidationReport {
    pub allow_services: ListValidation,
    pub deny_services: ListValidation,
    pub allow_categories: ListValidation,
    pub deny_categories: ListValidation,
    pub allow_event_codes: ListValidation,
    pub deny_event_codes: ListValidation,
}

impl ValidationReport {
    pub const fn is_ok(&self) -> bool {
        self.allow_services.is_ok()
            && self.deny_services.is_ok()
            && self.allow_categories.is_ok()
            && self.deny_categories.is_ok()
            && self.allow_event_codes.is_ok()
            && self.deny_event_codes.is_ok()
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
        for v in &self.allow_event_codes.invalid {
            out.push(format!("allow_event_codes '{v}'"));
        }
        for v in &self.deny_event_codes.invalid {
            out.push(format!("deny_event_codes '{v}'"));
        }
        out
    }
}

/// Catalogs fetched at startup via `DescribeEventTypes`, scoped to the
/// configured filter values, used to validate the allow/deny lists.
/// `event_codes` holds canonical `SERVICE/EVENT_TYPE_CODE` pairs.
#[derive(Debug, Default, Clone)]
pub struct Catalogs {
    pub services: HashSet<String>,
    pub event_codes: HashSet<String>,
}

/// A `SERVICE/EVENT_TYPE_CODE` filter entry, e.g. `VPN/AWS_VPN_REDUNDANCY_LOSS`.
/// Scoping the code to its service keeps an entry from accidentally matching
/// an identically named code published under another service.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceEventCode {
    pub service: String,
    pub code: String,
}

impl ServiceEventCode {
    /// Parses `SERVICE/EVENT_TYPE_CODE`. Both sides must be non-empty.
    pub fn parse(raw: &str) -> Option<Self> {
        let (service, code) = raw.trim().split_once('/')?;
        let (service, code) = (service.trim(), code.trim());
        if service.is_empty() || code.is_empty() {
            return None;
        }
        Some(Self {
            service: service.to_string(),
            code: code.to_string(),
        })
    }

    fn parse_normalized(raw: &str) -> Option<Self> {
        Self::parse(raw).map(|p| Self {
            service: p.service.to_ascii_lowercase(),
            code: p.code.to_ascii_lowercase(),
        })
    }

    /// Case-insensitive match against an event's service and event type code.
    fn matches(&self, service: &str, code: &str) -> bool {
        !code.is_empty()
            && self.service == service.trim().to_ascii_lowercase()
            && self.code == code.trim().to_ascii_lowercase()
    }
}

/// Validates configured allow/deny lists against the AWS Health catalog.
///
/// Services and event type codes are matched case-insensitively against
/// `catalogs`. Event code entries must be `SERVICE/EVENT_TYPE_CODE` pairs;
/// a malformed entry (no `/`) is reported as invalid. Categories are matched
/// case-sensitively against `VALID_CATEGORIES`.
pub fn validate_filters(
    allow_categories: &[String],
    deny_categories: &[String],
    allow_services: &[String],
    deny_services: &[String],
    allow_event_codes: &[String],
    deny_event_codes: &[String],
    catalogs: &Catalogs,
) -> ValidationReport {
    let valid_cats: HashSet<&str> = VALID_CATEGORIES.iter().copied().collect();

    let split_against = |list: &[String], catalog: &HashSet<String>| -> ListValidation {
        let catalog_ci: HashSet<String> = catalog.iter().map(|s| s.to_ascii_lowercase()).collect();
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

    let pair_catalog_ci: HashSet<String> = catalogs
        .event_codes
        .iter()
        .map(|s| s.to_ascii_lowercase())
        .collect();
    let split_pairs = |list: &[String]| -> ListValidation {
        let mut r = ListValidation::default();
        for v in list {
            let trimmed = v.trim();
            if trimmed.is_empty() {
                continue;
            }
            match ServiceEventCode::parse_normalized(trimmed) {
                Some(p) if pair_catalog_ci.contains(&format!("{}/{}", p.service, p.code)) => {
                    r.valid.push(trimmed.to_string());
                }
                _ => r.invalid.push(trimmed.to_string()),
            }
        }
        r
    };

    ValidationReport {
        allow_services: split_against(allow_services, &catalogs.services),
        deny_services: split_against(deny_services, &catalogs.services),
        allow_categories: split_categories(allow_categories),
        deny_categories: split_categories(deny_categories),
        allow_event_codes: split_pairs(allow_event_codes),
        deny_event_codes: split_pairs(deny_event_codes),
    }
}

#[derive(Debug, Clone, Default)]
pub struct EventFilter {
    allow_categories: Vec<String>,
    deny_categories: Vec<String>,
    allow_services: Vec<String>,
    deny_services: Vec<String>,
    allow_event_codes: Vec<ServiceEventCode>,
    deny_event_codes: Vec<ServiceEventCode>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilterDecision {
    Allow,
    DenyCategory,
    NotInAllowedCategories,
    DenyService,
    NotInAllowedServices,
    DenyEventCode,
    NotInAllowedEventCodes,
}

impl FilterDecision {
    pub const fn reason(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::DenyCategory => "deny_category",
            Self::NotInAllowedCategories => "category_not_allowed",
            Self::DenyService => "deny_service",
            Self::NotInAllowedServices => "service_not_allowed",
            Self::DenyEventCode => "deny_event_code",
            Self::NotInAllowedEventCodes => "event_code_not_allowed",
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
        allow_event_codes: &[String],
        deny_event_codes: &[String],
    ) -> Self {
        Self {
            allow_categories: normalize(allow_categories),
            deny_categories: normalize(deny_categories),
            allow_services: normalize(allow_services),
            deny_services: normalize(deny_services),
            // Malformed entries are dropped here; startup validation
            // (`validate_filters`) has already aborted on them.
            allow_event_codes: normalize_pairs(allow_event_codes),
            deny_event_codes: normalize_pairs(deny_event_codes),
        }
    }

    pub fn evaluate(&self, event: &HealthEvent) -> FilterDecision {
        let category = event.detail.event_type_category.as_deref().unwrap_or("");
        let service = event.detail.service.as_deref().unwrap_or("");
        let event_code = event.detail.event_type_code.as_deref().unwrap_or("");

        if contains_ci(&self.deny_categories, category) {
            return FilterDecision::DenyCategory;
        }
        if contains_ci(&self.deny_services, service) {
            return FilterDecision::DenyService;
        }
        if self
            .deny_event_codes
            .iter()
            .any(|p| p.matches(service, event_code))
        {
            return FilterDecision::DenyEventCode;
        }
        if !self.allow_categories.is_empty() && !contains_ci(&self.allow_categories, category) {
            return FilterDecision::NotInAllowedCategories;
        }
        if !self.allow_services.is_empty() && !contains_ci(&self.allow_services, service) {
            return FilterDecision::NotInAllowedServices;
        }
        if !self.allow_event_codes.is_empty()
            && !self
                .allow_event_codes
                .iter()
                .any(|p| p.matches(service, event_code))
        {
            return FilterDecision::NotInAllowedEventCodes;
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

fn normalize_pairs(values: &[String]) -> Vec<ServiceEventCode> {
    values
        .iter()
        .filter_map(|v| ServiceEventCode::parse_normalized(v))
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
        event_with_code(category, service, None)
    }

    fn event_with_code(category: &str, service: &str, code: Option<&str>) -> HealthEvent {
        HealthEvent {
            account: None,
            region: None,
            detail: HealthDetail {
                event_arn: None,
                service: Some(service.into()),
                event_type_code: code.map(Into::into),
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
        let f = EventFilter::new(&["issue".into()], &["issue".into()], &[], &[], &[], &[]);
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
        let f = EventFilter::new(&[], &[], &["ec2".into()], &[], &[], &[]);
        assert!(f.evaluate(&event("issue", "EC2")).is_allowed());
        assert_eq!(
            f.evaluate(&event("issue", "RDS")),
            FilterDecision::NotInAllowedServices
        );
    }

    #[test]
    fn parse_service_event_code() {
        assert_eq!(
            ServiceEventCode::parse("VPN/AWS_VPN_REDUNDANCY_LOSS"),
            Some(ServiceEventCode {
                service: "VPN".into(),
                code: "AWS_VPN_REDUNDANCY_LOSS".into(),
            })
        );
        assert_eq!(
            ServiceEventCode::parse(" VPN / AWS_VPN_REDUNDANCY_LOSS "),
            Some(ServiceEventCode {
                service: "VPN".into(),
                code: "AWS_VPN_REDUNDANCY_LOSS".into(),
            })
        );
        // Missing the service prefix is malformed.
        assert_eq!(ServiceEventCode::parse("AWS_VPN_REDUNDANCY_LOSS"), None);
        assert_eq!(ServiceEventCode::parse("/AWS_VPN_REDUNDANCY_LOSS"), None);
        assert_eq!(ServiceEventCode::parse("VPN/"), None);
    }

    #[test]
    fn deny_event_code_keeps_rest_of_service() {
        // The VPN use case: drop redundancy-loss blips, keep tunnel maintenance.
        let f = EventFilter::new(
            &[],
            &[],
            &[],
            &[],
            &[],
            &["VPN/AWS_VPN_REDUNDANCY_LOSS".into()],
        );
        assert_eq!(
            f.evaluate(&event_with_code(
                "accountNotification",
                "VPN",
                Some("AWS_VPN_REDUNDANCY_LOSS")
            )),
            FilterDecision::DenyEventCode
        );
        assert!(
            f.evaluate(&event_with_code(
                "scheduledChange",
                "VPN",
                Some("AWS_VPN_SINGLE_TUNNEL_NOTIFICATION")
            ))
            .is_allowed()
        );
    }

    #[test]
    fn deny_event_code_is_scoped_to_its_service() {
        let f = EventFilter::new(
            &[],
            &[],
            &[],
            &[],
            &[],
            &["VPN/AWS_VPN_REDUNDANCY_LOSS".into()],
        );
        // Same code under a different service is not denied.
        assert!(
            f.evaluate(&event_with_code(
                "issue",
                "DIRECTCONNECT",
                Some("AWS_VPN_REDUNDANCY_LOSS")
            ))
            .is_allowed()
        );
    }

    #[test]
    fn event_code_match_is_case_insensitive() {
        let f = EventFilter::new(
            &[],
            &[],
            &[],
            &[],
            &[],
            &["vpn/aws_vpn_redundancy_loss".into()],
        );
        assert_eq!(
            f.evaluate(&event_with_code(
                "accountNotification",
                "VPN",
                Some("AWS_VPN_REDUNDANCY_LOSS")
            )),
            FilterDecision::DenyEventCode
        );
    }

    #[test]
    fn allow_event_codes_restrict() {
        let f = EventFilter::new(
            &[],
            &[],
            &[],
            &[],
            &["EC2/AWS_EC2_INSTANCE_RETIREMENT".into()],
            &[],
        );
        assert!(
            f.evaluate(&event_with_code(
                "scheduledChange",
                "EC2",
                Some("AWS_EC2_INSTANCE_RETIREMENT")
            ))
            .is_allowed()
        );
        assert_eq!(
            f.evaluate(&event_with_code("issue", "EC2", Some("AWS_EC2_OTHER"))),
            FilterDecision::NotInAllowedEventCodes
        );
    }

    #[test]
    fn missing_event_code_passes_deny_list() {
        let f = EventFilter::new(
            &[],
            &[],
            &[],
            &[],
            &[],
            &["VPN/AWS_VPN_REDUNDANCY_LOSS".into()],
        );
        assert!(f.evaluate(&event("issue", "VPN")).is_allowed());
    }

    fn catalogs(services: &[&str], event_codes: &[&str]) -> Catalogs {
        Catalogs {
            services: services.iter().map(|s| (*s).to_string()).collect(),
            event_codes: event_codes.iter().map(|s| (*s).to_string()).collect(),
        }
    }

    #[test]
    fn validate_passes_for_known_values() {
        let cat = catalogs(&["EC2", "RDS", "KAFKA"], &["VPN/AWS_VPN_REDUNDANCY_LOSS"]);
        let r = validate_filters(
            &["issue".into()],
            &["accountNotification".into()],
            &["ec2".into(), "KAFKA".into()],
            &["rds".into()],
            &[],
            &["vpn/aws_vpn_redundancy_loss".into()],
            &cat,
        );
        assert!(r.is_ok(), "expected ok, got {:?}", r.all_invalid());
        assert_eq!(r.allow_services.valid, vec!["ec2", "KAFKA"]);
        assert_eq!(r.deny_services.valid, vec!["rds"]);
        assert_eq!(
            r.deny_event_codes.valid,
            vec!["vpn/aws_vpn_redundancy_loss"]
        );
    }

    #[test]
    fn validate_splits_known_and_unknown_services() {
        let cat = catalogs(&["EC2", "KAFKA"], &[]);
        let r = validate_filters(
            &[],
            &[],
            &["EC2".into(), "MSK".into(), "KAFKA".into()],
            &["BOGUS".into()],
            &[],
            &[],
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
        let cat = catalogs(&["EC2"], &[]);
        let r = validate_filters(&["bogus".into()], &[], &[], &[], &[], &[], &cat);
        assert!(!r.is_ok());
        assert_eq!(r.allow_categories.invalid, vec!["bogus"]);
    }

    #[test]
    fn validate_flags_unknown_event_code() {
        let cat = catalogs(&[], &["VPN/AWS_VPN_REDUNDANCY_LOSS"]);
        let r = validate_filters(
            &[],
            &[],
            &[],
            &[],
            &["VPN/AWS_VPN_TYPO".into()],
            &["VPN/AWS_VPN_REDUNDANCY_LOSS".into()],
            &cat,
        );
        assert!(!r.is_ok());
        assert_eq!(r.allow_event_codes.invalid, vec!["VPN/AWS_VPN_TYPO"]);
        assert_eq!(
            r.deny_event_codes.valid,
            vec!["VPN/AWS_VPN_REDUNDANCY_LOSS"]
        );
        assert_eq!(
            r.all_invalid(),
            vec!["allow_event_codes 'VPN/AWS_VPN_TYPO'"]
        );
    }

    #[test]
    fn validate_flags_event_code_without_service_prefix() {
        // Bare code (old format) and pair under the wrong service are both invalid.
        let cat = catalogs(&[], &["VPN/AWS_VPN_REDUNDANCY_LOSS"]);
        let r = validate_filters(
            &[],
            &[],
            &[],
            &[],
            &[],
            &[
                "AWS_VPN_REDUNDANCY_LOSS".into(),
                "EC2/AWS_VPN_REDUNDANCY_LOSS".into(),
            ],
            &cat,
        );
        assert!(!r.is_ok());
        assert_eq!(
            r.deny_event_codes.invalid,
            vec!["AWS_VPN_REDUNDANCY_LOSS", "EC2/AWS_VPN_REDUNDANCY_LOSS"]
        );
    }

    #[test]
    fn validate_ignores_empty_entries() {
        let cat = catalogs(&["EC2"], &[]);
        let r = validate_filters(
            &[String::new()],
            &[],
            &["  ".into()],
            &[],
            &["  ".into()],
            &[],
            &cat,
        );
        assert!(r.is_ok());
        assert!(r.allow_services.valid.is_empty());
        assert!(r.allow_event_codes.valid.is_empty());
    }
}
