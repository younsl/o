# Slack messages

Every message this controller can send, in the order a run produces them. Use it to
review the wording without waiting for a real maintenance event, and to know which
message means a human is needed.

All examples use the same fictional connection: `prod-dc` (`vpn-0123456789abcdef0`),
tunnel `203.0.113.10` being replaced while `203.0.113.20` carries traffic.

Two rules hold for every message below:

- It starts with its level and the VPN connection, rendered as text in the body.
  See [process.md](./process.md#message-levels) for what each level means.
- Everything after the approval card is posted as a reply in that card's thread, so
  one run reads as one conversation. The detection notice is the exception: it is sent
  before any card exists, so it stands on its own.
- Once an approval is given, every reply ends with a progress footer on its own line.
  See [Progress footer](#progress-footer) below. The examples omit it, so the wording
  stays readable; [section 6](#6-chained-tunnels) shows a full thread with it.

## Progress footer

```
Progress: 3/8 (38%)
```

A thread is read one message at a time, and a step named on its own says nothing about
how much is left. The footer answers that on every reply from the moment an approval is
given until the run closes, including the closing line on the card itself.

The denominator is the whole approved run, not one tunnel. An approval covers a VPN
connection, so a two-tunnel connection is one run of eight phases, and finishing the
first tunnel reads as `4/8 (50%)` rather than as a completed run.

Each tunnel contributes the same four phases, in order:

| # | Phase | What is happening |
| --- | --- | --- |
| 1 | checking | the preflight rules are being re-applied to the tunnel that is next |
| 2 | replacing | the in-flight record is written and `ReplaceVpnTunnel` is outstanding |
| 3 | verifying | AWS accepted, and the tunnel is being watched back to health |
| 4 | recorded | the outcome is persisted and the step is closed out |

The percentage is rounded, so the first phase of a long run never reads as `0%` and the
last always reads as `100%`. It only moves forward: the tunnel count is fixed when the
run starts, so a chain that stops early simply stops short of `100%` rather than having
its denominator revised.

Messages sent before an approval carry no footer. An expired, denied, or withdrawn card
has no run behind it, and a percentage there would claim a replacement got part-way when
none was started.

A restart does not restart the count. The tunnels finished by the previous process are
still part of the same approved run, so a resumed chain picks up at `5/8`, not `1/4`.

## 0. Detection notice

Sent as a direct message to every `approval.slackUserIDs` entry the first time AWS
reports maintenance queued on a connection that is not being replaced right now. It has
no buttons: while the connection is still blocked, there is no preflight evidence to
decide on.

Without it, the first anyone hears of queued maintenance is an approval card, which may
be days after AWS queued the work and hours before its deadline.

One notice covers the connection, the same scope the approval that follows will have. If
both tunnels have maintenance queued, that is one message listing both, not two.

```
[INFO] VPN connection prod-dc (vpn-0123456789abcdef0). Pending VPN tunnel maintenance detected

VPN connection            Region
prod-dc                   ap-northeast-2
(vpn-0123456789abcdef0)

Maintenance queued
- 203.0.113.10, applied by AWS itself after 2026-08-14 09:00 KST (in 15d6h)
- 203.0.113.20, applied by AWS itself after 2026-08-14 09:00 KST (in 15d6h)

Why it is not being replaced yet
outside window: schedule "0 2 * * 2,3,4" (Asia/Seoul) next opens at 2026-08-04 02:00 KST

What happens next
One approval request arrives here covering this connection, once it clears every
preflight check inside the maintenance window. Nothing is needed from you until then.
The window next opens at 2026-08-04 02:00 KST.

The maintenance window is "0 2 * * 2,3,4" for 3h0m0s (Asia/Seoul), min remaining 30m0s.
This notice is sent once per maintenance cycle. Request IDs are
vpn-0123456789abcdef0|203.0.113.10|1786604400 vpn-0123456789abcdef0|203.0.113.20|1786604400.
```

Once per maintenance cycle, not once per reconcile pass. The record lives in the state
ConfigMap under `notices`, keyed by the request IDs of every tunnel the notice covered, so
a restart or a leader handover does not re-announce anything. A request ID contains the
AWS deadline, so work AWS queues later is a new key and gets its own notice, and so does
a tunnel joining the queue after the first notice went out.

### Notice variants

| Condition | What changes |
| --- | --- |
| Deadline within `safety.escalateBefore` on any tunnel | Level becomes `WARN`. Waiting for the next window no longer resolves this on its own |
| Lifecycle control disabled on every queued tunnel | Level becomes `WARN` and the title becomes `VPN tunnel maintenance cannot be taken over`. The last section says to enable it with `ModifyVpnTunnelOptions` instead of promising an approval request |
| Lifecycle control disabled on one of two | Title and the approval promise stay, and a `What to do` section is added naming only that tunnel |
| Tunnels held by different rules | The reason section lists one line per tunnel instead of one shared explanation |
| No AWS deadline published | That tunnel's line reads `no published deadline` |
| Window open, a preflight rule holding the connection | The reason is that rule's own explanation, and no next opening is named: the schedule is not what the connection is waiting for |
| Every candidate deferred by the traffic gate | The reason says preflight passes and the gate is waiting for the tunnel to be quiet |

Not sent for a connection whose approval card is already outstanding, one being replaced,
or one deferred only because another replacement is running. Those are all cases where the
approvers are already looking at that connection, or about to be.

## 1. Approval card

Posted as a direct message to every `approval.slackUserIDs` entry. This is the only
message with buttons.

```
[ACTION] VPN connection prod-dc (vpn-0123456789abcdef0). VPN tunnel replacement approval

VPN connection            Region
prod-dc                   ap-northeast-2
(vpn-0123456789abcdef0)

Tunnel to replace         Tunnel carrying traffic
203.0.113.10              203.0.113.20

Gateway                   Customer gateway
tgw-prod (tgw-0a1b2c3d)   idc-fw-01 (cgw-0e4f5a6b)

Replacement order
1. 203.0.113.10 starts now. Traffic rides 203.0.113.20 while it is down.
2. 203.0.113.20 starts only once 203.0.113.10 is back UP, carrying routes, and has held steady for 5m0s.
Never two at once. Any step that would be unsafe stops the rest and leaves them for a later window.

Preflight checks passed
- Peer tunnel 203.0.113.20 is UP and has been stable for 6h13m0s
- Peer tunnel is accepting 12 BGP route(s)
- AWS reports pending endpoint maintenance and lifecycle control is enabled
- Traffic gate reports that current traffic 3.10M is 12% of the 25.80M baseline, within the 130% limit
- No other replacement is running, and this connection is out of cooldown

If you do nothing
AWS applies this maintenance itself after 2026-08-14 09:00 UTC (in 17d19h), at a time
of its choosing, which may be during business hours.

This cannot be undone. Approving replaces the tunnel endpoint immediately. The tunnel
drops for the duration of the replacement and traffic rides the other tunnel.

[ Approve replacement ]  [ Deny ]

The maintenance window is "0 2 * * *" for 3h0m0s (Asia/Seoul), min remaining 45m0s.
This request expires in 2h0m0s. Request ID is vpn-0123456789abcdef0|203.0.113.10|1786604400.
```

Approve opens a confirmation dialog before anything happens:

```
Confirm replacement
Replace tunnel 203.0.113.10 of prod-dc (vpn-0123456789abcdef0) now.

This is irreversible. The tunnel will drop and traffic will ride 203.0.113.20.

[ Replace it ]  [ Cancel ]
```

### Card variants

| Condition | What changes |
| --- | --- |
| `dryRun: true` | Title gains `(dry run)`. The irreversible warning is replaced by an explanation that approving only validates IAM permissions and arguments. The confirmation dialog says nothing will be replaced |
| Deadline within `safety.escalateBefore` | Level becomes `CRITICAL` and the title becomes `URGENT VPN tunnel replacement approval`. The deadline section is prefixed `URGENT.` |
| No AWS deadline published | The deadline section says so instead, and that the request will expire and be proposed again in a later window |
| Connection is static-routes-only | The BGP route line is replaced by a note that route count is not a health signal |
| Traffic gate disabled or unavailable | The traffic line is absent. Every other check still prints |
| One tunnel has maintenance queued | The order section ends with `203.0.113.20 is not touched by this approval.` |
| Connection has no Name tag | Every label renders as the bare `vpn-0123456789abcdef0` |

## 2. Decision

The approval is answered, or it is not.

```
[INFO] VPN connection prod-dc (vpn-0123456789abcdef0). Approved by <@U0123456789>. Re-checking safety conditions before touching anything.
```

```
[WARN] VPN connection prod-dc (vpn-0123456789abcdef0). *Denied* by <@U0123456789>. The tunnel was left alone.
```

```
[WARN] VPN connection prod-dc (vpn-0123456789abcdef0). *Expired.* Nobody responded within 2h0m0s. The tunnel was left alone and will be proposed again in a later window.
```

A request can also expire before anyone answers, because the conditions it was posted
under lapsed. The closing message names what changed instead of the timeout:

```
[WARN] VPN connection prod-dc (vpn-0123456789abcdef0). *Expired.* too little window left: 25m remaining, 45m required. The tunnel was left alone and will be proposed again in a later window.
```

A denied or expired request also rewrites the card without its buttons, at the level of
the closing message, so it never reads as a pending action later.

## 3. Held back after approval

Every gate is re-measured between the click and the AWS call. These messages mean
nothing was touched.

```
[WARN] VPN connection prod-dc (vpn-0123456789abcdef0). *Not replacing.* Conditions changed between approval and execution.
> peer tunnel 203.0.113.20 is DOWN (IPSEC IS DOWN); replacing this tunnel would drop the whole connection
Nothing was touched. The tunnel will be proposed again once it is safe.
```

```
[WARN] VPN connection prod-dc (vpn-0123456789abcdef0). *Not replacing.* The tunnel is no longer quiet.
> current traffic 46.40M is 180% of the 25.80M baseline, above the 130% limit
Nothing was touched. It will be proposed again once traffic drops.
```

```
[ERROR] VPN connection prod-dc (vpn-0123456789abcdef0). *Not replacing tunnel `203.0.113.10`.* Could not record the in-flight state in the ConfigMap, and a replacement that cannot be tracked must not be started. Nothing was touched. This request is closed rather than left clickable, because nothing is waiting on it any more; the tunnel is proposed again in a later window.
```

## 4. Execution and verification

The AWS call, then a poll loop until the tunnel is healthy or the timeout expires.

```
[INFO] VPN connection prod-dc (vpn-0123456789abcdef0). Calling `ReplaceVpnTunnel` on tunnel `203.0.113.10`. It will drop shortly; traffic rides `203.0.113.20`.
[INFO] VPN connection prod-dc (vpn-0123456789abcdef0). AWS accepted the replacement. Watching tunnel `203.0.113.10` until it returns (timeout 30m0s).
[INFO] VPN connection prod-dc (vpn-0123456789abcdef0). Tunnel `203.0.113.10` is DOWN. AWS reports IPSEC IS DOWN. Peer tunnel `203.0.113.20` is UP with 12 route(s). 1m 30s elapsed so far.
[SUCCESS] VPN connection prod-dc (vpn-0123456789abcdef0). Tunnel `203.0.113.10` is back UP with 9 route(s). The replacement took 4m 12s.
```

Progress lines are posted on change, and otherwise every `approval.progressHeartbeat`,
so a long replacement neither floods the thread nor goes quiet. Each one carries the
elapsed time, so the thread answers "how long has this been down" without arithmetic on
timestamps.

Under a dry run the first two lines are replaced by:

```
[INFO] VPN connection prod-dc (vpn-0123456789abcdef0). Dry run in progress. Validating `ReplaceVpnTunnel` for tunnel `203.0.113.10`.
[SUCCESS] VPN connection prod-dc (vpn-0123456789abcdef0). Dry run accepted by AWS in 412ms. Permissions and arguments are valid; no tunnel was replaced.
```

### The peer dropping

The failure the preflight checks exist to prevent. Reported the moment it is seen, not
at the end of the run.

```
[CRITICAL] VPN connection prod-dc (vpn-0123456789abcdef0). *Peer tunnel `203.0.113.20` just went DOWN while `203.0.113.10` is being replaced.* This connection currently has no healthy tunnel. AWS reports IPSEC IS DOWN.
[SUCCESS] VPN connection prod-dc (vpn-0123456789abcdef0). Peer tunnel `203.0.113.20` is back UP (12 route(s)).
```

### Verification failures

```
[ERROR] VPN connection prod-dc (vpn-0123456789abcdef0). *Gave up on tunnel `203.0.113.10` after 30m 00s.* the tunnel never came back UP with enough accepted routes
The replacement cannot be rolled back. Check the customer gateway side and the tunnel's IKE/IPsec status.
```

```
[ERROR] VPN connection prod-dc (vpn-0123456789abcdef0). Tunnel `203.0.113.10` is no longer reported by `vpn-0123456789abcdef0`, 2m 10s into the replacement. The connection changed during the replacement.
```

When AWS never answered the call, the timeout says so and sends the operator somewhere
else, because a tunnel that never moved is the likely case:

```
[WARN] VPN connection prod-dc (vpn-0123456789abcdef0). AWS did not answer the replacement request, so it may or may not be under way. Watching tunnel `203.0.113.10` as if it were (timeout 30m0s).
[ERROR] VPN connection prod-dc (vpn-0123456789abcdef0). *Gave up on tunnel `203.0.113.10` after 30m 00s.* the tunnel never came back UP with enough accepted routes, and the AWS call was never answered, so it may never have started
Check whether the tunnel still has pending maintenance before retrying. If it does, nothing was replaced.
```

```
[ERROR] VPN connection prod-dc (vpn-0123456789abcdef0). AWS rejected the replacement request after 1s. Nothing was replaced.
```

## 5. Closing line

One per replaced tunnel, posted in the thread and written into the card, which is
rewritten at this level without its buttons. Every outcome states how long the step
took, failures included: the time a failed attempt burned is what says whether the
window still has room for the rest of the connection.

| Outcome | Level | Message |
| --- | --- | --- |
| `succeeded` | `SUCCESS` | `*Replaced.* tunnel UP with 9 accepted route(s) in 4m 12s.` |
| `succeeded`, peer flapped | `WARN` | Same, plus `The peer tunnel also dropped during the replacement, so the connection was briefly without a healthy path. Worth reviewing.` |
| `dry_run` | `SUCCESS` | `*Dry run complete.* AWS accepted the dry-run request; nothing was replaced. Took 412ms.` |
| `request_failed` | `ERROR` | `*Rejected by AWS after 1s.* Nothing was replaced. <AWS error>` |
| `verify_timeout` | `ERROR` | `*Replaced but not healthy after 30m 00s.* the tunnel never came back UP with enough accepted routes. This needs a human because the replacement cannot be undone.` |
| `peer_lost` | `CRITICAL` | `*Both tunnels were down during the replacement.* <detail>. It ran for 6m 40s.` |
| `aborted` | none | Nothing is posted. The run is unfinished and the next leader resumes it |

### Closing report of the whole run

One more line follows the last tunnel's closing line, stating what the approval achieved
and how long the whole thing took. It is the only figure that includes the wait between
tunnels, which is usually the largest part of a chain and appears in none of the
per-tunnel durations: a 27m 30s run is typically 8m of replacement and 19m of waiting.

| Outcome | Level | Message |
| --- | --- | --- |
| every tunnel done | `SUCCESS` | `*Run complete.* All 2 tunnel(s) of this connection are done. The whole run took 27m 30s.` |
| chain stopped short | `WARN` | `*Run ended early.* 1 of 2 tunnel(s) replaced, and the whole run took 12m 04s. The rest keep their queued maintenance and are proposed again in a later window.` |
| all replaced, some unhealthy | `WARN` | `*Run finished.* All 2 tunnel(s) were replaced in 51m 18s, but 1 did not end healthy. Read the steps above before treating this connection as done.` |

Two cases produce nothing. A single-tunnel run, where the closing line one row above
already stated the same duration and repeating it reads as a second measurement. And a
run held back before any replacement, where there is no run to state the length of.

The clock starts when the approver clicks, not when `ReplaceVpnTunnel` is called: that is
the moment they have been waiting from, and the re-check sits between the two. It is
persisted with the in-flight record, so a run that outlives a rollout still reports how
long the connection really took rather than how long the surviving Pod was watching.

## 6. Chained tunnels

One approval covers the connection, so a two-tunnel connection produces one card and
two replacements in the same thread.

This is the one section that shows the progress footer on every reply, since a chain is
where the difference between a step and the whole run is worth seeing.

```
[INFO] VPN connection prod-dc (vpn-0123456789abcdef0). This approval covers 2 tunnel(s) of prod-dc (vpn-0123456789abcdef0), replaced one at a time in this order.
1. `203.0.113.10`
2. `203.0.113.20`
Progress: 1/8 (13%)
[INFO] VPN connection prod-dc (vpn-0123456789abcdef0). *Step 1 of 2.* Tunnel `203.0.113.10` is next.
Progress: 1/8 (13%)
[INFO] VPN connection prod-dc (vpn-0123456789abcdef0). AWS accepted the replacement. Watching tunnel `203.0.113.10` until it returns (timeout 30m0s).
Progress: 3/8 (38%)
[SUCCESS] VPN connection prod-dc (vpn-0123456789abcdef0). *Replaced.* tunnel UP with 9 accepted route(s) in 4m 12s.
Progress: 4/8 (50%)
[INFO] VPN connection prod-dc (vpn-0123456789abcdef0). Waiting before tunnel `203.0.113.20`: peer tunnel 203.0.113.10 has only been stable for 2m0s, 5m0s required (possible flapping)
Progress: 5/8 (63%)
[INFO] VPN connection prod-dc (vpn-0123456789abcdef0). *Step 2 of 2.* Tunnel `203.0.113.20` is next.
Progress: 5/8 (63%)
...
[SUCCESS] VPN connection prod-dc (vpn-0123456789abcdef0). *Replaced.* tunnel UP with 11 accepted route(s) in 3m 48s.
Progress: 8/8 (100%)
[SUCCESS] VPN connection prod-dc (vpn-0123456789abcdef0). *Run complete.* All 2 tunnel(s) of this connection are done. The whole run took 27m 30s.
Progress: 8/8 (100%)
```

Traffic does not stop a run that has already replaced a tunnel, but an elevated reading
is posted before the step it was measured for:

```
[WARN] VPN connection prod-dc (vpn-0123456789abcdef0). Tunnel `203.0.113.20` is not quiet, but this run already replaced its peer and continues anyway.
> now is in the 68th percentile of this window's traffic, above the 20th percentile required
The peer is UP and stable, so the failover still has a healthy path.
```

A chain stops rather than pushes on when the next step would be unsafe. The run report
still follows, because a run that gave up is a run that ended:

```
[WARN] VPN connection prod-dc (vpn-0123456789abcdef0). Stopping before tunnel `203.0.113.20`:
> the maintenance window has closed
Nothing further was touched; it will be proposed again in a later window.
Progress: 5/8 (63%)
[WARN] VPN connection prod-dc (vpn-0123456789abcdef0). *Run ended early.* 1 of 2 tunnel(s) replaced, and the whole run took 12m 04s. The rest keep their queued maintenance and are proposed again in a later window.
Progress: 5/8 (63%)
```

```
[WARN] VPN connection prod-dc (vpn-0123456789abcdef0). Stopping here: 1 tunnel(s) of this connection still have maintenance pending, but the last replacement did not end healthy. They will be proposed again once the connection is healthy.
```

## 7. Restart mid-run

A rollout or a leadership handover continues the same thread. Elapsed times count from
when the replacement really started, not from when the new Pod came up.

```
[INFO] VPN connection prod-dc (vpn-0123456789abcdef0). Controller restarted mid-replacement. Resuming verification of tunnel `203.0.113.10` without re-issuing the AWS call. It has been replacing for 12m 40s so far.
```

```
[WARN] VPN connection prod-dc (vpn-0123456789abcdef0). Controller is shutting down while verifying tunnel `203.0.113.10`, 3m 20s into the replacement. The replacement already happened; verification resumes when the controller comes back.
```

Between two tunnels of a chain, where nothing was in flight at AWS:

```
[INFO] VPN connection prod-dc (vpn-0123456789abcdef0). Picking the approved run back up after a restart. 1 of 2 tunnel(s) are done, and the rest follow in this order.
1. `203.0.113.20`
```

After finishing a tunnel that was in flight during the restart:

```
[INFO] VPN connection prod-dc (vpn-0123456789abcdef0). Continuing the approved run. 1 of 2 tunnel(s) are done, and the rest follow in this order.
1. `203.0.113.20`
```

An approval whose record could not be updated is closed rather than left clickable:

```
[ERROR] VPN connection prod-dc (vpn-0123456789abcdef0). *Closed without replacing anything.* The controller could not record what it was about to do. The tunnel is proposed again in a later window.
```

## Durations

Two formats, and the difference is deliberate.

| Kind | Format | Where |
| --- | --- | --- |
| How long something took | `4m 12s`, `1h 05m 12s`, `412ms` | Progress lines, closing lines, anything measured |
| A horizon still ahead | `2h0m0s`, `17d19h` | Approval expiry, AWS deadline, stability requirement |

Measured times keep their seconds at every scale, because a replacement that took 3m 07s
and one that took 3m 52s are different facts. Horizons are rounded, because no one acts
on the seconds left in a two-hour approval window.

The same durations reach the Pod log, where they are logged twice: `took` for reading
and `took_seconds` for querying.

```
level=INFO msg="replacement finished" vpn_connection_id=vpn-0123456789abcdef0 tunnel_ip=203.0.113.10 outcome=succeeded took="4m 12s" took_seconds=252.4
```
