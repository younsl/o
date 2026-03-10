# Kafka Topic

Custom plugin for self-service Kafka topic creation with in-app approval workflow.

## Features

- 4-step creation wizard (Cluster Info → Topics → Config → Simulate & Create)
- Per-cluster approval workflow (`requiresApproval` config)
- Admin review detail page with mandatory reason for approve/reject
- Deep linking for request detail pages (`/kafka-topic/requests/:id`)
- Approval pipeline visualization with person icons and status colors
- Partition distribution simulator with broker failure simulation
- Topic list with search highlighting, partition/RF/warning filters
- Cluster version display from broker metadata

## Configuration

### Cluster Settings

```yaml
# app-config.yaml
kafka:
  clusters:
    dev:
      brokers:
        - ${KAFKA_DEV_BROKER_1}
        - ${KAFKA_DEV_BROKER_2}
        - ${KAFKA_DEV_BROKER_3}
      tls: true
      requiresApproval: false
      topicConfig:
        default:
          numPartitions: 2
          replicationFactor: 2
          configEntries:
            - name: min.insync.replicas
              value: '1'
            - name: retention.ms
              value: '86400000'
    prd:
      brokers:
        - ${KAFKA_PRD_BROKER_1}
        - ${KAFKA_PRD_BROKER_2}
        - ${KAFKA_PRD_BROKER_3}
      tls: true
      requiresApproval: true
      topicConfig:
        default:
          numPartitions: 4
          replicationFactor: 2
          configEntries:
            - name: min.insync.replicas
              value: '1'
            - name: retention.ms
              value: '86400000'
        high:
          numPartitions: 6
          replicationFactor: 2
          configEntries:
            - name: min.insync.replicas
              value: '1'
            - name: retention.ms
              value: '86400000'
```

| Field | Type | Description |
|-------|------|-------------|
| `brokers` | `string[]` | Kafka broker addresses. Empty entries are filtered out |
| `tls` | `boolean` | Enable TLS connection (default: `false`) |
| `requiresApproval` | `boolean` | Require admin approval before topic creation (default: `false`) |
| `topicConfig` | `map` | Named topic configurations. If only `default` exists, config selection is hidden in UI |

### Topic Config Presets

Each `topicConfig` entry defines partition count, replication factor, and Kafka config entries:

| Field | Type | Description |
|-------|------|-------------|
| `numPartitions` | `number` | Number of partitions |
| `replicationFactor` | `number` | Replication factor |
| `configEntries` | `list` | Kafka topic config entries (`name`/`value` pairs) |

When `topicConfig` has multiple keys (e.g., `default` and `high`), a config preset selector appears in the creation wizard. For production clusters with varying traffic patterns, this allows different partition/RF settings per traffic level.

### Admin Authorization

Admins are authorized to approve/reject topic requests via `permission.admins`:

```yaml
# app-config.yaml
permission:
  admins:
    - user:default/admin1
    - user:default/admin2
```

### Sidebar Toggle

```yaml
# app-config.yaml
app:
  plugins:
    kafkaTopic: true  # Set to false to hide from sidebar
```

## Topic Naming Convention

Topics are named using the pattern: `{appName}-{eventName}-{action(optional)}`

Examples:
- `order-service-payment-completed`
- `order-service-payment`

## Approval Workflow

```
Developer                          Admin
    │                                │
    ├─ Create topic request ────────►│
    │  (status: pending)             │
    │                                ├─ Review detail page
    │                                ├─ Enter reason (required)
    │                                ├─ Approve or Reject
    │                                │
    │◄── Approved ──────────────────┤  → Topic created via kafkajs
    │◄── Rejected ──────────────────┤  → Request marked as rejected
```

- **requiresApproval: false** — topic is created immediately on submit
- **requiresApproval: true** — request is queued for admin review

## Access Control

| Action | User | Admin |
|--------|:----:|:-----:|
| Create topic request | O | O |
| View request list | O | O |
| View request detail page | O | O |
| Approve/Reject request | X | O |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/clusters` | List clusters with topic configs |
| GET | `/clusters/:cluster/metadata` | Cluster metadata (brokers, version) |
| GET | `/topics/:cluster` | List topics in cluster |
| POST | `/topics/:cluster` | Create topic (or queue for approval) |
| GET | `/requests` | List all topic requests |
| GET | `/requests/:id` | Get single topic request |
| POST | `/requests/:id/approve` | Approve request (admin only, reason required) |
| POST | `/requests/:id/reject` | Reject request (admin only, reason required) |
| GET | `/user-role` | Get current user's admin status |

## Limitations

- Request store is in-memory (resets on backend restart). For persistence, a database backend would be needed.
- Topic deletion is not supported through the UI.
