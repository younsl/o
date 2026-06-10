# ec2-metadata-exporter

Prometheus exporter that polls the EC2 DescribeInstances API and publishes
every instance's private IP and Name tag as metric labels. Built with Go 1.26
and shipped as a statically linked binary on a scratch image.

## Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `ec2_metadata_instance_info{instance_id, name, private_ip, instance_type, availability_zone, state}` | Gauge | Always 1. One series per non-terminated instance with a private IP. |
| `ec2_metadata_instances` | Gauge | Instance count from the last successful scrape. |
| `ec2_metadata_scrape_errors_total` | Counter | EC2 API scrape failures. |
| `ec2_metadata_scrape_duration_seconds` | Gauge | Duration of the last scrape. |
| `ec2_metadata_last_scrape_success_timestamp_seconds` | Gauge | Unix time of the last successful scrape. |

Example output:

```
ec2_metadata_instance_info{instance_id="i-0abc123",name="web-1",private_ip="10.0.1.10",instance_type="m5.large",availability_zone="ap-northeast-2a",state="running"} 1
```

The info gauge is fully reset on every refresh, so terminated instances drop
out instead of going stale.

## Configuration

All settings come from environment variables.

| Variable | Default | Description |
|----------|---------|-------------|
| `AWS_REGION` | SDK default chain | Region to scan. |
| `SCRAPE_INTERVAL` | `60s` | EC2 API polling interval (Go duration, min `1s`). |
| `METRICS_PORT` | `8081` | Port serving `/metrics`. |
| `HEALTH_PORT` | `8080` | Port serving `/healthz` and `/readyz`. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |
| `LOG_FORMAT` | `json` | `json` or `text`. |

## Required IAM permissions

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "ec2:DescribeInstances",
      "Resource": "*"
    }
  ]
}
```

AWS credentials resolve through the SDK default chain (environment variables,
shared config, IRSA, or instance profile).

## Usage

```bash
# Local run
AWS_REGION=ap-northeast-2 LOG_FORMAT=text make run

# Container
docker run --rm -p 8081:8081 \
  -e AWS_REGION=ap-northeast-2 \
  -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_SESSION_TOKEN \
  ghcr.io/younsl/ec2-metadata-exporter:latest

curl -s localhost:8081/metrics | grep ec2_metadata_instance_info
```

## Helm

```bash
helm install ec2-metadata-exporter ./charts/ec2-metadata-exporter \
  --namespace monitoring \
  --create-namespace \
  --set config.region=ap-northeast-2 \
  --set serviceMonitor.enabled=true \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=arn:aws:iam::123456789012:role/ec2-metadata-exporter
```

The chart is also released to the OCI registry on Chart.yaml version bumps:

```bash
crane ls ghcr.io/younsl/charts/ec2-metadata-exporter
helm install ec2-metadata-exporter oci://ghcr.io/younsl/charts/ec2-metadata-exporter --version 0.1.0
```

See [charts/ec2-metadata-exporter/README.md](charts/ec2-metadata-exporter/README.md) for all values.

## Development

```bash
make build      # Compile binary into bin/
make test       # Run tests with race detector
make coverage   # Enforce 70% minimum line coverage
make lint       # gofmt check + go vet
make all        # fmt + vet + lint + test + build
```
