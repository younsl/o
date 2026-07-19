package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// This file holds the low-level value parsers used by Load: sizes, durations,
// tag filters, and environment fallbacks. They are deliberately free of any
// Config knowledge so each parser is testable in isolation.

// maxEBSVolumeGiB is the largest EBS volume size AWS supports (64 TiB, io2
// Block Express). No grow amount can meaningfully exceed it.
const maxEBSVolumeGiB = 64 * 1024

// ParseGrowAmount parses an absolute growth value with a MiB or GiB unit (e.g.
// "10GiB", "5120MiB") into whole GiB. EBS volumes are sized in GiB, so a MiB
// value is rounded up to the next whole GiB to guarantee at least the requested
// growth. The unit is required and case-insensitive; the shorthand forms "Gi"
// and "Mi" are also accepted.
func ParseGrowAmount(raw string) (int32, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return 0, fmt.Errorf("empty value, expected a number with a MiB or GiB unit such as 10GiB")
	}
	lower := strings.ToLower(s)
	var (
		numStr  string
		toGiB   func(int64) int64
		unitErr = fmt.Errorf("value %q must end with a MiB or GiB unit such as 10GiB or 5120MiB", raw)
	)
	switch {
	case strings.HasSuffix(lower, "gib"):
		numStr, toGiB = lower[:len(lower)-3], func(n int64) int64 { return n }
	case strings.HasSuffix(lower, "mib"):
		numStr, toGiB = lower[:len(lower)-3], mibToGiB
	case strings.HasSuffix(lower, "gi"):
		numStr, toGiB = lower[:len(lower)-2], func(n int64) int64 { return n }
	case strings.HasSuffix(lower, "mi"):
		numStr, toGiB = lower[:len(lower)-2], mibToGiB
	default:
		return 0, unitErr
	}
	numStr = strings.TrimSpace(numStr)
	n, err := strconv.ParseInt(numStr, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("value %q has an invalid number %q: %w", raw, numStr, err)
	}
	if n <= 0 {
		return 0, fmt.Errorf("value %q must be greater than 0", raw)
	}
	gib := toGiB(n)
	if gib > maxEBSVolumeGiB {
		return 0, fmt.Errorf("value %q exceeds the EBS maximum volume size of 64TiB", raw)
	}
	return int32(gib), nil
}

// mibToGiB converts MiB to GiB, rounding up so the resulting whole GiB is never
// less than the requested MiB. The caller guarantees mib > 0; rounding via
// (mib-1)/1024+1 cannot overflow, unlike adding 1023 before dividing.
func mibToGiB(mib int64) int64 {
	return (mib-1)/1024 + 1
}

// parseTagFilters parses "Key=Value,Key2=Value2" into TagFilter slices.
func parseTagFilters(raw string) ([]TagFilter, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	var out []TagFilter
	for _, pair := range strings.Split(raw, ",") {
		pair = strings.TrimSpace(pair)
		if pair == "" {
			continue
		}
		key, value, found := strings.Cut(pair, "=")
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if !found || key == "" || value == "" {
			return nil, fmt.Errorf("invalid tag filter %q, expected Key=Value", pair)
		}
		out = append(out, TagFilter{Key: key, Value: value})
	}
	return out, nil
}

// parseDuration parses a Go duration string. An invalid value (including empty,
// which the pre-filled defaults make impossible in practice) is a hard error so
// misconfiguration (e.g. "1hour", "5min", or a unitless "300") fails at startup
// instead of running with a surprising value.
func parseDuration(name, raw string) (time.Duration, error) {
	d, err := time.ParseDuration(strings.TrimSpace(raw))
	if err != nil {
		return 0, fmt.Errorf("invalid %s %q: must be a Go duration such as 30s, 5m, 1h, 1h30m", name, raw)
	}
	return d, nil
}

func getEnv(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok {
		return v
	}
	return fallback
}
