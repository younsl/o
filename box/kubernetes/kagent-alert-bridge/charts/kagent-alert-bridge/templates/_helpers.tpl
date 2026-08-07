{{- define "kagent-alert-bridge.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "kagent-alert-bridge.fullname" -}}
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

{{- define "kagent-alert-bridge.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "kagent-alert-bridge.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "kagent-alert-bridge.selectorLabels" -}}
app.kubernetes.io/name: {{ include "kagent-alert-bridge.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "kagent-alert-bridge.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "kagent-alert-bridge.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
Name of the Secret holding the Slack bot token: an externally managed one when
given, otherwise the Secret this chart renders.
*/}}
{{- define "kagent-alert-bridge.slackSecretName" -}}
{{- default (printf "%s-slack" (include "kagent-alert-bridge.fullname" .)) .Values.slack.existingSecret -}}
{{- end -}}

{{- define "kagent-alert-bridge.slackSecretKey" -}}
{{- if .Values.slack.existingSecret -}}
{{- .Values.slack.existingSecretKey -}}
{{- else -}}
SLACK_BOT_TOKEN
{{- end -}}
{{- end -}}

{{/*
Name of the Secret holding the webhook bearer token, on the same rules.
*/}}
{{- define "kagent-alert-bridge.webhookSecretName" -}}
{{- default (printf "%s-webhook" (include "kagent-alert-bridge.fullname" .)) .Values.webhook.existingSecret -}}
{{- end -}}

{{- define "kagent-alert-bridge.webhookSecretKey" -}}
{{- if .Values.webhook.existingSecret -}}
{{- .Values.webhook.existingSecretKey -}}
{{- else -}}
WEBHOOK_BEARER_TOKEN
{{- end -}}
{{- end -}}

{{- define "kagent-alert-bridge.webhookAuthEnabled" -}}
{{- if or .Values.webhook.existingSecret .Values.webhook.token -}}
true
{{- end -}}
{{- end -}}
