# Runtime stage only — binary is pre-built by CI
FROM alpine:3.23

ARG TARGETARCH

# Install CA certificates for HTTPS
RUN apk add --no-cache ca-certificates

# Copy pre-built binary from CI artifacts
COPY linux/${TARGETARCH}/promdrop /usr/local/bin/promdrop
RUN chmod +x /usr/local/bin/promdrop

# Create non-root user
RUN adduser -D -u 1000 promdrop

# Set working directory
WORKDIR /data

# Switch to non-root user
USER promdrop

# Set entrypoint
ENTRYPOINT ["promdrop"]

# Default command (show help)
CMD ["--help"]
