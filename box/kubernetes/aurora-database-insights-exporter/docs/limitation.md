# Limitation

Known limitations of the AWS Performance Insights API that affect aurora-database-insights-exporter. This document covers engine-specific restrictions, unsupported metric types, and available workarounds.

## Per-SQL statistics not available for Aurora MySQL via PI API

The AWS PI console displays Calls/sec and Avg latency(ms)/call for Top SQL, but the `AdditionalMetrics` parameter on `DescribeDimensionKeys` returns `InvalidArgumentException` on Aurora MySQL. Aurora PostgreSQL supports this parameter via `pg_stat_statements`.

Despite [AWS documentation listing 45 per-SQL metrics](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/USER_PerfInsights.UsingDashboard.AnalyzeDBLoad.AdditionalMetrics.MySQL.html) sourced from `performance_schema.events_statements_summary_by_digest` for Aurora MySQL, the PI API does not accept them as `AdditionalMetrics` input.

### API response example

Successful `DescribeDimensionKeys` call without `AdditionalMetrics`:

```json
{
    "AlignedStartTime": "2026-04-06T14:51:00+09:00",
    "AlignedEndTime": "2026-04-06T14:53:00+09:00",
    "Keys": [
        {
            "Dimensions": {
                "db.sql_tokenized.id": "D656969114571343892FCC9B7BECF7E387A2B7F1",
                "db.sql_tokenized.statement": "COMMIT"
            },
            "Total": 0.15
        },
        {
            "Dimensions": {
                "db.sql_tokenized.id": "2D10CCBFC50A2877EB2015280E5AFA919BE83447",
                "db.sql_tokenized.statement": "SELECT `te1_0` . `access_token` , ..."
            },
            "Total": 0.016666666666666666
        }
    ]
}
```

Failed call with `AdditionalMetrics` on Aurora MySQL:

```json
{
    "__type": "InvalidArgumentException",
    "Message": "The specified metric is not a known metric"
}
```

### What PI API can provide for Aurora MySQL SQL

| Field | Dimension | Description |
|-------|-----------|-------------|
| SQL ID | `db.sql_tokenized.id` | Tokenized SQL identifier |
| SQL Text | `db.sql_tokenized.statement` | Tokenized SQL text |
| DB Load (AAS) | `db.load.avg` | Average Active Sessions consumed by the SQL |

### What PI API cannot provide for Aurora MySQL SQL

| Field | Reason |
|-------|--------|
| Calls/sec | `AdditionalMetrics` not supported for MySQL engine |
| Avg latency(ms)/call | `AdditionalMetrics` not supported for MySQL engine |

### Aurora PostgreSQL supports AdditionalMetrics

Aurora PostgreSQL returns per-SQL statistics via the `AdditionalMetrics` parameter, sourced from [`pg_stat_statements`](https://www.postgresql.org/docs/current/pgstatstatements.html). Key metrics include:

| Metric | Description |
|--------|-------------|
| `db.sql_tokenized.stats.calls_per_sec.avg` | SQL executions per second |
| `db.sql_tokenized.stats.avg_latency_per_call.avg` | Average latency per execution (ms) |
| `db.sql_tokenized.stats.rows_per_call.avg` | Rows returned per execution |
| `db.sql_tokenized.stats.shared_blks_hit_per_call.avg` | Shared buffer hits per execution |
| `db.sql_tokenized.stats.shared_blks_read_per_call.avg` | Disk reads per execution |

Full list of 43 metrics available in [Aurora PostgreSQL SQL statistics documentation](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/USER_PerfInsights.UsingDashboard.AnalyzeDBLoad.AdditionalMetrics.PostgreSQL.html).

### Alternative for Aurora MySQL

Query `performance_schema.events_statements_summary_by_digest` directly via MySQL connection. In the Prometheus ecosystem, [mysqld_exporter](https://github.com/prometheus/mysqld_exporter) serves this purpose.

### Reference

- [DescribeDimensionKeys API](https://docs.aws.amazon.com/performance-insights/latest/APIReference/API_DescribeDimensionKeys.html) — `AdditionalMetrics` parameter specification
- [Aurora MySQL SQL statistics](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/USER_PerfInsights.UsingDashboard.AnalyzeDBLoad.AdditionalMetrics.MySQL.html) — 45 metrics documented but not available via API
- [Aurora PostgreSQL SQL statistics](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/USER_PerfInsights.UsingDashboard.AnalyzeDBLoad.AdditionalMetrics.PostgreSQL.html) — 43 metrics available via `AdditionalMetrics`
- [pg_stat_statements](https://www.postgresql.org/docs/current/pgstatstatements.html) — Source of PostgreSQL per-SQL statistics
- Verified on Aurora MySQL 3.x, ap-northeast-2, 2026-04-06
