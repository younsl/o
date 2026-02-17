use std::process::Command;

fn main() {
    // Get git commit hash
    // Priority: CI env var > git command > "unknown"
    let commit = std::env::var("GIT_COMMIT").unwrap_or_else(|_| {
        Command::new("git")
            .args(["rev-parse", "--short", "HEAD"])
            .output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    String::from_utf8(o.stdout).ok()
                } else {
                    None
                }
            })
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| "unknown".to_string())
    });

    // Get build date
    // Priority: CI env var > date command > "unknown"
    let date = std::env::var("BUILD_DATE").unwrap_or_else(|_| {
        Command::new("date")
            .args(["+%Y-%m-%d"])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| "unknown".to_string())
    });

    println!("cargo:rustc-env=BUILD_COMMIT={}", commit);
    println!("cargo:rustc-env=BUILD_DATE={}", date);

    // Re-run triggers
    println!("cargo:rerun-if-changed=.git/HEAD");
    println!("cargo:rerun-if-env-changed=GIT_COMMIT");
    println!("cargo:rerun-if-env-changed=BUILD_DATE");
}
