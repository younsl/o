package auth

import (
	"context"
	"net/http"
)

const sessionCookie = "forklift_session"

type ctxKey int

const principalKey ctxKey = 0

// Middleware resolves the request principal (if any) and stores it in the
// request context. It never rejects; enforcement is done by handlers via
// FromContext and Principal.Can, or by RequireAuth.
func (s *Service) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, err := s.Resolve(r.Context(), r)
		if err != nil {
			s.log.Error("principal resolution failed", "err", err)
		}
		if p != nil {
			r = r.WithContext(context.WithValue(r.Context(), principalKey, p))
		}
		next.ServeHTTP(w, r)
	})
}

// FromContext returns the principal stored by Middleware, or nil for anonymous.
func FromContext(ctx context.Context) *Principal {
	p, _ := ctx.Value(principalKey).(*Principal)
	return p
}

// RequireAdmin is middleware that allows only global administrators.
func (s *Service) RequireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := FromContext(r.Context())
		if p == nil {
			Unauthorized(w)
			return
		}
		if !p.IsAdmin() {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RequireApprover is middleware that allows administrators and principals
// holding the approve action on at least one repository pattern. Handlers
// behind it still enforce per-repository checks via Can(repo, ActionApprove).
func (s *Service) RequireApprover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := FromContext(r.Context())
		if p == nil {
			Unauthorized(w)
			return
		}
		if !p.IsAdmin() && !p.CanApproveAny() {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RequireAuth is middleware that requires any authenticated principal.
func (s *Service) RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if FromContext(r.Context()) == nil {
			Unauthorized(w)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// SetSessionCookie writes the signed session cookie.
func SetSessionCookie(w http.ResponseWriter, value string, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    value,
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	})
}

// ClearSessionCookie removes the session cookie.
func ClearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: "", Path: "/", HttpOnly: true, MaxAge: -1,
	})
}

// Unauthorized writes a plain 401 without a Basic challenge. Used by the UI
// API so browsers never show the native credential dialog (cached Basic
// credentials would otherwise bypass logout and the login page).
func Unauthorized(w http.ResponseWriter) {
	http.Error(w, "unauthorized", http.StatusUnauthorized)
}

// UnauthorizedBasic writes a 401 with a Basic challenge so package-manager
// clients (Maven, npm, cargo, go) know to send credentials.
func UnauthorizedBasic(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", `Basic realm="forklift"`)
	http.Error(w, "unauthorized", http.StatusUnauthorized)
}
