//! Resolves the AWS account id and (best-effort) account alias.
//!
//! Both are looked up once at start-up and cached for the lifetime of the
//! process. Failures are non-fatal — Slack messages are still sent, just
//! without the alias.

use tracing::warn;

#[derive(Debug, Clone, Default)]
pub struct AccountIdentity {
    pub account_id: Option<String>,
    pub alias: Option<String>,
}

impl AccountIdentity {
    pub async fn resolve() -> Self {
        let cfg = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .load()
            .await;

        let account_id = match aws_sdk_sts::Client::new(&cfg)
            .get_caller_identity()
            .send()
            .await
        {
            Ok(out) => out.account,
            Err(e) => {
                warn!(error = %e, "failed to resolve account id via STS");
                None
            }
        };

        let alias = match aws_sdk_iam::Client::new(&cfg)
            .list_account_aliases()
            .send()
            .await
        {
            Ok(out) => out.account_aliases.into_iter().next(),
            Err(e) => {
                warn!(error = %e, "failed to resolve account alias via IAM (alias display disabled)");
                None
            }
        };

        Self { account_id, alias }
    }

    /// "alias (id)" if both known, else id, alias, or None.
    pub fn display(&self) -> Option<String> {
        match (self.alias.as_deref(), self.account_id.as_deref()) {
            (Some(a), Some(i)) => Some(format!("{a} ({i})")),
            (Some(a), None) => Some(a.to_string()),
            (None, Some(i)) => Some(i.to_string()),
            (None, None) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(alias: Option<&str>, account: Option<&str>) -> AccountIdentity {
        AccountIdentity {
            account_id: account.map(str::to_string),
            alias: alias.map(str::to_string),
        }
    }

    #[test]
    fn display_variants() {
        assert_eq!(
            id(Some("prod"), Some("123")).display().as_deref(),
            Some("prod (123)")
        );
        assert_eq!(id(Some("prod"), None).display().as_deref(), Some("prod"));
        assert_eq!(id(None, Some("123")).display().as_deref(), Some("123"));
        assert_eq!(id(None, None).display(), None);
    }
}
