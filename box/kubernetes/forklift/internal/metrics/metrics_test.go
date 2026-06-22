package metrics

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
)

type fakeReader struct {
	repos     []meta.Repository
	stats     map[int64]meta.RepoStats
	blobCount int64
	blobBytes int64
	err       bool
}

func (f *fakeReader) ListRepositories(context.Context) ([]meta.Repository, error) {
	if f.err {
		return nil, errors.New("boom")
	}
	return f.repos, nil
}

func (f *fakeReader) AllRepoStats(context.Context) (map[int64]meta.RepoStats, error) {
	if f.err {
		return nil, errors.New("boom")
	}
	return f.stats, nil
}

func (f *fakeReader) BlobStats(context.Context) (int64, int64, error) {
	if f.err {
		return 0, 0, errors.New("boom")
	}
	return f.blobCount, f.blobBytes, nil
}

func TestStorageCollector(t *testing.T) {
	c := NewStorageCollector(&fakeReader{
		repos: []meta.Repository{
			{ID: 1, Name: "npm-hosted", Format: "npm", Type: "hosted"},
			{ID: 2, Name: "npm-proxy", Format: "npm", Type: "proxy"},
			{ID: 3, Name: "maven-hosted", Format: "maven", Type: "hosted"},
		},
		stats: map[int64]meta.RepoStats{
			1: {ArtifactCount: 4, TotalSize: 100},
			2: {ArtifactCount: 6, TotalSize: 200},
		},
		blobCount: 7,
		blobBytes: 4096,
	})

	want := `
# HELP forklift_artifacts Logical artifacts stored across all repositories.
# TYPE forklift_artifacts gauge
forklift_artifacts 10
# HELP forklift_blobs Deduplicated content-addressed blobs in the blob store.
# TYPE forklift_blobs gauge
forklift_blobs 7
# HELP forklift_repositories Configured repositories by format and type.
# TYPE forklift_repositories gauge
forklift_repositories{format="maven",type="hosted"} 1
forklift_repositories{format="npm",type="hosted"} 1
forklift_repositories{format="npm",type="proxy"} 1
# HELP forklift_repository_artifacts Logical artifacts stored per repository.
# TYPE forklift_repository_artifacts gauge
forklift_repository_artifacts{format="maven",repository="maven-hosted",type="hosted"} 0
forklift_repository_artifacts{format="npm",repository="npm-hosted",type="hosted"} 4
forklift_repository_artifacts{format="npm",repository="npm-proxy",type="proxy"} 6
# HELP forklift_repository_size_bytes Logical (pre-dedup) bytes of artifacts stored per repository.
# TYPE forklift_repository_size_bytes gauge
forklift_repository_size_bytes{format="maven",repository="maven-hosted",type="hosted"} 0
forklift_repository_size_bytes{format="npm",repository="npm-hosted",type="hosted"} 100
forklift_repository_size_bytes{format="npm",repository="npm-proxy",type="proxy"} 200
# HELP forklift_storage_bytes Physical bytes used by deduplicated blobs.
# TYPE forklift_storage_bytes gauge
forklift_storage_bytes 4096
`
	if err := testutil.CollectAndCompare(c, strings.NewReader(want)); err != nil {
		t.Fatal(err)
	}
}

// A failing reader must not emit any metric (a single error never poisons the
// rest of the scrape; here all three queries fail so the output is empty).
func TestStorageCollectorErrorsAreSkipped(t *testing.T) {
	c := NewStorageCollector(&fakeReader{err: true})
	if n := testutil.CollectAndCount(c); n != 0 {
		t.Fatalf("expected no metrics on error, got %d", n)
	}
}
