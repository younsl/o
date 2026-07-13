# Built-in CLI

## Overview

The `external-ebs-autoresizer` binary ships operational subcommands alongside
the controller, in the style of Grafana Alloy. They let you validate the config
file and inspect policy reach without a running controller: from a laptop
before deploying, or inside the Pod with `kubectl exec` after.

Read this if you are:

- A platform or DevOps engineer writing or changing resize policies who wants
  to confirm what they match before they take effect.
- An on-call engineer checking why an instance was (or was not) resized.

```
Usage:
  external-ebs-autoresizer [flags]
  external-ebs-autoresizer [command]

Available Commands:
  completion  Generate the autocompletion script for the specified shell
  help        Help about any command
  instances   List discovered instances grouped by the policy each matches (calls AWS)
  policies    Print the resolved resize policies and their effective settings
  run         Run the controller (the default when no subcommand is given)
  validate    Load and validate the config file, then exit
```

With no subcommand (or `run`) the binary starts the controller. All commands
exit `0` on success and non-zero on any error, so they compose with CI checks
and shell scripts.

## The --config flag

Every command reads the same config file, resolved in this order:

1. `--config <path>` flag
2. `CONFIG_FILE` environment variable
3. `/etc/external-ebs-autoresizer/config.yaml` (the chart's ConfigMap mount)

## Commands

### validate

Loads the config file, applies defaults, strict-decodes it (unknown keys are
errors), validates every field, and compiles every resize policy (selector
regexes, grow amounts, required fields). Exits non-zero with the first error.
Never contacts AWS.

```console
$ external-ebs-autoresizer validate --config config.example.yaml
config config.example.yaml is valid: region=ap-northeast-2, 2 named resize policies plus the default
```

Typical uses: a CI check on config changes, and a pre-apply sanity check for a
new policy entry.

### policies

Prints each named policy and its **effective** settings — what an instance
matching it actually gets after inheriting unset fields from `defaultPolicy` —
sorted by precedence (highest weight first), with the default policy last.
Never contacts AWS unless `--count` is set.

```console
$ external-ebs-autoresizer policies --config config.example.yaml
POLICY   WEIGHT  SELECTOR                        PAUSED  THRESHOLD%  GROW             MAX_GIB
bastion  5       name~bastion                    true    60          percent +10%     1000
shared   1       name~^shared-                   false   80          absolute +50GiB  1000
default  -       (instances matching no policy)  false   80          percent +10%     1000
```

| Column | Meaning |
|--------|---------|
| `POLICY` | Policy name; `default` is the built-in bucket for unmatched instances |
| `WEIGHT` | Match precedence; highest wins when several policies match one instance |
| `SELECTOR` | Compact selector: `Key=Value` tag equalities and `name~<regex>`, ANDed with ` & ` |
| `PAUSED` | `true` means matching instances are skipped entirely |
| `THRESHOLD%` | Effective `usageThresholdPercent` |
| `GROW` | Effective growth: `percent +N%` or `absolute +NGiB` |
| `MAX_GIB` | Effective `maxVolumeSizeGiB` ceiling |

With `--count`, it also discovers target instances via AWS and appends a
`MATCHED` column with the number of instances each policy identifies (equals
the `external_ebs_autoresizer_policy_instances` metric):

```console
$ external-ebs-autoresizer policies --count --config config.example.yaml
POLICY   WEIGHT  SELECTOR                        PAUSED  THRESHOLD%  GROW             MAX_GIB  MATCHED
bastion  5       name~bastion                    true    60          percent +10%     1000     1
shared   1       name~^shared-                   false   80          absolute +50GiB  1000     5
default  -       (instances matching no policy)  false   80          percent +10%     1000     0
```

### instances

Discovers target instances exactly as the controller does (`tagFilters`,
`excludeEKSNodes`) and lists every instance grouped by the policy it matches.
Requires AWS credentials with `ec2:DescribeInstances` and
`ec2:DescribeVolumes`; makes no writes. A policy that matches nothing shows
`(none)` so a selector that silently stopped matching is visible.

```console
$ external-ebs-autoresizer instances --config config.example.yaml
POLICY   INSTANCE_ID          NAME                                  ROOT_VOLUME            SIZE_GIB
bastion  i-04d6e43bb3a79a490  shared-mpay-bastion-ec2               vol-07f532e1a4d0992c9  30
shared   i-00ed9f64b92d32d82  shared-mpay-gitlab-master-ec2         vol-0db7ffec1d0260f20  120
shared   i-0ec58d48dced9eb7e  shared-mpay-whatap-master-ec2         vol-0bdfd0996bdbb8b4e  500
default  (none)

6 instances discovered in ap-northeast-2
```

Use it to answer "which policy will govern this instance?" and to confirm a
policy's reach before merging a selector change.

### run

Starts the controller (identical to running with no subcommand): loads the
config, compiles policies, serves health and metrics, elects a leader when
enabled, and reconciles on the configured interval.

## Running inside the Pod

The container image ships the same binary, so every command works via
`kubectl exec` against the mounted ConfigMap:

```bash
kubectl exec deploy/external-ebs-autoresizer -- external-ebs-autoresizer policies --count
kubectl exec deploy/external-ebs-autoresizer -- external-ebs-autoresizer instances
```

The Pod's IRSA/Pod Identity credentials cover the read-only EC2 calls, since
the controller already requires them.

## Local verification

`config.example.yaml` at the project root mirrors the chart-rendered config.
The Makefile wraps each command against it; override the file with
`CONFIG=path`:

```bash
make validate     # go run ... validate  --config config.example.yaml
make policies     # go run ... policies   --config config.example.yaml
make instances    # go run ... instances  --config config.example.yaml (needs AWS credentials)
```

## Conclusion

Three read-only questions, three commands:

- Is the config valid? `validate`
- What does each policy do, and how many instances does it cover? `policies [--count]`
- Which policy governs which instance? `instances`

Wire `validate` into CI for config changes, and reach for `policies --count`
first when a resize did not happen where you expected one.
