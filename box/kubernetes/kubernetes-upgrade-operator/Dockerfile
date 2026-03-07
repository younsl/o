# Runtime-only Dockerfile for cross-compiled binaries
# Binaries are built via GitHub Actions cross-compilation (not QEMU emulation)
FROM alpine:3.23

ARG TARGETARCH

RUN addgroup -S kuo && adduser -S kuo -G kuo

COPY --chown=kuo:kuo kuo-linux-${TARGETARCH} /usr/local/bin/kuo

USER kuo:kuo
EXPOSE 8080

ENTRYPOINT ["kuo"]
