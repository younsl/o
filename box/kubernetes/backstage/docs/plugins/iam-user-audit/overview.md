---
plugins:
  - iam-user-audit
  - iam-user-audit-backend
---

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
    # Optional fallback. If set, IAM user "alice" maps to alice@example.com
    # when no delegated owner tag is present.
    # emailDomain: example.com
  schedule:
    fetchCron: '*/5 * * * *'
    cron: '0 10 * * 1-5'
```

## Delegated Owner Mapping

External or partner-owned IAM users can be delegated to an internal Backstage
user by adding this IAM user tag:

| IAM user | Tag key | Tag value |
| --- | --- | --- |
| `vendor-support-01` | `iam-user-audit.plugins.backstage.io/owner` | `user:default/younsung.lee` |

When the tag is present:

- the delegated owner can see that IAM user in the IAM Audit page
- automatic warning DMs are sent to the delegated owner
- manual status DMs are sent to the delegated owner

Slack DMs resolve the owner ref through the Backstage Catalog User entity
`spec.profile.email`. If the owner email cannot be resolved, the plugin falls
back to the existing IAM username / `emailDomain` lookup.

## AWS Permissions Required

`iam:ListUsers`, `iam:ListUserTags`, `iam:ListAccessKeys`, `iam:GetAccessKeyLastUsed`, `iam:GetLoginProfile`, `iam:UpdateLoginProfile`
