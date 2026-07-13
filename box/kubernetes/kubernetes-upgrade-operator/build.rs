use std::process::Command;

fn main() {
    // Get git commit hash
    let commit = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map_or_else(|| "unknown".to_string(), |s| s.trim().to_string());

    // Get build date
    let date = Command::new("date")
        .args(["+%Y-%m-%d"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map_or_else(|| "unknown".to_string(), |s| s.trim().to_string());

    // Get rustc version (e.g. "1.96.0" from "rustc 1.96.0 (abc123 2026-01-01)")
    let rustc = std::env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());
    let rustc_version = Command::new(rustc)
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.split_whitespace().nth(1).map(str::to_string))
        .unwrap_or_else(|| "unknown".to_string());

    // Target architecture (e.g. "x86_64", "aarch64"); set by cargo for build scripts
    let arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_else(|_| "unknown".to_string());

    println!("cargo:rustc-env=BUILD_COMMIT={commit}");
    println!("cargo:rustc-env=BUILD_DATE={date}");
    println!("cargo:rustc-env=BUILD_RUSTC_VERSION={rustc_version}");
    println!("cargo:rustc-env=BUILD_ARCH={arch}");

    // Rerun if git HEAD changes
    println!("cargo:rerun-if-changed=.git/HEAD");
}
