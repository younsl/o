# IAM User Audit

Custom plugin for monitoring inactive AWS IAM users with a password reset approval workflow.

## Features

- Dashboard with total, inactive (90+ days), severely inactive (180+ days) user counts
- Searchable/sortable IAM user table with access key details and inactivity days
- Password reset request/approval workflow with admin review
- Slack notifications for inactive user alerts and password reset DMs
- Role-based access control via `permission.admins` config
- Configurable inactivity threshold and cron schedules

## Configuration

```yaml
# app-config.yaml
iamUserAudit:
  enabled: true
  inactiveDays: 90
  region: us-east-1
  dryRun: false
  # assumeRoleArn: arn:aws:iam::123456789012:role/backstage-iam-user-audit-role
  slack:
    webhookUrl: ${IAM_AUDIT_SLACK_WEBHOOK_URL}
    botToken: ${IAM_AUDIT_SLACK_BOT_TOKEN}
  schedule:
    fetchCron: '*/5 * * * *'
    cron: '0 10 * * 1-5'
```

## AWS Permissions Required

`iam:ListUsers`, `iam:ListAccessKeys`, `iam:GetAccessKeyLastUsed`, `iam:GetLoginProfile`, `iam:UpdateLoginProfile`
