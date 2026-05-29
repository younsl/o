# logstash-with-opensearch-plugin

[![GHCR](https://img.shields.io/badge/ghcr.io-younsl%2Flogstash--with--opensearch--plugin-000000?style=flat-square&logo=github&logoColor=white)](https://github.com/younsl/o/pkgs/container/logstash-with-opensearch-plugin)
[![Logstash](https://img.shields.io/badge/logstash-8.19.0-005571?style=flat-square&logo=elastic&logoColor=white)](https://www.elastic.co/logstash)

[Logstash](https://github.com/elastic/logstash) image with [`logstash-output-opensearch`](https://github.com/opensearch-project/logstash-output-opensearch) pre-installed, for use with the [ECK](https://github.com/elastic/cloud-on-k8s) Operator.

## Background

The official Logstash image does not bundle the [OpenSearch](https://github.com/opensearch-project/OpenSearch) output plugin (still true on 9.x). Installing it via initContainer adds 5+ minutes to startup. This image installs the plugin at build time.

OpenSearch publishes a similar prebuilt image, [`opensearchproject/logstash-oss-with-opensearch-output-plugin`](https://hub.docker.com/r/opensearchproject/logstash-oss-with-opensearch-output-plugin), but it is based on `logstash-oss` and is not compatible with the [ECK](https://github.com/elastic/cloud-on-k8s) Operator, which requires the official `docker.elastic.co/logstash/logstash` base. This repo exists to fill that gap.

## Features

- Base: `docker.elastic.co/logstash/logstash:8.19.0` (ECK-compatible)
- Pre-installed [`logstash-output-opensearch`](https://github.com/opensearch-project/logstash-output-opensearch)
- Timezone: `Asia/Seoul`

## Logstash Lifecycle Policy

Elastic Stack minors follow a defined maintenance window after GA, after which they stop receiving bug fixes and security patches. Some minors near the end of a major line carry shortened windows tied to the release date of a later minor rather than the line-wide End of Maintenance date. Running an out-of-maintenance minor means no CVE coverage from upstream.

This image tracks a minor that is still under active maintenance. For the current End of Maintenance / End of Support dates and any footnoted exceptions, refer to the [Elastic Product End of Life Policy](https://www.elastic.co/support/eol) and the per-minor lifecycle on [endoflife.date — Logstash](https://endoflife.date/logstash).

Maintenance status of the two minors relevant to this image — the previously used 8.17 and the currently pinned 8.19:

| Version | Released   | End of Maintenance | Status                |
| ------- | ---------- | ------------------ | --------------------- |
| 8.17    | 2024-12-04 | 2025-07-14         | Out of maintenance    |
| 8.19    | 2025-07-14 | 2027-07-15         | Actively maintained   |

## Usage

```yaml
apiVersion: logstash.k8s.elastic.co/v1alpha1
kind: Logstash
metadata:
  name: logstash
spec:
  version: 8.19.0
  count: 1
  podTemplate:
    spec:
      containers:
        - name: logstash
          image: ghcr.io/younsl/logstash-with-opensearch-plugin:8.19.0
  pipelines:
    - pipeline.id: main
      config.string: |
        input  { beats { port => 5044 } }
        output {
          opensearch {
            hosts => ["https://opensearch:9200"]
            index => "logs-%{+YYYY.MM.dd}"
          }
        }
```

`spec.version` must match the image tag, and `podTemplate.spec.containers[].image` overrides ECK's default image to swap in this prebuilt one. The `opensearch { ... }` output is provided by the bundled plugin, so no initContainer or plugin install step is needed.

Image: `ghcr.io/younsl/logstash-with-opensearch-plugin:<TAG>`
