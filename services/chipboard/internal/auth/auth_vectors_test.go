package auth

import (
	"encoding/json"
	"os"
	"testing"
	"time"
)

// testdata/token_vectors.json is shared with the Next.js app: its minting
// (lib/chipboard/token.ts) is tested against the same file in
// lib/chipboard/token.test.ts. If either side changes the token format, one of
// the two tests fails instead of every connection silently closing with 4003.
func TestSharedTokenVectors(t *testing.T) {
	raw, err := os.ReadFile("testdata/token_vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Secret  string `json:"secret"`
		Vectors []struct {
			PlayerID string `json:"playerId"`
			Expiry   int64  `json:"expiry"`
			Token    string `json:"token"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Vectors) == 0 {
		t.Fatal("no vectors")
	}
	h, err := NewHMAC(f.Secret)
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range f.Vectors {
		tok, err := h.Mint(v.PlayerID, time.Unix(v.Expiry, 0))
		if err != nil || tok != v.Token {
			t.Errorf("%s: minted %q (%v), fixture %q", v.PlayerID, tok, err, v.Token)
		}
		id, err := h.Verify(v.Token, time.Unix(v.Expiry-1, 0))
		if err != nil || id != v.PlayerID {
			t.Errorf("%s: verify %q %v", v.PlayerID, id, err)
		}
		if _, err := h.Verify(v.Token, time.Unix(v.Expiry, 0)); err != ErrExpired {
			t.Errorf("%s: at expiry %v", v.PlayerID, err)
		}
	}
}
