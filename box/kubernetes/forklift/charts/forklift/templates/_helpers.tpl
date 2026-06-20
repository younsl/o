{{/* Expand the name of the chart. */}}
{{- define "forklift.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Fully qualified app name. */}}
{{- define "forklift.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Fully qualified container image reference, joining registry, repository and tag.
The registry is optional: when empty the repository is used as-is (so it may
itself carry a host). Tag defaults to the chart appVersion.
*/}}
{{- define "forklift.image" -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion -}}
{{- if .Values.image.registry -}}
{{- printf "%s/%s:%s" .Values.image.registry .Values.image.repository $tag -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end -}}
{{- end }}

{{- define "forklift.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "forklift.labels" -}}
helm.sh/chart: {{ include "forklift.chart" . }}
{{ include "forklift.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "forklift.selectorLabels" -}}
app.kubernetes.io/name: {{ include "forklift.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "forklift.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "forklift.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/* haEnabled resolves the HA toggle: explicit value, else replicaCount > 1. */}}
{{- define "forklift.haEnabled" -}}
{{- if kindIs "bool" .Values.ha.enabled }}
{{- .Values.ha.enabled }}
{{- else }}
{{- gt (int .Values.replicaCount) 1 }}
{{- end }}
{{- end }}

{{- define "forklift.leaseName" -}}
{{- default (printf "%s-leader" (include "forklift.fullname" .)) .Values.ha.leaseName }}
{{- end }}

{{- define "forklift.headlessServiceName" -}}
{{ include "forklift.fullname" . }}-headless
{{- end }}

{{/*
Container environment shared by the Deployment (shared RWX volume mode) and the
StatefulSet (PV-based replication mode).
*/}}
{{- define "forklift.env" -}}
- name: POD_NAME
  valueFrom:
    fieldRef:
      fieldPath: metadata.name
- name: POD_NAMESPACE
  valueFrom:
    fieldRef:
      fieldPath: metadata.namespace
- name: FORKLIFT_DATA_DIR
  value: /data
- name: FORKLIFT_LOG_LEVEL
  value: {{ .Values.log.level | quote }}
- name: FORKLIFT_LOG_FORMAT
  value: {{ .Values.log.format | quote }}
- name: FORKLIFT_ANONYMOUS_READ
  value: {{ .Values.auth.anonymousRead | quote }}
- name: FORKLIFT_SEED_DEFAULT_REPOS
  value: {{ .Values.seedDefaultRepos | quote }}
- name: FORKLIFT_AUDIT_ENABLED
  value: {{ .Values.audit.enabled | quote }}
- name: FORKLIFT_AUDIT_RETENTION
  value: {{ .Values.audit.retention | quote }}
- name: FORKLIFT_SESSION_TTL
  value: {{ .Values.auth.sessionTTL | quote }}
{{- if eq (include "forklift.haEnabled" .) "true" }}
- name: FORKLIFT_HA_ENABLED
  value: "true"
- name: FORKLIFT_HA_LEASE_NAME
  value: {{ include "forklift.leaseName" . }}
- name: FORKLIFT_HA_LEASE_DURATION
  value: {{ .Values.ha.leaseDuration | quote }}
- name: FORKLIFT_HA_RENEW_DEADLINE
  value: {{ .Values.ha.renewDeadline | quote }}
- name: FORKLIFT_HA_RETRY_PERIOD
  value: {{ .Values.ha.retryPeriod | quote }}
{{- end }}
{{- if .Values.replication.enabled }}
- name: FORKLIFT_REPLICATION_ENABLED
  value: "true"
- name: FORKLIFT_REPLICATION_PEER_SERVICE
  value: "{{ include "forklift.headlessServiceName" . }}.{{ .Release.Namespace }}.svc.cluster.local"
- name: FORKLIFT_REPLICATION_INTERVAL
  value: {{ .Values.replication.interval | quote }}
- name: FORKLIFT_REPLICATION_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ include "forklift.fullname" . }}
      key: replication-token
{{- end }}
{{- if .Values.auth.oidc.enabled }}
- name: FORKLIFT_OIDC_ENABLED
  value: "true"
- name: FORKLIFT_OIDC_ISSUER_URL
  value: {{ .Values.auth.oidc.issuerURL | quote }}
- name: FORKLIFT_OIDC_CLIENT_ID
  value: {{ .Values.auth.oidc.clientID | quote }}
- name: FORKLIFT_OIDC_REDIRECT_URL
  value: {{ .Values.auth.oidc.redirectURL | quote }}
- name: FORKLIFT_OIDC_USERNAME_CLAIM
  value: {{ .Values.auth.oidc.usernameClaim | quote }}
- name: FORKLIFT_OIDC_GROUPS_CLAIM
  value: {{ .Values.auth.oidc.groupsClaim | quote }}
- name: FORKLIFT_OIDC_CLIENT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "forklift.fullname" . }}
      key: oidc-client-secret
{{- end }}
- name: FORKLIFT_SESSION_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "forklift.fullname" . }}
      key: session-secret
- name: FORKLIFT_BOOTSTRAP_ADMIN_USER
  value: {{ .Values.auth.bootstrap.adminUser | quote }}
- name: FORKLIFT_BOOTSTRAP_ADMIN_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "forklift.fullname" . }}
      key: bootstrap-admin-password
{{- if .Values.auth.rbac.enabled }}
- name: FORKLIFT_RBAC_POLICY_FILE
  value: /etc/forklift/rbac/policy.csv
- name: FORKLIFT_RBAC_DEFAULT_ROLE
  value: {{ .Values.auth.rbac.policyDefault | quote }}
{{- if .Values.auth.rbac.accounts }}
- name: FORKLIFT_RBAC_ACCOUNTS_DIR
  value: /etc/forklift/accounts
{{- end }}
{{- end }}
- name: FORKLIFT_OSV_URL
  value: {{ .Values.vuln.osvUrl | quote }}
{{- with .Values.externalUrl }}
- name: FORKLIFT_EXTERNAL_URL
  value: {{ . | quote }}
{{- end }}
{{- with .Values.extraEnv }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{/*
RBAC volume mounts: the policy.csv ConfigMap and, when local accounts are
declared, the per-account password Secret projected as files named by username.
*/}}
{{- define "forklift.rbacVolumeMounts" -}}
{{- if .Values.auth.rbac.enabled }}
- name: rbac-policy
  mountPath: /etc/forklift/rbac
  readOnly: true
{{- if .Values.auth.rbac.accounts }}
- name: rbac-accounts
  mountPath: /etc/forklift/accounts
  readOnly: true
{{- end }}
{{- end }}
{{- end }}

{{- define "forklift.rbacVolumes" -}}
{{- if .Values.auth.rbac.enabled }}
- name: rbac-policy
  configMap:
    name: {{ include "forklift.fullname" . }}-rbac
{{- if .Values.auth.rbac.accounts }}
- name: rbac-accounts
  secret:
    secretName: {{ include "forklift.fullname" . }}
    items:
      {{- range .Values.auth.rbac.accounts }}
      - key: {{ printf "local-user-%s-password" .name }}
        path: {{ .name }}
      {{- end }}
{{- end }}
{{- end }}
{{- end }}
