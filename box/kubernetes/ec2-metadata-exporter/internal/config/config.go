// Package config loads exporter settings from environment variables.
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// Config holds all runtime settings for the exporter.
type Config struct {
	Region         string
	ScrapeInterval time.Duration
	MetricsPort    int
	HealthPort     int
	LogLevel       string
	LogFormat      string
}

// Load reads configuration from environment variables and applies defaults.
func Load() (Config, error) {
	cfg := Config{
		Region:         os.Getenv("AWS_REGION"),
		ScrapeInterval: 60 * time.Second,
		MetricsPort:    8081,
		HealthPort:     8080,
		LogLevel:       getEnv("LOG_LEVEL", "info"),
		LogFormat:      getEnv("LOG_FORMAT", "json"),
	}

	if v := os.Getenv("SCRAPE_INTERVAL"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil {
			return Config{}, fmt.Errorf("invalid SCRAPE_INTERVAL %q: %w", v, err)
		}
		if d < time.Second {
			return Config{}, fmt.Errorf("SCRAPE_INTERVAL must be at least 1s, got %s", d)
		}
		cfg.ScrapeInterval = d
	}

	var err error
	if cfg.MetricsPort, err = portEnv("METRICS_PORT", cfg.MetricsPort); err != nil {
		return Config{}, err
	}
	if cfg.HealthPort, err = portEnv("HEALTH_PORT", cfg.HealthPort); err != nil {
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
