# Statically linked Go binary on scratch. Cross-compilation happens inside the
# builder stage (CGO disabled), so buildx needs no QEMU for the compile step.
FROM --platform=$BUILDPLATFORM golang:1.27.0-alpine AS builder
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
ARG COMMIT=none
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath \
    -ldflags="-s -w -X github.com/younsl/o/box/kubernetes/filesystem-cleaner/internal/version.Version=${VERSION} -X github.com/younsl/o/box/kubernetes/filesystem-cleaner/internal/version.Commit=${COMMIT}" \
    -o /out/filesystem-cleaner ./cmd/filesystem-cleaner

FROM scratch AS runtime

LABEL org.opencontainers.image.title="filesystem-cleaner" \
      org.opencontainers.image.description="Kubernetes sidecar/init filesystem cleaner for managing disk space" \
      org.opencontainers.image.version="0.4.0" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.base.name="scratch" \
      org.opencontainers.image.deprecated="false"

COPY --from=builder /out/filesystem-cleaner /app/filesystem-cleaner
USER 65532:65532
ENTRYPOINT ["/app/filesystem-cleaner"]
