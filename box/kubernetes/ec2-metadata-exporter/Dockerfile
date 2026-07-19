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
    -ldflags="-s -w -X github.com/younsl/o/box/kubernetes/ec2-metadata-exporter/internal/version.Version=${VERSION} -X github.com/younsl/o/box/kubernetes/ec2-metadata-exporter/internal/version.Commit=${COMMIT}" \
    -o /out/ec2-metadata-exporter ./cmd/ec2-metadata-exporter

FROM alpine:3.23 AS certs
RUN apk add --no-cache ca-certificates

FROM scratch AS runtime

LABEL org.opencontainers.image.title="ec2-metadata-exporter" \
      org.opencontainers.image.description="Prometheus exporter that publishes every EC2 instance's private IP and Name tag via the DescribeInstances API" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.base.name="scratch" \
      org.opencontainers.image.deprecated="false"

COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /out/ec2-metadata-exporter /app/ec2-metadata-exporter
USER 65532:65532
ENTRYPOINT ["/app/ec2-metadata-exporter"]
