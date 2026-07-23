//! `EKSUpgrade` CRD type definition.

pub mod spec;
pub mod status;
pub mod types;

// Re-export all public types for backward compatibility.
// Some types are only consumed by test modules, but re-exporting keeps
// the public API consistent across `crate::crd::*`.
#[allow(unused_imports)]
pub use spec::{
    EKSUpgrade, EKSUpgradeSpec, KarpenterNodePoolsConfig, KarpenterStrategy, NotificationConfig,
    TimeoutConfig, UpgradeMode,
};
#[allow(unused_imports)]
pub use status::{
    AddonStatus, AwsIdentity, ControlPlaneStatus, CurrentBatchEntry, EKSUpgradeStatus,
    KarpenterNodePoolsStatus, KarpenterPoolStatus, LifecycleStatus, NodeClaimReplacement,
    NodegroupStatus, PhaseStatuses, PlanningStatus, PreflightCheckStatus, PreflightStatus,
    TransitionRecord, UpgradeCondition, VersionLifecycleInfo,
};
pub use types::{ComponentStatus, UpgradePhase};
