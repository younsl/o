# InfluxDB 2.7 to Kubernetes Migration

InfluxDB 2.7을 Kubernetes 환경으로 마이그레이션하는 절차입니다. 토큰, 메트릭, 대시보드 등 모든 데이터를 보존합니다.

## Prerequisites

- Source: InfluxDB 2.7 (EC2 or standalone)
- Target: InfluxDB 2.7 on Kubernetes
- `influx` CLI 설치
- S3 또는 공유 스토리지 (백업 전송용)

## Backup Scope

`influx backup`은 다음 파일들을 생성합니다:

| 파일 | 내용 |
|------|------|
| `*.bolt.gz` | Organizations, Buckets, Users, Tokens, Dashboards |
| `*.sqlite.gz` | Notebooks, Annotations |
| `*.<shard_id>.tar.gz` | TSM shard 데이터 (시계열 메트릭) |

```bash
# 백업 파일 예시
20251225T055356Z.573.tar.gz   # shard 573
20251225T055356Z.581.tar.gz   # shard 581
20251225T055356Z.589.tar.gz   # shard 589
20251225T055356Z.597.tar.gz   # shard 597
20251225T055356Z.bolt.gz      # 메타데이터
20251225T055356Z.sqlite.gz    # notebooks, annotations
```

모든 메타데이터와 시계열 데이터가 백업에 포함됩니다.

## InfluxDB 2 Helm Chart Paths

InfluxDB 2 Helm 차트(influxdata/influxdb2) 기본 경로:

| 경로 | 용도 |
|------|------|
| `/var/lib/influxdb2` | 데이터 (bolt, sqlite, engine) |
| `/etc/influxdb2` | 설정 파일 |

PVC가 `/var/lib/influxdb2`에 마운트됩니다.

```bash
# Pod 내부 데이터 구조
/var/lib/influxdb2/
├── engine/          # TSM 데이터
├── influxd.bolt     # 메타데이터
└── influxd.sqlite   # notebooks, annotations
```

## 1. Source에서 백업

### 1.1 tmux 세션 생성 (장시간 백업 대비)

```bash
tmux new -s influx-backup
```

### 1.2 전체 백업 실행

```bash
# 환경 변수 설정
export INFLUX_HOST="http://localhost:8086"
export INFLUX_TOKEN="your-admin-token"

# 백업 디렉토리 생성
BACKUP_DIR="/backup/influxdb-$(date +%Y%m%d-%H%M%S)"
mkdir -p $BACKUP_DIR

# 전체 백업 (메트릭 + 메타데이터)
nohup influx backup $BACKUP_DIR \
  --host $INFLUX_HOST \
  --token $INFLUX_TOKEN \
  > /tmp/influx-backup.log 2>&1 &

# 진행 상황 확인
tail -f /tmp/influx-backup.log
```

### 1.3 백업 내용 확인

```bash
ls -la $BACKUP_DIR
```

## 2. 백업 파일 전송

### Option A: S3 사용

```bash
# Source에서 S3로 업로드
aws s3 cp --recursive $BACKUP_DIR s3://your-bucket/influxdb-backup/

# Kubernetes Pod에서 다운로드
kubectl exec -it influxdb-0 -n influxdb -- \
  aws s3 cp --recursive s3://your-bucket/influxdb-backup/ /tmp/restore/
```

### Option B: kubectl cp 사용

```bash
# 로컬로 다운로드 후 Pod로 전송
scp -r user@source-server:$BACKUP_DIR ./influxdb-backup/
kubectl cp ./influxdb-backup/ influxdb/influxdb-0:/tmp/restore/
```

## 3. Kubernetes에서 복원

### 3.1 InfluxDB Pod 접속

```bash
kubectl exec -it influxdb-0 -n influxdb -- /bin/sh
```

### 3.2 복원 실행

```bash
# 전체 복원 (메타데이터 + 시계열 데이터)
influx restore /tmp/restore/ \
  --host http://localhost:8086 \
  --token $INFLUX_TOKEN \
  --full
```

#### Restore 옵션

`--full` 옵션은 서버의 모든 데이터를 완전히 교체합니다(Fully restore and replace all data on server). 새로 설치한 InfluxDB에 마이그레이션할 때 사용합니다.

`influx restore`는 API를 통해 복원하므로 백업 파일은 임시 경로(`/tmp/restore/`)에 두면 됩니다. 직접 `/var/lib/influxdb2`에 파일을 복사하는 것이 아니라, InfluxDB가 자동으로 데이터 경로에 복원합니다.

## 4. 검증

### 4.1 Organization 확인

```bash
influx org list --host http://localhost:8086 --token $INFLUX_TOKEN
```

### 4.2 Bucket 확인

```bash
influx bucket list --host http://localhost:8086 --token $INFLUX_TOKEN
```

### 4.3 토큰 확인

```bash
influx auth list --host http://localhost:8086 --token $INFLUX_TOKEN
```

### 4.4 데이터 쿼리 테스트

```bash
influx query 'from(bucket: "your-bucket") |> range(start: -1h) |> limit(n: 10)' \
  --host http://localhost:8086 \
  --token $INFLUX_TOKEN
```

## 5. 애플리케이션 전환

### 5.1 Kubernetes Service 확인

```bash
kubectl get svc -n influxdb

# 예시 출력
# NAME       TYPE        CLUSTER-IP     PORT(S)
# influxdb   ClusterIP   10.100.50.10   8086/TCP
```

### 5.2 애플리케이션 설정 업데이트

```yaml
# 기존 (EC2)
INFLUX_HOST: "http://influxdb.example.com:8086"

# 변경 (Kubernetes)
INFLUX_HOST: "http://influxdb.influxdb.svc.cluster.local:8086"
```

기존 토큰은 복원되었으므로 `INFLUX_TOKEN`은 변경 불필요합니다.

## 6. Rollback

문제 발생 시 Source InfluxDB로 롤백:

```bash
# 애플리케이션 설정을 기존 EC2 호스트로 변경
INFLUX_HOST: "http://influxdb.example.com:8086"
```

## Troubleshooting

### 토큰이 복원되지 않는 경우

`--full` 플래그 없이 복원하면 토큰이 복원되지 않습니다:

```bash
# 잘못된 예
influx restore /tmp/restore/

# 올바른 예
influx restore /tmp/restore/ --full
```

### 권한 오류

복원 시 admin 권한 토큰이 필요합니다. 새 InfluxDB 설치 시 초기 설정에서 생성된 토큰을 사용하세요.

### 버전 불일치

Source와 Target의 InfluxDB 버전이 동일해야 합니다:

```bash
influx version
```

## References

- [InfluxDB Backup and Restore](https://docs.influxdata.com/influxdb/v2/admin/backup-restore/)
- [InfluxDB CLI Documentation](https://docs.influxdata.com/influxdb/v2/reference/cli/influx/)
