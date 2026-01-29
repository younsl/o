.PHONY: build release run dev test fmt lint clean install install-local help deps

# Binary name
BINARY_NAME := ekup

# Setup Rust toolchain path
RUSTUP := $(shell command -v rustup 2>/dev/null || echo "/opt/homebrew/bin/rustup")
TOOLCHAIN_PATH := $(shell $(RUSTUP) which cargo 2>/dev/null | xargs dirname 2>/dev/null)

# Default target
.DEFAULT_GOAL := help

## Build debug binary
build:
	@echo "Building $(BINARY_NAME) (debug)..."
	@PATH="$(TOOLCHAIN_PATH):$$PATH" cargo build

## Build optimized release binary
release:
	@echo "Building $(BINARY_NAME) (release)..."
	@PATH="$(TOOLCHAIN_PATH):$$PATH" cargo build --release

## Build and run in interactive mode
run:
	@echo "Running ekup in interactive mode..."
	@PATH="$(TOOLCHAIN_PATH):$$PATH" cargo run

## Run with debug logging
dev:
	@echo "Running ekup with debug logging..."
	@PATH="$(TOOLCHAIN_PATH):$$PATH" cargo run -- --log-level debug

## Run tests
test:
	@echo "Running tests..."
	@PATH="$(TOOLCHAIN_PATH):$$PATH" cargo test --verbose

## Format code
fmt:
	@echo "Formatting code..."
	@PATH="$(TOOLCHAIN_PATH):$$PATH" cargo fmt

## Run clippy linter
lint:
	@echo "Running clippy..."
	@PATH="$(TOOLCHAIN_PATH):$$PATH" cargo clippy -- -D warnings

## Check code without building
check:
	@echo "Checking code..."
	@PATH="$(TOOLCHAIN_PATH):$$PATH" cargo check

## Update dependencies
deps:
	@echo "Updating dependencies..."
	@PATH="$(TOOLCHAIN_PATH):$$PATH" cargo update

## Clean build artifacts
clean:
	@echo "Cleaning build artifacts..."
	@PATH="$(TOOLCHAIN_PATH):$$PATH" cargo clean

## Install to ~/.cargo/bin/
install:
	@echo "Installing $(BINARY_NAME)..."
	@PATH="$(TOOLCHAIN_PATH):$$PATH" cargo install --path .

## Build release and install to /usr/local/bin/
install-local: release
	@echo "Installing $(BINARY_NAME) to /usr/local/bin/..."
	@sudo cp target/release/$(BINARY_NAME) /usr/local/bin/
	@echo "Installed $(BINARY_NAME) to /usr/local/bin/$(BINARY_NAME)"

## Show this help message
help:
	@echo "Available targets:"
	@echo ""
	@grep -E '^##' $(MAKEFILE_LIST) | sed 's/## /  /' | column -t -s ':'
