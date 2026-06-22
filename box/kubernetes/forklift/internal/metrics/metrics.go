// Package metrics provides scrape-time gauges for repository inventory and
// physical storage usage. Values are computed on each Prometheus scrape (like
// the approval_pending gauge) so they need no leader gating and stay accurate
// on standbys after a replication snapshot swap.
package metrics

import (
	"context"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
)

// Reader is the subset of the metadata store the collector queries on scrape.
type Reader interface {
	ListRepositories(ctx context.Context) ([]meta.Repository, error)
	AllRepoStats(ctx context.Context) (map[int64]meta.RepoStats, error)
	BlobStats(ctx context.Context) (count, bytes int64, err error)
}

// StorageCollector reports repository inventory and blob storage usage.
type StorageCollector struct {
	r       Reader
	timeout time.Duration

	repositories *prometheus.Desc
	artifacts    *prometheus.Desc
	blobs        *prometheus.Desc
	storageBytes *prometheus.Desc

	repoArtifacts *prometheus.Desc
	repoSizeBytes *prometheus.Desc
}

// NewStorageCollector builds a collector backed by the metadata store.
func NewStorageCollector(r Reader) *StorageCollector {
	return &StorageCollector{
		r:       r,
		timeout: 5 * time.Second,
		repositories: prometheus.NewDesc("forklift_repositories",
			"Configured repositories by format and type.",
			[]string{"format", "type"}, nil),
		artifacts: prometheus.NewDesc("forklift_artifacts",
			"Logical artifacts stored across all repositories.", nil, nil),
		blobs: prometheus.NewDesc("forklift_blobs",
			"Deduplicated content-addressed blobs in the blob store.", nil, nil),
		storageBytes: prometheus.NewDesc("forklift_storage_bytes",
			"Physical bytes used by deduplicated blobs.", nil, nil),
		repoArtifacts: prometheus.NewDesc("forklift_repository_artifacts",
			"Logical artifacts stored per repository.",
			[]string{"repository", "format", "type"}, nil),
		repoSizeBytes: prometheus.NewDesc("forklift_repository_size_bytes",
			"Logical (pre-dedup) bytes of artifacts stored per repository.",
			[]string{"repository", "format", "type"}, nil),
	}
}

// Describe implements prometheus.Collector.
func (c *StorageCollector) Describe(ch chan<- *prometheus.Desc) {
	ch <- c.repositories
	ch <- c.artifacts
	ch <- c.blobs
	ch <- c.storageBytes
	ch <- c.repoArtifacts
	ch <- c.repoSizeBytes
}

// Collect implements prometheus.Collector. Individual query failures skip only
// their own metrics so a single error never empties the whole scrape.
func (c *StorageCollector) Collect(ch chan<- prometheus.Metric) {
	ctx, cancel := context.WithTimeout(context.Background(), c.timeout)
	defer cancel()

	repos, repoErr := c.r.ListRepositories(ctx)
	if repoErr == nil {
		counts := map[[2]string]int{}
		for _, r := range repos {
			counts[[2]string{r.Format, r.Type}]++
		}
		for k, n := range counts {
			ch <- prometheus.MustNewConstMetric(c.repositories,
				prometheus.GaugeValue, float64(n), k[0], k[1])
		}
	}

	stats, statsErr := c.r.AllRepoStats(ctx)
	if statsErr == nil {
		var total int64
		for _, st := range stats {
			total += st.ArtifactCount
		}
		ch <- prometheus.MustNewConstMetric(c.artifacts, prometheus.GaugeValue, float64(total))
	}

	// Per-repository inventory needs both the repo list (for name/format/type)
	// and the stats keyed by id; repos with no artifacts are absent from stats
	// and report zero. Sizes here are logical (sum of artifact sizes) and so
	// differ from forklift_storage_bytes, which is deduplicated physical usage.
	if repoErr == nil && statsErr == nil {
		for _, r := range repos {
			st := stats[r.ID]
			ch <- prometheus.MustNewConstMetric(c.repoArtifacts,
				prometheus.GaugeValue, float64(st.ArtifactCount), r.Name, r.Format, r.Type)
			ch <- prometheus.MustNewConstMetric(c.repoSizeBytes,
				prometheus.GaugeValue, float64(st.TotalSize), r.Name, r.Format, r.Type)
		}
	}

	if count, bytes, err := c.r.BlobStats(ctx); err == nil {
		ch <- prometheus.MustNewConstMetric(c.blobs, prometheus.GaugeValue, float64(count))
		ch <- prometheus.MustNewConstMetric(c.storageBytes, prometheus.GaugeValue, float64(bytes))
	}
}
