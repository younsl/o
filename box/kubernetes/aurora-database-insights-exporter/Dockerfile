# Statically linked binary built via GitHub Actions cross-compilation (cargo-zigbuild)
FROM alpine:3.23 AS certs
RUN apk add --no-cache ca-certificates

FROM scratch AS runtime

LABEL org.opencontainers.image.title="aurora-database-insights-exporter" \
      org.opencontainers.image.description="Prometheus exporter for AWS Aurora MySQL Database Insights (Performance Insights) metrics" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.base.name="scratch" \
      org.opencontainers.image.deprecated="false"

ARG TARGETARCH
COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --chmod=755 adie-linux-${TARGETARCH} /app/adie
EXPOSE 9090
USER 65532:65532
ENTRYPOINT ["/app/adie"]
