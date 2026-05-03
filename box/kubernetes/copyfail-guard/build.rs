use std::env;
use std::path::Path;

fn main() {
    let git_sha = env::var("VERGEN_GIT_SHA").unwrap_or_else(|_| "unknown".to_string());
    let build_ts =
        env::var("VERGEN_BUILD_TIMESTAMP").unwrap_or_else(|_| chrono::Utc::now().to_rfc3339());

    println!("cargo:rustc-env=GIT_SHA={}", git_sha);
    println!("cargo:rustc-env=BUILD_TIMESTAMP={}", build_ts);

    let ebpf_obj = env::var("COPYFAIL_GUARD_EBPF_OBJ").unwrap_or_else(|_| {
        let manifest = env::var("CARGO_MANIFEST_DIR").unwrap();
        format!(
            "{}/target/bpfel-unknown-none/ebpf/copyfail-guard-ebpf",
            manifest
        )
    });

    // Ensure include_bytes!() in src/loader.rs has something to reference
    // during `cargo check`/`clippy` runs that don't compile the eBPF crate.
    if !Path::new(&ebpf_obj).exists() {
        let out_dir = env::var("OUT_DIR").unwrap();
        let placeholder = format!("{}/copyfail-guard-ebpf.placeholder", out_dir);
        std::fs::write(&placeholder, b"").expect("write placeholder");
        println!("cargo:rustc-env=COPYFAIL_GUARD_EBPF_OBJ={}", placeholder);
    } else {
        println!("cargo:rustc-env=COPYFAIL_GUARD_EBPF_OBJ={}", ebpf_obj);
    }
    println!("cargo:rerun-if-env-changed=COPYFAIL_GUARD_EBPF_OBJ");
    println!("cargo:rerun-if-changed=build.rs");
}
