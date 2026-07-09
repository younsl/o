// Package config loads viewer settings from environment variables.
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// Config holds all runtime settings for the viewer.
type Config struct {
	OpenSearchURL   string
	Username        string
	Password        string
	IndexTargets    string
	KibanaIndex     string
	RefreshInterval time.Duration
	ListenPort      int
	ClusterName     string
	LogLevel        string
	LogFormat       string
}

// Load reads configuration from environment variables and applies defaults.
func Load() (Config, error) {
	cfg := Config{
		OpenSearchURL:   os.Getenv("OPENSEARCH_URL"),
		Username:        os.Getenv("OPENSEARCH_USERNAME"),
		Password:        os.Getenv("OPENSEARCH_PASSWORD"),
		IndexTargets:    getEnv("INDEX_TARGETS", "logs-*"),
		KibanaIndex:     getEnv("KIBANA_INDEX", ".kibana"),
		RefreshInterval: time.Hour,
		ListenPort:      8080,
		ClusterName:     os.Getenv("CLUSTER_NAME"),
		LogLevel:        getEnv("LOG_LEVEL", "info"),
		LogFormat:       getEnv("LOG_FORMAT", "json"),
	}

	if cfg.OpenSearchURL == "" {
		return Config{}, fmt.Errorf("OPENSEARCH_URL is required, e.g. https://opensearch.example.com:443")
	}

	if v := os.Getenv("REFRESH_INTERVAL"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil {
			return Config{}, fmt.Errorf("invalid REFRESH_INTERVAL %q: %w", v, err)
		}
		if d < time.Minute {
			return Config{}, fmt.Errorf("REFRESH_INTERVAL must be at least 1m, got %s", d)
		}
		cfg.RefreshInterval = d
	}

	var err error
	if cfg.ListenPort, err = portEnv("LISTEN_PORT", cfg.ListenPort); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func portEnv(key string, fallback int) (int, error) {
	v := os.Getenv(key)
	if v == "" {
		return fallback, nil
	}
	p, err := strconv.Atoi(v)
	if err != nil || p < 1 || p > 65535 {
		return 0, fmt.Errorf("invalid %s %q: must be a port number between 1 and 65535", key, v)
	}
	return p, nil
}
