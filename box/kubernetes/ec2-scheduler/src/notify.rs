//! Notification module for EC2 schedule action events.

pub mod slack;

pub use slack::{SlackMessage, SlackNotifier};

use crate::crd::{ManagedInstance, ScheduleAction};

/// Build a Slack message for a successful start/stop action.
pub fn build_action_message(
    resource_name: &str,
    action: &ScheduleAction,
    region: &str,
    instances: &[ManagedInstance],
) -> SlackMessage {
    let display_names = instances
        .iter()
        .map(ManagedInstance::display_name)
        .collect::<Vec<_>>()
        .join(", ");

    let header = match action {
        ScheduleAction::Start => "EC2 Instances Started".to_string(),
        ScheduleAction::Stop => "EC2 Instances Stopped".to_string(),
    };

    SlackMessage {
        header,
        fields: vec![
            ("Action".to_string(), action.to_string()),
            ("Region".to_string(), region.to_string()),
            (
                "Instances".to_string(),
                format!("{} — {display_names}", instances.len()),
            ),
        ],
        context: format!("Sent by ec2-scheduler via EC2Schedule/{resource_name}"),
    }
}

/// Build a Slack message for a failed start/stop action.
pub fn build_failed_message(
    resource_name: &str,
    action: &ScheduleAction,
    region: &str,
    instances: &[ManagedInstance],
    error: &str,
) -> SlackMessage {
    let display_names = instances
        .iter()
        .map(ManagedInstance::display_name)
        .collect::<Vec<_>>()
        .join(", ");

    let header = match action {
        ScheduleAction::Start => "EC2 Start Failed".to_string(),
        ScheduleAction::Stop => "EC2 Stop Failed".to_string(),
    };

    SlackMessage {
        header,
        fields: vec![
            ("Action".to_string(), action.to_string()),
            ("Region".to_string(), region.to_string()),
            (
                "Instances".to_string(),
                format!("{} — {display_names}", instances.len()),
            ),
            ("Error".to_string(), error.to_string()),
        ],
        context: format!("Sent by ec2-scheduler via EC2Schedule/{resource_name}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_instances() -> Vec<ManagedInstance> {
        vec![
            ManagedInstance {
                instance_id: "i-abc".to_string(),
                name: Some("web-server".to_string()),
                state: "running".to_string(),
                last_transition_time: None,
            },
            ManagedInstance {
                instance_id: "i-def".to_string(),
                name: None,
                state: "stopped".to_string(),
                last_transition_time: None,
            },
        ]
    }

    #[test]
    fn test_build_action_message_start() {
        let instances = make_instances();
        let msg = build_action_message(
            "dev-instances",
            &ScheduleAction::Start,
            "ap-northeast-2",
            &instances,
        );
        assert_eq!(msg.header, "EC2 Instances Started");
        assert!(
            msg.fields
                .iter()
                .any(|(k, v)| k == "Action" && v == "Start")
        );
        assert!(
            msg.fields
                .iter()
                .any(|(k, v)| k == "Region" && v == "ap-northeast-2")
        );
        assert!(msg.fields.iter().any(|(k, v)| k == "Instances"
            && v.contains("web-server/i-abc")
            && v.contains("i-def")));
        assert!(msg.context.contains("EC2Schedule/dev-instances"));
    }

    #[test]
    fn test_build_action_message_stop() {
        let instances = make_instances();
        let msg = build_action_message(
            "dev-instances",
            &ScheduleAction::Stop,
            "ap-northeast-2",
            &instances,
        );
        assert_eq!(msg.header, "EC2 Instances Stopped");
        assert!(msg.fields.iter().any(|(k, v)| k == "Action" && v == "Stop"));
    }

    #[test]
    fn test_build_failed_message() {
        let instances = make_instances();
        let msg = build_failed_message(
            "dev-instances",
            &ScheduleAction::Stop,
            "ap-northeast-2",
            &instances,
            "AccessDenied",
        );
        assert_eq!(msg.header, "EC2 Stop Failed");
        assert!(
            msg.fields
                .iter()
                .any(|(k, v)| k == "Error" && v == "AccessDenied")
        );
        assert!(msg.context.contains("EC2Schedule/dev-instances"));
    }

    #[test]
    fn test_build_failed_message_start() {
        let msg = build_failed_message(
            "test",
            &ScheduleAction::Start,
            "us-east-1",
            &[],
            "Throttling",
        );
        assert_eq!(msg.header, "EC2 Start Failed");
    }

    #[test]
    fn test_build_action_message_empty_instances() {
        let msg = build_action_message("test", &ScheduleAction::Start, "us-east-1", &[]);
        assert!(msg
            .fields
            .iter()
            .any(|(k, v)| k == "Instances" && v.starts_with("0")));
    }

    #[test]
    fn test_build_action_message_single_instance() {
        let instances = vec![ManagedInstance {
            instance_id: "i-abc".to_string(),
            name: Some("web".to_string()),
            state: "running".to_string(),
            last_transition_time: None,
        }];
        let msg = build_action_message("test", &ScheduleAction::Stop, "us-east-1", &instances);
        assert!(msg
            .fields
            .iter()
            .any(|(k, v)| k == "Instances" && v.contains("1 — web/i-abc")));
    }

    #[test]
    fn test_build_action_message_all_without_name_tag() {
        let instances = vec![
            ManagedInstance {
                instance_id: "i-aaa".to_string(),
                name: None,
                state: "running".to_string(),
                last_transition_time: None,
            },
            ManagedInstance {
                instance_id: "i-bbb".to_string(),
                name: None,
                state: "running".to_string(),
                last_transition_time: None,
            },
        ];
        let msg =
            build_action_message("test", &ScheduleAction::Start, "us-east-1", &instances);
        let inst_field = msg
            .fields
            .iter()
            .find(|(k, _)| k == "Instances")
            .unwrap();
        assert!(inst_field.1.contains("i-aaa"));
        assert!(inst_field.1.contains("i-bbb"));
        assert!(!inst_field.1.contains('/'));
    }
}
