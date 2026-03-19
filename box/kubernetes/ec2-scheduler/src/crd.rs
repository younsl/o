//! `EC2Schedule` CRD type definition.

pub mod spec;
pub mod status;
pub mod types;

// Re-export all public types.
#[allow(unused_imports)]
pub use spec::{EC2Schedule, EC2ScheduleSpec, InstanceSelector, ScheduleEntry};
#[allow(unused_imports)]
pub use status::{EC2ScheduleStatus, ManagedInstance, ScheduleCondition};
pub use types::{ScheduleAction, SchedulePhase};
