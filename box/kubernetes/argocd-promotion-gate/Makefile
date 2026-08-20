BINARY      := argocd-promotion-gate
PKG         := ./cmd/$(BINARY)
MODULE      := github.com/younsl/o/box/kubernetes/$(BINARY)
VERSION     := $(shell grep -oE 'org\.opencontainers\.image\.version="[^"]+"' Dockerfile | cut -d'"' -f2)
COMMIT      := $(shell git rev-parse --short HEAD 2>/dev/null || echo none)
LDFLAGS     := -s -w \
	-X $(MODULE)/internal/version.Version=$(VERSION) \
	-X $(MODULE)/internal/version.Commit=$(COMMIT)
REGISTRY    ?= ghcr.io/younsl
IMAGE       := $(REGISTRY)/$(BINARY)
COVER_MIN   ?= 70
CHART       := charts/$(BINARY)

.PHONY: all build run test coverage fmt fix lint vet tidy clean \
        docker-build docker-buildx helm-lint helm-template help

all: fmt vet lint test build

## build: compile the binary into bin/
build:
	CGO_ENABLED=0 go build -trimpath -ldflags="$(LDFLAGS)" -o bin/$(BINARY) $(PKG)

## run: run against the current kubeconfig context with a local config file
run: build
	./bin/$(BINARY) \
	  --config ./config.example.yaml \
	  --kubeconfig $${KUBECONFIG:-$$HOME/.kube/config} \
	  --log-format text --log-level debug

## test: run tests with the race detector
test:
	go test -race ./...

## coverage: enforce minimum line coverage
coverage:
	go test -coverprofile=cover.out ./...
	@total=$$(go tool cover -func=cover.out | awk '/^total:/ {gsub("%","",$$3); print $$3}'); \
	echo "total coverage: $$total% (min $(COVER_MIN)%)"; \
	awk "BEGIN { exit !($$total >= $(COVER_MIN)) }" || { echo "coverage below $(COVER_MIN)%"; exit 1; }

## fmt: format code
fmt:
	gofmt -w .

## fix: apply go fix modernizations
fix:
	go fix ./...

## lint: gofmt check + go vet
lint: vet
	@unformatted=$$(gofmt -l .); \
	if [ -n "$$unformatted" ]; then echo "gofmt needed:"; echo "$$unformatted"; exit 1; fi

## vet: run go vet
vet:
	go vet ./...

## tidy: tidy module dependencies
tidy:
	go mod tidy

## clean: remove build and coverage artifacts
clean:
	rm -rf bin cover.out

## docker-build: build the image for the host platform
docker-build:
	docker build --build-arg VERSION=$(VERSION) --build-arg COMMIT=$(COMMIT) -t $(IMAGE):$(VERSION) .

## docker-buildx: build and push a multi-arch image
docker-buildx:
	docker buildx build \
	  --platform linux/amd64,linux/arm64 \
	  --build-arg VERSION=$(VERSION) --build-arg COMMIT=$(COMMIT) \
	  -t $(IMAGE):$(VERSION) --push .

## helm-lint: lint the chart
helm-lint:
	helm lint $(CHART)

## helm-template: render the chart locally
helm-template:
	helm template $(BINARY) $(CHART)

## help: show this help message
help:
	@echo "Available targets:"
	@echo ""
	@grep -E '^##' $(MAKEFILE_LIST) | sed 's/## /  /' | column -t -s ':'
