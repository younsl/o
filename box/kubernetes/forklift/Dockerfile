# Build the React UI first; its output is embedded into the Go binary.
FROM --platform=$BUILDPLATFORM node:22-alpine AS web
WORKDIR /web
COPY web/package.json ./
RUN npm install
COPY web/ ./
RUN npm run build

# Statically linked Go binary on scratch. Cross-compilation happens inside the
# builder stage (CGO disabled), so buildx needs no QEMU for the compile step.
# The React UI (internal/webui/dist) is embedded into the binary via go:embed.
FROM --platform=$BUILDPLATFORM golang:1.26.4-alpine AS builder
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
ARG COMMIT=none
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# Overlay the compiled UI on top of the committed placeholder.
COPY --from=web /internal/webui/dist ./internal/webui/dist
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath \
    -ldflags="-s -w -X github.com/younsl/o/box/kubernetes/forklift/internal/version.Version=${VERSION} -X github.com/younsl/o/box/kubernetes/forklift/internal/version.Commit=${COMMIT}" \
    -o /out/forklift ./cmd/forklift

FROM alpine:3.23 AS certs
RUN apk add --no-cache ca-certificates

FROM scratch AS runtime

LABEL org.opencontainers.image.title="forklift" \
      org.opencontainers.image.description="Lightweight Kubernetes-native artifact repository (Maven, npm, Cargo, Go) with proxy caching and supply-chain age policy" \
      org.opencontainers.image.version="0.2.0" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.base.name="scratch" \
      org.opencontainers.image.deprecated="false"

COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /out/forklift /app/forklift
EXPOSE 8080 8081
USER 65532:65532
ENTRYPOINT ["/app/forklift"]
