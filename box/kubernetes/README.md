# Kubernetes

[Kubernetes](https://github.com/kubernetes/kubernetes) operations automation and [observability](https://opentelemetry.io/docs/concepts/observability-primer/), built with [Rust](https://github.com/rust-lang/rust) for system safety and minimal resource footprint.

- [Kubernetes Operators](https://kubernetes.io/docs/concepts/extend-kubernetes/operator/)
- Kubernetes Addons
- Kubernetes-compatible container images
- Security vulnerability defense addons

## These addons are written in Rust

Go is Kubernetes' default language, but these small, long-running operators and exporters optimize for different axes: image size, memory, and crash behavior at 3am. Statically linked scratch images land at 5–15MB against Go's typical 30–80MB, and binaries idle around 5–10MB RSS — meaningful once the same workload fans out across a DaemonSet or parallel CronJobs. The type system removes an entire class of incidents: Option makes nil pointer panics structurally impossible, Result turns ignored errors into compile errors. No GC pauses plus Tokio's structured cancellation make SIGTERM handling deterministic, so controllers shut down cleanly instead of leaking a reconcile mid-flight.

Exception: `external-ebs-autoresizer` is written in Go (1.26.4), still on scratch and multi-arch. It is the one Go addon here, kept that way for the maturity of the AWS SDK for Go around EC2 and SSM.

## Implementation Details

- All Rust container images are based on [scratch](https://hub.docker.com/_/scratch) with statically linked binaries built via [cargo-zigbuild](https://github.com/rust-cross/cargo-zigbuild) for simplified cross-compilation, minimal attack surface and image size.
- Helm charts and container images are distributed as [OCI artifacts](https://helm.sh/docs/topics/registries/) via GHCR, following the [OCI distribution best practice](https://opencontainers.org/posts/blog/2024-03-13-image-and-distribution-1-1/) to unify chart and image delivery through a single registry.
- All Rust applications maintain a minimum of 70% test coverage, measured with [cargo-llvm-cov](https://github.com/taiki-e/cargo-llvm-cov).

## License

[MIT License](../../LICENSE)
