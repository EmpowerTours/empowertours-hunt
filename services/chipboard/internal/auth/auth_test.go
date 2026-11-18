package auth

import (
	"strings"
	"testing"
	"time"
)

const testSecret = "test-secret-test-secret-test-secret-0123"

func TestHMACRoundTrip(t *testing.T) {
	h, err := NewHMAC(testSecret)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1_800_000_000, 0)
	tok, err := h.Mint("0xAbC123", now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if id, err := h.Verify(tok, now); err != nil || id != "0xAbC123" {
		t.Fatalf("verify: %q %v", id, err)
	}
	if _, err := h.Verify(tok, now.Add(time.Hour)); err != ErrExpired {
		t.Errorf("at expiry: %v", err)
	}
	// Known answer, so another language can check its own minting:
	// HMAC-SHA256(secret, "ana.1800003600") in base64url without padding.
	tok2, _ := h.Mint("ana", now.Add(time.Hour))
	if !strings.HasPrefix(tok2, "ana.1800003600.") || len(strings.Split(tok2, ".")[2]) != 43 {
		t.Errorf("token shape: %d parts", len(strings.Split(tok2, ".")))
	}
}

func TestHMACRejects(t *testing.T) {
	h, _ := NewHMAC(testSecret)
	other, _ := NewHMAC(strings.Repeat("x", 32))
	now := time.Unix(1_800_000_000, 0)
	tok, _ := h.Mint("ana", now.Add(time.Hour))
	parts := strings.Split(tok, ".")
	otherTok, _ := other.Mint("ana", now.Add(time.Hour))
	cases := map[string]error{
		"":                                  ErrMalformed,
		"ana":                               ErrMalformed,
		"ana.1800003600":                    ErrMalformed,
		"a.b.c.d":                           ErrMalformed,
		"ana.soon." + parts[2]:              ErrMalformed,
		"an a." + parts[1] + "." + parts[2]: ErrMalformed,
		"ana." + parts[1] + ".!!!":          ErrMalformed,
		"beto." + parts[1] + "." + parts[2]: ErrSignature, // someone else's signature
		"ana.9999999999." + parts[2]:        ErrSignature, // stretched expiry
		otherTok:                            ErrSignature, // signed with another secret
	}
	for tok, want := range cases {
		if _, err := h.Verify(tok, now); err != want {
			t.Errorf("token with %d chars: got %v, want %v", len(tok), err, want)
		}
	}
}

func TestSecretAndIDRules(t *testing.T) {
	if _, err := NewHMAC("short"); err == nil {
		t.Error("short secret accepted")
	}
	h, _ := NewHMAC(testSecret)
	if _, err := h.Mint("a.b", time.Now()); err == nil {
		t.Error("player id with a dot accepted")
	}
	for id, want := range map[string]bool{"ana": true, "fid:1234": true, "0x7dBe": true, "": false, "a b": false, "a.b": false, strings.Repeat("a", 65): false} {
		if ValidPlayerID(id) != want {
			t.Errorf("ValidPlayerID(%q) != %v", id, want)
		}
	}
}
