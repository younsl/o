use vergen_gix::{BuildBuilder, Emitter, GixBuilder, RustcBuilder};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Rerun when the override env var changes (Docker builds without .git in
    // the context pass the SHA via --build-arg → ENV VERGEN_GIT_SHA=...).
    println!("cargo:rerun-if-env-changed=VERGEN_GIT_SHA");

    let mut emitter = Emitter::default();

    emitter.add_instructions(&BuildBuilder::default().build_date(true).build()?)?;
    emitter.add_instructions(&RustcBuilder::default().semver(true).build()?)?;

    // Try gix; if no .git is reachable (e.g. inside a Docker builder stage),
    // fall back to the SHA passed in via env. Last resort: "unknown".
    if let Ok(git) = GixBuilder::default().sha(true).dirty(true).build() {
        emitter.add_instructions(&git)?;
    } else {
        let sha = std::env::var("VERGEN_GIT_SHA").unwrap_or_else(|_| "unknown".into());
        println!("cargo:rustc-env=VERGEN_GIT_SHA={sha}");
        println!("cargo:rustc-env=VERGEN_GIT_DIRTY=unknown");
    }

    emitter.emit()?;
    Ok(())
}
