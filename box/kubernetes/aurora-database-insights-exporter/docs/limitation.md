# Limitation

## Per-SQL statistics not available for Aurora MySQL

The AWS PI console displays Calls/sec and Avg latency(ms)/call for Top SQL, but the public PI API does not expose these metrics for Aurora MySQL.

The `AdditionalMetrics` parameter on `DescribeDimensionKeys` is PostgreSQL-only (`pg_stat_statements`). All metric name variants return `InvalidArgumentException` on Aurora MySQL.

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

### Alternative

Query `performance_schema.events_statements_summary_by_digest` directly via MySQL connection. In the Prometheus ecosystem, [mysqld_exporter](https://github.com/prometheus/mysqld_exporter) serves this purpose.

### Reference

- [DescribeDimensionKeys API](https://docs.aws.amazon.com/performance-insights/latest/APIReference/API_DescribeDimensionKeys.html)
- Verified on Aurora MySQL, ap-northeast-2, 2026-04-06
