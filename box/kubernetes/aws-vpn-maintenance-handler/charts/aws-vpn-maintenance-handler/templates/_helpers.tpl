{{- define "aws-vpn-maintenance-handler.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "aws-vpn-maintenance-handler.fullname" -}}
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

{{- define "aws-vpn-maintenance-handler.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "aws-vpn-maintenance-handler.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "aws-vpn-maintenance-handler.selectorLabels" -}}
app.kubernetes.io/name: {{ include "aws-vpn-maintenance-handler.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "aws-vpn-maintenance-handler.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "aws-vpn-maintenance-handler.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
ConfigMap holding in-flight and cooldown state. Separate from the config ConfigMap
because the controller writes to it; this is what replaces a PersistentVolume.
*/}}
{{- define "aws-vpn-maintenance-handler.stateConfigMapName" -}}
{{- default (printf "%s-state" (include "aws-vpn-maintenance-handler.fullname" .)) .Values.stateConfigMapName -}}
{{- end -}}

{{/*
Leader election turns on above one replica, since two replicas could replace both
tunnels of one connection. Outputs "true" or empty, for use in if/with.
*/}}
{{- define "aws-vpn-maintenance-handler.leaderElectEnabled" -}}
{{- if gt (int .Values.replicaCount) 1 -}}
true
{{- end -}}
{{- end -}}

{{/* Secret holding the Slack tokens, chart-created or externally managed. */}}
{{- define "aws-vpn-maintenance-handler.slackSecretName" -}}
{{- if .Values.slack.existingSecret -}}
{{- .Values.slack.existingSecret -}}
{{- else -}}
{{- printf "%s-slack" (include "aws-vpn-maintenance-handler.fullname" .) -}}
{{- end -}}
{{- end -}}
