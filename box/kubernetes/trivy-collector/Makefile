.PHONY: help build release run dev test fmt lint check clean install docker-build docker-push podman-build deps build-all

BINARY_NAME := trivy-collector
IMAGE_NAME := trivy-collector
ECR_REGISTRY := <YOUR_ECR_REGISTRY>
VERSION := $(shell grep '^version' Cargo.toml | sed 's/version = "\(.*\)"/\1/')
GIT_COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_DATE := $(shell date -u +"%Y-%m-%dT%H:%M:%SZ")
PLATFORMS := linux/amd64,linux/arm64

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

build: ## Build debug binary
	cargo build

release: ## Build optimized release binary
	cargo build --release

run: build ## Build and run (server mode)
	MODE=server \
	STORAGE_PATH=/tmp/trivy-data \
	LOG_FORMAT=pretty \
	./target/debug/$(BINARY_NAME)

run-collector: build ## Build and run (collector mode)
	MODE=collector \
	SERVER_URL=http://localhost:3000 \
	CLUSTER_NAME=local-test \
	LOG_FORMAT=pretty \
	./target/debug/$(BINARY_NAME)

dev: ## Run with debug logging (server mode)
	MODE=server \
	STORAGE_PATH=/tmp/trivy-data \
	LOG_FORMAT=pretty \
	LOG_LEVEL=debug \
	cargo run

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
	rm -rf /tmp/trivy-data

install: release ## Install to ~/.cargo/bin/
	cp target/release/$(BINARY_NAME) ~/.cargo/bin/

deps: ## Update dependencies
	cargo update

docker-build: ## Build Docker image (cross-compiles for Linux)
	@ARCH=$$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/'); \
	if [ "$$ARCH" = "amd64" ]; then TARGET=x86_64-unknown-linux-musl; else TARGET=aarch64-unknown-linux-musl; fi; \
	echo "Building for $$TARGET..."; \
	cargo build --release --target $$TARGET; \
	cp target/$$TARGET/release/$(BINARY_NAME) $(BINARY_NAME)-linux-$$ARCH; \
	docker build -t $(IMAGE_NAME):$(VERSION) -t $(IMAGE_NAME):latest .; \
	rm -f $(BINARY_NAME)-linux-$$ARCH

docker-push: ## Push to registry
	docker tag $(IMAGE_NAME):$(VERSION) $(ECR_REGISTRY)/$(IMAGE_NAME):$(VERSION)
	docker tag $(IMAGE_NAME):latest $(ECR_REGISTRY)/$(IMAGE_NAME):latest
	docker push $(ECR_REGISTRY)/$(IMAGE_NAME):$(VERSION)
	docker push $(ECR_REGISTRY)/$(IMAGE_NAME):latest

podman-build: ## Build container image with Podman (cross-compiles for Linux)
	@ARCH=$$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/'); \
	if [ "$$ARCH" = "amd64" ]; then TARGET=x86_64-unknown-linux-musl; else TARGET=aarch64-unknown-linux-musl; fi; \
	echo "Building for $$TARGET..."; \
	cargo build --release --target $$TARGET; \
	cp target/$$TARGET/release/$(BINARY_NAME) $(BINARY_NAME)-linux-$$ARCH; \
	podman build -t $(IMAGE_NAME):$(VERSION) -t $(IMAGE_NAME):latest .; \
	rm -f $(BINARY_NAME)-linux-$$ARCH

build-all: ## Build for all platforms (requires cross)
	cross build --release --target x86_64-unknown-linux-gnu
	cross build --release --target aarch64-unknown-linux-gnu
