.PHONY: build release run dev test fmt lint check clean deps \
        zigbuild-amd64 zigbuild-arm64 zigbuild \
        docker-build docker-buildx \
        helm-lint helm-template \
        local-check-aws local-run local-run-replay local-send local-env \
        help

BINARY_NAME := aws-health-event-notifier
IMAGE_NAME  ?= aws-health-event-notifier
IMAGE_TAG   ?= 0.1.0
PLATFORM    ?= linux/amd64

RUSTUP := $(shell command -v rustup 2>/dev/null || echo "/opt/homebrew/bin/rustup")
TOOLCHAIN_PATH := $(shell $(RUSTUP) which cargo 2>/dev/null | xargs dirname 2>/dev/null)

.DEFAULT_GOAL := help

## Build debug binary
build:
	@PATH="$(TOOLCHAIN_PATH):$$PATH" cargo build

## Build optimized release binary
release:
	@PATH="$(TOOLCHAIN_PATH):$$PATH" cargo build --release

## Cross-compile to linux/amd64 musl using zig
zigbuild-amd64:
	@PATH="$(TOOLCHAIN_PATH):$$PATH" cargo zigbuild --release --target x86_64-unknown-linux-musl

## Cross-compile to linux/arm64 musl using zig
zigbuild-arm64:
	@PATH="$(TOOLCHAIN_PATH):$$PATH" cargo zigbuild --release --target aarch64-unknown-linux-musl

## Cross-compile to both linux/amd64 and linux/arm64 musl
zigbuild: zigbuild-amd64 zigbuild-arm64

## Run the binary locally
run:
	@PATH="$(TOOLCHAIN_PATH):$$PATH" cargo run

## Run with debug logging
dev:
	@RUST_LOG=debug PATH="$(TOOLCHAIN_PATH):$$PATH" cargo run

## Run tests
test:
	@PATH="$(TOOLCHAIN_PATH):$$PATH" cargo test --verbose

## Format code
fmt:
	@PATH="$(TOOLCHAIN_PATH):$$PATH" cargo fmt

## Run clippy linter
lint:
	@PATH="$(TOOLCHAIN_PATH):$$PATH" cargo clippy -- -D warnings

## Check code without building
check:
	@PATH="$(TOOLCHAIN_PATH):$$PATH" cargo check

## Update dependencies
deps:
	@PATH="$(TOOLCHAIN_PATH):$$PATH" cargo update

## Clean build artifacts
clean:
	@PATH="$(TOOLCHAIN_PATH):$$PATH" cargo clean

## Build Docker image (cross-compiles for Linux with cargo-zigbuild, then copies the static binary)
docker-build:
	@ARCH=$$(echo "$(PLATFORM)" | sed 's|linux/||'); \
	if [ "$$ARCH" = "amd64" ]; then TARGET=x86_64-unknown-linux-musl; else TARGET=aarch64-unknown-linux-musl; fi; \
	echo "Building for $$TARGET with cargo-zigbuild..."; \
	PATH="$(TOOLCHAIN_PATH):$$PATH" cargo zigbuild --release --target $$TARGET --bin $(BINARY_NAME); \
	cp target/$$TARGET/release/$(BINARY_NAME) $(BINARY_NAME)-linux-$$ARCH; \
	docker build --platform $(PLATFORM) -t $(IMAGE_NAME):$(IMAGE_TAG) .; \
	rm -f $(BINARY_NAME)-linux-$$ARCH

## Build multi-arch image via buildx (cross-compiles both arches, then builds and pushes)
docker-buildx:
	@PATH="$(TOOLCHAIN_PATH):$$PATH" cargo zigbuild --release --target x86_64-unknown-linux-musl --bin $(BINARY_NAME); \
	PATH="$(TOOLCHAIN_PATH):$$PATH" cargo zigbuild --release --target aarch64-unknown-linux-musl --bin $(BINARY_NAME); \
	cp target/x86_64-unknown-linux-musl/release/$(BINARY_NAME) $(BINARY_NAME)-linux-amd64; \
	cp target/aarch64-unknown-linux-musl/release/$(BINARY_NAME) $(BINARY_NAME)-linux-arm64; \
	docker buildx build \
	    --platform linux/amd64,linux/arm64 \
	    -t $(IMAGE_NAME):$(IMAGE_TAG) \
	    --push .; \
	rm -f $(BINARY_NAME)-linux-amd64 $(BINARY_NAME)-linux-arm64

## Lint Helm chart
helm-lint:
	@helm lint charts/aws-health-event-notifier/

## Render Helm templates locally
helm-template:
	@helm template aws-health-event-notifier charts/aws-health-event-notifier/

# ---------------- Local testing ----------------
# Override these on the command line:
#   make local-run SLACK_WEBHOOK_URL=https://hooks.slack.com/... AWS_PROFILE=shared
AWS_PROFILE          ?= default
AWS_REGION           ?= us-east-1
SLACK_WEBHOOK_URL    ?=
POLL_INTERVAL_SECS   ?= 30
INITIAL_LOOKBACK_SECS?= 600
LOOKBACK_HOURS       ?= 168

## Verify AWS Health API access using the current AWS_PROFILE
local-check-aws:
	@echo "Profile: $(AWS_PROFILE)  Region: $(AWS_REGION)"
	@AWS_PROFILE=$(AWS_PROFILE) aws sts get-caller-identity --output table
	@echo ""
	@AWS_PROFILE=$(AWS_PROFILE) aws health describe-event-aggregates \
	    --region $(AWS_REGION) \
	    --aggregate-field eventTypeCategory \
	    --output table

## Run daemon locally (poll 30s, cold-start suppress ON — safe, no replay flood)
local-run:
	@test -n "$(SLACK_WEBHOOK_URL)" || (echo "SLACK_WEBHOOK_URL not set; pass via make var or env" >&2; exit 1)
	@AWS_PROFILE=$(AWS_PROFILE) \
	 SLACK_WEBHOOK_URL='$(SLACK_WEBHOOK_URL)' \
	 POLL_INTERVAL_SECS=$(POLL_INTERVAL_SECS) \
	 INITIAL_LOOKBACK_SECS=$(INITIAL_LOOKBACK_SECS) \
	 COLD_START_SUPPRESS=true \
	 LOG_LEVEL=debug \
	 PATH="$(TOOLCHAIN_PATH):$$PATH" cargo run -- run

## Run daemon locally with cold-start REPLAY (sends recent open events to Slack — for demos)
local-run-replay:
	@test -n "$(SLACK_WEBHOOK_URL)" || (echo "SLACK_WEBHOOK_URL not set" >&2; exit 1)
	@AWS_PROFILE=$(AWS_PROFILE) \
	 SLACK_WEBHOOK_URL='$(SLACK_WEBHOOK_URL)' \
	 POLL_INTERVAL_SECS=$(POLL_INTERVAL_SECS) \
	 INITIAL_LOOKBACK_SECS=86400 \
	 COLD_START_SUPPRESS=false \
	 LOG_LEVEL=debug \
	 PATH="$(TOOLCHAIN_PATH):$$PATH" cargo run -- run

## Interactive send: pick recent events with multi-select and forward to Slack
local-send:
	@test -n "$(SLACK_WEBHOOK_URL)" || (echo "SLACK_WEBHOOK_URL not set" >&2; exit 1)
	@AWS_PROFILE=$(AWS_PROFILE) \
	 SLACK_WEBHOOK_URL='$(SLACK_WEBHOOK_URL)' \
	 PATH="$(TOOLCHAIN_PATH):$$PATH" cargo run -- send --lookback-hours $(LOOKBACK_HOURS)

## Print the environment variables the daemon would read
local-env:
	@echo "AWS_PROFILE           = $(AWS_PROFILE)"
	@echo "AWS_REGION            = $(AWS_REGION)"
	@echo "SLACK_WEBHOOK_URL     = $${SLACK_WEBHOOK_URL:+<set>}$${SLACK_WEBHOOK_URL:-<unset>}"
	@echo "POLL_INTERVAL_SECS    = $(POLL_INTERVAL_SECS)"
	@echo "INITIAL_LOOKBACK_SECS = $(INITIAL_LOOKBACK_SECS)"
	@echo "LOOKBACK_HOURS        = $(LOOKBACK_HOURS)  (only used by local-send)"

## Show this help message
help:
	@echo "Available targets:"
	@echo ""
	@grep -E '^##' $(MAKEFILE_LIST) | sed 's/## /  /' | column -t -s ':'
