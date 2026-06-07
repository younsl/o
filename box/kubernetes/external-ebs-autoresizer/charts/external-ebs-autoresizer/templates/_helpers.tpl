{{- define "external-ebs-autoresizer.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "external-ebs-autoresizer.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "external-ebs-autoresizer.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "external-ebs-autoresizer.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "external-ebs-autoresizer.selectorLabels" -}}
app.kubernetes.io/name: {{ include "external-ebs-autoresizer.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Leader election turns on automatically whenever more than one replica runs, so
HA deployments keep a single active reconciler. Outputs "true" when enabled,
empty otherwise, so it is usable in if/with.
*/}}
{{- define "external-ebs-autoresizer.leaderElectEnabled" -}}
{{- if gt (int .Values.replicaCount) 1 -}}
true
{{- end -}}
{{- end -}}

{{- define "external-ebs-autoresizer.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "external-ebs-autoresizer.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}
