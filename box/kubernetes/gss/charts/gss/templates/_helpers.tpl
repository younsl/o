{{/*
Expand the name of the chart.
*/}}
{{- define "gss.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "gss.fullname" -}}
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

{{/*
Creates a string in the format "{chart-name}-{version}"
*/}}
{{- define "gss.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Defines common labels used across Kubernetes resources
*/}}
{{- define "gss.labels" -}}
helm.sh/chart: {{ include "gss.chart" . }}
{{ include "gss.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
Selector labels
*/}}
{{- define "gss.selectorLabels" -}}
app.kubernetes.io/name: {{ include "gss.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Sets container image tag (uses .Chart.AppVersion if .Values.image.tag is not defined)
*/}}
{{- define "gss.imageTag" -}}
{{- .Values.image.tag | default .Chart.AppVersion -}}
{{- end -}}

{{/*
configMap data helper
This helper template iterates through configMap.data values defined in values.yaml and generates configMap data entries.
*/}}
{{- define "gss.configMapData" -}}
{{- range $key, $value := .Values.configMap.data }}
{{- if $value }}
{{ $key }}: {{ $value | quote }}
{{- end }}
{{- end }}
{{- end }}

{{/*
ConfigMap name helper
Returns the ConfigMap name to use (either external name or generated name)
*/}}
{{- define "gss.configMapName" -}}
{{- if .Values.configMap.name -}}
{{- .Values.configMap.name -}}
{{- else -}}
{{- include "gss.fullname" . -}}
{{- end -}}
{{- end -}}

{{/*
Exclude ConfigMap name helper
Returns the exclude ConfigMap name to use (either external name with -exclude suffix or generated name)
*/}}
{{- define "gss.excludeConfigMapName" -}}
{{- if .Values.configMap.name -}}
{{- printf "%s-exclude" .Values.configMap.name -}}
{{- else -}}
{{- printf "%s-exclude" (include "gss.fullname" .) -}}
{{- end -}}
{{- end -}}
