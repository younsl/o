BINARY      := forklift
PKG         := ./cmd/$(BINARY)
VERSION     := $(shell grep -oE 'org\.opencontainers\.image\.version="[^"]+"' Dockerfile | cut -d'"' -f2)
COMMIT      := $(shell git rev-parse --short HEAD 2>/dev/null || echo none)
LDFLAGS     := -s -w \
	-X github.com/younsl/o/box/kubernetes/forklift/internal/version.Version=$(VERSION) \
	-X github.com/younsl/o/box/kubernetes/forklift/internal/version.Commit=$(COMMIT)
ECR_REGISTRY ?= ghcr.io/younsl
IMAGE        := $(ECR_REGISTRY)/$(BINARY)
COVER_MIN   ?= 73
PLATFORMS   ?= linux/amd64,linux/arm64
DATA_DIR    ?= ./.data

.PHONY: all build run dev test coverage fmt lint vet tidy clean web-build docker-build docker-push helm-lint helm-template creds

all: fmt vet lint test build

## build: compile the binary into bin/
build:
	CGO_ENABLED=0 go build -trimpath -ldflags="$(LDFLAGS)" -o bin/$(BINARY) $(PKG)

## run: build and run with local dev settings
run: build
	FORKLIFT_DATA_DIR=./.data FORKLIFT_LOG_FORMAT=text ./bin/$(BINARY)

## dev: run with debug logging
dev:
	FORKLIFT_DATA_DIR=./.data FORKLIFT_LOG_FORMAT=text FORKLIFT_LOG_LEVEL=debug go run $(PKG)

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

## web-build: build the React UI into internal/webui/dist (embedded into the binary)
web-build:
	cd web && npm install && npm run build

## creds: list local users and password hashes from the local DB (plaintext is bcrypt-hashed and unrecoverable; the generated admin password is only printed once in bootstrap logs)
creds:
	@db="$(DATA_DIR)/forklift.db"; \
	if [ ! -f "$$db" ]; then echo "no database at $$db (run 'make run' first)"; exit 1; fi; \
	command -v sqlite3 >/dev/null || { echo "sqlite3 not installed"; exit 1; }; \
	sqlite3 -header -column "$$db" \
		"SELECT id, username, source, disabled, password_hash FROM users ORDER BY id;"

## clean: remove build and coverage artifacts
clean:
	rm -rf bin cover.out .data

## docker-build: build multi-arch image (requires buildx)
docker-build:
	docker buildx build --platform $(PLATFORMS) \
		--build-arg VERSION=$(VERSION) --build-arg COMMIT=$(COMMIT) \
		-t $(IMAGE):$(VERSION) -t $(IMAGE):latest .

## docker-push: build and push multi-arch image
docker-push:
	docker buildx build --push --platform $(PLATFORMS) \
		--build-arg VERSION=$(VERSION) --build-arg COMMIT=$(COMMIT) \
		-t $(IMAGE):$(VERSION) -t $(IMAGE):latest .

## helm-lint: lint the Helm chart
helm-lint:
	helm lint charts/$(BINARY)

## helm-template: render Helm templates locally
helm-template:
	helm template $(BINARY) charts/$(BINARY)

## helm-package: package the chart as a tgz
helm-package:
	helm package charts/$(BINARY)

## helm-push: push the packaged chart to the OCI registry (GHCR)
helm-push: helm-package
	helm push $(BINARY)-$(shell grep '^version:' charts/$(BINARY)/Chart.yaml | awk '{print $$2}').tgz oci://$(ECR_REGISTRY)/charts
