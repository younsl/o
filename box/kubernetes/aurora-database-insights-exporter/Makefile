.PHONY: help build release run test fmt lint check clean docker-build docker-push build-all coverage

BINARY_NAME := adie
IMAGE_NAME := aurora-database-insights-exporter
VERSION := $(shell grep '^version' Cargo.toml | sed 's/version = "\(.*\)"/\1/')
GIT_COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
PLATFORMS := linux/amd64,linux/arm64

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

build: ## Build debug binary
	cargo build

release: ## Build optimized release binary
	cargo build --release --bin $(BINARY_NAME)

run: build ## Build and run with default config
	ADIE_LOG_FORMAT=text ADIE_LOG_LEVEL=debug cargo run -- --region ap-northeast-2

test: ## Run tests
	cargo test --verbose

fmt: ## Format code
	cargo fmt

lint: ## Run clippy
	cargo clippy -- -D warnings

check: ## Check code without building
	cargo check

clean: ## Remove build artifacts
	cargo clean

coverage: ## Run tests with llvm-cov coverage report
	cargo llvm-cov --text

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

build-all: ## Build for all platforms (requires cargo-zigbuild)
	cargo zigbuild --release --target x86_64-unknown-linux-musl --bin $(BINARY_NAME)
	cargo zigbuild --release --target aarch64-unknown-linux-musl --bin $(BINARY_NAME)
