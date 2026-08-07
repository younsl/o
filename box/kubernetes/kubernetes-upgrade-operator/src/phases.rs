//! Upgrade phase implementations.
//!
//! Each phase reads the current status and advances one step per reconcile.

pub mod addons;
pub mod control_plane;
pub mod karpenter;
pub mod nodegroups;
pub mod planning;
pub mod preflight;
pub mod transition;
