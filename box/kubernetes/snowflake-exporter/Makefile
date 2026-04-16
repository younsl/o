.PHONY: help build release run dev test fmt lint check clean docker-build docker-push build-all coverage dev-setup

BINARY_NAME := snowflake-exporter
IMAGE_NAME := snowflake-exporter
VERSION := $(shell grep '^version' Cargo.toml | sed 's/version = "\(.*\)"/\1/')
GIT_COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
PLATFORMS := linux/amd64,linux/arm64

# Local dev defaults. These files are git-ignored (see .gitignore).
LOCAL_CONFIG := config.local.yaml
LOCAL_TOKEN := .token

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

build: ## Build debug binary
	cargo build

release: ## Build optimized release binary
	cargo build --release --bin $(BINARY_NAME)

dev-setup: ## Scaffold config.local.yaml and .token templates at repo root (git-ignored)
	@if [ ! -f $(LOCAL_CONFIG) ]; then \
		printf '%s\n' \
			'server:' \
			'  listen_address: "127.0.0.1:9975"' \
			'  metrics_path: "/metrics"' \
			'snowflake:' \
			'  account: "<ORG>-<ACCOUNT>"' \
			'  role: "METRICS_ROLE"' \
			'  warehouse: "METRICS_WH"' \
			'  database: "SNOWFLAKE"' \
			'  token_path: "$(LOCAL_TOKEN)"' \
			'  request_timeout_seconds: 60' \
			'collection:' \
			'  interval_seconds: 60' \
			'  exclude_deleted_tables: false' \
			'  enable_serverless_detail: false' \
			'  query_timeout_seconds: 60' \
			'logging:' \
			'  level: "debug"' \
			'  format: "text"' \
			> $(LOCAL_CONFIG); \
		echo "Wrote $(LOCAL_CONFIG)"; \
	else \
		echo "$(LOCAL_CONFIG) already exists — skipping"; \
	fi
	@if [ ! -f $(LOCAL_TOKEN) ]; then \
		touch $(LOCAL_TOKEN); \
		chmod 600 $(LOCAL_TOKEN); \
		echo "Created empty $(LOCAL_TOKEN) — paste your PAT into this file"; \
	fi

run: build ## Build and run against config.local.yaml (see `make dev-setup`)
	@test -f $(LOCAL_CONFIG) || { echo "Missing $(LOCAL_CONFIG). Run: make dev-setup"; exit 1; }
	@test -s $(LOCAL_TOKEN) || { echo "$(LOCAL_TOKEN) is empty. Paste the PAT into it."; exit 1; }
	SNOWFLAKE_EXPORTER_LOG_FORMAT=text SNOWFLAKE_EXPORTER_LOG_LEVEL=debug \
	cargo run --bin $(BINARY_NAME) -- --config $(LOCAL_CONFIG)

dev: run ## Alias of run

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
	docker tag $(IMAGE_NAME):$(VERSION) ghcr.io/younsl/$(IMAGE_NAME):$(VERSION)
	docker tag $(IMAGE_NAME):latest ghcr.io/younsl/$(IMAGE_NAME):latest
	docker push ghcr.io/younsl/$(IMAGE_NAME):$(VERSION)
	docker push ghcr.io/younsl/$(IMAGE_NAME):latest

build-all: ## Build for all platforms (requires cargo-zigbuild)
	cargo zigbuild --release --target x86_64-unknown-linux-musl --bin $(BINARY_NAME)
	cargo zigbuild --release --target aarch64-unknown-linux-musl --bin $(BINARY_NAME)
