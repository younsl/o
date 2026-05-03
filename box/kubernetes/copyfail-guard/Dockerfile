# Statically linked binary built via cargo-zigbuild (musl) with the eBPF object
# embedded in the binary at compile time. See Makefile and CI workflow.
FROM scratch AS runtime

LABEL org.opencontainers.image.title="copyfail-guard" \
      org.opencontainers.image.description="Kubernetes DaemonSet that blocks AF_ALG socket creation to mitigate CVE-2026-31431 (Copy.Fail) via eBPF LSM/tracepoint" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.base.name="scratch" \
      org.opencontainers.image.deprecated="false"

ARG TARGETARCH
COPY --chmod=755 copyfail-guard-linux-${TARGETARCH} /app/copyfail-guard
ENTRYPOINT ["/app/copyfail-guard"]
