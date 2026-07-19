# ec2-metadata-exporter

[![GitHub Container Registry](https://img.shields.io/badge/ghcr.io-ec2--metadata--exporter-black?style=flat-square&logo=docker&logoColor=white)](https://github.com/younsl/o/pkgs/container/ec2-metadata-exporter)
[![Helm Chart](https://img.shields.io/badge/ghcr.io-charts%2Fec2--metadata--exporter-black?style=flat-square&logo=helm&logoColor=white)](https://github.com/younsl/o/pkgs/container/charts%2Fec2-metadata-exporter)
[![Go](https://img.shields.io/badge/go-1.26.5-black?style=flat-square&logo=go&logoColor=white)](https://go.dev/)
[![GitHub license](https://img.shields.io/github/license/younsl/o?style=flat-square&color=black)](https://github.com/younsl/o/blob/main/LICENSE)

Prometheus exporter that polls the EC2 DescribeInstances API and publishes
every instance's private IP and Name tag as metric labels. Built with Go 1.26
and shipped as a statically linked binary on a scratch image.

## Metrics

The exporter serves metrics on `/metrics` (default port `8081`). All metric
names share the prefix `ec2_metadata_`. See [docs/metrics.md](docs/metrics.md)
for the full metric reference, example queries, and alerting hints.

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
