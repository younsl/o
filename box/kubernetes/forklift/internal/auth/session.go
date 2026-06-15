package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// sessionData is the payload stored in a signed session cookie. Sessions are
// stateless (no server-side store), which keeps HA failover trivial as long as
// all replicas share the same signing secret.
type sessionData struct {
	Username string   `json:"u"`
	Source   string   `json:"s"`
	Groups   []string `json:"g,omitempty"`
	Expires  int64    `json:"e"`
}

// SessionCodec signs and verifies session cookies with HMAC-SHA256.
type SessionCodec struct {
	secret []byte
	ttl    time.Duration
	now    func() time.Time
}

// NewSessionCodec creates a codec. The secret must be shared across replicas.
func NewSessionCodec(secret []byte, ttl time.Duration) *SessionCodec {
	return &SessionCodec{secret: secret, ttl: ttl, now: time.Now}
}

// Encode produces a signed cookie value for a principal.
func (c *SessionCodec) Encode(username, source string, groups []string) (string, error) {
	payload, err := json.Marshal(sessionData{
		Username: username, Source: source, Groups: groups,
		Expires: c.now().Add(c.ttl).Unix(),
	})
	if err != nil {
		return "", err
	}
	body := base64.RawURLEncoding.EncodeToString(payload)
	return body + "." + c.sign(body), nil
}

// Decode verifies a cookie value and returns its payload.
func (c *SessionCodec) Decode(value string) (sessionData, error) {
	body, sig, ok := strings.Cut(value, ".")
	if !ok {
		return sessionData{}, errors.New("malformed session")
	}
	if !hmac.Equal([]byte(sig), []byte(c.sign(body))) {
		return sessionData{}, errors.New("bad session signature")
	}
	raw, err := base64.RawURLEncoding.DecodeString(body)
	if err != nil {
		return sessionData{}, err
	}
	var d sessionData
	if err := json.Unmarshal(raw, &d); err != nil {
		return sessionData{}, err
	}
	if c.now().Unix() > d.Expires {
		return sessionData{}, errors.New("session expired")
	}
	return d, nil
}

func (c *SessionCodec) sign(body string) string {
	mac := hmac.New(sha256.New, c.secret)
	mac.Write([]byte(body))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
