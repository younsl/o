.PHONY: build release run dev fmt lint test check clean install

build:
	cargo build

release:
	cargo build --release

run:
	cargo run

dev:
	RUST_LOG=info,vlt=debug cargo run

fmt:
	cargo fmt

lint:
	cargo clippy --all-targets -- -D warnings

test:
	cargo test --verbose

check:
	cargo check

install:
	cargo install --path .

clean:
	cargo clean
