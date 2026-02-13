//! Output formatting module.

pub mod report;
pub mod table;

pub use report::{PhaseStatus, PhaseTiming, ReportData, generate_report, save_report};
pub use table::*;
