package gate

import (
	"encoding/json"
	"testing"
)

func TestParseImage(t *testing.T) {
	cases := []struct {
		name       string
		raw        string
		repository string
		basename   string
		tag        string
		digest     string
	}{
		{
			name:       "registry with tag",
			raw:        "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/payment-api:tag-abc1234",
			repository: "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/payment-api",
			basename:   "payment-api",
			tag:        "tag-abc1234",
		},
		{
			name:       "registry port without tag",
			raw:        "registry.example.com:5000/team/payment-api",
			repository: "registry.example.com:5000/team/payment-api",
			basename:   "payment-api",
		},
		{
			name:       "registry port with tag",
			raw:        "registry.example.com:5000/team/payment-api:1.2.3",
			repository: "registry.example.com:5000/team/payment-api",
			basename:   "payment-api",
			tag:        "1.2.3",
		},
		{
			name:       "digest pinned",
			raw:        "ghcr.io/example/app@sha256:abcdef",
			repository: "ghcr.io/example/app",
			basename:   "app",
			digest:     "sha256:abcdef",
		},
		{
			name:       "bare library image",
			raw:        "nginx",
			repository: "nginx",
			basename:   "nginx",
		},
		{
			name:       "surrounding whitespace",
			raw:        "  nginx:1.20-alpine  ",
			repository: "nginx",
			basename:   "nginx",
			tag:        "1.20-alpine",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ParseImage(tc.raw)
			if got.Repository != tc.repository {
				t.Errorf("Repository = %q, want %q", got.Repository, tc.repository)
			}
			if got.Basename != tc.basename {
				t.Errorf("Basename = %q, want %q", got.Basename, tc.basename)
			}
			if got.Tag != tc.tag {
				t.Errorf("Tag = %q, want %q", got.Tag, tc.tag)
			}
			if got.Digest != tc.digest {
				t.Errorf("Digest = %q, want %q", got.Digest, tc.digest)
			}
		})
	}
}

func TestImageRefRef(t *testing.T) {
	if got := ParseImage("app:v1").Ref(); got != "v1" {
		t.Errorf("Ref() = %q, want v1", got)
	}
	if got := ParseImage("app@sha256:aaa").Ref(); got != "sha256:aaa" {
		t.Errorf("Ref() = %q, want sha256:aaa", got)
	}
	if got := ParseImage("app").Ref(); got != "" {
		t.Errorf("Ref() = %q, want empty", got)
	}
}

func TestIsIgnored(t *testing.T) {
	ignore := []string{"nginx", "autoinstrumentation-*"}
	cases := map[string]bool{
		"nginx":                     true,
		"autoinstrumentation-java":  true,
		"autoinstrumentation-":      true,
		"payment-api":               false,
		"nginx-prometheus-exporter": false,
	}
	for basename, want := range cases {
		if got := IsIgnored(basename, ignore); got != want {
			t.Errorf("IsIgnored(%q) = %v, want %v", basename, got, want)
		}
	}
	if IsIgnored("anything", nil) {
		t.Error("IsIgnored() with an empty list = true, want false")
	}
}

func TestIndexByBasename(t *testing.T) {
	images := []ImageRef{
		ParseImage("123456789012.dkr.ecr.example/payment-api:v1"),
		ParseImage("123456789012.dkr.ecr.example/nginx:1.20-alpine"),
		// A repeated repository must not produce two entries.
		ParseImage("123456789012.dkr.ecr.example/payment-api:v2"),
	}
	idx := IndexByBasename(images, []string{"nginx"})
	if len(idx) != 1 {
		t.Fatalf("IndexByBasename() returned %d entries, want 1", len(idx))
	}
	if idx["payment-api"].Tag != "v2" {
		t.Errorf("payment-api tag = %q, want v2 (last occurrence wins)", idx["payment-api"].Tag)
	}
}

func decode(t *testing.T, raw string) any {
	t.Helper()
	var out any
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	return out
}

func TestExtractImages(t *testing.T) {
	cases := []struct {
		name     string
		manifest string
		want     []string
	}{
		{
			name: "deployment with init container",
			manifest: `{"kind":"Deployment","spec":{"template":{"spec":{
				"initContainers":[{"image":"busybox:1.36"}],
				"containers":[{"image":"ghcr.io/example/payment-api:v1"},{"image":"  "}]}}}}`,
			want: []string{"payment-api", "busybox"},
		},
		{
			name:     "cronjob nests one level deeper",
			manifest: `{"kind":"CronJob","spec":{"jobTemplate":{"spec":{"template":{"spec":{"containers":[{"image":"ghcr.io/example/batch:v9"}]}}}}}}`,
			want:     []string{"batch"},
		},
		{
			name:     "rollout is handled without per-kind code",
			manifest: `{"kind":"Rollout","apiVersion":"argoproj.io/v1alpha1","spec":{"template":{"spec":{"containers":[{"image":"ghcr.io/example/api:v3"}]}}}}`,
			want:     []string{"api"},
		},
		{
			name:     "ephemeral containers are counted",
			manifest: `{"spec":{"ephemeralContainers":[{"image":"ghcr.io/example/debug:v1"}]}}`,
			want:     []string{"debug"},
		},
		{
			name:     "unrelated image key is ignored",
			manifest: `{"kind":"ConfigMap","data":{"image":"not-a-container"}}`,
			want:     nil,
		},
		{
			name:     "malformed container list is ignored",
			manifest: `{"spec":{"containers":"nope"}}`,
			want:     nil,
		},
		{
			name:     "container entry without an image is ignored",
			manifest: `{"spec":{"containers":[{"name":"sidecar"},"nope"]}}`,
			want:     nil,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			images := ExtractImages(decode(t, tc.manifest))
			if len(images) != len(tc.want) {
				t.Fatalf("ExtractImages() = %d images, want %d (%+v)", len(images), len(tc.want), images)
			}
			found := make(map[string]struct{}, len(images))
			for _, img := range images {
				found[img.Basename] = struct{}{}
			}
			for _, basename := range tc.want {
				if _, ok := found[basename]; !ok {
					t.Errorf("ExtractImages() missing %q, got %+v", basename, images)
				}
			}
		})
	}
}

func TestExtractImagesIsDeterministic(t *testing.T) {
	manifest := decode(t, `{"spec":{"template":{"spec":{"containers":[
		{"image":"a.example/one:v1"},{"image":"a.example/two:v2"},{"image":"a.example/three:v3"}]}}}}`)
	first := ExtractImages(manifest)
	for range 20 {
		next := ExtractImages(manifest)
		if len(next) != len(first) {
			t.Fatalf("ExtractImages() length changed between runs")
		}
		for i := range first {
			if next[i].Raw != first[i].Raw {
				t.Fatalf("ExtractImages() order changed between runs at %d: %q vs %q", i, next[i].Raw, first[i].Raw)
			}
		}
	}
}

func TestCompareImages(t *testing.T) {
	t.Run("same tag across different registries matches", func(t *testing.T) {
		// The whole point of comparing basenames: one ECR account per env.
		got := CompareImages(
			[]ImageRef{ParseImage("123456789012.dkr.ecr.example/payment-api:tag-abc")},
			[]ImageRef{ParseImage("210987654321.dkr.ecr.example/payment-api:tag-abc")},
			nil,
		)
		if len(got) != 1 || !got[0].Matched {
			t.Fatalf("CompareImages() = %+v, want one match", got)
		}
	})

	t.Run("different tag does not match", func(t *testing.T) {
		got := CompareImages(
			[]ImageRef{ParseImage("a.example/payment-api:new")},
			[]ImageRef{ParseImage("b.example/payment-api:old")},
			nil,
		)
		if len(got) != 1 || got[0].Matched {
			t.Fatalf("CompareImages() = %+v, want one mismatch", got)
		}
		if got[0].DesiredTag != "new" || got[0].UpstreamTag != "old" {
			t.Errorf("CompareImages() tags = %q/%q, want new/old", got[0].DesiredTag, got[0].UpstreamTag)
		}
	})

	t.Run("only repositories on both sides are compared", func(t *testing.T) {
		got := CompareImages(
			[]ImageRef{ParseImage("a.example/payment-api:v1"), ParseImage("a.example/nginx:1.20")},
			[]ImageRef{ParseImage("b.example/payment-api:v1"), ParseImage("b.example/otel-agent:1.0")},
			nil,
		)
		if len(got) != 1 || got[0].Repository != "payment-api" {
			t.Fatalf("CompareImages() = %+v, want only payment-api", got)
		}
	})

	t.Run("ignored repositories are dropped", func(t *testing.T) {
		got := CompareImages(
			[]ImageRef{ParseImage("a.example/payment-api:v1"), ParseImage("a.example/nginx:1.20")},
			[]ImageRef{ParseImage("b.example/payment-api:v1"), ParseImage("b.example/nginx:1.21")},
			[]string{"nginx"},
		)
		if len(got) != 1 || got[0].Repository != "payment-api" {
			t.Fatalf("CompareImages() = %+v, want nginx dropped", got)
		}
	})

	t.Run("digests compare by digest", func(t *testing.T) {
		same := CompareImages(
			[]ImageRef{ParseImage("a.example/app@sha256:aaa")},
			[]ImageRef{ParseImage("b.example/app@sha256:aaa")},
			nil,
		)
		if !same[0].Matched {
			t.Error("identical digests did not match")
		}
		differs := CompareImages(
			[]ImageRef{ParseImage("a.example/app@sha256:aaa")},
			[]ImageRef{ParseImage("b.example/app@sha256:bbb")},
			nil,
		)
		if differs[0].Matched {
			t.Error("different digests matched")
		}
	})

	t.Run("tag against digest never matches", func(t *testing.T) {
		got := CompareImages(
			[]ImageRef{ParseImage("a.example/app:v1")},
			[]ImageRef{ParseImage("b.example/app@sha256:aaa")},
			nil,
		)
		if got[0].Matched {
			t.Error("a tag matched a digest")
		}
	})

	t.Run("references without tag or digest never match", func(t *testing.T) {
		got := CompareImages(
			[]ImageRef{ParseImage("a.example/app")},
			[]ImageRef{ParseImage("b.example/app")},
			nil,
		)
		if got[0].Matched {
			t.Error("two untagged references matched, which would pass an unverifiable image")
		}
	})

	t.Run("no comparable repository yields no comparison", func(t *testing.T) {
		if got := CompareImages(nil, nil, nil); len(got) != 0 {
			t.Errorf("CompareImages() = %+v, want empty", got)
		}
	})
}
