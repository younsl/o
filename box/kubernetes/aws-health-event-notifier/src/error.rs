use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("upstream slack error: {0}")]
    Slack(String),

    #[error("kubernetes event error: {0}")]
    K8s(String),

    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

pub type AppResult<T> = Result<T, AppError>;
