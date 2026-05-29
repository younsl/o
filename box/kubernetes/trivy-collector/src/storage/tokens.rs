//! API token CRUD operations

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use sqlx::Row;
use tracing::debug;

use super::database::Database;
use super::models::TokenInfo;

impl Database {
    /// Create a new API token for the given user.
    /// `expires_days` must be one of 1, 7, 30, 90, 180, 365.
    /// Returns (plaintext_token, TokenInfo).
    pub async fn create_token(
        &self,
        user_sub: &str,
        name: &str,
        description: &str,
        expires_days: u32,
    ) -> Result<(String, TokenInfo)> {
        let token_plaintext = generate_token();
        let token_hash = hash_token(&token_plaintext);
        let token_prefix = token_plaintext[..11].to_string(); // "tc_" + 8 hex chars
        let now = chrono::Utc::now();
        let created_at = now.to_rfc3339();

        let expires_at = now
            .checked_add_signed(chrono::Duration::days(i64::from(expires_days)))
            .unwrap_or(now)
            .to_rfc3339();

        let result = sqlx::query(
            "INSERT INTO api_tokens (user_sub, name, description, token_hash, token_prefix, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(user_sub)
        .bind(name)
        .bind(description)
        .bind(&token_hash)
        .bind(&token_prefix)
        .bind(&created_at)
        .bind(&expires_at)
        .execute(&self.pool)
        .await
        .context("Failed to insert API token")?;

        let id = result.last_insert_rowid();

        debug!(token_id = id, user_sub = %user_sub, name = %name, expires_days = expires_days, "API token created");

        Ok((
            token_plaintext,
            TokenInfo {
                id,
                name: name.to_string(),
                description: description.to_string(),
                token_prefix,
                created_at,
                expires_at,
                last_used_at: None,
            },
        ))
    }

    /// List all tokens for the given user (hashes are not included).
    pub async fn list_tokens(&self, user_sub: &str) -> Result<Vec<TokenInfo>> {
        let rows = sqlx::query(
            "SELECT id, name, description, token_prefix, created_at, expires_at, last_used_at FROM api_tokens WHERE user_sub = $1 ORDER BY created_at DESC",
        )
        .bind(user_sub)
        .fetch_all(&self.pool)
        .await
        .context("Failed to execute list_tokens query")?;

        let tokens = rows
            .iter()
            .map(|row| TokenInfo {
                id: row.get::<i64, _>(0),
                name: row.get::<String, _>(1),
                description: row.get::<String, _>(2),
                token_prefix: row.get::<String, _>(3),
                created_at: row.get::<String, _>(4),
                expires_at: row.get::<String, _>(5),
                last_used_at: row.get::<Option<String>, _>(6),
            })
            .collect();

        Ok(tokens)
    }

    /// Delete a token by ID, only if it belongs to the given user.
    /// Returns true if a row was deleted.
    pub async fn delete_token(&self, user_sub: &str, token_id: i64) -> Result<bool> {
        let result = sqlx::query("DELETE FROM api_tokens WHERE id = $1 AND user_sub = $2")
            .bind(token_id)
            .bind(user_sub)
            .execute(&self.pool)
            .await
            .context("Failed to delete API token")?;

        let rows = result.rows_affected();

        if rows > 0 {
            debug!(token_id = token_id, user_sub = %user_sub, "API token deleted");
        }

        Ok(rows > 0)
    }

    /// Validate a plaintext token. Returns the user_sub if valid (and not expired),
    /// and updates last_used_at.
    pub async fn validate_token(&self, token_plaintext: &str) -> Result<Option<String>> {
        let token_hash = hash_token(token_plaintext);

        let result: Option<(i64, String, String)> =
            sqlx::query("SELECT id, user_sub, expires_at FROM api_tokens WHERE token_hash = $1")
                .bind(&token_hash)
                .fetch_optional(&self.pool)
                .await?
                .map(|row| {
                    (
                        row.get::<i64, _>(0),
                        row.get::<String, _>(1),
                        row.get::<String, _>(2),
                    )
                });

        if let Some((id, user_sub, expires_at)) = result {
            // Check expiration
            if let Ok(exp) = chrono::DateTime::parse_from_rfc3339(&expires_at)
                && chrono::Utc::now() >= exp
            {
                debug!(token_id = id, "API token expired");
                return Ok(None);
            }

            let now = chrono::Utc::now().to_rfc3339();
            let _ = sqlx::query("UPDATE api_tokens SET last_used_at = $1 WHERE id = $2")
                .bind(&now)
                .bind(id)
                .execute(&self.pool)
                .await;
            debug!(token_id = id, user_sub = %user_sub, "API token validated");
            Ok(Some(user_sub))
        } else {
            Ok(None)
        }
    }
}

/// Generate a random API token with "tc_" prefix + 32 random bytes as hex (67 chars total).
fn generate_token() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let mut bytes = [0u8; 32];
    rng.fill(&mut bytes);
    format!("tc_{}", hex::encode(bytes))
}

/// SHA-256 hash a token and return hex string.
fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_token_format() {
        let token = generate_token();
        assert!(token.starts_with("tc_"));
        assert_eq!(token.len(), 67); // "tc_" (3) + 64 hex chars
    }

    #[test]
    fn test_hash_token_deterministic() {
        let hash1 = hash_token("tc_abc123");
        let hash2 = hash_token("tc_abc123");
        assert_eq!(hash1, hash2);
    }

    #[test]
    fn test_hash_token_different_inputs() {
        let hash1 = hash_token("tc_abc123");
        let hash2 = hash_token("tc_def456");
        assert_ne!(hash1, hash2);
    }

    #[tokio::test]
    async fn test_create_and_list_tokens() {
        let db = Database::new(":memory:")
            .await
            .expect("Failed to create database");

        let (plaintext, info) = db
            .create_token("user-1", "my-token", "", 30)
            .await
            .expect("Failed to create token");

        assert!(plaintext.starts_with("tc_"));
        assert_eq!(info.name, "my-token");
        assert!(plaintext.starts_with(&info.token_prefix));
        assert!(!info.expires_at.is_empty());

        let tokens = db
            .list_tokens("user-1")
            .await
            .expect("Failed to list tokens");
        assert_eq!(tokens.len(), 1);
        assert_eq!(tokens[0].name, "my-token");
        assert!(!tokens[0].expires_at.is_empty());
    }

    #[tokio::test]
    async fn test_validate_token() {
        let db = Database::new(":memory:")
            .await
            .expect("Failed to create database");

        let (plaintext, _) = db
            .create_token("user-1", "my-token", "test desc", 365)
            .await
            .expect("Failed to create token");

        let result = db
            .validate_token(&plaintext)
            .await
            .expect("Failed to validate token");
        assert_eq!(result, Some("user-1".to_string()));

        let result = db
            .validate_token("tc_invalidtoken")
            .await
            .expect("Failed to validate token");
        assert_eq!(result, None);
    }

    #[tokio::test]
    async fn test_delete_token() {
        let db = Database::new(":memory:")
            .await
            .expect("Failed to create database");

        let (_, info) = db
            .create_token("user-1", "my-token", "", 7)
            .await
            .expect("Failed to create token");

        // Wrong user cannot delete
        let deleted = db
            .delete_token("user-2", info.id)
            .await
            .expect("Failed to delete token");
        assert!(!deleted);

        // Correct user can delete
        let deleted = db
            .delete_token("user-1", info.id)
            .await
            .expect("Failed to delete token");
        assert!(deleted);

        let tokens = db
            .list_tokens("user-1")
            .await
            .expect("Failed to list tokens");
        assert!(tokens.is_empty());
    }

    #[tokio::test]
    async fn test_duplicate_token_name_fails() {
        let db = Database::new(":memory:")
            .await
            .expect("Failed to create database");

        db.create_token("user-1", "my-token", "", 30)
            .await
            .expect("Failed to create token");

        let result = db.create_token("user-1", "my-token", "", 90).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_same_name_different_users() {
        let db = Database::new(":memory:")
            .await
            .expect("Failed to create database");

        db.create_token("user-1", "ci-token", "", 30)
            .await
            .expect("Failed to create token");
        db.create_token("user-2", "ci-token", "", 30)
            .await
            .expect("Failed to create token");

        let tokens1 = db
            .list_tokens("user-1")
            .await
            .expect("Failed to list tokens");
        let tokens2 = db
            .list_tokens("user-2")
            .await
            .expect("Failed to list tokens");
        assert_eq!(tokens1.len(), 1);
        assert_eq!(tokens2.len(), 1);
    }
}
