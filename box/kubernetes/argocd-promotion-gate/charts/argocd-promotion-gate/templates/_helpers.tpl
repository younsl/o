{{- define "argocd-promotion-gate.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "argocd-promotion-gate.fullname" -}}
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

{{- define "argocd-promotion-gate.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "argocd-promotion-gate.labels" -}}
helm.sh/chart: {{ include "argocd-promotion-gate.chart" . }}
{{ include "argocd-promotion-gate.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "argocd-promotion-gate.selectorLabels" -}}
app.kubernetes.io/name: {{ include "argocd-promotion-gate.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "argocd-promotion-gate.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "argocd-promotion-gate.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "argocd-promotion-gate.image" -}}
{{- $registry := .Values.image.registry | trimSuffix "/" -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag -}}
{{- if $registry -}}
{{- printf "%s/%s:%s" $registry .Values.image.repository $tag -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end -}}
{{- end -}}

{{/*
The gate config file. Rendered from .Values.gate plus the mount paths the
chart owns, so a path never has to be repeated in values.
*/}}
{{- define "argocd-promotion-gate.config" -}}
{{- $gate := deepCopy .Values.gate -}}
{{- $argocd := $gate.argocd -}}
{{- $_ := unset $argocd "caSecret" -}}
{{- $_ := unset $argocd "tokenSecret" -}}
{{- if and .Values.gate.argocd.caSecret.enabled (not .Values.gate.argocd.insecureSkipVerify) -}}
{{- $_ := set $argocd "caFile" (printf "/etc/argocd-promotion-gate/argocd-ca/%s" .Values.gate.argocd.caSecret.key) -}}
{{- else -}}
{{- $_ := set $argocd "caFile" "" -}}
{{- end -}}
{{- $_ := set $argocd "tokenPath" (printf "/etc/argocd-promotion-gate/token/%s" .Values.gate.argocd.tokenSecret.key) -}}
{{- $_ := set $gate "argocd" $argocd -}}
{{- toYaml $gate -}}
{{- end -}}

{{/*
CEL match conditions. Narrowing here rather than in the handler keeps the API
server from calling this webhook on the constant stream of status writes that
Argo CD makes for every Application.
*/}}
{{- define "argocd-promotion-gate.matchConditions" -}}
{{- $gated := .Values.gate.gatedEnvs -}}
{{- if not $gated -}}
{{- $gated = rest .Values.gate.chain -}}
{{- end -}}
- name: only-new-sync-operations
  expression: "has(object.operation) && (oldObject == null || !has(oldObject.operation))"
- name: only-gated-projects
  expression: "has(object.spec) && has(object.spec.project) && object.spec.project in [{{ range $i, $env := $gated }}{{ if $i }}, {{ end }}'{{ $env }}'{{ end }}]"
{{- range .Values.gate.exempt.usernames }}
- name: {{ printf "not-%s" (. | replace ":" "-" | replace "." "-" | lower | trunc 55 | trimSuffix "-") | quote }}
  expression: "request.userInfo.username != '{{ . }}'"
{{- end }}
{{- with .Values.webhook.extraMatchConditions }}
{{- toYaml . | nindent 0 }}
{{- end }}
{{- end -}}

{{/*
Serving certificate for the webhook listener.

Memoized on .Values for the duration of one render, because the Secret and the
ValidatingWebhookConfiguration live in separate files and must agree: genSignedCert
is not deterministic, so calling it twice would hand the API server a CA that does
not match the certificate the pod serves.

An existing Secret is reused so `helm upgrade` does not rotate the certificate out
from under a running API server.
*/}}
{{- define "argocd-promotion-gate.certs" -}}
{{- if not (hasKey .Values "generatedCerts") -}}
{{- $fullName := include "argocd-promotion-gate.fullname" . -}}
{{- $secretName := printf "%s-tls" $fullName -}}
{{- $existing := lookup "v1" "Secret" .Release.Namespace $secretName -}}
{{- if and $existing $existing.data (index $existing.data "tls.crt") (index $existing.data "tls.key") (index $existing.data "ca.crt") -}}
{{- $_ := set .Values "generatedCerts" (dict
      "cert" (index $existing.data "tls.crt")
      "key" (index $existing.data "tls.key")
      "ca" (index $existing.data "ca.crt")) -}}
{{- else -}}
{{- $days := int .Values.webhook.certValidityDays -}}
{{- $altNames := list
      $fullName
      (printf "%s.%s" $fullName .Release.Namespace)
      (printf "%s.%s.svc" $fullName .Release.Namespace)
      (printf "%s.%s.svc.cluster.local" $fullName .Release.Namespace) -}}
{{- $ca := genCA (printf "%s-ca" $fullName) $days -}}
{{- $signed := genSignedCert $fullName nil $altNames $days $ca -}}
{{- $_ := set .Values "generatedCerts" (dict
      "cert" ($signed.Cert | b64enc)
      "key" ($signed.Key | b64enc)
      "ca" ($ca.Cert | b64enc)) -}}
{{- end -}}
{{- end -}}
{{- end -}}
