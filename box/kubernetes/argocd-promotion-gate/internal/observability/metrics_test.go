package observability

import (
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/younsl/o/box/kubernetes/argocd-promotion-gate/internal/gate"
)

func TestRecordDecision(t *testing.T) {
	m := NewMetrics()
	m.RecordDecision(gate.Decision{Env: "prd", Code: gate.CodeImageTagMismatch, Allowed: false})
	m.RecordDecision(gate.Decision{Env: "prd", Code: gate.CodeImageTagMismatch, Allowed: false})
	m.RecordDecision(gate.Decision{Env: "prd", Code: gate.CodePassed, Allowed: true})

	if got := testutil.ToFloat64(m.Decisions.WithLabelValues("prd", "ImageTagMismatch", "false")); got != 2 {
		t.Errorf("denied ImageTagMismatch count = %v, want 2", got)
	}
	if got := testutil.ToFloat64(m.Decisions.WithLabelValues("prd", "Passed", "true")); got != 1 {
		t.Errorf("passed count = %v, want 1", got)
	}
}

func TestRecordAdmissionAndLookupFailures(t *testing.T) {
	m := NewMetrics()
	m.RecordAdmission("denied")
	m.RecordAdmission("denied")
	m.RecordAdmission("skipped")
	m.RecordLookupFailure("desired_images")

	if got := testutil.ToFloat64(m.AdmissionRequests.WithLabelValues("denied")); got != 2 {
		t.Errorf("denied admissions = %v, want 2", got)
	}
	if got := testutil.ToFloat64(m.AdmissionRequests.WithLabelValues("skipped")); got != 1 {
		t.Errorf("skipped admissions = %v, want 1", got)
	}
	if got := testutil.ToFloat64(m.LookupFailures.WithLabelValues("desired_images")); got != 1 {
		t.Errorf("lookup failures = %v, want 1", got)
	}
}

func TestMetricNamesAreNamespaced(t *testing.T) {
	// A CounterVec with no observation exposes no family, so each one is
	// touched before gathering.
	m := NewMetrics()
	m.RecordDecision(gate.Decision{Env: "prd", Code: gate.CodePassed, Allowed: true})
	m.RecordAdmission("allowed")
	m.RecordLookupFailure("upstream")

	families, err := m.Registry().Gather()
	if err != nil {
		t.Fatalf("Gather() error = %v", err)
	}
	var found []string
	for _, family := range families {
		if strings.HasPrefix(family.GetName(), namespace+"_") {
			found = append(found, family.GetName())
		}
	}
	if len(found) != 3 {
		t.Errorf("gate metric families = %v, want three", found)
	}
}

func TestRegistryIncludesRuntimeCollectors(t *testing.T) {
	families, err := NewMetrics().Registry().Gather()
	if err != nil {
		t.Fatalf("Gather() error = %v", err)
	}
	var hasGo bool
	for _, family := range families {
		if strings.HasPrefix(family.GetName(), "go_") {
			hasGo = true
			break
		}
	}
	if !hasGo {
		t.Error("the registry exposes no go_* metrics, so runtime health is invisible")
	}
}
