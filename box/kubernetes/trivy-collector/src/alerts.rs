//! Alert rules: Alertmanager-style schema, ConfigMap-backed storage,
//! Slack webhook delivery.

pub mod evaluator;
pub mod expr;
pub mod notifier;
pub mod preview;
pub mod store;
pub mod types;

pub use evaluator::AlertEvaluator;
pub use store::{AlertStore, AlertStoreError};
pub use types::{AlertRule, Matchers, Receiver, SlackReceiver};
