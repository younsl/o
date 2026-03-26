# Statically linked binary built via GitHub Actions cross-compilation
FROM alpine:3.23 AS certs
RUN apk add --no-cache ca-certificates

FROM scratch AS runtime
ARG TARGETARCH
COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --chmod=755 trivy-collector-linux-${TARGETARCH} /app/trivy-collector
EXPOSE 3000 8080
ENV MODE=server \
    STORAGE_PATH=/data \
    SERVER_PORT=3000 \
    HEALTH_PORT=8080 \
    LOG_FORMAT=json
USER 1000:1000
ENTRYPOINT ["/app/trivy-collector"]
