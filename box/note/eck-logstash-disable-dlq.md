# ECK Logstash DLQ 볼륨 비활성화

ECK Logstash에서 DLQ(Dead Letter Queue)용 PVC를 비활성화하고 emptyDir로 대체하는 방법.

## 배경

ECK Operator는 Logstash 배포 시 기본적으로 `logstash-data` PVC를 자동 생성한다. MSK(Kafka)가 중간 버퍼 역할을 하는 아키텍처에서는 DLQ가 불필요하므로 비활성화하여 불필요한 EBS 비용을 절감할 수 있다.

```
MSK (Kafka) → Logstash → OpenSearch/S3
```

Kafka가 메시지 영속성을 보장하므로 Logstash 실패 시에도 데이터 손실이 없다:

- **일반 재시작**: 마지막 커밋된 offset부터 자동으로 이어서 처리 (`enable_auto_commit: true`)
- **재처리 필요시**: 수동으로 consumer group offset을 리셋하여 과거 데이터 재처리 가능

## 설정 방법

### 1. DLQ 비활성화

`dead_letter_queue.enable`을 생략하면 기본값은 `true`이므로 명시적으로 비활성화해야 한다.

```yaml
# charts/eck-stack/values.yaml
eck-logstash:
  config:
    # Disable DLQ to prevent automatic volume creation
    dead_letter_queue.enable: false
```

### 2. emptyDir 볼륨으로 오버라이드

```yaml
# charts/eck-stack/values.yaml
eck-logstash:
  volumeClaimTemplates: []
  podTemplate:
    spec:
      volumes:
        - name: logstash-data
          emptyDir: {}
      containers:
        - name: logstash
          volumeMounts:
            - name: logstash-data
              mountPath: /usr/share/logstash/data
```

ECK Operator가 자동 생성하는 다른 볼륨(config, pipeline 등)은 그대로 유지되며, 동일한 이름의 볼륨만 오버라이드된다.

## 기존 StatefulSet 마이그레이션

StatefulSet의 `volumeClaimTemplates`는 immutable 필드이므로 in-place 업데이트가 불가능하다.

```
StatefulSet.apps "logstash-opensearch-ls" is invalid: spec: Forbidden: updates to statefulset spec for fields other than 'replicas', 'ordinals', 'template', 'updateStrategy', 'persistentVolumeClaimRetentionPolicy' and 'minReadySeconds' are forbidden
```

### 해결 방법

StatefulSet을 삭제하면 ECK Operator가 Logstash CR을 기반으로 즉시 새로운 StatefulSet을 자동 생성한다. 이 과정에서 변경된 볼륨 설정(emptyDir)이 적용된다.

```bash
# 1. StatefulSet 삭제 (Logstash CR은 유지)
kubectl delete sts logstash-opensearch-ls -n elastic-system
kubectl delete sts logstash-s3-ls -n elastic-system

# 2. ECK Operator가 새 StatefulSet 생성하는지 확인
kubectl get sts -n elastic-system -w

# 3. 기존 PVC 삭제
kubectl delete pvc -n elastic-system -l logstash.k8s.elastic.co/name=logstash-opensearch
kubectl delete pvc -n elastic-system -l logstash.k8s.elastic.co/name=logstash-s3
```

PVC 삭제 시 StorageClass의 `reclaimPolicy`에 따라 PV(EBS)도 함께 삭제된다 (기본값: Delete).

## 참고

- MSK가 메시지를 retention 기간 동안 보관하고 consumer offset을 관리하므로, Logstash StatefulSet 삭제 후 재생성 시에도 마지막 처리 지점부터 이어서 consume할 수 있어 데이터 손실이 없다
- DLQ 필요 시 PVC + `dead_letter_queue.enable: true` 설정 필요
