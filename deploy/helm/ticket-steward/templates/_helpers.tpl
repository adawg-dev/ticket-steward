{{- define "steward.image" -}}
{{ .repository }}:{{ .tag }}
{{- end -}}

{{/* storageClassName only when one is named: an empty string would ask for no class at all, not the default. */}}
{{- define "steward.storageClass" -}}
{{- if .Values.storage.className }}
storageClassName: {{ .Values.storage.className | quote }}
{{- end }}
{{- end -}}

{{/* The private ranges, then the cluster's service and pod CIDRs: no pod but the dispatcher reaches them. */}}
{{- define "steward.privateRanges" -}}
- 10.0.0.0/8
- 172.16.0.0/12
- 192.168.0.0/16
- {{ required "cluster.serviceCidr is required" .Values.cluster.serviceCidr }}
- {{ required "cluster.podCidr is required" .Values.cluster.podCidr }}
{{- end -}}

{{- define "steward.runPodSelector" -}}
matchExpressions:
  - key: steward.run-id
    operator: Exists
{{- end -}}

{{- define "steward.dns" -}}
- to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
      podSelector:
        matchLabels:
          k8s-app: kube-dns
  ports:
    - protocol: UDP
      port: 53
    - protocol: TCP
      port: 53
{{- end -}}
