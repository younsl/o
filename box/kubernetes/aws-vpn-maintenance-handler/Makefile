BINARY      := aws-vpn-maintenance-handler
PKG         := ./cmd/$(BINARY)
VERSION     := $(shell grep -oE 'org\.opencontainers\.image\.version="[^"]+"' Dockerfile | cut -d'"' -f2)
COMMIT      := $(shell git rev-parse --short HEAD 2>/dev/null || echo none)
LDFLAGS     := -s -w \
	-X github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/version.Version=$(VERSION) \
	-X github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/version.Commit=$(COMMIT)
REGISTRY    ?= ghcr.io/younsl
IMAGE       := $(REGISTRY)/$(BINARY)
PLATFORM    ?= linux/amd64
COVER_MIN   ?= 70
CONFIG      ?= config.example.yaml
CHART       := charts/$(BINARY)

.PHONY: all build run dev test coverage fmt lint vet tidy clean \
        docker-build docker-buildx helm-lint helm-template docs \
        validate status help

.DEFAULT_GOAL := help

all: fmt vet test build

## build: compile the binary into bin/
build:
	CGO_ENABLED=0 go build -trimpath -ldflags="$(LDFLAGS)" -o bin/$(BINARY) $(PKG)

## run: build and run the daemon with the example config
run: build
	@$(LOCAL_ENV) LOG_FORMAT=text ./bin/$(BINARY)

## dev: run the daemon with debug logging and the example config
dev:
	@$(LOCAL_ENV) LOG_FORMAT=text LOG_LEVEL=debug go run $(PKG)

# The Slack tokens and Pod identity are required config, so a local run needs stand-ins.
# validate and status never make a Slack call, so placeholders are enough there; export
# real tokens to run the daemon, and they win over these defaults.
LOCAL_ENV = CONFIG_FILE=$(CONFIG) \
	POD_NAMESPACE=$${POD_NAMESPACE:-kube-system} POD_NAME=$${POD_NAME:-local} \
	SLACK_BOT_TOKEN=$${SLACK_BOT_TOKEN:-xoxb-placeholder} \
	SLACK_APP_TOKEN=$${SLACK_APP_TOKEN:-xapp-placeholder}

## validate: validate the config file without touching AWS or Kubernetes
validate:
	@$(LOCAL_ENV) go run $(PKG) validate

## status: print tunnel telemetry and pending maintenance, read-only (needs AWS credentials)
status:
	@$(LOCAL_ENV) go run $(PKG) status

## test: run tests with the race detector
test:
	go test -race ./...

## coverage: run tests and fail below COVER_MIN percent line coverage
coverage:
	@go test -coverprofile=cover.out -covermode=atomic ./... >/dev/null
	@go tool cover -func=cover.out | tail -1
	@total=$$(go tool cover -func=cover.out | tail -1 | awk '{print $$3}' | tr -d '%'); \
	 awk -v t="$$total" -v m="$(COVER_MIN)" 'BEGIN { if (t+0 < m+0) { printf "coverage %.1f%% is below the %s%% minimum\n", t, m; exit 1 } printf "coverage %.1f%% meets the %s%% minimum\n", t, m }'

## fmt: format the code
fmt:
	gofmt -w .

## vet: run go vet
vet:
	go vet ./...

## lint: run golangci-lint if installed, otherwise go vet
lint:
	@command -v golangci-lint >/dev/null 2>&1 && golangci-lint run ./... || $(MAKE) vet

## tidy: tidy go.mod and go.sum
tidy:
	go mod tidy

## clean: remove build and coverage artifacts
clean:
	rm -rf bin cover.out

## docker-build: build the container image for PLATFORM
docker-build:
	docker build --platform $(PLATFORM) \
	    --build-arg VERSION=$(VERSION) --build-arg COMMIT=$(COMMIT) \
	    -t $(IMAGE):$(VERSION) .

## docker-buildx: build and push a multi-arch image
docker-buildx:
	docker buildx build --platform linux/amd64,linux/arm64 \
	    --build-arg VERSION=$(VERSION) --build-arg COMMIT=$(COMMIT) \
	    -t $(IMAGE):$(VERSION) --push .

## helm-lint: lint the Helm chart
helm-lint:
	helm lint $(CHART) \
	    --set config.region=$(or $(AWS_REGION),ap-northeast-2) \
	    --set slack.botToken=xoxb-lint --set slack.appToken=xapp-lint

## helm-template: render the Helm chart locally
helm-template:
	helm template $(BINARY) $(CHART) \
	    --set config.region=$(or $(AWS_REGION),ap-northeast-2) \
	    --set slack.botToken=xoxb-lint --set slack.appToken=xapp-lint

## docs: regenerate the chart README via helm-docs (never edit it directly)
docs:
	$(MAKE) -C ../charts docs

## help: show this help message
help:
	@grep -E '^##' $(MAKEFILE_LIST) | sed 's/## /  /' | column -t -s ':'
