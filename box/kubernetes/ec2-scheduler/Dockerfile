# Runtime-only Dockerfile for cross-compiled static binaries
# Binaries are built via GitHub Actions cross-compilation (not QEMU emulation)
FROM scratch

ARG TARGETARCH

COPY ec2-scheduler-linux-${TARGETARCH} /ec2-scheduler

USER 65532:65532
EXPOSE 8080

ENTRYPOINT ["/ec2-scheduler"]
