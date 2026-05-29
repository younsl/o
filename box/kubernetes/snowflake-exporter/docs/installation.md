# Installation

Install `snowflake-exporter` as a Helm release backed by the OCI chart at
`oci://ghcr.io/younsl/charts/snowflake-exporter`.

The exporter authenticates to the Snowflake SQL API v2 using a
**Programmatic Access Token (PAT)**. A PAT is a user-bound Bearer token, so
no RSA keys or passwords are involved.

## 1. Prerequisites

- Kubernetes 1.27+
- Helm 3.14+
- `crane` (optional, for listing published chart versions)
- Snowflake account with `ACCOUNTADMIN`-level privileges to run the setup
  SQL below

## 2. Snowflake setup

All SQL runs once, as `ACCOUNTADMIN`, in the **Snowsight SQL worksheet** or
via `snowsql`.

### 2.1 Identify the account identifier

The exporter needs the fully-qualified account locator used in the SQL API
hostname: `<account>.snowflakecomputing.com`. Confirm yours:

```sql
SELECT CURRENT_ORGANIZATION_NAME() || '-' || CURRENT_ACCOUNT_NAME()
       AS organization_account,
       CURRENT_REGION() AS region;
```

Either `organization_account` (e.g. `MYORG-MYACCT`) or the legacy locator
form `xy12345.ap-northeast-2.aws` works. Use whichever form matches the URL
shown in the Snowflake UI. You will pass this as
`config.snowflake.account`.

### 2.2 Create a dedicated warehouse

A tiny auto-suspending warehouse keeps exporter cost near zero — each
collection cycle is a handful of short metadata queries.

```sql
CREATE WAREHOUSE IF NOT EXISTS METRICS_WH
  WAREHOUSE_SIZE = XSMALL
  AUTO_SUSPEND = 60
  AUTO_RESUME = TRUE
  INITIALLY_SUSPENDED = TRUE
  COMMENT = 'Warehouse used by snowflake-exporter';
```

### 2.3 Create a role with read-only access to ACCOUNT_USAGE

`ACCOUNT_USAGE` lives in the shared `SNOWFLAKE` database. The exporter
needs `IMPORTED PRIVILEGES` on it plus `USAGE` on the warehouse.

```sql
CREATE ROLE IF NOT EXISTS METRICS_ROLE
  COMMENT = 'Read-only access to SNOWFLAKE.ACCOUNT_USAGE for monitoring';

GRANT IMPORTED PRIVILEGES ON DATABASE SNOWFLAKE TO ROLE METRICS_ROLE;
GRANT USAGE ON WAREHOUSE METRICS_WH TO ROLE METRICS_ROLE;

-- ACCOUNTADMIN must own the role so it can mint PATs for users holding it
GRANT ROLE METRICS_ROLE TO ROLE SYSADMIN;
```

> The role grants no write privileges, no `USAGE` on any non-`SNOWFLAKE`
> database, and no access to customer data. It can only read usage
> metadata.

### 2.4 Create a service user

Snowflake classifies users as `PERSON`, `SERVICE`, or `LEGACY_SERVICE`.
Service users cannot log in interactively and are exempt from MFA.

```sql
CREATE USER IF NOT EXISTS METRICS_USER
  TYPE = SERVICE
  DEFAULT_ROLE = METRICS_ROLE
  DEFAULT_WAREHOUSE = METRICS_WH
  COMMENT = 'Service account for snowflake-exporter';

GRANT ROLE METRICS_ROLE TO USER METRICS_USER;
```

### 2.5 (Optional) Constrain the user with a network policy

If your organization requires network policies, whitelist the cluster's
egress NAT range and attach the policy to the user (not the account) so the
restriction does not affect human operators.

```sql
CREATE NETWORK POLICY IF NOT EXISTS METRICS_NETWORK_POLICY
  ALLOWED_IP_LIST = ('203.0.113.0/24');          -- cluster NAT CIDR

ALTER USER METRICS_USER SET NETWORK_POLICY = METRICS_NETWORK_POLICY;
```

### 2.6 Generate the Programmatic Access Token

A PAT is a Bearer token scoped to the user and (optionally) a single role.
Snowflake returns the secret value **once** — copy it immediately.

```sql
ALTER USER METRICS_USER ADD PROGRAMMATIC ACCESS TOKEN snowflake_exporter
  ROLE_RESTRICTION = 'METRICS_ROLE'
  DAYS_TO_EXPIRY = 90
  COMMENT = 'Token consumed by the Kubernetes snowflake-exporter pod';
```

Snapshot of the returned row:

```
+---------------------------+---------------------------------+
| name                      | token_secret                    |
|---------------------------+---------------------------------|
| snowflake_exporter        | eyJhbGciOi... (copy this value) |
+---------------------------+---------------------------------+
```

Export it into a shell variable for the Helm install below:

```bash
export TOKEN_SECRET='eyJhbGciOi...'
```

### 2.7 Verify the PAT end-to-end

Before going through Helm, confirm the token talks to the SQL API:

```bash
curl -sS -X POST \
  "https://<account>.snowflakecomputing.com/api/v2/statements" \
  -H "Authorization: Bearer $TOKEN_SECRET" \
  -H "X-Snowflake-Authorization-Token-Type: PROGRAMMATIC_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
        "statement": "SELECT CURRENT_USER(), CURRENT_ROLE()",
        "warehouse": "METRICS_WH",
        "role": "METRICS_ROLE",
        "database": "SNOWFLAKE"
      }' | jq
```

You should see a `data` array containing `METRICS_USER` and `METRICS_ROLE`.
HTTP 401/403 means the PAT, role, or network policy is wrong — fix it at
the Snowflake layer before installing the chart.

### 2.8 Operational commands

```sql
-- List PATs for a user
SHOW USER PROGRAMMATIC ACCESS TOKENS FOR USER METRICS_USER;

-- Rotate (returns a new token_secret and keeps the old one valid for
-- MINS_TO_EXPIRY minutes so you can roll the Secret without downtime)
ALTER USER METRICS_USER ROTATE PROGRAMMATIC ACCESS TOKEN snowflake_exporter;

-- Disable (does not remove)
ALTER USER METRICS_USER MODIFY PROGRAMMATIC ACCESS TOKEN snowflake_exporter
  SET DISABLED = TRUE;

-- Remove
ALTER USER METRICS_USER REMOVE PROGRAMMATIC ACCESS TOKEN snowflake_exporter;
```

## 3. Install the chart

### Option A — chart-managed Secret (simple, for testing)

The chart creates a `Secret` containing the PAT when `auth.createSecret=true`.

```bash
helm install snowflake-exporter \
  oci://ghcr.io/younsl/charts/snowflake-exporter \
  --namespace monitoring \
  --create-namespace \
  --set config.snowflake.account=xy12345.ap-northeast-2.aws \
  --set config.snowflake.role=METRICS_ROLE \
  --set config.snowflake.warehouse=METRICS_WH \
  --set auth.token="$TOKEN_SECRET"
```

### Option B — pre-existing Secret (production)

Create the `Secret` out-of-band (External Secrets Operator, Vault, etc.):

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: snowflake-exporter-auth
  namespace: monitoring
type: Opaque
stringData:
  token: eyJhbGciOi...
```

```bash
helm install snowflake-exporter \
  oci://ghcr.io/younsl/charts/snowflake-exporter \
  --namespace monitoring \
  --create-namespace \
  --set config.snowflake.account=xy12345.ap-northeast-2.aws \
  --set config.snowflake.role=METRICS_ROLE \
  --set config.snowflake.warehouse=METRICS_WH \
  --set auth.createSecret=false \
  --set auth.existingSecret=snowflake-exporter-auth \
  --set auth.tokenSecretKey=token
```

## 4. Verify

```bash
kubectl -n monitoring rollout status deploy/snowflake-exporter
kubectl -n monitoring port-forward svc/snowflake-exporter 9975:9975 &
curl -s localhost:9975/metrics | grep '^snowflake_up'
# snowflake_up 1
```

`snowflake_up 1` means the last collection cycle succeeded. The first cycle
runs immediately at pod startup; subsequent cycles run every
`config.collection.intervalSeconds` (default `300`).

## 5. Scraping

The chart ships a `ServiceMonitor` enabled by default (requires the
Prometheus Operator CRDs). If you are not running the operator:

```bash
--set serviceMonitor.enabled=false
```

…and scrape port `9975` via your own Prometheus configuration.

## Discovering chart versions

```bash
crane ls ghcr.io/younsl/charts/snowflake-exporter
```

## Uninstalling

```bash
helm uninstall snowflake-exporter -n monitoring
```

Resources outside the chart (external `Secret`, Snowflake role/user/PAT) are
not deleted and must be cleaned up manually. Remember to `REMOVE
PROGRAMMATIC ACCESS TOKEN` on the Snowflake side.

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| `snowflake_up 0` after first cycle | Role lacks `IMPORTED PRIVILEGES` on `SNOWFLAKE` or warehouse does not exist. |
| HTTP 401 in logs | PAT expired, rotated, or removed. Generate a new one and update the Secret. |
| HTTP 403 "token is not valid for user" | PAT belongs to a different user or the user was disabled. |
| HTTP 403 with network policy error | Account network policy blocks the exporter's egress. Add cluster NAT IPs to the policy. |
| Metrics missing `table_*` | Account has extremely large `TABLE_STORAGE_METRICS`; set `config.collection.excludeDeletedTables=true`. |
| `token_path is required` | The Secret key did not land at the mount path. Check `auth.tokenSecretKey` matches the key in your Secret. |
