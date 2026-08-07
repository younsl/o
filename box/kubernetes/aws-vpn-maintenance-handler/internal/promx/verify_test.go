package promx

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

func probeVars() Vars {
	return Vars{
		VPNConnectionID: "vpn-0123456789abcdef0",
		VPNName:         "prod-dc",
		TunnelIP:        "203.0.113.10",
		PeerIP:          "203.0.113.20",
		Region:          "ap-northeast-2",
	}
}

// A disabled gate has nothing to verify and must never hold up startup.
func TestVerifySkipsADisabledGate(t *testing.T) {
	gate, err := NewGate(nil, GateConfig{Enabled: false}, testLogger())
	if err != nil {
		t.Fatalf("NewGate returned error: %v", err)
	}
	if err := gate.Verify(context.Background(), probeVars()); err != nil {
		t.Fatalf("Verify on a disabled gate returned error: %v", err)
	}
}

// An unreachable or misconfigured endpoint has to be told apart from a missing
// exporter, because the fix is a different one.
func TestVerifyFailsOnAnUnusableEndpoint(t *testing.T) {
	stub := newStub(t, func(string) (int, string) {
		return http.StatusUnauthorized, `{"status":"error","error":"no org id"}`
	})
	gate, _ := NewGate(stub.client(t, nil), GateConfig{
		Enabled: true, Percentile: 20, OnError: OnErrorBlock,
	}, testLogger())

	err := gate.Verify(context.Background(), probeVars())
	if err == nil {
		t.Fatal("an endpoint that rejects a trivial query must fail the check")
	}
	if !strings.Contains(err.Error(), "trivial query") {
		t.Fatalf("the error should point at the endpoint rather than the exporter: %v", err)
	}
}

// The endpoint answering is not enough: with no matching metric every candidate would
// be blocked, so startup must fail while somebody is watching.
func TestVerifyFailsWhenNoTrafficMetricExists(t *testing.T) {
	stub := newStub(t, func(query string) (int, string) {
		if strings.HasPrefix(query, "vector(1)") {
			return http.StatusOK, vectorBody("1")
		}
		return http.StatusOK, `{"status":"success","data":{"resultType":"vector","result":[]}}`
	})
	gate, _ := NewGate(stub.client(t, nil), GateConfig{
		Enabled: true, Percentile: 20, OnError: OnErrorBlock,
	}, testLogger())

	err := gate.Verify(context.Background(), probeVars())
	if err == nil {
		t.Fatal("a gate with no usable metric must fail the check")
	}
	if !strings.Contains(err.Error(), "vpn-0123456789abcdef0") {
		t.Fatalf("the error should name the connection it probed: %v", err)
	}
}

func TestVerifyPassesWhenTheMetricAnswers(t *testing.T) {
	stub := newStub(t, func(string) (int, string) {
		return http.StatusOK, vectorBody("42")
	})
	gate, _ := NewGate(stub.client(t, nil), GateConfig{
		Enabled: true, Percentile: 20, OnError: OnErrorBlock,
	}, testLogger())

	if err := gate.Verify(context.Background(), probeVars()); err != nil {
		t.Fatalf("Verify returned error: %v", err)
	}
}

// With no managed connection there is nothing to select on, so the check proves the
// endpoint and stops there rather than failing a controller that has nothing to do.
func TestVerifyWithoutAConnectionOnlyChecksTheEndpoint(t *testing.T) {
	stub := newStub(t, func(query string) (int, string) {
		if !strings.HasPrefix(query, "vector(1)") {
			t.Errorf("unexpected query without a connection: %s", query)
		}
		return http.StatusOK, vectorBody("1")
	})
	gate, _ := NewGate(stub.client(t, nil), GateConfig{
		Enabled: true, Percentile: 20, OnError: OnErrorBlock,
	}, testLogger())

	if err := gate.Verify(context.Background(), Vars{Region: "ap-northeast-2"}); err != nil {
		t.Fatalf("Verify without a connection returned error: %v", err)
	}
}

// onError is the operator's statement about what an unavailable metric source means,
// and startup honors the same statement.
func TestFailClosedFollowsOnError(t *testing.T) {
	stub := newStub(t, func(string) (int, string) { return http.StatusOK, vectorBody("1") })

	blocking, _ := NewGate(stub.client(t, nil), GateConfig{
		Enabled: true, Percentile: 20, OnError: OnErrorBlock,
	}, testLogger())
	if !blocking.FailClosed() {
		t.Fatal("onError block must fail closed")
	}

	allowing, _ := NewGate(stub.client(t, nil), GateConfig{
		Enabled: true, Percentile: 20, OnError: OnErrorAllow,
	}, testLogger())
	if allowing.FailClosed() {
		t.Fatal("onError allow must not fail closed")
	}

	disabled, _ := NewGate(nil, GateConfig{Enabled: false}, testLogger())
	if disabled.FailClosed() {
		t.Fatal("a disabled gate must not fail closed")
	}
}
