# Statically linked binary built via GitHub Actions cross-compilation (cargo-zigbuild)
FROM alpine:3.23 AS certs
RUN apk add --no-cache ca-certificates

FROM scratch AS runtime

LABEL org.opencontainers.image.title="gss" \
      org.opencontainers.image.description="GHES scheduled workflow scanner for Kubernetes" \
      org.opencontainers.image.version="0.6.1" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.base.name="scratch" \
      org.opencontainers.image.deprecated="false"

ARG TARGETARCH
COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --chmod=755 ghes-schedule-scanner-linux-${TARGETARCH} /app/ghes-schedule-scanner
USER 65532:65532
ENTRYPOINT ["/app/ghes-schedule-scanner"]
