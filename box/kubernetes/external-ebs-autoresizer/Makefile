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

.PHONY: all build run dev test coverage fmt lint vet tidy clean docker-build docker-push

all: fmt vet lint test build

## build: compile the binary into bin/
build:
	CGO_ENABLED=0 go build -trimpath -ldflags="$(LDFLAGS)" -o bin/$(BINARY) $(PKG)

## run: build and run with example settings
run: build
	AWS_REGION=ap-northeast-2 TAG_FILTERS=Environment=dev DRY_RUN=true LOG_FORMAT=text ./bin/$(BINARY)

## dev: run with debug logging
dev:
	AWS_REGION=ap-northeast-2 TAG_FILTERS=Environment=dev DRY_RUN=true LOG_FORMAT=text LOG_LEVEL=debug go run $(PKG)

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
