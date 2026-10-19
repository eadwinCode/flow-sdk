package flow

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"testing"
	"time"

	"github.com/eadwinCode/flow-sdk/internal/core"
)

type vectors struct {
	StepIDs struct {
		Cases []struct {
			ID         string `json:"id"`
			Occurrence int    `json:"occurrence"`
			Input      string `json:"input"`
			Hashed     string `json:"hashed"`
		} `json:"cases"`
	} `json:"stepIds"`
	Signatures struct {
		Cases []struct {
			SigningKey string `json:"signingKey"`
			Body       string `json:"body"`
			T          int64  `json:"t"`
			Header     string `json:"header"`
		} `json:"cases"`
	} `json:"signatures"`
	Bearer struct {
		SigningKey string `json:"signingKey"`
		Bearer     string `json:"bearer"`
	} `json:"bearer"`
}

func loadVectors(t *testing.T) vectors {
	t.Helper()
	// In the monorepo the vectors sit next to this module. The public flow-sdk
	// repo gets a copy in testdata/ at release time.
	b, err := os.ReadFile("../conformance/vectors.json")
	if errors.Is(err, fs.ErrNotExist) {
		b, err = os.ReadFile("testdata/vectors.json")
	}
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var v vectors
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	return v
}

func TestVectorStepIDs(t *testing.T) {
	v := loadVectors(t)
	if len(v.StepIDs.Cases) == 0 {
		t.Fatal("no step id cases")
	}
	for _, c := range v.StepIDs.Cases {
		if got := core.HashStepID(c.ID, c.Occurrence); got != c.Hashed {
			t.Errorf("HashStepID(%q, %d) = %s, want %s", c.ID, c.Occurrence, got, c.Hashed)
		}
	}
}

func TestVectorStepIDsThroughRun(t *testing.T) {
	// The counter in a run gives the same IDs as the vectors.
	v := loadVectors(t)
	r := core.NewRun("run_1", "", nil, nil)
	for _, c := range v.StepIDs.Cases {
		if c.ID != "load-user" {
			continue
		}
		h, _ := r.Next(c.ID)
		if h != c.Hashed {
			t.Errorf("occurrence %d: got %s, want %s", c.Occurrence, h, c.Hashed)
		}
	}
}

func TestVectorSignatures(t *testing.T) {
	v := loadVectors(t)
	if len(v.Signatures.Cases) == 0 {
		t.Fatal("no signature cases")
	}
	for _, c := range v.Signatures.Cases {
		at := time.Unix(c.T, 0)
		got, err := signRequest(c.SigningKey, []byte(c.Body), at)
		if err != nil {
			t.Fatal(err)
		}
		if got != c.Header {
			t.Errorf("signRequest(%q) = %s, want %s", c.Body, got, c.Header)
		}
		if !verifySignature(c.Header, []byte(c.Body), []string{c.SigningKey}, at) {
			t.Errorf("verifySignature rejected vector %q", c.Body)
		}
		if !verifySignature(c.Header, []byte(c.Body), []string{c.SigningKey}, at.Add(300*time.Second)) {
			t.Errorf("verifySignature rejected a signature 300s old")
		}
		if verifySignature(c.Header, []byte(c.Body), []string{c.SigningKey}, at.Add(301*time.Second)) {
			t.Errorf("verifySignature took a signature 301s old")
		}
		if verifySignature(c.Header, []byte(c.Body), []string{c.SigningKey}, at.Add(-301*time.Second)) {
			t.Errorf("verifySignature took a signature 301s in the future")
		}
		if verifySignature(c.Header, []byte(c.Body+" "), []string{c.SigningKey}, at) {
			t.Errorf("verifySignature took a changed body")
		}
	}
}

func TestVectorBearer(t *testing.T) {
	v := loadVectors(t)
	got, err := signingKeyBearer(v.Bearer.SigningKey)
	if err != nil {
		t.Fatal(err)
	}
	if got != v.Bearer.Bearer {
		t.Errorf("bearer = %s, want %s", got, v.Bearer.Bearer)
	}
}

func TestDurationText(t *testing.T) {
	cases := map[time.Duration]string{
		30 * time.Second:        "30s",
		5 * time.Minute:         "300s",
		7 * 24 * time.Hour:      "604800s",
		1500 * time.Millisecond: "1500ms",
		0:                       "0s",
	}
	for d, want := range cases {
		if got := core.Duration(d); got != want {
			t.Errorf("Duration(%v) = %s, want %s", d, got, want)
		}
	}
}
