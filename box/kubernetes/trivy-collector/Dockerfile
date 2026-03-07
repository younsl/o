# Runtime-only Dockerfile for cross-compiled binaries
# Binaries are built via GitHub Actions cross-compilation (not QEMU emulation)
FROM alpine:3.23

ARG TARGETARCH

RUN apk add --no-cache ca-certificates

RUN addgroup -g 1000 trivy && \
    adduser -D -u 1000 -G trivy trivy

RUN mkdir -p /data && chown trivy:trivy /data

USER trivy
WORKDIR /app

COPY --chown=trivy:trivy trivy-collector-linux-${TARGETARCH} /app/trivy-collector

EXPOSE 3000 8080

ENV MODE=server
ENV STORAGE_PATH=/data
ENV SERVER_PORT=3000
ENV HEALTH_PORT=8080
ENV LOG_FORMAT=json

ENTRYPOINT ["/app/trivy-collector"]
