//! Domain types for an AWS Health event, populated from the Health API.

#[derive(Debug, Clone)]
pub struct HealthEvent {
    pub account: Option<String>,
    pub region: Option<String>,
    pub detail: HealthDetail,
}

#[derive(Debug, Clone)]
pub struct HealthDetail {
    pub event_arn: Option<String>,
    pub service: Option<String>,
    pub event_type_code: Option<String>,
    pub event_type_category: Option<String>,
    pub start_time: Option<String>,
    pub end_time: Option<String>,
    pub last_updated_time: Option<String>,
    pub status_code: Option<String>,
    pub event_description: Vec<EventDescription>,
    pub affected_entities: Vec<AffectedEntity>,
}

#[derive(Debug, Clone)]
pub struct EventDescription {
    pub language: Option<String>,
    pub latest_description: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AffectedEntity {
    pub entity_value: Option<String>,
    pub status: Option<String>,
}

impl HealthDetail {
    /// Best-effort English description; falls back to the first available language.
    pub fn description(&self) -> Option<&str> {
        self.event_description
            .iter()
            .find(|d| matches!(d.language.as_deref(), Some("en")))
            .or_else(|| self.event_description.first())
            .and_then(|d| d.latest_description.as_deref())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn detail(descs: Vec<EventDescription>) -> HealthDetail {
        HealthDetail {
            event_arn: None,
            service: None,
            event_type_code: None,
            event_type_category: None,
            start_time: None,
            end_time: None,
            last_updated_time: None,
            status_code: None,
            event_description: descs,
            affected_entities: vec![],
        }
    }

    #[test]
    fn description_prefers_english() {
        let d = detail(vec![
            EventDescription {
                language: Some("ja".into()),
                latest_description: Some("日本語".into()),
            },
            EventDescription {
                language: Some("en".into()),
                latest_description: Some("english".into()),
            },
        ]);
        assert_eq!(d.description(), Some("english"));
    }

    #[test]
    fn description_falls_back_to_first() {
        let d = detail(vec![EventDescription {
            language: Some("ja".into()),
            latest_description: Some("日本語".into()),
        }]);
        assert_eq!(d.description(), Some("日本語"));
    }

    #[test]
    fn description_none_when_empty() {
        assert_eq!(detail(vec![]).description(), None);
    }
}
