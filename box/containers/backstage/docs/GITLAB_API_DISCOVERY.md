# GitLab API Auto Discovery Guide

Backstage에서 GitLab 프로젝트의 API를 자동으로 등록하는 방법을 설명합니다.

## 작동 방식

```
┌─────────────────┐     ┌──────────────────────┐     ┌─────────────────┐
│  GitLab Repo    │     │  Backstage Provider  │     │  Backstage UI   │
│                 │     │                      │     │                 │
│ catalog-info.yaml ──▶ │ 30분마다 자동 스캔   │────▶│  API Catalog    │
│ openapi.yaml    │     │  (gitlab provider)   │     │  API Docs       │
└─────────────────┘     └──────────────────────┘     └─────────────────┘
```

1. 각 GitLab 프로젝트 루트에 `catalog-info.yaml` 파일 추가
2. Backstage GitLab Provider가 30분마다 자동 스캔
3. 발견된 API가 Backstage 카탈로그에 등록
4. API Docs 페이지에서 스펙 확인 가능

## Quick Start

### 1. 템플릿 선택

프로젝트의 API 유형에 맞는 템플릿을 선택하세요:

| API 유형 | 템플릿 파일 | 스펙 파일 |
|---------|------------|----------|
| REST API | `catalog-info-api-openapi.yaml` | `openapi.yaml` 또는 `swagger.json` |
| Event-driven | `catalog-info-api-asyncapi.yaml` | `asyncapi.yaml` |
| GraphQL | `catalog-info-api-graphql.yaml` | `schema.graphql` |
| gRPC | `catalog-info-api-grpc.yaml` | `*.proto` |

### 2. catalog-info.yaml 작성

GitLab 프로젝트 루트에 `catalog-info.yaml` 파일을 생성합니다:

```yaml
apiVersion: backstage.io/v1alpha1
kind: API
metadata:
  name: my-service-api          # 고유 식별자 (소문자, 하이픈만)
  title: My Service API         # UI에 표시될 이름
  description: REST API for My Service
  annotations:
    gitlab.com/project-slug: my-group/my-service
  tags:
    - rest
spec:
  type: openapi                 # openapi, asyncapi, graphql, grpc
  lifecycle: production         # development, staging, production, deprecated
  owner: team-backend           # 소유 팀
  definition:
    $text: ./openapi.yaml       # API 스펙 파일 경로
```

### 3. API 스펙 파일 추가

`catalog-info.yaml`에서 참조하는 API 스펙 파일이 같은 저장소에 있어야 합니다.

#### OpenAPI 예시 (`openapi.yaml`)

```yaml
openapi: 3.0.0
info:
  title: My Service API
  version: 1.0.0
paths:
  /users:
    get:
      summary: List users
      responses:
        '200':
          description: Success
```

### 4. GitLab에 Push

```bash
git add catalog-info.yaml openapi.yaml
git commit -m "feat: Add Backstage catalog info for API documentation"
git push
```

### 5. Backstage에서 확인

- 최대 30분 후 자동 등록 (또는 Backstage 재시작)
- Catalog > APIs 메뉴에서 확인
- API 상세 페이지 > Definition 탭에서 스펙 확인

## 고급 설정

### Component와 API 연결

서비스(Component)가 API를 제공하는 관계를 정의할 수 있습니다:

```yaml
---
apiVersion: backstage.io/v1alpha1
kind: API
metadata:
  name: user-api
spec:
  type: openapi
  lifecycle: production
  owner: team-backend
  definition:
    $text: ./openapi.yaml

---
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: user-service
spec:
  type: service
  lifecycle: production
  owner: team-backend
  providesApis:
    - user-api              # API 참조
  consumesApis:
    - payment-api           # 다른 API 소비
```

### System 구성

여러 Component와 API를 System으로 그룹화:

```yaml
apiVersion: backstage.io/v1alpha1
kind: System
metadata:
  name: order-system
  description: Order management system
spec:
  owner: team-orders

---
apiVersion: backstage.io/v1alpha1
kind: API
metadata:
  name: order-api
spec:
  type: openapi
  owner: team-orders
  system: order-system      # System에 포함
  definition:
    $text: ./openapi.yaml
```

### 외부 URL에서 API 스펙 가져오기

스펙 파일이 다른 위치에 있는 경우:

```yaml
spec:
  definition:
    $text: https://api.example.com/openapi.json
```

## Lifecycle 값

| 값 | 의미 |
|----|------|
| `development` | 개발 중, 변경 가능 |
| `staging` | 테스트 환경 |
| `production` | 프로덕션 배포됨 |
| `deprecated` | 더 이상 사용하지 않음 |
| `experimental` | 실험적 기능 |

## API Type 값

| 값 | 설명 |
|----|------|
| `openapi` | OpenAPI/Swagger (REST) |
| `asyncapi` | AsyncAPI (Kafka, RabbitMQ, WebSocket) |
| `graphql` | GraphQL |
| `grpc` | gRPC (Protocol Buffers) |

## 트러블슈팅

### API가 등록되지 않는 경우

1. `catalog-info.yaml` 파일명 확인 (대소문자 주의)
2. YAML 문법 오류 확인: `yamllint catalog-info.yaml`
3. Backstage 로그 확인: `kubectl logs -n backstage <pod-name>`
4. GitLab Provider 설정 확인 (`app-config.yaml`의 `catalog.providers.gitlab`)

### API 스펙이 표시되지 않는 경우

1. `definition.$text` 경로가 정확한지 확인
2. 스펙 파일이 유효한 OpenAPI/AsyncAPI 형식인지 확인
3. GitLab 토큰이 해당 저장소에 접근 권한이 있는지 확인

### 수동 등록 (테스트용)

자동 스캔을 기다리지 않고 바로 등록하려면:

1. Backstage UI > Create > Register Existing Component
2. GitLab URL 입력: `https://gitlab.example.com/my-group/my-service/-/blob/main/catalog-info.yaml`

## 참고 자료

- [Backstage Catalog Model](https://backstage.io/docs/features/software-catalog/descriptor-format)
- [API Docs Plugin](https://backstage.io/docs/features/api-docs/)
- [GitLab Discovery](https://backstage.io/docs/integrations/gitlab/discovery)
