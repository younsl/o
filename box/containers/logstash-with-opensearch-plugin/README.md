# logstash-with-opensearch-plugin

[![GHCR](https://img.shields.io/badge/ghcr.io-younsl%2Flogstash--with--opensearch--plugin-000000?style=flat-square&logo=github&logoColor=white)](https://github.com/younsl/o/pkgs/container/logstash-with-opensearch-plugin)
[![Logstash](https://img.shields.io/badge/logstash-8.17.0-005571?style=flat-square&logo=elastic&logoColor=white)](https://www.elastic.co/logstash)

Logstash image with pre-installed OpenSearch output plugin for ECK (Elastic Cloud on Kubernetes) Operator.

## Background

The official Logstash image does not include the `logstash-output-opensearch` plugin by default. Installing the plugin via initContainer causes startup times exceeding 5 minutes, which is unacceptable for production workloads.

This image solves the problem by pre-installing the plugin at build time.

## Features

- Based on `docker.elastic.co/logstash/logstash:8.17.0`
- Pre-installed `logstash-output-opensearch` plugin
- Timezone set to `Asia/Seoul`

## Usage

### Docker

```bash
docker build -t logstash-with-opensearch-plugin:8.17.0 .
docker run --rm -it \
  -v $(pwd)/pipeline:/usr/share/logstash/pipeline \
  logstash-with-opensearch-plugin:8.17.0
```

### ECK Operator

Example of using this image in a Logstash resource managed by ECK Operator:

```yaml
apiVersion: logstash.k8s.elastic.co/v1alpha1
kind: Logstash
metadata:
  name: logstash
spec:
  version: 8.17.0
  count: 1
  podTemplate:
    spec:
      containers:
        - name: logstash
          image: ghcr.io/younsl/logstash-with-opensearch-plugin:8.17.0
          resources:
            requests:
              memory: 2Gi
              cpu: 1
            limits:
              memory: 2Gi
  pipelines:
    - pipeline.id: main
      config.string: |
        input {
          beats {
            port => 5044
          }
        }
        output {
          opensearch {
            hosts => ["https://opensearch:9200"]
            index => "logs-%{+YYYY.MM.dd}"
          }
        }
```

## Container Registry

Published to GitHub Container Registry:

```
ghcr.io/younsl/logstash-with-opensearch-plugin:<TAG>
```
