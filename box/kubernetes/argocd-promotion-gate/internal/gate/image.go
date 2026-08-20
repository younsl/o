package gate

import (
	"sort"
	"strings"
)

// containerKeys are the manifest keys whose entries carry an image field.
var containerKeys = map[string]struct{}{
	"containers":          {},
	"initContainers":      {},
	"ephemeralContainers": {},
}

// ParseImage parses a container image reference.
//
// The digest is split off first, then a tag separator is only honoured after
// the last "/" so a registry port ("registry:5000/app") is not mistaken for a
// tag.
func ParseImage(raw string) ImageRef {
	raw = strings.TrimSpace(raw)

	if repo, digest, found := strings.Cut(raw, "@"); found {
		return ImageRef{
			Raw:        raw,
			Repository: repo,
			Basename:   basenameOf(repo),
			Digest:     digest,
		}
	}

	if idx := strings.LastIndex(raw, ":"); idx > strings.LastIndex(raw, "/") {
		repo := raw[:idx]
		return ImageRef{
			Raw:        raw,
			Repository: repo,
			Basename:   basenameOf(repo),
			Tag:        raw[idx+1:],
		}
	}

	return ImageRef{
		Raw:        raw,
		Repository: raw,
		Basename:   basenameOf(raw),
	}
}

func basenameOf(repository string) string {
	if idx := strings.LastIndex(repository, "/"); idx >= 0 {
		return repository[idx+1:]
	}
	return repository
}

// IsIgnored matches a repository basename against the ignore list. A single
// trailing "*" globs, so one entry covers a sidecar family.
func IsIgnored(basename string, ignore []string) bool {
	for _, pattern := range ignore {
		if prefix, wildcard := strings.CutSuffix(pattern, "*"); wildcard {
			if strings.HasPrefix(basename, prefix) {
				return true
			}
			continue
		}
		if pattern == basename {
			return true
		}
	}
	return false
}

// IndexByBasename indexes images by repository basename, dropping ignored
// repositories. The last occurrence wins, which keeps the result stable when a
// manifest repeats a repository across containers.
func IndexByBasename(images []ImageRef, ignore []string) map[string]ImageRef {
	out := make(map[string]ImageRef, len(images))
	for _, img := range images {
		if IsIgnored(img.Basename, ignore) {
			continue
		}
		out[img.Basename] = img
	}
	return out
}

// ExtractImages collects every container image from a rendered Kubernetes
// manifest.
//
// It walks the decoded JSON rather than switching on kind, so Deployment,
// StatefulSet, DaemonSet, CronJob, and Argo Rollouts all work with no per-kind
// handling.
func ExtractImages(manifest any) []ImageRef {
	var out []ImageRef
	walk(manifest, &out)
	return out
}

func walk(node any, out *[]ImageRef) {
	switch value := node.(type) {
	case map[string]any:
		// Iterate in key order so repeated runs produce the same slice.
		keys := make([]string, 0, len(value))
		for key := range value {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			child := value[key]
			if _, isContainerList := containerKeys[key]; isContainerList {
				collectContainerImages(child, out)
			}
			walk(child, out)
		}
	case []any:
		for _, item := range value {
			walk(item, out)
		}
	}
}

func collectContainerImages(node any, out *[]ImageRef) {
	containers, ok := node.([]any)
	if !ok {
		return
	}
	for _, entry := range containers {
		container, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		image, ok := container["image"].(string)
		if !ok || strings.TrimSpace(image) == "" {
			continue
		}
		*out = append(*out, ParseImage(image))
	}
}

// CompareImages compares desired against upstream-live images by repository
// basename.
//
// Only repositories present on both sides are comparable: a sidecar injected
// in one environment only, or an image pulled from a different registry
// account, must not register as a mismatch.
func CompareImages(desired, upstreamLive []ImageRef, ignore []string) []ImageComparison {
	desiredIdx := IndexByBasename(desired, ignore)
	upstreamIdx := IndexByBasename(upstreamLive, ignore)

	basenames := make([]string, 0, len(desiredIdx))
	for basename := range desiredIdx {
		if _, both := upstreamIdx[basename]; both {
			basenames = append(basenames, basename)
		}
	}
	sort.Strings(basenames)

	out := make([]ImageComparison, 0, len(basenames))
	for _, basename := range basenames {
		desiredImg := desiredIdx[basename]
		upstreamImg := upstreamIdx[basename]
		// A digest-pinned reference carries no tag, so comparing empty tags
		// would report a false match. Comparing Ref() falls back to the digest
		// and only matches when both sides pin the same one.
		matched := desiredImg.Ref() != "" && desiredImg.Ref() == upstreamImg.Ref()
		out = append(out, ImageComparison{
			Repository:  basename,
			DesiredTag:  desiredImg.Ref(),
			UpstreamTag: upstreamImg.Ref(),
			Matched:     matched,
		})
	}
	return out
}
