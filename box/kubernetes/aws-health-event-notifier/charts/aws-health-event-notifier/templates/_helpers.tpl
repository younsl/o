{{- define "ahen.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "ahen.fullname" -}}
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

{{- define "ahen.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "ahen.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/component: notifier
app.kubernetes.io/part-of: aws-health-event-notifier
{{- end }}

{{- define "ahen.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ahen.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "ahen.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "ahen.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "ahen.slackSecretName" -}}
{{- if .Values.slack.existingSecret }}
{{- .Values.slack.existingSecret }}
{{- else }}
{{- printf "%s-slack" (include "ahen.fullname" .) }}
{{- end }}
{{- end }}

{{- define "ahen.slackSecretKey" -}}
{{- if .Values.slack.existingSecret -}}
{{- default "webhook-url" .Values.slack.existingSecretKey -}}
{{- else -}}
webhook-url
{{- end -}}
{{- end }}

{{/*
Compose the container image reference from optional registry + repository + tag.
*/}}
{{- define "ahen.image" -}}
{{- $reg := .Values.image.registry | trimSuffix "/" -}}
{{- $repo := .Values.image.repository -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion -}}
{{- if $reg -}}
{{- printf "%s/%s:%s" $reg $repo $tag -}}
{{- else -}}
{{- printf "%s:%s" $repo $tag -}}
{{- end -}}
{{- end -}}

{{/*
Render a value that may itself be a template string. Pass `{ "value": <any>, "context": $ }`.
Accepts either a raw string or a structured value (renders via toYaml first).
*/}}
{{- define "ahen.tplvalues.render" -}}
{{- if typeIs "string" .value -}}
{{ tpl .value .context }}
{{- else -}}
{{ tpl (.value | toYaml) .context }}
{{- end -}}
{{- end -}}
