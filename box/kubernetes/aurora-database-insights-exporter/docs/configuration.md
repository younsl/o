# Configuration

aurora-database-insights-exporter is configured via a YAML file. By default, it reads `/etc/adie/config.yaml`. Override with `--config <path>`.

## Config file

```yaml
server:
  listen_address: "0.0.0.0:9090"

aws:
  region: "ap-northeast-2"

discovery:
  interval_seconds: 300
  exported_tags:
    - Team
    - Environment
  include:
    identifier: ["^prod-"]
  exclude:
    identifier: ["-test$"]

collection:
  interval_seconds: 60
  top_sql_limit: 10
  top_host_limit: 20

logging:
  level: "info"
  format: "json"
```

## CLI flags

CLI flags override config file values.

| Flag | Env | Default | Description |
|------|-----|---------|-------------|
| `-c, --config` | `ADIE_CONFIG` | `/etc/adie/config.yaml` | Config file path |
| `-p, --port` | `ADIE_PORT` | — | Listen port override |
| `--region` | `ADIE_AWS_REGION` | — | AWS region override |
| `--log-level` | `ADIE_LOG_LEVEL` | — | Log level override |
| `--log-format` | `ADIE_LOG_FORMAT` | — | Log format override (json/text) |

## Run locally

```bash
adie --config config.example.yaml --log-format text --log-level debug
```

## IAM permissions

Minimum IAM policy required for the exporter.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "RDSDiscovery",
      "Effect": "Allow",
      "Action": [
        "rds:DescribeDBInstances"
      ],
      "Resource": "arn:aws:rds:*:*:db:*"
    },
    {
      "Sid": "PerformanceInsightsRead",
      "Effect": "Allow",
      "Action": [
        "pi:GetResourceMetrics",
        "pi:DescribeDimensionKeys",
        "pi:GetDimensionKeyDetails",
        "pi:ListAvailableResourceMetrics"
      ],
      "Resource": "arn:aws:pi:*:*:metrics/rds/*"
    }
  ]
}
```