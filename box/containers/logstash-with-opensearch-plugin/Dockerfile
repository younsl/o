# Logstash with OpenSearch output plugin
# Usage:
# docker build -t logstash-with-opensearch-plugin:8.17.0 .
# docker run --rm -it \
#   -v $(pwd)/pipeline:/usr/share/logstash/pipeline \
#   logstash-with-opensearch-plugin:8.17.0

FROM docker.elastic.co/logstash/logstash:9.2.4

LABEL maintainer="Younsung Lee <cysl@kakao.com>" \
      version="8.17.0" \
      description="Logstash with OpenSearch output plugin and Asia/Seoul timezone" \
      repository="https://github.com/younsl/box" \
      base-image="docker.elastic.co/logstash/logstash:8.17.0"

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends tzdata \
    && rm -rf /var/lib/apt/lists/*
USER logstash

ENV TZ=Asia/Seoul

RUN bin/logstash-plugin install logstash-output-opensearch \
    && bin/logstash-plugin list
