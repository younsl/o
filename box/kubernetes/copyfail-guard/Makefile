.PHONY: help all build release run dev test fmt lint check deps clean coverage build-all docker-build docker-push install uninstall ebpf ebpf-clean ebpf-lint

BINARY_NAME := copyfail-guard
IMAGE_NAME := copyfail-guard
VERSION := $(shell grep '^version' Cargo.toml | head -n1 | sed 's/.*"\(.*\)".*/\1/')
GIT_COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
PLATFORMS := linux/amd64,linux/arm64
ECR_REGISTRY := your-account.dkr.ecr.us-east-1.amazonaws.com

EBPF_OBJ := $(CURDIR)/target/bpfel-unknown-none/ebpf/copyfail-guard-ebpf
EBPF_BUILD := cargo +nightly build --bin copyfail-guard-ebpf --target bpfel-unknown-none -Z build-std=core --features build-ebpf --profile ebpf

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

all: fmt lint test build ## Run fmt, lint, test, and build

ebpf: ## Build the eBPF object (nightly + bpfel-unknown-none)
	$(EBPF_BUILD)

ebpf-clean: ## Remove eBPF build artifacts only
	rm -rf target/bpfel-unknown-none

ebpf-lint: ## Run clippy on the eBPF bin
	cargo +nightly clippy --bin copyfail-guard-ebpf --target bpfel-unknown-none -Z build-std=core --features build-ebpf --profile ebpf -- -D warnings

build: ebpf ## Build debug userspace binary
	COPYFAIL_GUARD_EBPF_OBJ=$(EBPF_OBJ) cargo build --bin $(BINARY_NAME)

release: ebpf ## Build optimized release userspace binary
	COPYFAIL_GUARD_EBPF_OBJ=$(EBPF_OBJ) cargo build --release --locked --bin $(BINARY_NAME)

run: build ## Build and run with debug logging
	sudo ./target/debug/$(BINARY_NAME) --log-format pretty --log-level debug

dev: build ## Run with verbose tracing
	sudo RUST_LOG=debug ./target/debug/$(BINARY_NAME) --log-format pretty --log-level debug

test: ## Run userspace tests
	cargo test --bin $(BINARY_NAME) --verbose

fmt: ## Format code
	cargo fmt

lint: ## Run clippy on the userspace bin
	cargo clippy --bin $(BINARY_NAME) -- -D warnings

check: ## Check userspace bin without building
	cargo check --bin $(BINARY_NAME)

deps: ## Update dependencies
	cargo update

clean: ## Remove all build artifacts
	cargo clean

coverage: ## Run tests with llvm-cov coverage report
	cargo llvm-cov --bin $(BINARY_NAME) --text

build-all: ebpf ## Build for all Linux platforms (requires cargo-zigbuild)
	COPYFAIL_GUARD_EBPF_OBJ=$(EBPF_OBJ) cargo zigbuild --release --target x86_64-unknown-linux-musl --bin $(BINARY_NAME)
	COPYFAIL_GUARD_EBPF_OBJ=$(EBPF_OBJ) cargo zigbuild --release --target aarch64-unknown-linux-musl --bin $(BINARY_NAME)

docker-build: ebpf ## Build Docker image (cross-compiles for Linux with cargo-zigbuild)
	@ARCH=$$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/'); \
	if [ "$$ARCH" = "amd64" ]; then TARGET=x86_64-unknown-linux-musl; else TARGET=aarch64-unknown-linux-musl; fi; \
	echo "Building for $$TARGET with cargo-zigbuild..."; \
	COPYFAIL_GUARD_EBPF_OBJ=$(EBPF_OBJ) cargo zigbuild --release --target $$TARGET --bin $(BINARY_NAME); \
	cp target/$$TARGET/release/$(BINARY_NAME) $(BINARY_NAME)-linux-$$ARCH; \
	docker build -t $(IMAGE_NAME):$(VERSION) -t $(IMAGE_NAME):latest .; \
	rm -f $(BINARY_NAME)-linux-$$ARCH

docker-push: ## Push image to registry
	docker tag $(IMAGE_NAME):$(VERSION) $(ECR_REGISTRY)/$(IMAGE_NAME):$(VERSION)
	docker tag $(IMAGE_NAME):latest $(ECR_REGISTRY)/$(IMAGE_NAME):latest
	docker push $(ECR_REGISTRY)/$(IMAGE_NAME):$(VERSION)
	docker push $(ECR_REGISTRY)/$(IMAGE_NAME):latest

install: release ## Install to ~/.cargo/bin/
	cargo install --path . --bin $(BINARY_NAME) --locked

uninstall: ## Uninstall from ~/.cargo/bin/
	cargo uninstall $(BINARY_NAME)
