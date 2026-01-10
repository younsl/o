# Build stage
FROM rust:1.92-alpine3.22 AS builder

# Build arguments for version info
ARG VERSION=dev
ARG GIT_COMMIT=unknown
ARG BUILD_DATE=unknown

WORKDIR /app

# Install build dependencies including UPX for binary compression
RUN apk add --no-cache musl-dev git upx

# Copy manifests
COPY Cargo.toml Cargo.lock ./
COPY build.rs ./

# Create dummy main to cache dependencies
RUN mkdir src && \
    echo "fn main() {}" > src/main.rs && \
    cargo build --release && \
    rm -rf src target/release/deps/trivy_collector* target/release/trivy-collector*

# Copy source code and static files
COPY src ./src
COPY static ./static

# Build for release with version info from build args
RUN GIT_COMMIT=${GIT_COMMIT} BUILD_DATE="${BUILD_DATE}" \
    cargo build --release --locked

# Strip debug symbols and compress with UPX
RUN strip /app/target/release/trivy-collector && \
    upx --best --lzma /app/target/release/trivy-collector

# Runtime stage
FROM alpine:3.23 AS runtime

# Install ca-certificates for HTTPS connections
RUN apk add --no-cache ca-certificates

# Create non-root user
RUN addgroup -g 1000 trivy && \
    adduser -D -u 1000 -G trivy trivy

# Create data directory
RUN mkdir -p /data && chown trivy:trivy /data

USER trivy
WORKDIR /app

# Copy compressed binary with ownership set
COPY --from=builder --chown=trivy:trivy /app/target/release/trivy-collector /app/trivy-collector

# Expose ports (API: 3000, Health: 8080)
EXPOSE 3000 8080

# Default to server mode
ENV MODE=server
ENV STORAGE_PATH=/data
ENV SERVER_PORT=3000
ENV HEALTH_PORT=8080
ENV LOG_FORMAT=json

ENTRYPOINT ["/app/trivy-collector"]
