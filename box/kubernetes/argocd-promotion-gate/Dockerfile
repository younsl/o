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
    -ldflags="-s -w -X github.com/younsl/o/box/kubernetes/argocd-promotion-gate/internal/version.Version=${VERSION} -X github.com/younsl/o/box/kubernetes/argocd-promotion-gate/internal/version.Commit=${COMMIT}" \
    -o /out/argocd-promotion-gate ./cmd/argocd-promotion-gate

FROM alpine:3.23 AS certs
RUN apk add --no-cache ca-certificates

FROM scratch AS runtime

LABEL org.opencontainers.image.title="argocd-promotion-gate" \
      org.opencontainers.image.description="Admission gate that blocks an Argo CD Application sync until the same app is promoted in the upstream environment" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.base.name="scratch" \
      org.opencontainers.image.deprecated="false"

# The Kubernetes API and argocd-server are both reached over TLS, so the trust
# store is not optional even though both are in-cluster.
COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /out/argocd-promotion-gate /app/argocd-promotion-gate
EXPOSE 8443 8080
USER 65532:65532
ENTRYPOINT ["/app/argocd-promotion-gate"]
