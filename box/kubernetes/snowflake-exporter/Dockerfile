# Statically linked binary built via GitHub Actions cross-compilation (cargo-zigbuild)
FROM alpine:3.23 AS certs
RUN apk add --no-cache ca-certificates

FROM scratch AS runtime

LABEL org.opencontainers.image.title="snowflake-exporter" \
      org.opencontainers.image.description="Prometheus exporter for Snowflake account usage metrics" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.base.name="scratch" \
      org.opencontainers.image.deprecated="false"

ARG TARGETARCH
COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --chmod=755 snowflake-exporter-linux-${TARGETARCH} /app/snowflake-exporter
EXPOSE 9975
USER 65532:65532
ENTRYPOINT ["/app/snowflake-exporter"]
