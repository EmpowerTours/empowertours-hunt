// Package auth says who a connection belongs to.
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Verifier turns a session token into a player id.
type Verifier interface {
	Verify(token string, now time.Time) (playerID string, err error)
}

var (
	ErrMalformed = errors.New("malformed token")
	ErrSignature = errors.New("bad signature")
	ErrExpired   = errors.New("token expired")
)

var playerIDRe = regexp.MustCompile(`^[A-Za-z0-9_:-]{1,64}$`)

// ValidPlayerID reports whether s can be a player id: 1-64 of A-Z a-z 0-9 _ : -
// (no dot, which separates the token's parts).
func ValidPlayerID(s string) bool { return playerIDRe.MatchString(s) }

// MinSecretLen is the shortest shared secret accepted.
const MinSecretLen = 32

// HMAC verifies tokens of the form
//
//	playerId.expiry.signature
//
// where expiry is Unix seconds in decimal and signature is
// base64url(HMAC-SHA256(secret, playerId + "." + expiry)) without padding.
// The Next.js app mints them with the same shared secret.
type HMAC struct{ secret []byte }

// TestSecretPrefix marks the fixed secrets in this repo's tests and fixtures.
// They are public (committed), so a server must never run with one.
const TestSecretPrefix = "TEST-ONLY"

// IsTestSecret reports whether secret is one of the committed test secrets.
func IsTestSecret(secret string) bool { return strings.HasPrefix(secret, TestSecretPrefix) }

func NewHMAC(secret string) (*HMAC, error) {
	if len(secret) < MinSecretLen {
		return nil, errors.New("session secret must be at least 32 characters")
	}
	return &HMAC{secret: []byte(secret)}, nil
}

func (h *HMAC) sign(payload string) []byte {
	m := hmac.New(sha256.New, h.secret)
	m.Write([]byte(payload))
	return m.Sum(nil)
}

// Mint makes a token for playerID that is good until expiry.
func (h *HMAC) Mint(playerID string, expiry time.Time) (string, error) {
	if !ValidPlayerID(playerID) {
		return "", errors.New("invalid player id")
	}
	payload := playerID + "." + strconv.FormatInt(expiry.Unix(), 10)
	return payload + "." + base64.RawURLEncoding.EncodeToString(h.sign(payload)), nil
}

func (h *HMAC) Verify(token string, now time.Time) (string, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || !ValidPlayerID(parts[0]) {
		return "", ErrMalformed
	}
	exp, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || exp <= 0 {
		return "", ErrMalformed
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return "", ErrMalformed
	}
	// Check the signature before the expiry, in constant time, so a forged
	// token learns nothing from which error comes back.
	if !hmac.Equal(sig, h.sign(parts[0]+"."+parts[1])) {
		return "", ErrSignature
	}
	if now.Unix() >= exp {
		return "", ErrExpired
	}
	return parts[0], nil
}
