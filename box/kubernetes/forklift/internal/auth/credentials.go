package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"

	"golang.org/x/crypto/bcrypt"
)

// patPrefix identifies forklift personal access tokens in client configs.
const patPrefix = "flpat_"

// HashPassword returns a bcrypt hash of a plaintext password.
func HashPassword(plain string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(plain), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// VerifyPassword checks a plaintext password against a bcrypt hash.
func VerifyPassword(hash, plain string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(plain)) == nil
}

// GenerateToken creates a new personal access token and its storage hash. The
// plaintext is returned once to the caller and never persisted.
func GenerateToken() (plaintext, hash string, err error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", "", err
	}
	plaintext = patPrefix + hex.EncodeToString(buf)
	return plaintext, HashToken(plaintext), nil
}

// HashToken returns the SHA-256 hex hash used to look up a token. PATs are high
// entropy, so a fast hash (not bcrypt) is appropriate and keeps lookups cheap.
func HashToken(plaintext string) string {
	sum := sha256.Sum256([]byte(plaintext))
	return hex.EncodeToString(sum[:])
}

// RandomPassword generates a URL-safe random password (used to seed the initial
// admin when no password is configured).
func RandomPassword() (string, error) {
	b := make([]byte, 18)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// IsPAT reports whether a credential string looks like a forklift PAT.
func IsPAT(s string) bool {
	return len(s) > len(patPrefix) && s[:len(patPrefix)] == patPrefix
}

// ErrInvalidCredential is returned when authentication fails.
var ErrInvalidCredential = errors.New("invalid credentials")

// ErrAccountLocked is returned when a valid account is locked out after too many
// failed password attempts and must be unlocked by an administrator.
var ErrAccountLocked = errors.New("account locked")

// MaxFailedLogins is the consecutive failed-password threshold that locks a
// lockout-enabled account.
const MaxFailedLogins = 5
