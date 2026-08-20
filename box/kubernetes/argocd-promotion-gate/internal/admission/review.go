// Package admission implements the ValidatingAdmissionWebhook that actually
// blocks a sync.
//
// A UI extension cannot enforce anything: disabling a button in the Argo CD UI
// leaves `argocd app sync`, the REST API, and auto-sync untouched. A sync is a
// write that sets the Application's top-level `operation` field, so admission
// is the one place every path passes through.
package admission

import (
	"strings"
)

const (
	admissionAPIVersion = "admission.k8s.io/v1"
	admissionKind       = "AdmissionReview"
)

// ReviewRequest is the inbound AdmissionReview envelope.
type ReviewRequest struct {
	Request *Request `json:"request"`
}

// Request is the admission request itself, narrowed to the fields the gate
// reads.
type Request struct {
	UID       string         `json:"uid"`
	Name      string         `json:"name"`
	Namespace string         `json:"namespace"`
	Operation string         `json:"operation"`
	UserInfo  UserInfo       `json:"userInfo"`
	Object    map[string]any `json:"object"`
	OldObject map[string]any `json:"oldObject"`
}

// UserInfo is the authenticated principal that issued the write. For a sync
// started from the UI this is the argocd-server service account, not the
// person; the person's name travels inside operation.initiatedBy.
type UserInfo struct {
	Username string   `json:"username"`
	Groups   []string `json:"groups"`
}

// ReviewResponse is the outbound AdmissionReview envelope.
type ReviewResponse struct {
	APIVersion string   `json:"apiVersion"`
	Kind       string   `json:"kind"`
	Response   Response `json:"response"`
}

// Response is the admission verdict.
type Response struct {
	UID      string   `json:"uid"`
	Allowed  bool     `json:"allowed"`
	Status   *Status  `json:"status,omitempty"`
	Warnings []string `json:"warnings,omitempty"`
}

// Status carries the message the Argo CD UI shows in its error toast.
type Status struct {
	Code    int32  `json:"code"`
	Reason  string `json:"reason"`
	Message string `json:"message"`
}

// Allow builds an allowing response.
func Allow(uid string, warnings []string) ReviewResponse {
	return ReviewResponse{
		APIVersion: admissionAPIVersion,
		Kind:       admissionKind,
		Response: Response{
			UID:      uid,
			Allowed:  true,
			Warnings: warnings,
		},
	}
}

// Deny builds a denying response. The message is surfaced verbatim by
// kubectl, by the Argo CD CLI, and by the Argo CD UI toast, so it is written
// for the person reading it.
func Deny(uid, reason, message string) ReviewResponse {
	return ReviewResponse{
		APIVersion: admissionAPIVersion,
		Kind:       admissionKind,
		Response: Response{
			UID:     uid,
			Allowed: false,
			Status: &Status{
				Code:    403,
				Reason:  reason,
				Message: message,
			},
		},
	}
}

// IsSyncRequest reports whether this admission request starts a sync.
//
// A sync sets the top-level `operation` field. Every other write to an
// Application, status updates from the controller and spec changes from git
// included, leaves it untouched and must pass straight through.
func IsSyncRequest(req *Request) bool {
	if !hasOperation(req.Object) {
		return false
	}
	return !hasOperation(req.OldObject)
}

func hasOperation(obj map[string]any) bool {
	if obj == nil {
		return false
	}
	value, present := obj["operation"]
	return present && value != nil
}

// IsAutomated reports whether Argo CD marked the pending operation automated,
// which is how an auto-sync differs from a person pressing Sync.
func IsAutomated(req *Request) bool {
	automated, _ := nested(req.Object, "operation", "initiatedBy", "automated").(bool)
	return automated
}

// InitiatedBy is the user Argo CD recorded as starting the sync, which is more
// useful in a log line than the service account that carried the write.
func InitiatedBy(req *Request) string {
	username, _ := nested(req.Object, "operation", "initiatedBy", "username").(string)
	return username
}

// SyncRevision is the revision the pending operation targets, which is what
// makes a rollback identifiable.
func SyncRevision(req *Request) string {
	revision, _ := nested(req.Object, "operation", "sync", "revision").(string)
	return revision
}

// Username is the authenticated principal, with a printable fallback.
func Username(req *Request) string {
	if strings.TrimSpace(req.UserInfo.Username) == "" {
		return "<unknown>"
	}
	return req.UserInfo.Username
}

func nested(obj map[string]any, path ...string) any {
	current := any(obj)
	for _, key := range path {
		asMap, ok := current.(map[string]any)
		if !ok {
			return nil
		}
		current, ok = asMap[key]
		if !ok {
			return nil
		}
	}
	return current
}
