# ==============================================================================
# Backstage Custom Image with GitLab Auto Discovery
# ==============================================================================
# Compatible with official Backstage Helm chart (https://github.com/backstage/charts)
#
# Build pattern follows official Backstage Dockerfile:
#   Stage 1 (build): Build with devDependencies
#   Stage 2 (runner): Extract skeleton → install prod deps → extract bundle
#
# Requires: Yarn Berry (4.x) with nodeLinker: node-modules
# ==============================================================================

# ------------------------------------------------------------------------------
# Stage 1: Build the Backstage app
# ------------------------------------------------------------------------------
FROM node:25-bookworm-slim AS build

# Install build dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        python3 \
        g++ \
        build-essential \
        git \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install and enable corepack for Yarn Berry (not included in slim image)
RUN npm install -g corepack --force && corepack enable

WORKDIR /app

# Copy Yarn Berry configuration
COPY .yarn ./.yarn
COPY .yarnrc.yml ./

# Copy package files for dependency caching
COPY package.json yarn.lock ./
COPY packages/backend/package.json packages/backend/
COPY packages/app/package.json packages/app/
COPY plugins/openapi-registry/package.json plugins/openapi-registry/
COPY plugins/openapi-registry-backend/package.json plugins/openapi-registry-backend/

# Install all dependencies (including devDependencies for build)
RUN yarn install --immutable

# Copy source files
COPY . .

# Build backend and frontend
RUN yarn tsc && \
    yarn build:backend && \
    yarn build:all

# ------------------------------------------------------------------------------
# Stage 2: Production image (official Backstage pattern)
# ------------------------------------------------------------------------------
FROM node:25-bookworm-slim AS runner

LABEL org.opencontainers.image.title="Backstage with GitLab Discovery" \
      org.opencontainers.image.description="Backstage instance with GitLab auto-discovery and API docs plugins" \
      org.opencontainers.image.source="https://github.com/younsl/o"

# Install runtime dependencies and build tools for native modules
# Build tools (python3, g++, build-essential) are needed for yarn workspaces focus
# to compile native dependencies like better-sqlite3, tree-sitter, etc.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        python3 \
        g++ \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install and enable corepack for Yarn Berry (not included in slim image)
RUN npm install -g corepack --force && corepack enable

# Set production environment
ENV NODE_ENV=production
ENV NODE_OPTIONS=--no-node-snapshot

# Use /app as working directory (required by official Helm chart)
WORKDIR /app

# Change ownership to node user
RUN chown node:node /app

USER node

# Copy root package.json and yarn.lock (required for workspaces)
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/yarn.lock ./

# Copy skeleton from build stage
COPY --from=build --chown=node:node /app/packages/backend/dist/skeleton.tar.gz ./

# Extract skeleton (package.json for backend workspace)
RUN tar xzf skeleton.tar.gz && rm skeleton.tar.gz

# Copy Yarn Berry configuration AFTER skeleton extraction
COPY --from=build --chown=node:node /app/.yarn ./.yarn
COPY --from=build --chown=node:node /app/.yarnrc.yml ./

# Copy app workspace package.json BEFORE yarn install
# This allows yarn to create proper workspace symlinks (node_modules/app -> packages/app)
# plugin-app-backend uses resolvePackagePath('app') which requires this symlink
COPY --from=build --chown=node:node /app/packages/app/package.json ./packages/app/

# Copy plugins package.json for workspace resolution
COPY --from=build --chown=node:node /app/plugins/openapi-registry/package.json ./plugins/openapi-registry/
COPY --from=build --chown=node:node /app/plugins/openapi-registry-backend/package.json ./plugins/openapi-registry-backend/

# Install production dependencies only (Yarn Berry feature)
# Uses cached packages from .yarn/cache
RUN yarn workspaces focus --all --production

# Copy and extract bundle (compiled backend code)
COPY --from=build --chown=node:node /app/packages/backend/dist/bundle.tar.gz ./
RUN tar xzf bundle.tar.gz && rm bundle.tar.gz

# Copy frontend build (served by plugin-app-backend)
COPY --from=build --chown=node:node /app/packages/app/dist ./packages/app/dist

# Copy config schema for Backstage config-loader
# Required: package.json references configSchema: "config.d.ts"
COPY --from=build --chown=node:node /app/packages/app/config.d.ts ./packages/app/

# Copy templates for scaffolder
COPY --from=build --chown=node:node /app/templates ./templates

# Expose Backstage backend port
EXPOSE 7007

# Health check compatible with official Helm chart probes
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:7007/.backstage/health/v1/readiness || exit 1

# Default command (official Helm chart uses: node packages/backend)
# Config files should be mounted via Helm chart's appConfig or extraVolumes
CMD ["node", "packages/backend"]
