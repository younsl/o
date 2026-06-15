// Package openapi serves the embedded OpenAPI 3.1 specification and a Scalar
// API reference UI.
package openapi

import (
	_ "embed"
	"net/http"

	"github.com/go-chi/chi/v5"
)

//go:embed openapi.yaml
var spec []byte

// scalarHTML renders the spec with Scalar (loaded from a CDN).
const scalarHTML = `<!doctype html>
<html>
  <head>
    <title>forklift API</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script id="api-reference" data-url="/openapi.yaml"></script>
    <!-- Pinned version (not floating @latest) to reduce CDN-rolling risk. -->
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.25.28" crossorigin="anonymous"></script>
  </body>
</html>`

// Register mounts the spec and docs UI on the router.
func Register(r chi.Router) {
	r.Get("/openapi.yaml", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/yaml")
		_, _ = w.Write(spec)
	})
	r.Get("/api-docs", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(scalarHTML))
	})
}

// Spec returns the raw OpenAPI document (for tests).
func Spec() []byte { return spec }
