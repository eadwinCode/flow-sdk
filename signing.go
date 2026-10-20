package flow

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Signing follows packages/protocol/src/signing.ts.
//
// Engine -> app: X-Inngest-Signature: t=<unix seconds>&s=<hex HMAC-SHA256(secret, body + t)>,
// where secret is the key without its "signkey-" prefix, used as text.
// App -> engine answer: X-Flow-Answer-Signature: s=<hex HMAC-SHA256(secret, answerString)>.
// App -> engine: Authorization: Bearer signkey-<hex SHA-256 of the hex-decoded secret>.

// signatureTolerance is how old (or new) a signature may be.
const signatureTolerance = 300 * time.Second

var signingKeyRE = regexp.MustCompile(`^signkey-([0-9a-f]{64})$`)

func parseSigningKey(key string) (secret string, err error) {
	m := signingKeyRE.FindStringSubmatch(key)
	if m == nil {
		return "", errors.New("flow: invalid signing key format (want signkey-<64 hex>)")
	}
	return m[1], nil
}

func hmacHex(secret, message string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(message))
	return hex.EncodeToString(mac.Sum(nil))
}

// signRequest returns the signature header value for body at time now.
func signRequest(signingKey string, body []byte, now time.Time) (string, error) {
	secret, err := parseSigningKey(signingKey)
	if err != nil {
		return "", err
	}
	t := strconv.FormatInt(now.Unix(), 10)
	return "t=" + t + "&s=" + hmacHex(secret, string(body)+t), nil
}

// verifySignature checks a signature header against the given keys (empty keys
// are skipped). It checks every key so timing does not show which one matched.
func verifySignature(header string, body []byte, keys []string, now time.Time) bool {
	return matchSignature(header, body, keys, now) != ""
}

// matchSignature is verifySignature, but returns the key that matched (the
// first one, if more do), or "". The answer is signed with that key.
func matchSignature(header string, body []byte, keys []string, now time.Time) string {
	if header == "" {
		return ""
	}
	params, err := url.ParseQuery(header)
	if err != nil {
		return ""
	}
	t, s := params.Get("t"), params.Get("s")
	if t == "" || s == "" {
		return ""
	}
	for _, c := range t {
		if c < '0' || c > '9' {
			return ""
		}
	}
	ts, err := strconv.ParseInt(t, 10, 64)
	if err != nil {
		return ""
	}
	diff := now.Unix() - ts
	if diff < 0 {
		diff = -diff
	}
	if diff > int64(signatureTolerance/time.Second) {
		return ""
	}
	matched := ""
	for _, key := range keys {
		if key == "" {
			continue
		}
		secret, err := parseSigningKey(key)
		if err != nil {
			continue
		}
		want := hmacHex(secret, string(body)+t)
		if subtle.ConstantTimeCompare([]byte(s), []byte(want)) == 1 && matched == "" {
			matched = key
		}
	}
	return matched
}

// signAnswer returns the X-Flow-Answer-Signature value for an answer. request
// is the request's whole X-Inngest-Signature header (its s ties the answer to
// that call); noRetry and retryAfter are the answer's X-Inngest-No-Retry and
// Retry-After headers ("" when not set).
func signAnswer(signingKey, request string, status int, noRetry, retryAfter string, body []byte) (string, error) {
	secret, err := parseSigningKey(signingKey)
	if err != nil {
		return "", err
	}
	params, err := url.ParseQuery(request)
	if err != nil || params.Get("s") == "" {
		return "", errors.New("flow: the request signature has no s")
	}
	msg := strings.Join([]string{"flow-answer-v1", params.Get("s"), strconv.Itoa(status), noRetry, retryAfter, string(body)}, "\n")
	return "s=" + hmacHex(secret, msg), nil
}

// signingKeyBearer is the bearer token the app sends to the engine.
func signingKeyBearer(signingKey string) (string, error) {
	secret, err := parseSigningKey(signingKey)
	if err != nil {
		return "", err
	}
	raw, err := hex.DecodeString(secret)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return "signkey-" + hex.EncodeToString(sum[:]), nil
}
