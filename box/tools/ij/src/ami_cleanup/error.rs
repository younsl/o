use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {
    #[error("EC2 error: {0}")]
    Ec2(String),

    #[error("AutoScaling error: {0}")]
    AutoScaling(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ec2_error_display() {
        let err = AppError::Ec2("access denied".into());
        assert_eq!(err.to_string(), "EC2 error: access denied");
    }

    #[test]
    fn test_autoscaling_error_display() {
        let err = AppError::AutoScaling("throttled".into());
        assert_eq!(err.to_string(), "AutoScaling error: throttled");
    }
}
