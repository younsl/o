# Troubleshooting

Common issues and solutions for trivy-collector.

## Server mode: 403 Forbidden when watching CRDs

**Symptom**: Server mode fails with RBAC errors when `--watch-local` is enabled (default):

```
ERROR: SbomReport watcher error
error: "sbomreports.aquasecurity.github.io is forbidden: User \"system:serviceaccount:trivy-system:trivy-collector\" cannot list resource \"sbomreports\" in API group \"aquasecurity.github.io\" at the cluster scope"
```

**Cause**: ClusterRole/ClusterRoleBinding not created for server mode.

**Solution**: Ensure the Helm chart creates RBAC resources for both modes. The ClusterRole is required whenever the application watches Kubernetes CRDs, regardless of mode:

```bash
# Verify ClusterRole exists
kubectl get clusterrole trivy-collector

# Verify ClusterRoleBinding exists
kubectl get clusterrolebinding trivy-collector

# If missing, check Helm values
helm get values trivy-collector -n trivy-system
# Ensure serviceAccount.create: true
```

If using the Helm chart, RBAC resources are created when `serviceAccount.create: true`.

## Collector not receiving reports

- Verify Trivy Operator is installed and generating reports
- Check RBAC permissions for watching CRDs
- Verify `SERVER_URL` is reachable from collector pod

## Server not storing reports

- Check storage path permissions (`/data` directory)
- Verify SQLite database is writable
- Check logs for database errors

## Web UI not loading

- Verify server is running on correct port (default: 3000)
- Check ingress/service configuration
- Access server pod directly: `kubectl port-forward svc/trivy-collector 3000:3000`
