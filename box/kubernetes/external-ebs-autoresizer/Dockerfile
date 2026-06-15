# Statically linked Go binary on scratch. Cross-compilation happens inside the
# builder stage (CGO disabled), so buildx needs no QEMU for the compile step.
FROM --platform=$BUILDPLATFORM golang:1.26.4-alpine AS builder
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
    -ldflags="-s -w -X github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/version.Version=${VERSION} -X github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/version.Commit=${COMMIT}" \
    -o /out/external-ebs-autoresizer ./cmd/external-ebs-autoresizer

FROM alpine:3.23 AS certs
RUN apk add --no-cache ca-certificates

FROM scratch AS runtime

LABEL org.opencontainers.image.title="external-ebs-autoresizer" \
      org.opencontainers.image.description="Auto-expands the root filesystem (ext2/3/4 or XFS) of standalone EC2 instances via EBS ModifyVolume and SSM" \
      org.opencontainers.image.version="0.3.0" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.base.name="scratch" \
      org.opencontainers.image.deprecated="false"

COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /out/external-ebs-autoresizer /app/external-ebs-autoresizer
USER 65532:65532
ENTRYPOINT ["/app/external-ebs-autoresizer"]
