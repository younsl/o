BINARY      := external-ebs-autoresizer
PKG         := ./cmd/$(BINARY)
VERSION     := $(shell grep -oE 'org\.opencontainers\.image\.version="[^"]+"' Dockerfile | cut -d'"' -f2)
COMMIT      := $(shell git rev-parse --short HEAD 2>/dev/null || echo none)
LDFLAGS     := -s -w \
	-X github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/version.Version=$(VERSION) \
	-X github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/version.Commit=$(COMMIT)
ECR_REGISTRY ?= ghcr.io/younsl
IMAGE        := $(ECR_REGISTRY)/$(BINARY)
COVER_MIN   ?= 70
CONFIG      ?= config.example.yaml

.PHONY: all build run dev test coverage fmt lint vet tidy clean docker-build docker-push validate policies instances

all: fmt vet lint test build

## build: compile the binary into bin/
build:
	CGO_ENABLED=0 go build -trimpath -ldflags="$(LDFLAGS)" -o bin/$(BINARY) $(PKG)

## run: build and run the controller with the example config (CONFIG=path to override)
run: build
	CONFIG_FILE=$(CONFIG) LOG_FORMAT=text ./bin/$(BINARY)

## dev: run the controller with debug logging and the example config
dev:
	CONFIG_FILE=$(CONFIG) LOG_FORMAT=text LOG_LEVEL=debug go run $(PKG)

## validate: validate the config file via the built-in CLI (no AWS)
validate:
	go run $(PKG) validate --config $(CONFIG)

## policies: print resolved resize policies via the built-in CLI (no AWS)
policies:
	go run $(PKG) policies --config $(CONFIG)

## instances: list discovered instances grouped by matched policy (needs AWS credentials)
instances:
	go run $(PKG) instances --config $(CONFIG)

## test: run tests with race detector
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

## docker-build: build multi-arch image (requires buildx)
docker-build:
	docker buildx build --platform linux/amd64,linux/arm64 \
		--build-arg VERSION=$(VERSION) --build-arg COMMIT=$(COMMIT) \
		-t $(IMAGE):$(VERSION) -t $(IMAGE):latest .

## docker-push: build and push multi-arch image
docker-push:
	docker buildx build --platform linux/amd64,linux/arm64 \
		--build-arg VERSION=$(VERSION) --build-arg COMMIT=$(COMMIT) \
		-t $(IMAGE):$(VERSION) -t $(IMAGE):latest --push .
