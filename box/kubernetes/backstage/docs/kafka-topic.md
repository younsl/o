---
plugins:
  - kafka-topic
  - kafka-topic-backend
---

# Kafka Topic

Custom plugin for self-service Kafka topic creation with in-app approval workflow.

## Features

- 4-step creation wizard (Cluster Info → Topics → Config → Simulate & Create)
- Batch topic creation (up to 20 topics with shared configuration)
- Per-cluster approval workflow (`requiresApproval` config)
- Batch approval/rejection for multi-topic requests
- Admin review detail page with mandatory reason for approve/reject
- Deep linking for request detail pages (`/kafka-topic/requests/:id`)
- Approval pipeline visualization with person icons and status colors
- Partition distribution simulator with broker failure simulation
- Topic list with search highlighting, partition/RF/warning filters
- Batch grouping in request list with tooltip showing all topic names
- Client-side pagination (20 rows per page)
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

Topic names are entered directly in the creation wizard. Allowed characters: letters, digits, periods, hyphens, and underscores.

Examples:
- `order-service-payment-completed`
- `order-service-payment`

## Batch Topic Creation

Multiple topics (up to 20) can be created in a single request with shared configuration (cluster, topic config preset, cleanup policy). Each topic name is entered as a separate row in the creation wizard.

- Duplicate detection runs with 300ms debounce against both existing cluster topics and other topics in the same batch
- All duplicates must be resolved before proceeding (Block mode)
- Batch-created topics are grouped as a single row in the request list with a `+N more` badge
- For approval-required clusters, the entire batch can be approved or rejected at once

## Approval Workflow

```
Developer                          Admin
    │                                │
    ├─ Create topic request ────────►│
    │  (single or batch)             │
    │  (status: pending)             │
    │                                ├─ Review detail page
    │                                ├─ Enter reason (required)
    │                                ├─ Approve or Reject (batch: all at once)
    │                                │
    │◄── Approved ───────────────────┤  → Topic(s) created via kafkajs
    │◄── Rejected ───────────────────┤  → Request(s) marked as rejected
```

- **requiresApproval: false** — topic(s) created immediately on submit
- **requiresApproval: true** — request is queued for admin review

## Access Control

Admins defined in `permission.admins` can approve or reject topic requests. All other authenticated users can create and view requests but cannot approve or reject.

| Action | User | Admin |
|--------|:----:|:-----:|
| Create topic request (single/batch) | O | O |
| View request list | O | O |
| View request detail page | O | O |
| Approve/Reject request (single/batch) | X | O |

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
