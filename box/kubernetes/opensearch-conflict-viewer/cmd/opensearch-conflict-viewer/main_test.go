package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/younsl/o/box/kubernetes/opensearch-conflict-viewer/internal/config"
)

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func TestRunServesUntilCancelled(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/.kibana/_search", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"hits":{"hits":[{"_source":{"index-pattern":{"title":"logs-a-*"}}}]}}`))
	})
	mux.HandleFunc("/logs-*/_field_caps", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"indices":["logs-a-1","logs-a-2"],"fields":{"f":{
			"text":{"type":"text","indices":["logs-a-1"]},
			"long":{"type":"long","indices":["logs-a-2"]}
		}}}`))
	})
	fake := httptest.NewServer(mux)
	defer fake.Close()

	port := freePort(t)
	t.Setenv("OPENSEARCH_URL", fake.URL)
	t.Setenv("LISTEN_PORT", fmt.Sprint(port))
	t.Setenv("LOG_FORMAT", "text")

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- run(ctx) }()

	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	deadline := time.Now().Add(5 * time.Second)
	for {
		resp, err := http.Get(base + "/readyz")
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("server did not become ready in time")
		}
		time.Sleep(50 * time.Millisecond)
	}

	resp, err := http.Get(base + "/api/conflicts")
	if err != nil {
		t.Fatalf("GET /api/conflicts: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/conflicts = %d, want 200", resp.StatusCode)
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("run returned error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("run did not shut down after cancel")
	}
}

func TestRunFailsWithoutURL(t *testing.T) {
	t.Setenv("OPENSEARCH_URL", "")
	if err := run(context.Background()); err == nil {
		t.Fatal("expected config error")
	}
}

func TestNewLogger(t *testing.T) {
	if newLogger(config.Config{LogLevel: "debug", LogFormat: "text"}) == nil {
		t.Fatal("nil text logger")
	}
	if newLogger(config.Config{LogLevel: "bogus", LogFormat: "json"}) == nil {
		t.Fatal("nil json logger")
	}
}
