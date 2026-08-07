# Metrics

Metrics flow in both directions, which is worth separating before reading the tables.

**Read**: the traffic gate queries Prometheus or Mimir to decide whether a tunnel is
quiet enough to replace right now. Only when a candidate exists, never on an idle pass.

**Written**: the controller exposes its own metrics on `:9090/metrics`, for dashboards
and alerts.

## Written: exposed on /metrics

### Per-tunnel state

All four carry the same labels, so a dashboard can join them without relabeling:
`vpn_connection_id`, `vpn_connection_name`, `tunnel_ip`.

Series are reset at the start of each pass and repopulated, so a connection that was
untagged or deleted stops reporting rather than freezing at its last value.

| Metric | Type | Meaning |
| --- | --- | --- |
| `aws_vpn_maintenance_handler_tunnel_up` | gauge | 1 when telemetry reports UP |
| `aws_vpn_maintenance_handler_tunnel_accepted_routes` | gauge | BGP routes accepted. Always 0 on static-routes-only connections, where it carries no health information |
| `aws_vpn_maintenance_handler_tunnel_pending_maintenance` | gauge | 1 when AWS has endpoint maintenance queued for this tunnel |
| `aws_vpn_maintenance_handler_tunnel_maintenance_deadline_seconds` | gauge | Unix timestamp after which AWS applies the maintenance itself. 0 when none is published |
| `aws_vpn_maintenance_handler_tunnel_lifecycle_control` | gauge | 1 when endpoint lifecycle control is enabled. A 0 means this controller can never take the tunnel over |

### Decisions

| Metric | Type | Meaning |
| --- | --- | --- |
| `aws_vpn_maintenance_handler_blocked_tunnels` | gauge | Tunnels currently held back, by `reason` |
| `aws_vpn_maintenance_handler_blocked_total` | counter | Cumulative preflight rejections, by `reason` |
| `aws_vpn_maintenance_handler_window_open` | gauge | 1 when the window is open and long enough to start in |
| `aws_vpn_maintenance_handler_window_remaining_seconds` | gauge | Seconds left in the current window, 0 when closed |
| `aws_vpn_maintenance_handler_traffic_gate_total` | counter | Traffic gate verdicts, by `verdict` (`allowed`, `blocked`) |
| `aws_vpn_maintenance_handler_traffic_ratio` | gauge | Most recent traffic over the quiet threshold. Below 1 means the gate would open. Only set when the window history was readable |
| `aws_vpn_maintenance_handler_traffic_percentile` | gauge | Where the measured traffic falls in what the connection carries during its maintenance window, in percent. Compare against `quietPercentile` |
| `aws_vpn_maintenance_handler_detection_notices_total` | counter | Detection notices delivered to the approvers, by the `reason` holding back the tunnel AWS takes over first. One per connection per maintenance cycle |
| `aws_vpn_maintenance_handler_approval_total` | counter | Resolved approval requests, by `decision` (`approved`, `denied`, `timeout`, `expired`, `aborted`). `timeout` is nobody answering; `expired` is the preconditions lapsing while the request was outstanding |

`reason` values, shared by the blocked series and the notice counter:
`lifecycle_control_disabled`, `no_pending_maintenance`, `connection_unavailable`,
`tunnel_count`, `peer_down`, `peer_unstable`, `peer_no_routes`, `cooldown`,
`replacement_in_flight`, `awaiting_approval`, `window_closed`, `traffic_high`.
Notices are never counted under `replacement_in_flight` or `awaiting_approval`: a
connection the approvers are already looking at is not notified about again.

### Replacements

| Metric | Type | Meaning |
| --- | --- | --- |
| `aws_vpn_maintenance_handler_replacement_total` | counter | Attempts by `outcome` (`succeeded`, `dry_run`, `request_failed`, `verify_timeout`, `peer_lost`, `aborted`) |
| `aws_vpn_maintenance_handler_replacement_duration_seconds` | histogram | Time from the AWS call until verified or given up |
| `aws_vpn_maintenance_handler_replacement_in_flight` | gauge | 1 while a replacement is running or being verified |
| `aws_vpn_maintenance_handler_peer_dropped_total` | counter | Replacements during which the surviving tunnel also dropped. Should stay at 0 |

### Process

| Metric | Type | Meaning |
| --- | --- | --- |
| `aws_vpn_maintenance_handler_reconcile_total` | counter | Passes started |
| `aws_vpn_maintenance_handler_reconcile_errors_total` | counter | Errors by `stage` |
| `aws_vpn_maintenance_handler_managed_connections` | gauge | Tag-matched connections discovered in the latest pass |

Go runtime and process collectors are registered as well.

## Alerts worth having

The interesting failures are silent ones: nothing crashes, maintenance simply never
happens.

```yaml
groups:
  - name: aws-vpn-maintenance-handler
    rules:
      # A tunnel nobody can take over. Actionable configuration, not a transient state.
      - alert: VPNTunnelLifecycleControlDisabled
        expr: aws_vpn_maintenance_handler_tunnel_lifecycle_control == 0
        for: 1h
        annotations:
          summary: "Tunnel {{ $labels.tunnel_ip }} has endpoint lifecycle control disabled"

      # Maintenance is queued and AWS will apply it within 48h at a time of its
      # choosing. Almost always an unanswered approval.
      - alert: VPNTunnelMaintenanceDeadlineNear
        expr: |
          aws_vpn_maintenance_handler_tunnel_maintenance_deadline_seconds > 0
          and aws_vpn_maintenance_handler_tunnel_maintenance_deadline_seconds - time() < 172800
        for: 30m
        annotations:
          summary: "AWS will replace tunnel {{ $labels.tunnel_ip }} on its own schedule soon"

      # Both tunnels of a connection were down during a replacement. Should never fire.
      - alert: VPNTunnelPeerLostDuringReplacement
        expr: increase(aws_vpn_maintenance_handler_peer_dropped_total[1h]) > 0
        annotations:
          summary: "A VPN connection had no healthy tunnel during a replacement"

      # Replaced and still not healthy. Cannot be rolled back.
      - alert: VPNTunnelReplacementUnhealthy
        expr: increase(aws_vpn_maintenance_handler_replacement_total{outcome=~"verify_timeout|peer_lost"}[1h]) > 0
        annotations:
          summary: "A tunnel replacement did not come back healthy"

      # Approvals are unreachable, so nothing can be authorized.
      - alert: AWSVPNMaintenanceHandlerNotReady
        expr: up{job="aws-vpn-maintenance-handler"} == 1 and aws_vpn_maintenance_handler_reconcile_total == 0
        for: 15m
        annotations:
          summary: "aws-vpn-maintenance-handler is running but not reconciling"
```

Readiness already covers the Slack connection: `/readyz` fails when Socket Mode is
disconnected, because a controller that cannot receive approvals cannot do its job.

## Read: the traffic gate

The gate compares what the tunnel is carrying now against its own recent history. A
relative baseline is what makes "quiet" mean quiet for this tunnel rather than below
some global byte figure.

### Auto mode (default)

Nobody writes PromQL. On first use the controller probes the metric store for a known
VPN traffic metric and builds both queries itself:

| Exporter | Metrics | Labels |
| --- | --- | --- |
| yet-another-cloudwatch-exporter | `aws_ec2_vpn_tunnel_data_out_sum`, `..._data_in_sum` | `dimension_VpnId`, `dimension_TunnelIpAddress` |
| yet-another-cloudwatch-exporter (vpn namespace) | `aws_vpn_tunnel_data_out_sum`, `..._data_in_sum` | same |
| prometheus cloudwatch_exporter | `aws_ec2_tunnel_data_out_sum`, `..._data_in_sum` | same |
| cloudwatch_exporter (average) | `aws_vpn_tunnel_data_out_average`, `..._data_in_average` | same |
| OpenTelemetry awscloudwatchmetrics receiver | `amazonaws_com_AWS_VPN_TunnelDataOut`, `...TunnelDataIn` | `VpnId`, `TunnelIpAddress` |

The first profile with data for the connection wins, and the result is cached: probing
every pass would multiply queries for an answer that does not change while the exporter
stays the same. Which of these is correct depends on the exporter a cluster happens to
run, and a query written once by hand silently stops matching when the exporter is
swapped, which is the reason this is detected rather than configured.

The generated expression, for a gauge-style exporter, read once as a range query and
used for both the present moment and the history it is compared against:

```promql
(sum(avg_over_time(aws_ec2_vpn_tunnel_data_out_sum{dimension_VpnId="vpn-abc"}[5m])) or vector(0))
  + (sum(avg_over_time(aws_ec2_vpn_tunnel_data_in_sum{dimension_VpnId="vpn-abc"}[5m])) or vector(0))
```

One expression rather than a current/baseline pair, so the two ends of the comparison
cannot drift apart. Both directions count, because a replacement interrupts traffic
either way and a connection can be busy inbound while its egress looks idle; `or
vector(0)` keeps a missing direction from emptying the whole expression. Counter-style
exporters get `rate()` instead of `avg_over_time()`, because `rate()` on a gauge is
meaningless.

Fixed, because they are properties of the question rather than of a cluster: a 5m sample
window matching the CloudWatch period, a 28d lookback covering four occurrences of a
weekly window, a 15m sustain window for "now", and a floor of 24 in-window samples
before a percentile means anything.

If no profile matches, the gate treats it as a query failure and applies `onError`,
which defaults to blocking. No metric means no evidence the tunnel is quiet.

### The one threshold

| Setting | Effect |
| --- | --- |
| `quietPercentile` | Share of what this connection carries *during its own maintenance window* that counts as quiet. 20 acts once traffic is in the quietest fifth of the last four weeks of that window |
| `onError` | `block` (default) or `allow`. What an unreadable metric source means |

The distribution is built from window instants only. A midday value compared against a
distribution that includes every night is judged against sleeping hours, and no
percentile of that mixture is reached during business hours.

Read `aws_vpn_maintenance_handler_traffic_percentile` against the configured value to see
how close the gate is to opening, and `..._traffic_ratio` for the same thing as a
multiple of the threshold. A gate that never passes shows up as pending maintenance that
keeps reaching its AWS deadline unreplaced; raising `quietPercentile` is the fix, and
`safety.escalateBefore` already relaxes the target to the median as that deadline
approaches.
