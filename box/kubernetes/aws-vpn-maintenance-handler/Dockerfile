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
    -ldflags="-s -w -X github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/version.Version=${VERSION} -X github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/version.Commit=${COMMIT}" \
    -o /out/aws-vpn-maintenance-handler ./cmd/aws-vpn-maintenance-handler

FROM alpine:3.23 AS certs
# tzdata provides /usr/share/zoneinfo, which the alpine base image does not ship.
RUN apk add --no-cache ca-certificates tzdata

FROM scratch AS runtime

LABEL org.opencontainers.image.title="aws-vpn-maintenance-handler" \
      org.opencontainers.image.description="Owns AWS Site-to-Site VPN tunnel endpoint maintenance, applying it in a maintenance window after Slack approval" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.base.name="scratch" \
      org.opencontainers.image.deprecated="false"

# The AWS SDK and the Slack Socket Mode WebSocket both need the trust store, and
# scratch has none.
COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
# Timezone database, so maintenanceWindow.timezone can be an IANA name. Without
# it, time.LoadLocation only resolves UTC and the controller fails at startup.
COPY --from=certs /usr/share/zoneinfo /usr/share/zoneinfo
COPY --from=builder /out/aws-vpn-maintenance-handler /app/aws-vpn-maintenance-handler
EXPOSE 8081 9090
USER 65532:65532
ENTRYPOINT ["/app/aws-vpn-maintenance-handler"]
