# Statically linked binary built via GitHub Actions cross-compilation (cargo-zigbuild)
FROM scratch AS runtime

LABEL org.opencontainers.image.title="filesystem-cleaner" \
      org.opencontainers.image.description="Kubernetes sidecar/init filesystem cleaner for managing disk space" \
      org.opencontainers.image.version="0.4.0" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.base.name="scratch" \
      org.opencontainers.image.deprecated="false"

ARG TARGETARCH
COPY --chmod=755 filesystem-cleaner-linux-${TARGETARCH} /app/filesystem-cleaner
USER 65532:65532
ENTRYPOINT ["/app/filesystem-cleaner"]
