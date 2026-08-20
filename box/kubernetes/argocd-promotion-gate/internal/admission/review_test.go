package admission

import (
	"encoding/json"
	"testing"
)

func request(object, oldObject map[string]any) *Request {
	return &Request{
		UID:       "uid-1",
		Name:      "prd-payment-api",
		Namespace: "argocd",
		Operation: "UPDATE",
		UserInfo:  UserInfo{Username: "system:serviceaccount:argocd:argocd-server"},
		Object:    object,
		OldObject: oldObject,
	}
}

func TestIsSyncRequest(t *testing.T) {
	cases := []struct {
		name      string
		object    map[string]any
		oldObject map[string]any
		want      bool
	}{
		{
			name:      "newly set operation is a sync",
			object:    map[string]any{"operation": map[string]any{"sync": map[string]any{}}},
			oldObject: map[string]any{"spec": map[string]any{}},
			want:      true,
		},
		{
			name:      "unchanged operation is not a sync",
			object:    map[string]any{"operation": map[string]any{"sync": map[string]any{}}},
			oldObject: map[string]any{"operation": map[string]any{"sync": map[string]any{}}},
			want:      false,
		},
		{
			name:      "a status write is not a sync",
			object:    map[string]any{"status": map[string]any{"sync": map[string]any{"status": "Synced"}}},
			oldObject: map[string]any{"status": map[string]any{"sync": map[string]any{"status": "OutOfSync"}}},
			want:      false,
		},
		{
			name:      "a spec change from git is not a sync",
			object:    map[string]any{"spec": map[string]any{"source": map[string]any{"targetRevision": "v2"}}},
			oldObject: map[string]any{"spec": map[string]any{"source": map[string]any{"targetRevision": "v1"}}},
			want:      false,
		},
		{
			name:      "a null operation is not a sync",
			object:    map[string]any{"operation": nil},
			oldObject: nil,
			want:      false,
		},
		{
			name:      "create carrying an operation is a sync",
			object:    map[string]any{"operation": map[string]any{"sync": map[string]any{}}},
			oldObject: nil,
			want:      true,
		},
		{
			name:      "clearing an operation is not a sync",
			object:    map[string]any{},
			oldObject: map[string]any{"operation": map[string]any{"sync": map[string]any{}}},
			want:      false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsSyncRequest(request(tc.object, tc.oldObject)); got != tc.want {
				t.Errorf("IsSyncRequest() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestIsAutomated(t *testing.T) {
	automated := request(map[string]any{
		"operation": map[string]any{"initiatedBy": map[string]any{"automated": true}},
	}, nil)
	if !IsAutomated(automated) {
		t.Error("IsAutomated() = false for an automated operation")
	}

	manual := request(map[string]any{
		"operation": map[string]any{"initiatedBy": map[string]any{"username": "dev@example.com"}},
	}, nil)
	if IsAutomated(manual) {
		t.Error("IsAutomated() = true for a manual operation")
	}
	if got := InitiatedBy(manual); got != "dev@example.com" {
		t.Errorf("InitiatedBy() = %q, want dev@example.com", got)
	}

	if IsAutomated(request(nil, nil)) {
		t.Error("IsAutomated() = true for an absent object")
	}
	if got := InitiatedBy(request(map[string]any{"operation": "nope"}, nil)); got != "" {
		t.Errorf("InitiatedBy() = %q for a malformed operation, want empty", got)
	}
}

func TestUsername(t *testing.T) {
	req := request(nil, nil)
	if got := Username(req); got != "system:serviceaccount:argocd:argocd-server" {
		t.Errorf("Username() = %q", got)
	}

	req.UserInfo.Username = "   "
	if got := Username(req); got != "<unknown>" {
		t.Errorf("Username() = %q, want <unknown>", got)
	}
}

func TestAllowResponse(t *testing.T) {
	raw, err := json.Marshal(Allow("uid-1", nil))
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	if decoded["apiVersion"] != admissionAPIVersion || decoded["kind"] != admissionKind {
		t.Errorf("envelope = %v, want the v1 AdmissionReview envelope", decoded)
	}
	response, _ := decoded["response"].(map[string]any)
	if response["allowed"] != true {
		t.Errorf("allowed = %v, want true", response["allowed"])
	}
	if _, present := response["status"]; present {
		t.Error("an allowing response carried a status")
	}
	if _, present := response["warnings"]; present {
		t.Error("an allowing response carried an empty warnings key")
	}
}

func TestDenyResponse(t *testing.T) {
	raw, err := json.Marshal(Deny("uid-1", "PromotionGateBlocked", "stg-payment-api is OutOfSync"))
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	response, _ := decoded["response"].(map[string]any)
	if response["allowed"] != false {
		t.Errorf("allowed = %v, want false", response["allowed"])
	}
	status, _ := response["status"].(map[string]any)
	// 403 with a human-readable message is what the Argo CD UI renders in its
	// error toast, so both are part of the contract.
	if status["code"] != float64(403) {
		t.Errorf("code = %v, want 403", status["code"])
	}
	if status["message"] != "stg-payment-api is OutOfSync" {
		t.Errorf("message = %v", status["message"])
	}
	if status["reason"] != "PromotionGateBlocked" {
		t.Errorf("reason = %v", status["reason"])
	}
}

func TestParseRealAdmissionReviewEnvelope(t *testing.T) {
	raw := []byte(`{
		"apiVersion": "admission.k8s.io/v1",
		"kind": "AdmissionReview",
		"request": {
			"uid": "abc-123",
			"name": "prd-payment-api",
			"namespace": "argocd",
			"operation": "UPDATE",
			"userInfo": {"username": "system:serviceaccount:argocd:argocd-server", "groups": ["system:authenticated"]},
			"object": {"operation": {"sync": {"revision": "HEAD"}, "initiatedBy": {"username": "dev@example.com"}}},
			"oldObject": {"spec": {"project": "prd"}}
		}
	}`)
	var review ReviewRequest
	if err := json.Unmarshal(raw, &review); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	if review.Request == nil {
		t.Fatal("Request = nil")
	}
	if review.Request.UID != "abc-123" {
		t.Errorf("UID = %q", review.Request.UID)
	}
	if !IsSyncRequest(review.Request) {
		t.Error("IsSyncRequest() = false for a real sync envelope")
	}
	if got := InitiatedBy(review.Request); got != "dev@example.com" {
		t.Errorf("InitiatedBy() = %q, want the human who pressed Sync", got)
	}
	if len(review.Request.UserInfo.Groups) != 1 {
		t.Errorf("Groups = %v", review.Request.UserInfo.Groups)
	}
}
