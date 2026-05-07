//! SSM session management with escape sequence support.

use std::process::Command;
use tracing::debug;

use crate::ec2::Instance;
use crate::error::{Error, Result};
use crate::forward::PortForward;

#[cfg(unix)]
mod pty;

/// Pre-resolved STS credentials to inject into the spawned `aws` CLI.
///
/// When present, the credentials are passed via `AWS_*` environment variables
/// and `--profile` is omitted, so the AWS CLI skips its own credential
/// resolution (and any MFA prompt that would imply).
#[derive(Debug, Clone)]
pub struct SessionCredentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: String,
}

/// Session manager for SSM connections.
pub struct SessionManager {
    profile: Option<String>,
    shell_commands: Vec<String>,
    credentials: Option<SessionCredentials>,
}

impl SessionManager {
    /// Create a new session manager.
    pub fn new(profile: Option<String>, shell_commands: Vec<String>) -> Self {
        Self {
            profile,
            shell_commands,
            credentials: None,
        }
    }

    /// Attach pre-resolved STS credentials. When set, the spawned `aws` CLI
    /// receives them via env vars and `--profile` is suppressed.
    pub fn with_credentials(mut self, credentials: SessionCredentials) -> Self {
        self.credentials = Some(credentials);
        self
    }

    fn apply_auth(&self, cmd: &mut Command) {
        if let Some(ref c) = self.credentials {
            cmd.env("AWS_ACCESS_KEY_ID", &c.access_key_id)
                .env("AWS_SECRET_ACCESS_KEY", &c.secret_access_key)
                .env("AWS_SESSION_TOKEN", &c.session_token)
                // The user's shell may export AWS_PROFILE; explicit env-var
                // creds take precedence in the AWS CLI, but removing the
                // profile env avoids any ambiguity.
                .env_remove("AWS_PROFILE");
        } else if let Some(ref profile) = self.profile {
            cmd.args(["--profile", profile]);
        }
    }

    /// Connect to an EC2 instance via SSM.
    pub fn connect(&self, instance: &Instance) -> Result<()> {
        debug!(
            "Connecting to {} in {} via Session Manager",
            instance.instance_id,
            instance.region()
        );

        let mut cmd = Command::new("aws");
        cmd.args([
            "ssm",
            "start-session",
            "--target",
            &instance.instance_id,
            "--region",
            instance.region(),
        ]);

        if !self.shell_commands.is_empty() {
            debug!("Using shell commands: {:?}", self.shell_commands);
            let joined = self.shell_commands.join("; ");
            let params = serde_json::json!({"command": [joined]}).to_string();
            cmd.args([
                "--document-name",
                "AWS-StartInteractiveCommand",
                "--parameters",
                &params,
            ]);
        }

        self.apply_auth(&mut cmd);

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

    /// Start a port forwarding session via SSM.
    pub fn port_forward(&self, instance: &Instance, pf: &PortForward) -> Result<()> {
        debug!(
            "Port forwarding via {} in {}: {}",
            instance.instance_id,
            instance.region(),
            pf.display_info(),
        );

        let mut cmd = Command::new("aws");
        cmd.args([
            "ssm",
            "start-session",
            "--target",
            &instance.instance_id,
            "--region",
            instance.region(),
            "--document-name",
            pf.document_name(),
            "--parameters",
            &pf.parameters_json(),
        ]);

        self.apply_auth(&mut cmd);

        debug!("Executing: {:?}", cmd);

        let status = cmd
            .status()
            .map_err(|e| Error::Session(format!("Failed to execute aws ssm: {}", e)))?;

        if !status.success() {
            return Err(Error::Session(format!(
                "Port forwarding session failed with status: {}",
                status
            )));
        }
        Ok(())
    }
}
