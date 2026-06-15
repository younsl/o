# Jenkins inbound agent with sshpass and AWS CLI v2 baked in.
# Extends the upstream inbound-agent used by pay/prepay-jenkins batch agents so
# jobs can run `aws s3 cp` and sshpass-based steps without runtime installs.
#
# Usage:
#   docker build -t jenkins-inbound-agent:3355.v388858a_47b_33-19 .
#   docker run --rm -it jenkins-inbound-agent:3355.v388858a_47b_33-19 aws --version

ARG BASE_IMAGE=jenkins/inbound-agent
ARG BASE_TAG=3355.v388858a_47b_33-19
ARG AWSCLI_VERSION=2.22.35

# --- Stage 1: install AWS CLI v2 into an isolated prefix ---
FROM ${BASE_IMAGE}:${BASE_TAG} AS awscli
ARG AWSCLI_VERSION
ARG TARGETARCH
USER root
RUN set -eux; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "${arch}" in \
      amd64) awscli_arch="x86_64" ;; \
      arm64) awscli_arch="aarch64" ;; \
      *) echo "unsupported arch: ${arch}" >&2; exit 1 ;; \
    esac; \
    apt-get update; \
    apt-get install -y --no-install-recommends curl unzip ca-certificates; \
    curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${awscli_arch}-${AWSCLI_VERSION}.zip" -o /tmp/awscliv2.zip; \
    unzip -q /tmp/awscliv2.zip -d /tmp; \
    /tmp/aws/install -i /opt/aws-cli -b /usr/local/bin; \
    rm -rf /tmp/aws /tmp/awscliv2.zip /var/lib/apt/lists/*

# --- Stage 2: final agent image ---
FROM ${BASE_IMAGE}:${BASE_TAG}

LABEL maintainer="Younsung Lee <cysl@kakao.com>" \
      org.opencontainers.image.title="jenkins-inbound-agent" \
      org.opencontainers.image.description="Jenkins inbound agent with sshpass and AWS CLI v2 baked in" \
      org.opencontainers.image.version="3355.v388858a_47b_33-19" \
      org.opencontainers.image.base.name="docker.io/jenkins/inbound-agent:3355.v388858a_47b_33-19" \
      org.opencontainers.image.source="https://github.com/younsl/o" \
      org.opencontainers.image.deprecated="false"

# sshpass via apt (replaces the runtime apk install done by the agent init container)
USER root
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends sshpass; \
    rm -rf /var/lib/apt/lists/*

# AWS CLI v2 from the builder stage (no curl/unzip left in the final image).
# Copy the install tree and recreate the bin symlinks here; copying the
# /usr/local/bin/aws symlink directly would dereference it and break the CLI's
# relative bundled-library lookup (libpython).
COPY --from=awscli /opt/aws-cli /opt/aws-cli
RUN set -eux; \
    ln -s /opt/aws-cli/v2/current/bin/aws /usr/local/bin/aws; \
    ln -s /opt/aws-cli/v2/current/bin/aws_completer /usr/local/bin/aws_completer

# Back to the unprivileged agent user; inherit the base ENTRYPOINT (jenkins-agent)
USER jenkins

# Build-time sanity check
RUN aws --version && sshpass -V
