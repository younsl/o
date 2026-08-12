# Statically linked Go binary on scratch. Cross-compilation happens inside the
# builder stage (CGO disabled), so buildx needs no QEMU for the compile step.
FROM --platform=$BUILDPLATFORM golang:1.26.5-alpine AS builder
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
    -ldflags="-s -w -X github.com/younsl/o/box/kubernetes/kagent-alert-bridge/internal/version.Version=${VERSION} -X github.com/younsl/o/box/kubernetes/kagent-alert-bridge/internal/version.Commit=${COMMIT}" \
    -o /out/kagent-alert-bridge ./cmd/kagent-alert-bridge

FROM alpine:3.23 AS certs
RUN apk add --no-cache ca-certificates

FROM scratch AS runtime

LABEL org.opencontainers.image.title="kagent-alert-bridge" \
      org.opencontainers.image.description="Posts Alertmanager alerts to Slack and replies in-thread with an analysis from a kagent agent over A2A" \
      org.opencontainers.image.version="0.3.1" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.base.name="scratch" \
      org.opencontainers.image.deprecated="false"

# The Slack Web API is reached over TLS, so the trust store is not optional.
COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /out/kagent-alert-bridge /app/kagent-alert-bridge
USER 65532:65532
ENTRYPOINT ["/app/kagent-alert-bridge"]
