# ==============================================================================
# Backstage Custom Image Build
# ==============================================================================

IMAGE_NAME ?= backstage
IMAGE_TAG ?= latest
REGISTRY ?= ghcr.io/younsl

# Container runtime auto-detection (docker or podman)
# Checks if runtime is actually working, not just installed
# Override with: make build CONTAINER_RUNTIME=podman
CONTAINER_RUNTIME ?= $(shell podman info >/dev/null 2>&1 && echo podman || echo docker)

# .env file handling (use if exists, ignore if not)
ENV_FILE := $(wildcard .env)
ENV_FILE_OPT := $(if $(ENV_FILE),--env-file $(ENV_FILE),)

.PHONY: help init build push run clean runtime-info

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-15s\033[0m %s\n", $$1, $$2}'

runtime-info: ## Show detected container runtime
	@echo "Container runtime: $(CONTAINER_RUNTIME)"

init: ## Initialize project (install dependencies)
	yarn install

dev: ## Run Backstage in development mode
	@if [ -f .env ]; then set -a && . ./.env && set +a; fi && \
		yarn dev

build: ## Build container image
	$(CONTAINER_RUNTIME) build \
		-t $(IMAGE_NAME):$(IMAGE_TAG) .

build-nocache: ## Build container image without cache
	$(CONTAINER_RUNTIME) build --no-cache \
		-t $(IMAGE_NAME):$(IMAGE_TAG) .

push: ## Push image to registry
	$(CONTAINER_RUNTIME) tag $(IMAGE_NAME):$(IMAGE_TAG) $(REGISTRY)/$(IMAGE_NAME):$(IMAGE_TAG)
	$(CONTAINER_RUNTIME) push $(REGISTRY)/$(IMAGE_NAME):$(IMAGE_TAG)

run: ## Run container locally (SQLite)
	$(CONTAINER_RUNTIME) run --rm -it \
		-p 7007:7007 \
		-v $(PWD)/app-config.yaml:/app/app-config.yaml:ro \
		-v $(PWD)/app-config.local.yaml:/app/app-config.local.yaml:ro \
		-v $(PWD)/templates:/app/templates:ro \
		$(ENV_FILE_OPT) \
		-e NODE_OPTIONS=--no-node-snapshot \
		$(IMAGE_NAME):$(IMAGE_TAG) \
		node packages/backend --config app-config.yaml --config app-config.local.yaml

clean: ## Remove build artifacts
	rm -rf node_modules dist
	$(CONTAINER_RUNTIME) rmi $(IMAGE_NAME):$(IMAGE_TAG) || true
