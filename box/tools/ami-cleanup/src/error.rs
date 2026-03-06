use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {
    #[error("EC2 error: {0}")]
    Ec2(String),

    #[error("AutoScaling error: {0}")]
    AutoScaling(String),
}
