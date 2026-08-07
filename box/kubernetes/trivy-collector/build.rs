use vergen_gix::{BuildBuilder, CargoBuilder, Emitter, GixBuilder, RustcBuilder};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let build = BuildBuilder::default().build_timestamp(true).build()?;
    let cargo = CargoBuilder::default().target_triple(true).build()?;
    let git = GixBuilder::default().sha(true).dirty(true).build()?;
    let rustc = RustcBuilder::default()
        .semver(true)
        .channel(true)
        .host_triple(true)
        .llvm_version(true)
        .build()?;

    Emitter::default()
        .add_instructions(&build)?
        .add_instructions(&cargo)?
        .add_instructions(&git)?
        .add_instructions(&rustc)?
        .emit()?;

    Ok(())
}
