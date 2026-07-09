package opensearch

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

func newFake(t *testing.T) (*httptest.Server, *Client) {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/.kibana/_search", func(w http.ResponseWriter, r *http.Request) {
		if user, pass, ok := r.BasicAuth(); !ok || user != "viewer" || pass != "secret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Write([]byte(`{"hits":{"hits":[
			{"_source":{"index-pattern":{"title":"logs-b-*"}}},
			{"_source":{"index-pattern":{"title":"logs-a-*"}}},
			{"_source":{"index-pattern":{"title":"logs-a-*"}}},
			{"_source":{"index-pattern":{"title":""}}},
			{"_source":{}}
		]}}`))
	})
	mux.HandleFunc("/logs-*/_field_caps", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{
			"indices":["logs-a-1","logs-a-2"],
			"fields":{"f":{
				"text":{"type":"text","indices":["logs-a-1"]},
				"long":{"type":"long","indices":["logs-a-2"]}
			}}
		}`))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, New(srv.URL, "viewer", "secret")
}

func TestIndexPatterns(t *testing.T) {
	_, c := newFake(t)
	patterns, err := c.IndexPatterns(context.Background(), ".kibana")
	if err != nil {
		t.Fatalf("IndexPatterns: %v", err)
	}
	want := []string{"logs-a-*", "logs-b-*"}
	if !reflect.DeepEqual(patterns, want) {
		t.Fatalf("patterns = %v, want %v (sorted, deduped, empty skipped)", patterns, want)
	}
}

func TestFieldCapabilities(t *testing.T) {
	_, c := newFake(t)
	caps, err := c.FieldCapabilities(context.Background(), "logs-*")
	if err != nil {
		t.Fatalf("FieldCapabilities: %v", err)
	}
	if len(caps.Indices) != 2 {
		t.Fatalf("Indices = %v, want 2", caps.Indices)
	}
	if caps.Fields["f"]["text"].Indices[0] != "logs-a-1" {
		t.Fatalf("field caps = %+v", caps.Fields["f"])
	}
}

func TestUnauthorized(t *testing.T) {
	srv, _ := newFake(t)
	c := New(srv.URL, "viewer", "wrong")
	if _, err := c.IndexPatterns(context.Background(), ".kibana"); err == nil {
		t.Fatal("expected error on 401")
	}
}

func TestUnreachable(t *testing.T) {
	c := New("http://127.0.0.1:1", "", "")
	if _, err := c.FieldCapabilities(context.Background(), "logs-*"); err == nil {
		t.Fatal("expected connection error")
	}
}
