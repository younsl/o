# Container Images

This directory contains custom container images for various DevOps and development purposes.

Inspired by [bitnami/containers](https://github.com/bitnami/containers).

## Available Images

Production-ready container images for DevOps automation, development tooling, and Kubernetes workloads. All images are hosted on [ghcr.io](https://github.com/younsl?tab=packages) (GitHub Container Registry).

| # | Name | Description | Image | Helm Chart | Remark |
|---|------|-------------|-------|------------|--------|
| 1 | [backstage](./backstage/) | Backstage 1.47.3 with GitLab and API Auto Discovery plugins | [ghcr.io/younsl/backstage](https://github.com/younsl/o/pkgs/container/backstage) | - | - |
| 2 | [filesystem-cleaner](./filesystem-cleaner/) | Sidecar container that monitors and cleans specified directories | [ghcr.io/younsl/filesystem-cleaner](https://github.com/younsl/o/pkgs/container/filesystem-cleaner) | - | - |
| 3 | [logstash-with-opensearch-plugin](./logstash-with-opensearch-plugin/) | Logstash 8.17.0 with OpenSearch output plugin and Asia/Seoul timezone | [ghcr.io/younsl/logstash-with-opensearch-plugin](https://github.com/younsl/o/pkgs/container/logstash-with-opensearch-plugin) | - | - |

## References

- **Helm Charts**: [younsl/charts](https://github.com/younsl/charts) - Helm charts repository maintained by me (younsl) that uses these container images

## License

This project is licensed under the MIT License - see the [LICENSE](../../LICENSE) file in the project root for details.
