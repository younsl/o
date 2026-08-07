# jenkins-inbound-agent

[![GHCR](https://img.shields.io/badge/ghcr.io-younsl%2Fjenkins--inbound--agent-000000?style=flat-square&logo=github&logoColor=white)](https://github.com/younsl/o/pkgs/container/jenkins-inbound-agent)
[![Jenkins](https://img.shields.io/badge/inbound--agent-3355.v388858a__47b__33--19-d33833?style=flat-square&logo=jenkins&logoColor=white)](https://github.com/jenkinsci/docker-inbound-agent)
[![AWS CLI](https://img.shields.io/badge/aws--cli-2.22.35-232f3e?style=flat-square&logo=amazonwebservices&logoColor=white)](https://github.com/aws/aws-cli)

[Jenkins inbound agent](https://github.com/jenkinsci/docker-inbound-agent) image with [`sshpass`](https://sourceforge.net/projects/sshpass/) and [AWS CLI v2](https://github.com/aws/aws-cli) baked in, for Kubernetes-based Jenkins build agents.

## Background

The upstream `jenkins/inbound-agent` image ships neither `sshpass` nor the AWS CLI. Pipelines needing `aws s3 cp` or `sshpass`-based SSH steps normally install them at runtime, in an initContainer or an early pipeline stage. That adds a package install to every build, and makes builds depend on apt/PyPI reachability from the agent pod.

This image installs both at build time, so agent pods start ready to run those steps.

## Features

- Base: `jenkins/inbound-agent:3355.v388858a_47b_33-19`
- [AWS CLI v2](https://github.com/aws/aws-cli) `2.22.35`, installed in a builder stage so `curl`/`unzip` are absent from the final image
- [`sshpass`](https://sourceforge.net/projects/sshpass/) via apt
- Multi-arch: `linux/amd64`, `linux/arm64`
- Runs as the unprivileged `jenkins` user and inherits the base `jenkins-agent` entrypoint
- Build-time sanity check (`aws --version && sshpass -V`) fails the build if either binary is broken

The AWS CLI install tree is copied from the builder stage and its `bin` symlinks are recreated in the final stage. Copying `/usr/local/bin/aws` directly would dereference the symlink and break the CLI's relative lookup of its bundled `libpython`.

## Usage

Kubernetes plugin pod template:

```yaml
apiVersion: v1
kind: Pod
spec:
  containers:
    - name: jnlp
      image: ghcr.io/younsl/jenkins-inbound-agent:3355.v388858a_47b_33-19
      resources:
        requests:
          cpu: 500m
          memory: 512Mi
```

The container must be named `jnlp` for the Jenkins Kubernetes plugin to treat it as the agent and inject the connection environment variables.

Local verification:

```bash
docker run --rm -it ghcr.io/younsl/jenkins-inbound-agent:3355.v388858a_47b_33-19 aws --version
```

Image: `ghcr.io/younsl/jenkins-inbound-agent:<TAG>`

## Build

```bash
docker build -t jenkins-inbound-agent:3355.v388858a_47b_33-19 .

# Override the base agent or AWS CLI version
docker build \
  --build-arg BASE_TAG=3355.v388858a_47b_33-19 \
  --build-arg AWSCLI_VERSION=2.22.35 \
  -t jenkins-inbound-agent:custom .
```

| Build arg | Default | Purpose |
| --------- | ------- | ------- |
| `BASE_IMAGE` | `jenkins/inbound-agent` | Upstream agent image |
| `BASE_TAG` | `3355.v388858a_47b_33-19` | Upstream agent tag, also the published image tag |
| `AWSCLI_VERSION` | `2.22.35` | AWS CLI v2 release to install |

## Release

Tagging follows the upstream agent tag, so the image tag states which `jenkins/inbound-agent` it is built from.

[`release-containers.yml`](../../../.github/workflows/release-containers.yml) builds and pushes on merge to `main` when the `org.opencontainers.image.version` label in the Dockerfile changes and that version does not already exist on GHCR. To release, bump both `BASE_TAG` and the version label, then merge.

## License

This project is licensed under the Apache License 2.0. See the [LICENSE](../../../LICENSE) file for details.
