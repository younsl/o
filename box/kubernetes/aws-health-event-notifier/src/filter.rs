//! Category / service / region / event-type-code filtering for AWS Health events.
//!
//! Allow lists are inclusive: empty means "allow everything".
//! Deny lists always win — an entry in deny is dropped even if allow lists it.
//! Service, region, and event-type-code matching is case-insensitive; category
//! matching is exact since AWS uses fixed camelCase values (`issue`,
//! `scheduledChange`, ...).
//!
//! Event-type-code filters are written as `SERVICE/EVENT_TYPE_CODE` pairs
//! (e.g. `VPN/AWS_VPN_REDUNDANCY_LOSS`) and sit below service filters: deny a
//! noisy code while still receiving every other event from the same service.
//!
//! Region filters drop events from regions the account does not run in, without
//! silencing the same event type where it matters. `global` is appended to a
//! non-empty allow list so global-scope events (IAM, Route 53, and the Health
//! service itself) survive; list it in the deny list to drop them. An event whose
//! region is absent or empty passes both lists, since losing a real event to a
//! missing field is worse than one extra notification.

use std::collections::HashSet;

use crate::health::HealthEvent;

/// Region value AWS Health uses for global-scope events. Always allowed unless
/// explicitly denied, so an allow list does not silently drop global services.
pub const GLOBAL_REGION: &str = "global";

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

/// The eight allow/deny lists that make up the event filter, as configured.
///
/// Named fields instead of eight positional `&[String]` arguments: the lists are
/// all the same type, so ordering them by hand at the call site is a silent bug
/// waiting to happen. `Default` is the all-empty case, which means allow all.
#[derive(Debug, Default, Clone, Copy)]
pub struct FilterLists<'a> {
    pub allow_categories: &'a [String],
    pub deny_categories: &'a [String],
    pub allow_services: &'a [String],
    pub deny_services: &'a [String],
    pub allow_regions: &'a [String],
    pub deny_regions: &'a [String],
    pub allow_event_codes: &'a [String],
    pub deny_event_codes: &'a [String],
}

/// Full validation result for all eight filter lists.
#[derive(Debug, Default, Clone)]
pub struct ValidationReport {
    pub allow_services: ListValidation,
    pub deny_services: ListValidation,
    pub allow_categories: ListValidation,
    pub deny_categories: ListValidation,
    pub allow_regions: ListValidation,
    pub deny_regions: ListValidation,
    pub allow_event_codes: ListValidation,
    pub deny_event_codes: ListValidation,
}

impl ValidationReport {
    pub const fn is_ok(&self) -> bool {
        self.allow_services.is_ok()
            && self.deny_services.is_ok()
            && self.allow_categories.is_ok()
            && self.deny_categories.is_ok()
            && self.allow_regions.is_ok()
            && self.deny_regions.is_ok()
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
        for v in &self.allow_regions.invalid {
            out.push(format!("allow_regions '{v}'"));
        }
        for v in &self.deny_regions.invalid {
            out.push(format!("deny_regions '{v}'"));
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

/// True for a well-formed AWS region code, or the literal `global`.
///
/// Shape check only: `DescribeEventTypes` publishes no region catalog, so there
/// is nothing to validate against. A static list of known regions would reject a
/// newly launched region and turn a correct configuration into a crash loop,
/// while a wrong-but-well-formed region is only an over-filter, visible as
/// `aws_health_event_filtered_total{reason="region_not_allowed"}`.
///
/// Matches `^[a-z]{2}(-[a-z]+)+-\d$`: `ap-northeast-2`, `us-gov-east-1`,
/// `cn-north-1`. Rejects `ap-northeast2` and `eu_central_1`.
fn is_region_shaped(value: &str) -> bool {
    if value.eq_ignore_ascii_case(GLOBAL_REGION) {
        return true;
    }
    let mut parts = value.split('-');
    let Some(prefix) = parts.next() else {
        return false;
    };
    if prefix.len() != 2 || !prefix.bytes().all(|b| b.is_ascii_lowercase()) {
        return false;
    }
    // Everything between the prefix and the trailing digit is a lowercase word,
    // and there is at least one of them (`ap` + `northeast` + `2`).
    let rest: Vec<&str> = parts.collect();
    let Some((digit, words)) = rest.split_last() else {
        return false;
    };
    if words.is_empty() {
        return false;
    }
    digit.len() == 1
        && digit.bytes().all(|b| b.is_ascii_digit())
        && words
            .iter()
            .all(|w| !w.is_empty() && w.bytes().all(|b| b.is_ascii_lowercase()))
}

/// Validates configured allow/deny lists against the AWS Health catalog.
///
/// Services and event type codes are matched case-insensitively against
/// `catalogs`. Event code entries must be `SERVICE/EVENT_TYPE_CODE` pairs;
/// a malformed entry (no `/`) is reported as invalid. Categories are matched
/// case-sensitively against `VALID_CATEGORIES`. Regions are shape-checked, see
/// `is_region_shaped`.
pub fn validate_filters(lists: &FilterLists, catalogs: &Catalogs) -> ValidationReport {
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
    let split_regions = |list: &[String]| -> ListValidation {
        let mut r = ListValidation::default();
        for v in list {
            let trimmed = v.trim();
            if trimmed.is_empty() {
                continue;
            }
            if is_region_shaped(&trimmed.to_ascii_lowercase()) {
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
        allow_services: split_against(lists.allow_services, &catalogs.services),
        deny_services: split_against(lists.deny_services, &catalogs.services),
        allow_categories: split_categories(lists.allow_categories),
        deny_categories: split_categories(lists.deny_categories),
        allow_regions: split_regions(lists.allow_regions),
        deny_regions: split_regions(lists.deny_regions),
        allow_event_codes: split_pairs(lists.allow_event_codes),
        deny_event_codes: split_pairs(lists.deny_event_codes),
    }
}

#[derive(Debug, Clone, Default)]
pub struct EventFilter {
    allow_categories: Vec<String>,
    deny_categories: Vec<String>,
    allow_services: Vec<String>,
    deny_services: Vec<String>,
    /// Effective allow list: the configured regions plus `GLOBAL_REGION`.
    /// Empty means allow all, so nothing is appended in that case.
    allow_regions: Vec<String>,
    deny_regions: Vec<String>,
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
    DenyRegion,
    NotInAllowedRegions,
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
            Self::DenyRegion => "deny_region",
            Self::NotInAllowedRegions => "region_not_allowed",
            Self::DenyEventCode => "deny_event_code",
            Self::NotInAllowedEventCodes => "event_code_not_allowed",
        }
    }

    pub const fn is_allowed(self) -> bool {
        matches!(self, Self::Allow)
    }
}

impl EventFilter {
    pub fn new(lists: &FilterLists) -> Self {
        Self {
            allow_categories: normalize(lists.allow_categories),
            deny_categories: normalize(lists.deny_categories),
            allow_services: normalize(lists.allow_services),
            deny_services: normalize(lists.deny_services),
            allow_regions: with_global(normalize(lists.allow_regions)),
            deny_regions: normalize(lists.deny_regions),
            // Malformed entries are dropped here; startup validation
            // (`validate_filters`) has already aborted on them.
            allow_event_codes: normalize_pairs(lists.allow_event_codes),
            deny_event_codes: normalize_pairs(lists.deny_event_codes),
        }
    }

    /// The allow list actually enforced, including the implicit `global`.
    /// Logged at startup so the appended entry is visible to the operator.
    pub fn effective_allow_regions(&self) -> &[String] {
        &self.allow_regions
    }

    pub fn evaluate(&self, event: &HealthEvent) -> FilterDecision {
        let category = event.detail.event_type_category.as_deref().unwrap_or("");
        let service = event.detail.service.as_deref().unwrap_or("");
        let event_code = event.detail.event_type_code.as_deref().unwrap_or("");
        let region = event.region.as_deref().unwrap_or("");

        if contains_ci(&self.deny_categories, category) {
            return FilterDecision::DenyCategory;
        }
        if contains_ci(&self.deny_services, service) {
            return FilterDecision::DenyService;
        }
        // `contains_ci` is false for an empty needle, so an event without a
        // region is never denied on region.
        if contains_ci(&self.deny_regions, region) {
            return FilterDecision::DenyRegion;
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
        // A missing region skips the allow check entirely; dropping an event
        // because AWS omitted the field would be a silent loss.
        if !self.allow_regions.is_empty()
            && !region.trim().is_empty()
            && !contains_ci(&self.allow_regions, region)
        {
            return FilterDecision::NotInAllowedRegions;
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

/// Appends `GLOBAL_REGION` to a non-empty allow list. An empty list already
/// allows everything, so it is left alone.
fn with_global(mut regions: Vec<String>) -> Vec<String> {
    if !regions.is_empty() && !regions.iter().any(|r| r == GLOBAL_REGION) {
        regions.push(GLOBAL_REGION.to_string());
    }
    regions
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
        event_in(category, service, code, None)
    }

    /// `region: None` models an event AWS returned without the field;
    /// `Some("")` models the field present but empty.
    fn event_in(
        category: &str,
        service: &str,
        code: Option<&str>,
        region: Option<&str>,
    ) -> HealthEvent {
        HealthEvent {
            account: None,
            region: region.map(Into::into),
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
        let f = EventFilter::new(&FilterLists {
            allow_categories: &["issue".into()],
            deny_categories: &["issue".into()],
            ..Default::default()
        });
        assert_eq!(
            f.evaluate(&event("issue", "EC2")),
            FilterDecision::DenyCategory
        );
    }

    #[test]
    fn allow_list_restricts_categories() {
        let f = EventFilter::new(&FilterLists {
            allow_categories: &["issue".into(), "securityNotification".into()],
            ..Default::default()
        });
        assert!(f.evaluate(&event("issue", "EC2")).is_allowed());
        assert_eq!(
            f.evaluate(&event("accountNotification", "EC2")),
            FilterDecision::NotInAllowedCategories
        );
    }

    #[test]
    fn service_match_is_case_insensitive() {
        let f = EventFilter::new(&FilterLists {
            allow_services: &["ec2".into()],
            ..Default::default()
        });
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
        let f = EventFilter::new(&FilterLists {
            deny_event_codes: &["VPN/AWS_VPN_REDUNDANCY_LOSS".into()],
            ..Default::default()
        });
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
        let f = EventFilter::new(&FilterLists {
            deny_event_codes: &["VPN/AWS_VPN_REDUNDANCY_LOSS".into()],
            ..Default::default()
        });
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
        let f = EventFilter::new(&FilterLists {
            deny_event_codes: &["vpn/aws_vpn_redundancy_loss".into()],
            ..Default::default()
        });
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
        let f = EventFilter::new(&FilterLists {
            allow_event_codes: &["EC2/AWS_EC2_INSTANCE_RETIREMENT".into()],
            ..Default::default()
        });
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
        let f = EventFilter::new(&FilterLists {
            deny_event_codes: &["VPN/AWS_VPN_REDUNDANCY_LOSS".into()],
            ..Default::default()
        });
        assert!(f.evaluate(&event("issue", "VPN")).is_allowed());
    }

    #[test]
    fn empty_region_lists_allow_every_region() {
        let f = EventFilter::default();
        assert!(
            f.evaluate(&event_in("issue", "EC2", None, Some("eu-central-1")))
                .is_allowed()
        );
        assert!(f.evaluate(&event("issue", "EC2")).is_allowed());
    }

    #[test]
    fn deny_regions_drops_only_listed_regions() {
        let f = EventFilter::new(&FilterLists {
            deny_regions: &["eu-central-1".into()],
            ..Default::default()
        });
        assert_eq!(
            f.evaluate(&event_in("issue", "EC2", None, Some("eu-central-1"))),
            FilterDecision::DenyRegion
        );
        assert!(
            f.evaluate(&event_in("issue", "EC2", None, Some("ap-northeast-2")))
                .is_allowed()
        );
    }

    #[test]
    fn allow_regions_restricts_regions() {
        let f = EventFilter::new(&FilterLists {
            allow_regions: &["ap-northeast-2".into()],
            ..Default::default()
        });
        assert!(
            f.evaluate(&event_in("issue", "EC2", None, Some("ap-northeast-2")))
                .is_allowed()
        );
        assert_eq!(
            f.evaluate(&event_in("issue", "EC2", None, Some("eu-central-1"))),
            FilterDecision::NotInAllowedRegions
        );
    }

    #[test]
    fn deny_region_wins_over_allow_region() {
        let f = EventFilter::new(&FilterLists {
            allow_regions: &["ap-northeast-2".into()],
            deny_regions: &["ap-northeast-2".into()],
            ..Default::default()
        });
        assert_eq!(
            f.evaluate(&event_in("issue", "EC2", None, Some("ap-northeast-2"))),
            FilterDecision::DenyRegion
        );
    }

    #[test]
    fn region_match_is_case_insensitive() {
        let f = EventFilter::new(&FilterLists {
            allow_regions: &["AP-NORTHEAST-2".into()],
            ..Default::default()
        });
        assert!(
            f.evaluate(&event_in("issue", "EC2", None, Some("ap-northeast-2")))
                .is_allowed()
        );
    }

    #[test]
    fn missing_or_empty_region_passes_allow_list() {
        // AWS omitting the field must not cost us a real event.
        let f = EventFilter::new(&FilterLists {
            allow_regions: &["ap-northeast-2".into()],
            ..Default::default()
        });
        assert!(
            f.evaluate(&event_in("issue", "EC2", None, None))
                .is_allowed()
        );
        assert!(
            f.evaluate(&event_in("issue", "EC2", None, Some("")))
                .is_allowed()
        );
    }

    #[test]
    fn global_region_passes_allow_list_that_omits_it() {
        let f = EventFilter::new(&FilterLists {
            allow_regions: &["ap-northeast-2".into()],
            ..Default::default()
        });
        assert!(
            f.evaluate(&event_in("issue", "IAM", None, Some("global")))
                .is_allowed()
        );
    }

    #[test]
    fn global_region_is_deniable() {
        let f = EventFilter::new(&FilterLists {
            allow_regions: &["ap-northeast-2".into()],
            deny_regions: &["global".into()],
            ..Default::default()
        });
        assert_eq!(
            f.evaluate(&event_in("issue", "IAM", None, Some("global"))),
            FilterDecision::DenyRegion
        );
    }

    #[test]
    fn effective_allow_regions_appends_global_only_when_configured() {
        assert!(
            EventFilter::new(&FilterLists::default())
                .effective_allow_regions()
                .is_empty()
        );
        assert_eq!(
            EventFilter::new(&FilterLists {
                allow_regions: &["ap-northeast-2".into()],
                ..Default::default()
            })
            .effective_allow_regions(),
            ["ap-northeast-2", "global"]
        );
        // Listing it explicitly must not duplicate it.
        assert_eq!(
            EventFilter::new(&FilterLists {
                allow_regions: &["ap-northeast-2".into(), "GLOBAL".into()],
                ..Default::default()
            })
            .effective_allow_regions(),
            ["ap-northeast-2", "global"]
        );
    }

    #[test]
    fn region_rule_replaces_a_global_event_code_deny() {
        // The motivating case: Frankfurt Direct Connect noise is dropped on
        // region while a Seoul Direct Connect outage still pages.
        let f = EventFilter::new(&FilterLists {
            allow_regions: &["ap-northeast-2".into()],
            ..Default::default()
        });
        let code = Some("AWS_DIRECTCONNECT_OPERATIONAL_ISSUE");
        assert_eq!(
            f.evaluate(&event_in(
                "issue",
                "DIRECTCONNECT",
                code,
                Some("eu-central-1")
            )),
            FilterDecision::NotInAllowedRegions
        );
        assert!(
            f.evaluate(&event_in(
                "issue",
                "DIRECTCONNECT",
                code,
                Some("ap-northeast-2")
            ))
            .is_allowed()
        );
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
            &FilterLists {
                allow_categories: &["issue".into()],
                deny_categories: &["accountNotification".into()],
                allow_services: &["ec2".into(), "KAFKA".into()],
                deny_services: &["rds".into()],
                allow_regions: &["ap-northeast-2".into()],
                deny_event_codes: &["vpn/aws_vpn_redundancy_loss".into()],
                ..Default::default()
            },
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
            &FilterLists {
                allow_services: &["EC2".into(), "MSK".into(), "KAFKA".into()],
                deny_services: &["BOGUS".into()],
                ..Default::default()
            },
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
        let r = validate_filters(
            &FilterLists {
                allow_categories: &["bogus".into()],
                ..Default::default()
            },
            &cat,
        );
        assert!(!r.is_ok());
        assert_eq!(r.allow_categories.invalid, vec!["bogus"]);
    }

    #[test]
    fn validate_flags_unknown_event_code() {
        let cat = catalogs(&[], &["VPN/AWS_VPN_REDUNDANCY_LOSS"]);
        let r = validate_filters(
            &FilterLists {
                allow_event_codes: &["VPN/AWS_VPN_TYPO".into()],
                deny_event_codes: &["VPN/AWS_VPN_REDUNDANCY_LOSS".into()],
                ..Default::default()
            },
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
            &FilterLists {
                deny_event_codes: &[
                    "AWS_VPN_REDUNDANCY_LOSS".into(),
                    "EC2/AWS_VPN_REDUNDANCY_LOSS".into(),
                ],
                ..Default::default()
            },
            &cat,
        );
        assert!(!r.is_ok());
        assert_eq!(
            r.deny_event_codes.invalid,
            vec!["AWS_VPN_REDUNDANCY_LOSS", "EC2/AWS_VPN_REDUNDANCY_LOSS"]
        );
    }

    #[test]
    fn validate_accepts_region_shapes_and_global() {
        let cat = catalogs(&[], &[]);
        let r = validate_filters(
            &FilterLists {
                allow_regions: &[
                    "ap-northeast-2".into(),
                    "us-gov-east-1".into(),
                    "cn-north-1".into(),
                    "GLOBAL".into(),
                ],
                ..Default::default()
            },
            &cat,
        );
        assert!(r.is_ok(), "expected ok, got {:?}", r.all_invalid());
        assert_eq!(r.allow_regions.valid.len(), 4);
    }

    #[test]
    fn validate_flags_malformed_regions() {
        let cat = catalogs(&[], &[]);
        let r = validate_filters(
            &FilterLists {
                allow_regions: &["ap-northeast2".into(), "ap-northeast-2".into()],
                deny_regions: &["eu_central_1".into()],
                ..Default::default()
            },
            &cat,
        );
        assert!(!r.is_ok());
        assert_eq!(r.allow_regions.valid, vec!["ap-northeast-2"]);
        assert_eq!(r.allow_regions.invalid, vec!["ap-northeast2"]);
        assert_eq!(r.deny_regions.invalid, vec!["eu_central_1"]);
        assert_eq!(
            r.all_invalid(),
            vec![
                "allow_regions 'ap-northeast2'",
                "deny_regions 'eu_central_1'"
            ]
        );
    }

    #[test]
    fn region_shape_rejects_near_misses() {
        assert!(is_region_shaped("ap-northeast-2"));
        assert!(is_region_shaped("us-gov-east-1"));
        assert!(is_region_shaped("global"));
        assert!(!is_region_shaped(""));
        assert!(!is_region_shaped("ap"));
        assert!(!is_region_shaped("ap-2"));
        assert!(!is_region_shaped("apn-northeast-2"));
        assert!(!is_region_shaped("ap-northeast-22"));
        assert!(!is_region_shaped("ap--2"));
        assert!(!is_region_shaped("ap-northeast-x"));
    }

    #[test]
    fn validate_ignores_empty_entries() {
        let cat = catalogs(&["EC2"], &[]);
        let r = validate_filters(
            &FilterLists {
                allow_categories: &[String::new()],
                allow_services: &["  ".into()],
                allow_regions: &["  ".into()],
                allow_event_codes: &["  ".into()],
                ..Default::default()
            },
            &cat,
        );
        assert!(r.is_ok());
        assert!(r.allow_services.valid.is_empty());
        assert!(r.allow_regions.valid.is_empty());
        assert!(r.allow_event_codes.valid.is_empty());
    }
}
