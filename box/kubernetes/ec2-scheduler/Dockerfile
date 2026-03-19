# Runtime-only Dockerfile for cross-compiled binaries
# Binaries are built via GitHub Actions cross-compilation (not QEMU emulation)
FROM alpine:3.23

ARG TARGETARCH

RUN addgroup -S ec2-scheduler && adduser -S ec2-scheduler -G ec2-scheduler

COPY --chown=ec2-scheduler:ec2-scheduler ec2-scheduler-linux-${TARGETARCH} /usr/local/bin/ec2-scheduler

USER ec2-scheduler:ec2-scheduler
EXPOSE 8080

ENTRYPOINT ["ec2-scheduler"]
