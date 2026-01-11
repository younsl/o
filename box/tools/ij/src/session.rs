//! SSM session management with escape sequence support.

use std::process::Command;
use tracing::debug;

use crate::ec2::Instance;
use crate::error::{Error, Result};

#[cfg(unix)]
mod pty;

/// Session manager for SSM connections.
pub struct SessionManager {
    profile: Option<String>,
}

impl SessionManager {
    /// Create a new session manager.
    pub fn new(profile: Option<String>) -> Self {
        Self { profile }
    }

    /// Connect to an EC2 instance via SSM.
    pub fn connect(&self, instance: &Instance) -> Result<()> {
        debug!(
            "Connecting to {} in {} via Session Manager",
            instance.instance_id, instance.region
        );

        let mut cmd = Command::new("aws");
        cmd.args([
            "ssm",
            "start-session",
            "--target",
            &instance.instance_id,
            "--region",
            &instance.region,
        ]);

        if let Some(ref profile) = self.profile {
            cmd.args(["--profile", profile]);
        }

        debug!("Executing: {:?}", cmd);

        #[cfg(unix)]
        {
            pty::connect_with_pty(cmd).map_err(|e| Error::Session(e.to_string()))
        }

        #[cfg(not(unix))]
        {
            let status = cmd
                .status()
                .map_err(|e| Error::Session(format!("Failed to execute aws ssm: {}", e)))?;

            if !status.success() {
                return Err(Error::Session(format!(
                    "Session Manager connection failed with status: {}",
                    status
                )));
            }
            Ok(())
        }
    }
}
