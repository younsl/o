use std::process::Command;

fn main() {
    // Get git commit hash
    // Priority: CI env var > git command > "unknown"
    let git_commit = std::env::var("GIT_COMMIT").unwrap_or_else(|_| {
        Command::new("git")
            .args(["rev-parse", "--short", "HEAD"])
            .output()
            .ok()
            .and_then(|output| {
                if output.status.success() {
                    String::from_utf8(output.stdout).ok()
                } else {
                    None
                }
            })
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| "unknown".to_string())
    });

    // Get build date
    // Priority: CI env var > current timestamp
    let build_date =
        std::env::var("BUILD_DATE").unwrap_or_else(|_| chrono::Utc::now().to_rfc3339());

    // Get Rust version
    let rustc_version = rustc_version::version()
        .map(|v| v.to_string())
        .unwrap_or_else(|_| "unknown".to_string());

    // Set environment variables for compilation
    for (key, value) in [
        ("GIT_COMMIT", git_commit.as_str()),
        ("BUILD_DATE", build_date.as_str()),
        ("RUSTC_VERSION", rustc_version.as_str()),
    ] {
        println!("cargo:rustc-env={}={}", key, value);
    }

    // Re-run triggers
    for trigger in [
        "cargo:rerun-if-changed=.git/HEAD",
        "cargo:rerun-if-env-changed=GIT_COMMIT",
        "cargo:rerun-if-env-changed=BUILD_DATE",
    ] {
        println!("{}", trigger);
    }
}
