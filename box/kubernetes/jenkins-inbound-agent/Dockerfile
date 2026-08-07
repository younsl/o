ARG BASE_IMAGE=jenkins/inbound-agent
ARG BASE_TAG=3355.v388858a_47b_33-19
ARG AWSCLI_VERSION=2.22.35

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

FROM ${BASE_IMAGE}:${BASE_TAG}

LABEL maintainer="Younsung Lee <cysl@kakao.com>" \
      org.opencontainers.image.title="jenkins-inbound-agent" \
      org.opencontainers.image.description="Jenkins inbound agent with sshpass and AWS CLI v2 baked in" \
      org.opencontainers.image.version="3355.v388858a_47b_33-19" \
      org.opencontainers.image.base.name="docker.io/jenkins/inbound-agent:3355.v388858a_47b_33-19" \
      org.opencontainers.image.source="https://github.com/younsl/o" \
      org.opencontainers.image.deprecated="false"

USER root
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends sshpass; \
    rm -rf /var/lib/apt/lists/*

COPY --from=awscli /opt/aws-cli /opt/aws-cli
RUN set -eux; \
    ln -s /opt/aws-cli/v2/current/bin/aws /usr/local/bin/aws; \
    ln -s /opt/aws-cli/v2/current/bin/aws_completer /usr/local/bin/aws_completer

USER jenkins

RUN aws --version && sshpass -V
