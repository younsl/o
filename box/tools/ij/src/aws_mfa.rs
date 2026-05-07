//! MFA-aware AWS credential resolution.
//!
//! `aws-config` 1.x does not interactively prompt for MFA codes when a profile
//! has `mfa_serial`. When such a profile is selected, this module performs an
//! explicit STS `AssumeRole` with a user-supplied OTP and returns an
//! [`aws_config::SdkConfig`] backed by the resulting temporary credentials.
//!
//! The credentials are cached in-process per profile, so the OTP is only
//! requested once per `ij` invocation.

// `aws_config::profile::profile_file` is the public path the rest of the
// codebase already uses. The crate marks it as a deprecated re-export of
// `aws_runtime::env_config::file`, but `aws-runtime` is not a direct dep.
#[allow(deprecated)]
use aws_config::profile::profile_file::{ProfileFileKind, ProfileFiles};
use aws_config::{BehaviorVersion, Region, SdkConfig};
use aws_credential_types::Credentials;
use aws_credential_types::provider::SharedCredentialsProvider;
use aws_types::os_shim_internal::{Env, Fs};
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};
use tokio::sync::Mutex;
use tracing::debug;

use crate::error::{Error, Result};

const DEFAULT_REGION: &str = "ap-northeast-2";
const MFA_PROVIDER_NAME: &str = "ij-mfa";

static MFA_CACHE: OnceLock<Mutex<HashMap<String, Credentials>>> = OnceLock::new();

fn cache() -> &'static Mutex<HashMap<String, Credentials>> {
    MFA_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Build a [`SdkConfig`] for the given profile.
///
/// If the profile defines `mfa_serial`, the user is prompted for an OTP and
/// `AssumeRole` is invoked with the source profile's credentials. Otherwise,
/// the standard `aws_config` provider chain is used.
pub async fn build_sdk_config(
    profile: Option<&str>,
    aws_config_file: Option<&str>,
) -> Result<SdkConfig> {
    if let Some(p) = profile
        && let Some(info) = detect_mfa_profile(p, aws_config_file).await
    {
        return build_with_mfa(info, aws_config_file).await;
    }

    Ok(default_loader(profile, aws_config_file).load().await)
}

/// Return resolved STS credentials for an MFA-enabled profile, or `None` for
/// profiles that do not declare `mfa_serial`.
///
/// Reuses the same in-process cache as [`build_sdk_config`], so calling this
/// after `build_sdk_config` for the same profile does not re-prompt for an
/// OTP nor issue another `AssumeRole` call.
pub async fn resolve_credentials(
    profile: Option<&str>,
    aws_config_file: Option<&str>,
) -> Result<Option<Credentials>> {
    let Some(p) = profile else {
        return Ok(None);
    };
    let Some(info) = detect_mfa_profile(p, aws_config_file).await else {
        return Ok(None);
    };
    let creds = resolve_mfa_credentials(&info, aws_config_file).await?;
    Ok(Some(creds))
}

fn default_loader(
    profile: Option<&str>,
    aws_config_file: Option<&str>,
) -> aws_config::ConfigLoader {
    let mut loader = aws_config::defaults(BehaviorVersion::latest());
    if let Some(p) = profile {
        loader = loader.profile_name(p);
    }
    if let Some(path) = aws_config_file {
        #[allow(deprecated)]
        let pf = ProfileFiles::builder()
            .with_file(ProfileFileKind::Config, path)
            .include_default_credentials_file(true)
            .build();
        #[allow(deprecated)]
        {
            loader = loader.profile_files(pf);
        }
    }
    loader
}

#[derive(Debug, Clone)]
struct MfaProfile {
    profile_name: String,
    role_arn: String,
    mfa_serial: String,
    source_profile: String,
    region: Option<String>,
    role_session_name: Option<String>,
    duration_seconds: Option<i32>,
    external_id: Option<String>,
}

async fn detect_mfa_profile(profile: &str, aws_config_file: Option<&str>) -> Option<MfaProfile> {
    use aws_config::profile::load;

    #[allow(deprecated)]
    let profile_files = match aws_config_file {
        Some(path) => ProfileFiles::builder()
            .with_file(ProfileFileKind::Config, path)
            .include_default_credentials_file(true)
            .build(),
        // `EnvConfigFiles::default()` includes both `~/.aws/config` and
        // `~/.aws/credentials`. The empty builder panics on `build()`.
        None => ProfileFiles::default(),
    };

    let profile_set = match load(
        &Fs::real(),
        &Env::real(),
        &profile_files,
        Some(profile.to_string().into()),
    )
    .await
    {
        Ok(ps) => ps,
        Err(e) => {
            debug!("Could not parse AWS profiles: {}", e);
            return None;
        }
    };

    let p = profile_set.get_profile(profile)?;
    let mfa_serial = p.get("mfa_serial")?.to_string();
    let role_arn = p.get("role_arn")?.to_string();

    Some(MfaProfile {
        profile_name: profile.to_string(),
        role_arn,
        mfa_serial,
        source_profile: p.get("source_profile").unwrap_or("default").to_string(),
        region: p.get("region").map(str::to_string),
        role_session_name: p.get("role_session_name").map(str::to_string),
        duration_seconds: p.get("duration_seconds").and_then(|s| s.parse().ok()),
        external_id: p.get("external_id").map(str::to_string),
    })
}

async fn build_with_mfa(info: MfaProfile, aws_config_file: Option<&str>) -> Result<SdkConfig> {
    let creds = resolve_mfa_credentials(&info, aws_config_file).await?;
    let region = info
        .region
        .clone()
        .unwrap_or_else(|| DEFAULT_REGION.to_string());

    Ok(aws_config::defaults(BehaviorVersion::latest())
        .credentials_provider(SharedCredentialsProvider::new(creds))
        .region(Region::new(region))
        .load()
        .await)
}

async fn resolve_mfa_credentials(
    info: &MfaProfile,
    aws_config_file: Option<&str>,
) -> Result<Credentials> {
    {
        let guard = cache().lock().await;
        if let Some(creds) = guard.get(&info.profile_name)
            && !is_expired(creds)
        {
            debug!(
                "Reusing cached MFA credentials for profile {}",
                info.profile_name
            );
            return Ok(creds.clone());
        }
    }

    let source_config = default_loader(Some(&info.source_profile), aws_config_file)
        .region(Region::new(
            info.region
                .clone()
                .unwrap_or_else(|| DEFAULT_REGION.to_string()),
        ))
        .load()
        .await;

    let token_code = prompt_mfa_token(&info.mfa_serial, &info.profile_name)?;

    let sts = aws_sdk_sts::Client::new(&source_config);
    let session_name = info
        .role_session_name
        .clone()
        .unwrap_or_else(|| format!("ij-{}", chrono::Utc::now().timestamp()));

    let mut req = sts
        .assume_role()
        .role_arn(&info.role_arn)
        .role_session_name(session_name)
        .serial_number(&info.mfa_serial)
        .token_code(token_code);
    if let Some(d) = info.duration_seconds {
        req = req.duration_seconds(d);
    }
    if let Some(ref ext) = info.external_id {
        req = req.external_id(ext);
    }

    let resp = req.send().await.map_err(|e| {
        Error::Aws(format!(
            "AssumeRole with MFA failed: {}",
            display_sdk_error(e)
        ))
    })?;

    let aws_creds = resp
        .credentials
        .ok_or_else(|| Error::Aws("AssumeRole returned no credentials".into()))?;

    let expiry = SystemTime::UNIX_EPOCH + Duration::from_secs(aws_creds.expiration.secs() as u64);
    let creds = Credentials::new(
        aws_creds.access_key_id,
        aws_creds.secret_access_key,
        Some(aws_creds.session_token),
        Some(expiry),
        MFA_PROVIDER_NAME,
    );

    cache()
        .lock()
        .await
        .insert(info.profile_name.clone(), creds.clone());

    Ok(creds)
}

fn is_expired(creds: &Credentials) -> bool {
    creds
        .expiry()
        .is_some_and(|t| t <= SystemTime::now() + Duration::from_secs(60))
}

fn prompt_mfa_token(serial: &str, profile: &str) -> Result<String> {
    use std::io::IsTerminal;

    if !std::io::stdin().is_terminal() {
        return Err(Error::Aws(format!(
            "MFA required for profile '{profile}' (serial: {serial}), but stdin is not a TTY. Run from an interactive terminal."
        )));
    }

    eprintln!();
    eprintln!("MFA required for AWS profile '{profile}' (serial: {serial})");
    let token = dialoguer::Input::<String>::new()
        .with_prompt("MFA token code")
        .interact_text()
        .map_err(|e| Error::Aws(format!("Failed to read MFA token: {e}")))?;
    Ok(token.trim().to_string())
}

fn display_sdk_error<E: std::fmt::Display + std::error::Error>(e: E) -> String {
    let mut msg = e.to_string();
    let mut src = e.source();
    while let Some(s) = src {
        msg.push_str(": ");
        msg.push_str(&s.to_string());
        src = s.source();
    }
    msg
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_expired_no_expiry() {
        let creds = Credentials::new("ak", "sk", None, None, "test");
        assert!(!is_expired(&creds));
    }

    #[test]
    fn is_expired_future_expiry() {
        let creds = Credentials::new(
            "ak",
            "sk",
            None,
            Some(SystemTime::now() + Duration::from_secs(3600)),
            "test",
        );
        assert!(!is_expired(&creds));
    }

    #[test]
    fn is_expired_past_expiry() {
        let creds = Credentials::new(
            "ak",
            "sk",
            None,
            Some(SystemTime::now() - Duration::from_secs(60)),
            "test",
        );
        assert!(is_expired(&creds));
    }

    #[test]
    fn is_expired_within_skew_window() {
        let creds = Credentials::new(
            "ak",
            "sk",
            None,
            Some(SystemTime::now() + Duration::from_secs(30)),
            "test",
        );
        assert!(is_expired(&creds));
    }
}
