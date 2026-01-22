# Backstage with GitLab Discovery

Backstage 커스텀 이미지로, GitLab Auto Discovery와 API Docs 플러그인이 포함되어 있습니다.

## Version

| Component | Version |
|-----------|---------|
| Backstage | 1.47.0 |
| Node.js | 24.x |
| Yarn | 4.x (Berry) |
| @backstage/cli | 0.35.2 |

## Features

| Feature | Plugin | Description |
|---------|--------|-------------|
| GitLab Auto Discovery | `plugin-catalog-backend-module-gitlab` | GitLab 저장소에서 `catalog-info.yaml` 자동 발견 |
| GitLab Org Sync | `plugin-catalog-backend-module-gitlab-org` | GitLab 그룹/사용자를 Backstage에 동기화 |
| API Docs | `plugin-api-docs` | OpenAPI, AsyncAPI, GraphQL 스펙 뷰어 |
| TechDocs | `plugin-techdocs` | Markdown 기반 기술 문서 |
| Scaffolder | `plugin-scaffolder` | 템플릿 기반 프로젝트 생성 |
| Search | `plugin-search` | 카탈로그 전체 검색 |

## Quick Start

### Build

```bash
# 컨테이너 런타임 자동 감지 (podman 우선, 없으면 docker)
make build

# 명시적으로 런타임 지정
make build CONTAINER_RUNTIME=docker
make build CONTAINER_RUNTIME=podman
```

### Run Locally

```bash
export GITLAB_TOKEN="glpat-xxxxxxxxxxxx"
make run
```

브라우저에서 http://localhost:7007 접속

### Push to Registry (Manual)

```bash
make push REGISTRY=ghcr.io/your-org
```

### Release via GitHub Actions (Recommended)

태그 푸시로 자동 릴리즈:

```bash
# 태그 생성 및 푸시
git tag backstage/1.47.0
git push origin backstage/1.47.0
```

또는 GitHub Actions에서 `workflow_dispatch`로 수동 실행 가능.

## Helm Chart Integration

공식 [Backstage Helm Chart](https://github.com/backstage/charts)에서 이미지만 교체하여 사용합니다.

> **Note**: 이 이미지는 설정 파일(app-config.yaml)을 포함하지 않습니다.
> 공식 차트의 `appConfig`를 사용하여 설정을 주입하세요.

```yaml
# values.yaml
backstage:
  image:
    registry: ghcr.io
    repository: your-org/backstage
    tag: latest

  args:
    - "--config"
    - "/app/config/app-config.yaml"

  appConfig:
    app:
      title: Backstage
      baseUrl: https://backstage.example.com

    backend:
      baseUrl: https://backstage.example.com
      listen:
        port: 7007
      database:
        client: pg
        connection:
          host: ${POSTGRES_HOST}
          port: ${POSTGRES_PORT}
          user: ${POSTGRES_USER}
          password: ${POSTGRES_PASSWORD}

    integrations:
      gitlab:
        - host: ${GITLAB_HOST}
          token: ${GITLAB_TOKEN}

    catalog:
      providers:
        gitlab:
          default:
            host: ${GITLAB_HOST}
            branch: main
            fallbackBranch: master
            schedule:
              frequency: { minutes: 30 }
              timeout: { minutes: 3 }

  extraEnvVars:
    - name: GITLAB_HOST
      value: "gitlab.com"
    - name: GITLAB_TOKEN
      valueFrom:
        secretKeyRef:
          name: backstage-secrets
          key: gitlab-token
    - name: POSTGRES_HOST
      value: "backstage-postgresql"
    - name: POSTGRES_PORT
      value: "5432"
    - name: POSTGRES_USER
      valueFrom:
        secretKeyRef:
          name: backstage-secrets
          key: postgres-user
    - name: POSTGRES_PASSWORD
      valueFrom:
        secretKeyRef:
          name: backstage-secrets
          key: postgres-password
```

### Install with Helm

```bash
# Secret 생성
kubectl create secret generic backstage-secrets \
  --from-literal=gitlab-token=glpat-xxxxxxxxxxxx \
  --from-literal=postgres-user=backstage \
  --from-literal=postgres-password=changeme

# Helm 설치
helm repo add backstage https://backstage.github.io/charts
helm install backstage backstage/backstage -f values.yaml
```

## Configuration

### GitLab Discovery 설정

프로젝트 루트의 `app-config.yaml`에서 GitLab discovery 설정을 변경할 수 있습니다:

```yaml
catalog:
  providers:
    gitlab:
      yourProviderId:
        host: ${GITLAB_HOST}
        branch: main
        fallbackBranch: master
        # 특정 그룹만 스캔
        # group: my-team
        schedule:
          frequency: { minutes: 30 }
          timeout: { minutes: 3 }
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GITLAB_HOST` | Yes | GitLab 호스트 (예: `gitlab.com`) |
| `GITLAB_TOKEN` | Yes | GitLab Personal Access Token (api scope 필요) |
| `BACKSTAGE_BASE_URL` | Production | Backstage 외부 URL |

## GitLab Repository Setup

GitLab 저장소에 `catalog-info.yaml` 파일을 추가하면 Backstage가 자동으로 발견합니다.

### Component 예시

```yaml
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: my-service
  description: My awesome microservice
  annotations:
    gitlab.com/project-slug: my-group/my-service
spec:
  type: service
  lifecycle: production
  owner: platform-team
```

### API 스펙 포함 예시

```yaml
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: my-service
  description: My service with API docs
spec:
  type: service
  lifecycle: production
  owner: platform-team
  providesApis:
    - my-service-api
---
apiVersion: backstage.io/v1alpha1
kind: API
metadata:
  name: my-service-api
  description: My Service REST API
spec:
  type: openapi
  lifecycle: production
  owner: platform-team
  definition:
    $text: ./openapi.yaml
```

### 지원하는 API 타입

| Type | Spec Format |
|------|-------------|
| `openapi` | OpenAPI 3.x / Swagger 2.0 |
| `asyncapi` | AsyncAPI 2.x |
| `graphql` | GraphQL SDL |
| `grpc` | Protocol Buffers |

## Project Structure

```
backstage/
├── Dockerfile
├── Makefile
├── package.json
├── app-config.yaml              # 기본 설정
├── app-config.production.yaml   # 프로덕션 오버라이드
├── tsconfig.json
└── packages/
    ├── app/                     # Frontend
    │   ├── package.json
    │   └── src/
    │       ├── App.tsx
    │       └── components/
    └── backend/                 # Backend
        ├── package.json
        └── src/
            └── index.ts         # 플러그인 등록
```

## Development

### Local Development (without container)

```bash
# 의존성 설치
make init

# 개발 서버 실행
make dev
```

### Available Make Targets

```bash
make help           # 도움말 출력
make runtime-info   # 감지된 컨테이너 런타임 확인
make init           # yarn install
make dev            # 로컬 개발 서버
make build          # 컨테이너 이미지 빌드
make build-nocache  # 캐시 없이 빌드
make push           # 레지스트리에 푸시
make run            # 로컬에서 컨테이너 실행
make clean          # 빌드 아티팩트 삭제
```

## Ports

| Port | Description |
|------|-------------|
| 7007 | Backstage Backend (production) |
| 3000 | Frontend dev server (development only) |

프로덕션에서는 7007 포트만 노출하면 됩니다.
