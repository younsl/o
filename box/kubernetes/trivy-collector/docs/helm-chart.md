# Helm Chart

This document provides Helm chart installation and configuration guide for trivy-collector. Helm chart is the officially recommended installation method for trivy-collector.

**Target audience**: Platform Engineers and DevOps Engineers deploying trivy-collector to Kubernetes clusters.

## Values Reference

```yaml
# Deployment mode
mode: collector  # or "server"

# Collector settings
collector:
  serverUrl: "http://trivy-server:3000"
  clusterName: "my-cluster"
  namespaces: []  # empty = all namespaces
  collectVulnerabilityReports: true
  collectSbomReports: true

# Server settings
server:
  port: 3000
  persistence:
    enabled: true
    storageClass: ""
    size: 5Gi
  ingress:
    enabled: false
    hosts:
      - host: trivy.example.com
        paths:
          - path: /
            pathType: Prefix
  gateway:  # Gateway API HTTPRoute (alternative to Ingress)
    enabled: false
    parentRefs:
      - name: main-gateway
        namespace: gateway-system

# Common settings
health:
  port: 8080

logging:
  format: json
  level: info

resources:
  limits:
    memory: 256Mi
  requests:
    cpu: 100m
    memory: 128Mi
```

## Installation Examples

### Server with persistence and ingress

```bash
helm install trivy-server ./charts/trivy-collector \
  --namespace trivy-system \
  --set mode=server \
  --set server.persistence.enabled=true \
  --set server.ingress.enabled=true \
  --set server.ingress.className=nginx \
  --set server.ingress.hosts[0].host=trivy.example.com
```

### Collector watching specific namespaces

```bash
helm install trivy-collector ./charts/trivy-collector \
  --namespace trivy-system \
  --set mode=collector \
  --set collector.serverUrl=http://trivy-server:3000 \
  --set collector.clusterName=production \
  --set collector.namespaces="{default,kube-system,app}"
```

### Server with Gateway API HTTPRoute

```bash
helm install trivy-server ./charts/trivy-collector \
  --namespace trivy-system \
  --set mode=server \
  --set server.gateway.enabled=true \
  --set server.gateway.hostnames[0]=trivy.example.com
```
