# Statically linked binary built via GitHub Actions cross-compilation
FROM alpine:3.23 AS certs
RUN apk add --no-cache ca-certificates

FROM scratch AS runtime
ARG TARGETARCH
COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --chmod=755 kuo-linux-${TARGETARCH} /app/kuo
EXPOSE 8080
USER 65532:65532
ENTRYPOINT ["/app/kuo"]
