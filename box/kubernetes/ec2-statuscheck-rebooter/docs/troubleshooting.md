# Troubleshooting

## Common Issues

### No instances being monitored

**Symptoms:**
- Logs show `total_scanned=0` or `healthy_count=0`
- No instances appear in monitoring output

**Possible Causes & Solutions:**

1. **Incorrect tag filters**
   - Verify tag filters match your EC2 instance tags exactly
   - Check tag key-value format: `Key=Value`
   - Test without filters first to see all instances

2. **Instances not in running state**
   - Only running instances are monitored
   - Check instance state: `aws ec2 describe-instances --instance-ids i-xxxxx`

3. **IAM permissions not configured**
   - Verify IAM role has required EC2 permissions
   - Check IRSA or Pod Identity association is correct
   - Test with `aws ec2 describe-instance-status` from pod

4. **Monitoring EKS worker nodes by mistake**
   - This tool automatically excludes EKS worker nodes
   - Check logs for "Excluding EKS worker node from monitoring"
   - Ensure target instances don't have EKS-related tags:
     - `kubernetes.io/cluster/<cluster-name>`
     - `eks:cluster-name`
     - `eks:nodegroup-name`

5. **Wrong AWS region**
   - Verify `rebooter.region` matches your instances' region
   - Check logs for "Using explicit AWS region" or "auto-detect"
   - If using region restriction in IAM policy, ensure it matches

### Permission denied errors

**Symptoms:**
- Error: `AccessDenied` or `UnauthorizedOperation`
- API calls failing with 403 status

**Possible Causes & Solutions:**

1. **IRSA annotation incorrect**
   ```yaml
   # Verify annotation format
   serviceAccount:
     annotations:
       eks.amazonaws.com/role-arn: arn:aws:iam::ACCOUNT_ID:role/ROLE_NAME
   ```

2. **IAM role missing required permissions**
   - Ensure all four permissions are attached:
     - `ec2:DescribeRegions`
     - `ec2:DescribeInstanceStatus`
     - `ec2:DescribeInstances`
     - `ec2:RebootInstances`
   - Test IAM policy with AWS Policy Simulator

3. **Trust relationship not configured**
   - For IRSA: Verify OIDC provider trust relationship
   - For Pod Identity: Verify pod identity association exists
   - Check service account namespace matches trust policy

4. **Region restriction in IAM policy**
   - If using `aws:RequestedRegion` condition, verify region is allowed
   - Check application region matches IAM policy condition

### Instances not being rebooted

**Symptoms:**
- Instances show impaired status but no reboot occurs
- Logs show failure count increasing but no reboot action

**Possible Causes & Solutions:**

1. **Dry run mode enabled**
   ```bash
   # Check if dry run is enabled
   kubectl get deployment ec2-statuscheck-rebooter -o yaml | grep DRY_RUN

   # Disable dry run
   helm upgrade ec2-statuscheck-rebooter ./charts/ec2-statuscheck-rebooter \
     --set rebooter.dryRun=false
   ```

2. **Failure threshold not reached**
   - Check current failure count in logs
   - Default threshold is 2 consecutive failures
   - Wait for next check cycle or lower threshold:
   ```bash
   helm upgrade ec2-statuscheck-rebooter ./charts/ec2-statuscheck-rebooter \
     --set rebooter.failureThreshold=1
   ```

3. **RebootInstances permission missing**
   - Verify IAM policy includes `ec2:RebootInstances`
   - Check for any Resource or Condition restrictions

4. **Instance already rebooting**
   - Check EC2 console for instance state
   - AWS may rate-limit reboot requests

### EKS worker nodes being monitored

**Symptoms:**
- Logs show EKS worker node instance IDs
- Cluster nodes appear in monitoring output

**Solution:**

This should not happen as EKS nodes are automatically excluded. If you see this:

1. **Verify EKS node exclusion logs**
   ```json
   {"instance_id":"i-xxx","instance_name":"eks-node","cluster_name":"my-cluster","message":"Excluding EKS worker node from monitoring"}
   ```

2. **Check instance tags**
   - EKS nodes should have these tags automatically
   - If missing, this is an EKS configuration issue

3. **Use explicit tag filters**
   ```bash
   # Only monitor instances with specific tags
   helm upgrade ec2-statuscheck-rebooter ./charts/ec2-statuscheck-rebooter \
     --set rebooter.tagFilters="{Environment=production,ManagedBy=ec2-rebooter}"
   ```

**Important**: This tool is NOT for managing Kubernetes worker nodes. Use:
- [AWS Node Termination Handler](https://github.com/aws/aws-node-termination-handler) for EKS node lifecycle
- [Karpenter](https://karpenter.sh/) for advanced node management
- [kured](https://github.com/kubereboot/kured) for automatic node reboots after kernel updates

### Health check probe failures

**Symptoms:**
- Pod not becoming ready
- `/readyz` endpoint returns 503
- Kubernetes shows pod as not ready

**Possible Causes & Solutions:**

1. **AWS connectivity issue**
   - Check logs for "Failed to connect to EC2 API endpoint"
   - Verify network connectivity to EC2 API
   - Check VPC endpoints if using private subnets

2. **IAM credentials not available**
   - Verify IRSA or Pod Identity is configured
   - Check pod has correct service account
   - Verify IAM role trust relationship

3. **Incorrect health check configuration**
   ```yaml
   # Increase initial delay if startup is slow
   readinessProbe:
     initialDelaySeconds: 10
     periodSeconds: 10
   ```

### High memory or CPU usage

**Symptoms:**
- Pod using more than 128Mi memory
- CPU throttling occurring
- OOMKilled events

**Possible Causes & Solutions:**

1. **Monitoring too many instances**
   - Use tag filters to reduce scope
   - Increase check interval to reduce API calls
   - Consider increasing resource limits:
   ```yaml
   resources:
     limits:
       memory: 256Mi
       cpu: 500m
   ```

2. **Aggressive check interval**
   - Default 300s is recommended
   - Avoid intervals below 60s
   - AWS API has rate limits

3. **Log level too verbose**
   ```bash
   # Use info level in production
   helm upgrade ec2-statuscheck-rebooter ./charts/ec2-statuscheck-rebooter \
     --set rebooter.logLevel=info
   ```

## Debugging Tips

### View application logs

```bash
# Follow logs in real-time
kubectl logs -f deployment/ec2-statuscheck-rebooter -n monitoring

# View last 100 lines
kubectl logs --tail=100 deployment/ec2-statuscheck-rebooter -n monitoring

# View logs with timestamps
kubectl logs --timestamps deployment/ec2-statuscheck-rebooter -n monitoring
```

### Test AWS API connectivity from pod

```bash
# Exec into running pod
kubectl exec -it deployment/ec2-statuscheck-rebooter -n monitoring -- sh

# Test AWS credentials
aws sts get-caller-identity

# List EC2 instances
aws ec2 describe-instances --region us-east-1

# Check instance status
aws ec2 describe-instance-status --region us-east-1
```

### Verify IRSA configuration

```bash
# Check service account annotations
kubectl get serviceaccount ec2-statuscheck-rebooter -n monitoring -o yaml

# Verify IAM role exists
aws iam get-role --role-name EC2RebooterRole

# Check IAM role permissions
aws iam get-role-policy --role-name EC2RebooterRole --policy-name EC2RebooterPolicy
```

### Verify Pod Identity configuration

```bash
# List pod identity associations
aws eks list-pod-identity-associations --cluster-name my-cluster

# Describe specific association
aws eks describe-pod-identity-association \
  --cluster-name my-cluster \
  --association-id a-xxxxx
```

### Enable debug logging

```bash
# Upgrade with debug level
helm upgrade ec2-statuscheck-rebooter ./charts/ec2-statuscheck-rebooter \
  --set rebooter.logLevel=debug \
  --set rebooter.logFormat=pretty
```

### Check health endpoints

```bash
# Port-forward to access health endpoints
kubectl port-forward deployment/ec2-statuscheck-rebooter 8080:8080 -n monitoring

# Test liveness probe
curl http://localhost:8080/healthz

# Test readiness probe
curl http://localhost:8080/readyz
```

## Getting Help

If you're still experiencing issues:

1. Enable debug logging and capture logs
2. Check AWS CloudTrail for API call errors
3. Review IAM policy simulator results
4. Open an issue with:
   - Helm values used
   - Application logs (redact sensitive info)
   - Error messages
   - Steps to reproduce
