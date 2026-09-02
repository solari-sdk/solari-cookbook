package solari

import (
	"errors"
	"fmt"
)

// GatewayErrorBody is the JSON shape a gateway error response may carry.
type GatewayErrorBody struct {
	Code    string `json:"code,omitempty"`
	Error   string `json:"error,omitempty"`
	Message string `json:"message,omitempty"`
	// Retryable is a gateway hint that the failure is transient. The HTTP
	// transport retries idempotent requests when set.
	Retryable bool `json:"retryable,omitempty"`
}

// SolariError is the base type for every error the SDK produces. The typed
// errors below embed it (directly or transitively), so callers can match
// broadly with errors.As(&*SolariError) or narrowly on a concrete type.
type SolariError struct {
	Message string
}

func (e *SolariError) Error() string { return e.Message }

func newSolariError(msg string) *SolariError { return &SolariError{Message: msg} }

// GatewayError is any non-2xx gateway response not otherwise specialized.
type GatewayError struct {
	SolariError
	Status int
	Code   string
	Body   *GatewayErrorBody
}

func (e *GatewayError) Error() string { return e.Message }
func (e *GatewayError) Unwrap() error { return &e.SolariError }

// AuthError maps HTTP 401/403 — the API key was missing, malformed, or rejected.
type AuthError struct{ GatewayError }

func (e *AuthError) Unwrap() error { return &e.GatewayError }

// PlanError maps HTTP 402 (or a plan_* body) — the plan doesn't allow this.
type PlanError struct{ GatewayError }

func (e *PlanError) Unwrap() error { return &e.GatewayError }

// ConcurrencyLimitError maps HTTP 429 — the org is at its live-session cap. It
// is NOT retryable (retrying won't help).
type ConcurrencyLimitError struct{ GatewayError }

func (e *ConcurrencyLimitError) Unwrap() error { return &e.GatewayError }

// NoCapacityError maps HTTP 503 (or a no_capacity body) — no host currently
// available. Retryable.
type NoCapacityError struct{ GatewayError }

func (e *NoCapacityError) Unwrap() error { return &e.GatewayError }

// ActionError is raised when a control-WS JSON-RPC call returns {ok:false}.
type ActionError struct {
	SolariError
	Method string
	Code   string
}

func (e *ActionError) Error() string { return e.Message }
func (e *ActionError) Unwrap() error { return &e.SolariError }

// TimeoutError is raised when an RPC (or a connect) does not complete within its
// deadline. Method is the RPC method name, or "connect".
type TimeoutError struct {
	SolariError
	Method    string
	TimeoutMs int
}

func (e *TimeoutError) Error() string { return e.Message }
func (e *TimeoutError) Unwrap() error { return &e.SolariError }

func newTimeoutError(method string, timeoutMs int) *TimeoutError {
	return &TimeoutError{
		SolariError: SolariError{Message: fmt.Sprintf("Action %q timed out after %dms", method, timeoutMs)},
		Method:      method,
		TimeoutMs:   timeoutMs,
	}
}

// ConnectionError is raised when the control WebSocket is not open (never
// connected, closed mid-flight, or the dial failed).
type ConnectionError struct{ SolariError }

func (e *ConnectionError) Error() string { return e.Message }
func (e *ConnectionError) Unwrap() error { return &e.SolariError }

func newConnectionError(msg string) *ConnectionError {
	return &ConnectionError{SolariError{Message: msg}}
}

// mapGatewayError maps an HTTP status + optional error body onto the typed
// hierarchy, returning a concrete typed error (so errors.As on *AuthError,
// *PlanError, … matches) whose Unwrap chain also exposes *GatewayError and
// *SolariError. Unrecognized statuses fall back to a plain *GatewayError.
func mapGatewayError(status int, body *GatewayErrorBody) error {
	msg := ""
	if body != nil {
		switch {
		case body.Message != "":
			msg = body.Message
		case body.Error != "":
			msg = body.Error
		case body.Code != "":
			msg = body.Code
		}
	}
	code := ""
	if body != nil {
		code = body.Code
	}
	build := func(defMsg string) GatewayError {
		m := msg
		if m == "" {
			m = defMsg
		}
		return GatewayError{
			SolariError: SolariError{Message: m},
			Status:      status,
			Code:        code,
			Body:        body,
		}
	}

	switch status {
	case 401, 403:
		return &AuthError{build("Invalid or missing API key")}
	case 402:
		return &PlanError{build("This feature requires a different plan")}
	case 429:
		return &ConcurrencyLimitError{build("Concurrency limit exceeded")}
	case 503:
		return &NoCapacityError{build("No host available")}
	default:
		g := build(fmt.Sprintf("Gateway request failed with status %d", status))
		return &g
	}
}

// isRouteUnavailable reports whether err means the one-shot /exec route is not
// served (an older gateway) — the only case where runCommand retries over the
// control WS. A real host/command failure is NOT route-unavailable and must
// propagate.
func isRouteUnavailable(err error) bool {
	var ge *GatewayError
	if errors.As(err, &ge) {
		return ge.Status == 404 || ge.Status == 405 || ge.Status == 501
	}
	return false
}
