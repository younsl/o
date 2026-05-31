# Statically linked binary built via GitHub Actions cross-compilation (cargo-zigbuild)
FROM alpine:3.23 AS certs
RUN apk add --no-cache ca-certificates

FROM scratch AS runtime

LABEL org.opencontainers.image.title="elasticache-backup" \
      org.opencontainers.image.description="ElastiCache snapshot backup to S3 automation" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.base.name="scratch" \
      org.opencontainers.image.deprecated="false"

ARG TARGETARCH
COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --chmod=755 elasticache-backup-linux-${TARGETARCH} /app/elasticache-backup
USER 65532:65532
ENTRYPOINT ["/app/elasticache-backup"]
