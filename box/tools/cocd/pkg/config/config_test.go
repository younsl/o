package config

import (
	"testing"
)

func TestExtractHostname(t *testing.T) {
	tests := []struct {
		name     string
		baseURL  string
		expected string
	}{
		{
			name:     "GitHub.com with https",
			baseURL:  "https://github.com",
			expected: "github.com",
		},
		{
			name:     "GitHub API with https",
			baseURL:  "https://api.github.com",
			expected: "api.github.com",
		},
		{
			name:     "GHES with https",
			baseURL:  "https://github.example.com",
			expected: "github.example.com",
		},
		{
			name:     "Hostname without protocol",
			baseURL:  "github.example.com",
			expected: "github.example.com",
		},
		{
			name:     "URL with path",
			baseURL:  "https://github.com/api/v3",
			expected: "github.com",
		},
		{
			name:     "URL with query parameters",
			baseURL:  "https://github.com?param=value",
			expected: "github.com",
		},
		{
			name:     "Empty string",
			baseURL:  "",
			expected: "",
		},
		{
			name:     "HTTP protocol",
			baseURL:  "http://github.com",
			expected: "github.com",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := extractHostname(tt.baseURL)
			if result != tt.expected {
				t.Errorf("extractHostname(%q) = %q, expected %q", tt.baseURL, result, tt.expected)
			}
		})
	}
}
