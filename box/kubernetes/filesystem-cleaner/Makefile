.PHONY: help all build release run dev test fmt lint check deps clean coverage build-all docker-build docker-push install uninstall

BINARY_NAME := filesystem-cleaner
IMAGE_NAME := filesystem-cleaner
VERSION := $(shell grep '^version' Cargo.toml | sed 's/version = "\(.*\)"/\1/')
GIT_COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
PLATFORMS := linux/amd64,linux/arm64
ECR_REGISTRY := your-account.dkr.ecr.us-east-1.amazonaws.com

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

all: fmt lint test build ## Run fmt, lint, test, and build

build: ## Build debug binary
	cargo build

release: ## Build optimized release binary
	cargo build --release --locked --bin $(BINARY_NAME)

run: build ## Build and run with default settings
	target/debug/$(BINARY_NAME) --dry-run --usage-threshold-percent 70 --target-paths /tmp

dev: build ## Run with debug logging
	target/debug/$(BINARY_NAME) --log-level debug --dry-run --usage-threshold-percent 70 --target-paths /tmp

test: ## Run tests
	cargo test --verbose

fmt: ## Format code
	cargo fmt

lint: ## Run clippy
	cargo clippy -- -D warnings

check: ## Check code without building
	cargo check

deps: ## Update dependencies
	cargo update

clean: ## Remove build artifacts
	cargo clean

coverage: ## Run tests with llvm-cov coverage report
	cargo llvm-cov --text

build-all: ## Build for all Linux platforms (requires cargo-zigbuild)
	cargo zigbuild --release --target x86_64-unknown-linux-musl --bin $(BINARY_NAME)
	cargo zigbuild --release --target aarch64-unknown-linux-musl --bin $(BINARY_NAME)

docker-build: ## Build Docker image (cross-compiles for Linux with cargo-zigbuild)
	@ARCH=$$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/'); \
	if [ "$$ARCH" = "amd64" ]; then TARGET=x86_64-unknown-linux-musl; else TARGET=aarch64-unknown-linux-musl; fi; \
	echo "Building for $$TARGET with cargo-zigbuild..."; \
	cargo zigbuild --release --target $$TARGET --bin $(BINARY_NAME); \
	cp target/$$TARGET/release/$(BINARY_NAME) $(BINARY_NAME)-linux-$$ARCH; \
	docker build -t $(IMAGE_NAME):$(VERSION) -t $(IMAGE_NAME):latest .; \
	rm -f $(BINARY_NAME)-linux-$$ARCH

docker-push: ## Push to registry
	docker tag $(IMAGE_NAME):$(VERSION) $(ECR_REGISTRY)/$(IMAGE_NAME):$(VERSION)
	docker tag $(IMAGE_NAME):latest $(ECR_REGISTRY)/$(IMAGE_NAME):latest
	docker push $(ECR_REGISTRY)/$(IMAGE_NAME):$(VERSION)
	docker push $(ECR_REGISTRY)/$(IMAGE_NAME):latest

install: release ## Install to ~/.cargo/bin/
	cargo install --path . --locked

uninstall: ## Uninstall from ~/.cargo/bin/
	cargo uninstall $(BINARY_NAME)
