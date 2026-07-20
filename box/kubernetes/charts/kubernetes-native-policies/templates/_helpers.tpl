{{/*
Expand the name of the chart.
*/}}
{{- define "kubernetes-native-policies.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "kubernetes-native-policies.fullname" -}}
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
Create chart name and version as used by the chart label.
*/}}
{{- define "kubernetes-native-policies.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "kubernetes-native-policies.labels" -}}
helm.sh/chart: {{ include "kubernetes-native-policies.chart" . }}
{{ include "kubernetes-native-policies.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- with .Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "kubernetes-native-policies.selectorLabels" -}}
app.kubernetes.io/name: {{ include "kubernetes-native-policies.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Resolve a policy resource name: explicit .name wins, otherwise the map key.
Usage: {{ include "kubernetes-native-policies.policyName" (dict "key" $key "value" $value) }}
*/}}
{{- define "kubernetes-native-policies.policyName" -}}
{{- default .key .value.name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Resolve a binding resource name: explicit .name wins, otherwise <policyName>-<bindingKey>.
Usage: {{ include "kubernetes-native-policies.bindingName" (dict "policyName" $policyName "key" $key "value" $value) }}
*/}}
{{- define "kubernetes-native-policies.bindingName" -}}
{{- default (printf "%s-%s" .policyName .key) .value.name | trunc 63 | trimSuffix "-" }}
{{- end }}
