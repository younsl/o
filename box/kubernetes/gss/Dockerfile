# Build stage
FROM rust:1.93-alpine AS builder

WORKDIR /app

# Install build dependencies for Alpine
RUN apk add --no-cache \
    musl-dev \
    pkgconfig \
    openssl-dev \
    openssl-libs-static

# Copy manifests
COPY Cargo.toml Cargo.lock ./
COPY build.rs ./

# Create dummy main.rs to build dependencies
RUN mkdir src && \
    echo "fn main() {}" > src/main.rs && \
    cargo build --release && \
    rm -rf src

# Copy source code
COPY src ./src

# Build application with metadata from CI
ARG BUILD_DATE
ARG GIT_COMMIT

ENV BUILD_DATE=${BUILD_DATE}
ENV GIT_COMMIT=${GIT_COMMIT}

RUN cargo build --release

# Runtime stage
FROM alpine:3.23 AS runtime

WORKDIR /app

# Install runtime dependencies
RUN apk add --no-cache \
    ca-certificates \
    libgcc

# Create non-root user and group
RUN addgroup -g 1000 appgroup && \
    adduser -D -u 1000 -G appgroup appuser

# Create directory for exclude repos config
RUN mkdir -p /etc/gss && \
    chown -R appuser:appgroup /etc/gss /app

# Copy binary from builder
COPY --from=builder /app/target/release/ghes-schedule-scanner /usr/local/bin/ghes-schedule-scanner

# Change ownership of the binary
RUN chown appuser:appgroup /usr/local/bin/ghes-schedule-scanner

# Switch to non-root user
USER 1000:1000

ENTRYPOINT ["/usr/local/bin/ghes-schedule-scanner"]
