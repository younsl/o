# Statically linked binary built via GitHub Actions cross-compilation (cargo-zigbuild)
FROM alpine:3.23 AS certs
RUN apk add --no-cache ca-certificates

FROM scratch AS runtime

LABEL org.opencontainers.image.title="kuo" \
      org.opencontainers.image.description="Kubernetes operator for declarative EKS cluster upgrades" \
      org.opencontainers.image.version="0.2.0" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.base.name="scratch" \
      org.opencontainers.image.deprecated="false"

ARG TARGETARCH
COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --chmod=755 kuo-linux-${TARGETARCH} /app/kuo
EXPOSE 8080
USER 65532:65532
ENTRYPOINT ["/app/kuo"]
