package solari

// Shared HTTP transport for the SDK ⇆ Gateway REST API. One place owns auth
// headers, error mapping, retries/backoff, idempotency keys, and timeouts.
//
// Retry policy: idempotent requests (GET, DELETE, or any request carrying an
// Idempotency-Key) are retried on network errors, HTTP 5xx, and bodies flagged
// retryable, with exponential backoff + jitter. 429 is NOT retried — it maps to
// ConcurrencyLimitError (the org is at its session cap). Non-idempotent writes
// are never silently retried; pass an idempotency key to opt a create in.

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	mrand "math/rand"
	"net/http"
	"strings"
	"time"
)

const (
	defaultMaxRetries       = 5
	defaultRequestTimeoutMs = 300_000
)

// httpTransport carries out REST calls to the gateway.
type httpTransport struct {
	apiKey     string
	baseURL    string
	httpClient *http.Client
	maxRetries int
	// retryDelayMs, when >= 0, replaces exponential backoff (mainly for tests).
	retryDelayMs int
}

type httpTransportOptions struct {
	apiKey     string
	baseURL    string
	httpClient *http.Client
	maxRetries int
	// requestTimeoutMs bounds each individual attempt. Default 300000.
	requestTimeoutMs int
	// retryDelayMs < 0 means "use exponential backoff + jitter".
	retryDelayMs int
}

func newHTTPTransport(o httpTransportOptions) (*httpTransport, error) {
	if o.apiKey == "" {
		return nil, newSolariError("httpTransport requires an apiKey")
	}
	if o.baseURL == "" {
		return nil, newSolariError("httpTransport requires a baseUrl")
	}
	maxRetries := o.maxRetries
	if maxRetries == 0 {
		maxRetries = defaultMaxRetries
	}
	timeoutMs := o.requestTimeoutMs
	if timeoutMs == 0 {
		timeoutMs = defaultRequestTimeoutMs
	}
	client := o.httpClient
	if client == nil {
		client = &http.Client{Timeout: time.Duration(timeoutMs) * time.Millisecond}
	}
	return &httpTransport{
		apiKey:       o.apiKey,
		baseURL:      strings.TrimRight(o.baseURL, "/"),
		httpClient:   client,
		maxRetries:   maxRetries,
		retryDelayMs: o.retryDelayMs,
	}, nil
}

// authHeader returns the Authorization value used for handles + WS upgrades.
func (t *httpTransport) authHeader() string {
	return "Bearer " + t.apiKey
}

// wsOrigin returns the ws://(wss://) origin derived from the gateway base URL.
func (t *httpTransport) wsOrigin() string {
	if strings.HasPrefix(t.baseURL, "https") {
		return "wss" + strings.TrimPrefix(t.baseURL, "https")
	}
	if strings.HasPrefix(t.baseURL, "http") {
		return "ws" + strings.TrimPrefix(t.baseURL, "http")
	}
	return t.baseURL
}

// httpRequestOptions carry per-request knobs.
type httpRequestOptions struct {
	// idempotencyKey, when set, sends an Idempotency-Key header AND makes the
	// request retry-safe.
	idempotencyKey string
}

// request performs a REST call and unmarshals the JSON response into out (which
// may be nil for empty-body responses). It applies the retry policy above.
func (t *httpTransport) request(ctx context.Context, method, path string, body interface{}, opts httpRequestOptions, out interface{}) error {
	idempotent := method == http.MethodGet || method == http.MethodDelete || opts.idempotencyKey != ""

	var bodyBytes []byte
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return newSolariError(fmt.Sprintf("failed to marshal request body: %v", err))
		}
		bodyBytes = b
	}

	attempt := 0
	for {
		req, err := http.NewRequestWithContext(ctx, method, t.baseURL+path, bytesReader(bodyBytes))
		if err != nil {
			return newConnectionError(fmt.Sprintf("%s %s failed: %v", method, path, err))
		}
		req.Header.Set("Authorization", "Bearer "+t.apiKey)
		req.Header.Set("Accept", "application/json")
		if bodyBytes != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if opts.idempotencyKey != "" {
			req.Header.Set("Idempotency-Key", opts.idempotencyKey)
		}

		res, err := t.httpClient.Do(req)
		if err != nil {
			if idempotent && attempt < t.maxRetries {
				if serr := t.sleepBackoff(ctx, attempt); serr != nil {
					return serr
				}
				attempt++
				continue
			}
			return newConnectionError(fmt.Sprintf("%s %s failed: %v", method, path, err))
		}

		if res.StatusCode < 200 || res.StatusCode >= 300 {
			var errBody *GatewayErrorBody
			raw, _ := io.ReadAll(res.Body)
			res.Body.Close()
			if len(raw) > 0 {
				var b GatewayErrorBody
				if json.Unmarshal(raw, &b) == nil {
					errBody = &b
				}
			}
			// 5xx or an explicit retryable hint. NOT 429 (ConcurrencyLimitError).
			retryable := res.StatusCode >= 500 || (errBody != nil && errBody.Retryable)
			if idempotent && retryable && attempt < t.maxRetries {
				if serr := t.sleepBackoff(ctx, attempt); serr != nil {
					return serr
				}
				attempt++
				continue
			}
			return mapGatewayError(res.StatusCode, errBody)
		}

		raw, err := io.ReadAll(res.Body)
		res.Body.Close()
		if err != nil {
			return newConnectionError(fmt.Sprintf("%s %s: reading body failed: %v", method, path, err))
		}
		if len(raw) == 0 || out == nil {
			return nil
		}
		if err := json.Unmarshal(raw, out); err != nil {
			return newSolariError(fmt.Sprintf("%s %s: decoding response failed: %v", method, path, err))
		}
		return nil
	}
}

// sleepBackoff waits the retry delay, respecting ctx cancellation.
func (t *httpTransport) sleepBackoff(ctx context.Context, attempt int) error {
	d := t.backoff(attempt)
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// backoff computes the delay before retry attempt n: min(150·2^n, 8000)+jitter.
func (t *httpTransport) backoff(attempt int) time.Duration {
	if t.retryDelayMs >= 0 {
		return time.Duration(t.retryDelayMs) * time.Millisecond
	}
	base := 150 * (1 << uint(attempt))
	if base > 8000 {
		base = 8000
	}
	jitter := mrand.Intn(250)
	return time.Duration(base+jitter) * time.Millisecond
}

// bytesReader returns an io.Reader for b, or nil when b is nil (so GET/DELETE
// send no body).
func bytesReader(b []byte) io.Reader {
	if b == nil {
		return nil
	}
	return bytes.NewReader(b)
}

// encodeURIComponent percent-encodes s exactly as JavaScript's
// encodeURIComponent does: A-Z a-z 0-9 and - _ . ! ~ * ' ( ) pass through, every
// other byte becomes %XX over its UTF-8 bytes.
//
// WHY NOT url.PathEscape: PathEscape follows RFC 3986, under which ':' is a legal
// path character, so it leaves it alone. Session ids are
// `<poolId>:<vmId>:<orgId>.<sig>` — ALL COLONS — so PathEscape emitted
// `/sandboxes/pool:vm:org.sig` where the TypeScript, Python and C++ SDKs all emit
// `/sandboxes/pool%3Avm%3Aorg.sig`. Both route identically through the gateway
// (path-to-regexp matches the decoded segment either way), so this was a latent
// cosmetic divergence rather than a live bug — but it made Go the only SDK whose
// URLs differ byte-for-byte from the reference, which the wire contract test
// below cannot look away from. Matching the reference is cheaper than carving out
// an exception for it.
func encodeURIComponent(s string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		unreserved := (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
			(c >= '0' && c <= '9') || strings.IndexByte("-_.!~*'()", c) >= 0
		if unreserved {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(hex[c>>4])
		b.WriteByte(hex[c&0x0f])
	}
	return b.String()
}

// newIdempotencyKey returns a fresh UUID-v4-ish key.
func newIdempotencyKey() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// Fallback: time+random hex (never expected in practice).
		n, _ := rand.Int(rand.Reader, big.NewInt(1<<62))
		return fmt.Sprintf("%d-%s", time.Now().UnixNano(), n.String())
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10
	s := hex.EncodeToString(b[:])
	return fmt.Sprintf("%s-%s-%s-%s-%s", s[0:8], s[8:12], s[12:16], s[16:20], s[20:32])
}
