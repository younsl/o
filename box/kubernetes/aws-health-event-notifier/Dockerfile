# Statically linked binary built via GitHub Actions cross-compilation (cargo-zigbuild)
FROM alpine:3.23 AS certs
RUN apk add --no-cache ca-certificates

FROM scratch AS runtime

LABEL org.opencontainers.image.title="aws-health-event-notifier" \
      org.opencontainers.image.description="Receives AWS Health events and posts them to Slack" \
      org.opencontainers.image.version="0.2.0" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.base.name="scratch" \
      org.opencontainers.image.deprecated="false"

ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

ARG TARGETARCH
COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --chmod=755 aws-health-event-notifier-linux-${TARGETARCH} /app/aws-health-event-notifier
EXPOSE 8081
USER 65532:65532
ENTRYPOINT ["/app/aws-health-event-notifier"]
