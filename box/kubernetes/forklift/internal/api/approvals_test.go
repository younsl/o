package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"testing"
)

// mkProxyRepo creates a proxy repository through the API and returns its id.
func mkProxyRepo(t *testing.T, srvURL, name string) int64 {
	t.Helper()
	body := fmt.Sprintf(`{"name":%q,"format":"npm","type":"proxy","upstream_url":"https://registry.npmjs.org"}`, name)
	resp := adminDo(t, http.MethodPost, srvURL+"/repositories", body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create repo: status=%d", resp.StatusCode)
	}
	var dto struct {
		ID int64 `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&dto); err != nil {
		t.Fatal(err)
	}
	return dto.ID
}

func TestApprovalLifecycle(t *testing.T) {
	srv := newTestServer(t)
	mkProxyRepo(t, srv.URL, "npmjs")

	// Manual pre-approval.
	resp := adminDo(t, http.MethodPost, srv.URL+"/approvals",
		`{"repo":"npmjs","package":"lodash","status":"approved","note":"trusted"}`)
	var created struct {
		ID     int64  `json:"id"`
		Status string `json:"status"`
	}
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create approval: status=%d", resp.StatusCode)
	}
	_ = json.NewDecoder(resp.Body).Decode(&created)
	resp.Body.Close()
	if created.Status != "approved" {
		t.Fatalf("created = %+v", created)
	}

	// Re-decide: reject the approved package.
	resp = adminDo(t, http.MethodPost, fmt.Sprintf("%s/approvals/%d/reject", srv.URL, created.ID),
		`{"note":"incident"}`)
	var decided struct {
		Status    string `json:"status"`
		DecidedBy string `json:"decided_by"`
		Note      string `json:"note"`
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("reject: status=%d", resp.StatusCode)
	}
	_ = json.NewDecoder(resp.Body).Decode(&decided)
	resp.Body.Close()
	if decided.Status != "rejected" || decided.DecidedBy != adminUser || decided.Note != "incident" {
		t.Fatalf("decided = %+v", decided)
	}

	// Approve again (body optional).
	resp = adminDo(t, http.MethodPost, fmt.Sprintf("%s/approvals/%d/approve", srv.URL, created.ID), "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("approve: status=%d", resp.StatusCode)
	}
	resp.Body.Close()

	// List with filters.
	resp = adminDo(t, http.MethodGet, srv.URL+"/approvals?repo=npmjs&status=approved", "")
	var list struct {
		Count     int64 `json:"count"`
		Approvals []struct {
			Package string `json:"package"`
		} `json:"approvals"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&list)
	resp.Body.Close()
	if list.Count != 1 || len(list.Approvals) != 1 || list.Approvals[0].Package != "lodash" {
		t.Fatalf("list = %+v", list)
	}

	// Count endpoint (badge).
	resp = adminDo(t, http.MethodGet, srv.URL+"/approvals/count?status=pending", "")
	var cnt struct {
		Count int64 `json:"count"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&cnt)
	resp.Body.Close()
	if cnt.Count != 0 {
		t.Fatalf("pending count = %d", cnt.Count)
	}

	// Decide on unknown id.
	resp = adminDo(t, http.MethodPost, srv.URL+"/approvals/9999/approve", "")
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown id: status=%d", resp.StatusCode)
	}
	resp.Body.Close()
}

func TestApprovalValidation(t *testing.T) {
	srv := newTestServer(t)
	mkProxyRepo(t, srv.URL, "npmjs")

	for name, body := range map[string]string{
		"missing package": `{"repo":"npmjs","status":"approved"}`,
		"bad status":      `{"repo":"npmjs","package":"x","status":"pending"}`,
		"unknown repo":    `{"repo":"nope","package":"x","status":"approved"}`,
	} {
		resp := adminDo(t, http.MethodPost, srv.URL+"/approvals", body)
		if resp.StatusCode != http.StatusBadRequest && resp.StatusCode != http.StatusNotFound {
			t.Fatalf("%s: status=%d", name, resp.StatusCode)
		}
		resp.Body.Close()
	}

	// Hosted repos cannot carry approvals (decision target) nor approval config.
	resp := adminDo(t, http.MethodPost, srv.URL+"/repositories",
		`{"name":"npm-hosted","format":"npm","type":"hosted"}`)
	resp.Body.Close()
	resp = adminDo(t, http.MethodPost, srv.URL+"/approvals",
		`{"repo":"npm-hosted","package":"x","status":"approved"}`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("approval on hosted: status=%d", resp.StatusCode)
	}
	resp.Body.Close()
	resp = adminDo(t, http.MethodPost, srv.URL+"/repositories",
		`{"name":"npm-h2","format":"npm","type":"hosted","config":{"approval":{"enabled":true}}}`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("approval config on hosted: status=%d", resp.StatusCode)
	}
	resp.Body.Close()

	// Unauthenticated access is denied.
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/approvals", nil)
	plain, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer plain.Body.Close()
	if plain.StatusCode != http.StatusUnauthorized && plain.StatusCode != http.StatusForbidden {
		t.Fatalf("unauthenticated: status=%d", plain.StatusCode)
	}
}

// userDo sends a request authenticated as an arbitrary local user.
func userDo(t *testing.T, username, password, method, url, body string) *http.Response {
	t.Helper()
	var r io.Reader
	if body != "" {
		r = bytes.NewBufferString(body)
	}
	req, err := http.NewRequest(method, url, r)
	if err != nil {
		t.Fatal(err)
	}
	req.SetBasicAuth(username, password)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

// TestApproveActionForSecurityEngineers covers the non-admin approver flow: a
// role with the approve action on a repo pattern can run the approvals API for
// matching repositories only, and gets no other admin surface.
func TestApproveActionForSecurityEngineers(t *testing.T) {
	srv := newTestServer(t)
	mkProxyRepo(t, srv.URL, "npm-gated")

	// pypi proxy outside the security role's npm-* pattern.
	resp := adminDo(t, http.MethodPost, srv.URL+"/repositories",
		`{"name":"pypi-gated","format":"pypi","type":"proxy","upstream_url":"https://pypi.org/simple"}`)
	mustStatus(t, resp, http.StatusCreated)
	resp.Body.Close()

	// Security engineer: approve on npm-* plus read everywhere.
	resp = adminDo(t, http.MethodPost, srv.URL+"/users",
		`{"username":"sec1","password":"pw123456"}`)
	mustStatus(t, resp, http.StatusCreated)
	userID := int64(decodeAs[map[string]any](t, resp)["id"].(float64))
	resp = adminDo(t, http.MethodPost, srv.URL+"/roles",
		`{"name":"security","description":"package approvers"}`)
	mustStatus(t, resp, http.StatusCreated)
	role := decodeAs[roleDTO](t, resp)
	resp = adminDo(t, http.MethodPost, fmt.Sprintf("%s/roles/%d/permissions", srv.URL, role.ID),
		`{"repo_pattern":"npm-*","actions":["read","approve"]}`)
	mustStatus(t, resp, http.StatusCreated)
	resp.Body.Close()
	resp = adminDo(t, http.MethodPost, fmt.Sprintf("%s/users/%d/roles", srv.URL, userID),
		fmt.Sprintf(`{"role_id":%d}`, role.ID))
	mustStatus(t, resp, http.StatusNoContent)
	resp.Body.Close()

	// Pending rows in both repos (seeded by admin pre-decisions, then flipped
	// to pending is not possible via API, so use create + the queue endpoint).
	resp = adminDo(t, http.MethodPost, srv.URL+"/approvals",
		`{"repo":"npm-gated","package":"left-pad","status":"rejected"}`)
	mustStatus(t, resp, http.StatusCreated)
	npmRow := decodeAs[approvalDTO](t, resp)
	resp = adminDo(t, http.MethodPost, srv.URL+"/approvals",
		`{"repo":"pypi-gated","package":"requests","status":"rejected"}`)
	mustStatus(t, resp, http.StatusCreated)
	pypiRow := decodeAs[approvalDTO](t, resp)

	// /me reports the approver capability.
	resp = userDo(t, "sec1", "pw123456", http.MethodGet, srv.URL+"/me", "")
	me := decodeAs[map[string]any](t, resp)
	if me["admin"] != false || me["approver"] != true {
		t.Fatalf("me = %v", me)
	}

	// The shared queue is visible.
	resp = userDo(t, "sec1", "pw123456", http.MethodGet, srv.URL+"/approvals", "")
	mustStatus(t, resp, http.StatusOK)
	resp.Body.Close()
	resp = userDo(t, "sec1", "pw123456", http.MethodGet, srv.URL+"/approvals/count", "")
	mustStatus(t, resp, http.StatusOK)
	resp.Body.Close()

	// Deciding inside the pattern works; outside it is forbidden.
	resp = userDo(t, "sec1", "pw123456", http.MethodPost,
		fmt.Sprintf("%s/approvals/%d/approve", srv.URL, npmRow.ID), `{"note":"sec review"}`)
	mustStatus(t, resp, http.StatusOK)
	decided := decodeAs[approvalDTO](t, resp)
	if decided.Status != "approved" || decided.DecidedBy != "sec1" {
		t.Fatalf("decided = %+v", decided)
	}
	resp = userDo(t, "sec1", "pw123456", http.MethodPost,
		fmt.Sprintf("%s/approvals/%d/approve", srv.URL, pypiRow.ID), "")
	mustStatus(t, resp, http.StatusForbidden)
	resp.Body.Close()

	// Manual pre-decisions follow the same pattern scoping.
	resp = userDo(t, "sec1", "pw123456", http.MethodPost, srv.URL+"/approvals",
		`{"repo":"npm-gated","package":"axios","status":"approved"}`)
	mustStatus(t, resp, http.StatusCreated)
	resp.Body.Close()
	resp = userDo(t, "sec1", "pw123456", http.MethodPost, srv.URL+"/approvals",
		`{"repo":"pypi-gated","package":"boto3","status":"approved"}`)
	mustStatus(t, resp, http.StatusForbidden)
	resp.Body.Close()

	// No other admin surface leaks through (repository listing is now readable by
	// any authenticated user, so probe a still-admin-only endpoint instead).
	resp = userDo(t, "sec1", "pw123456", http.MethodGet, srv.URL+"/users", "")
	mustStatus(t, resp, http.StatusForbidden)
	resp.Body.Close()

	// A PAT minted by the approver cannot approve: token scopes never carry the
	// approve action, so RequireApprover rejects token-authenticated principals.
	resp = userDo(t, "sec1", "pw123456", http.MethodPost, srv.URL+"/tokens",
		`{"name":"ci","description":"ci token","scopes":[{"repo_pattern":"*","actions":["read"]}],"expires_in":"720h"}`)
	mustStatus(t, resp, http.StatusCreated)
	token := decodeAs[map[string]any](t, resp)["token"].(string)
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/approvals", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	tresp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer tresp.Body.Close()
	if tresp.StatusCode != http.StatusForbidden {
		t.Fatalf("PAT approvals access: status=%d, want 403", tresp.StatusCode)
	}

	// Tokens still cannot be minted with an approve scope at all.
	resp = userDo(t, "sec1", "pw123456", http.MethodPost, srv.URL+"/tokens",
		`{"name":"bad","description":"x","scopes":[{"repo_pattern":"*","actions":["approve"]}],"expires_in":"720h"}`)
	mustStatus(t, resp, http.StatusBadRequest)
	resp.Body.Close()
}

func TestApproveAllPendingEndpoint(t *testing.T) {
	srv, store := newTestServerWithStore(t)
	mkProxyRepo(t, srv.URL, "npmjs")
	mkProxyRepo(t, srv.URL, "pypi")

	// Seed pending demand directly: the public API can't create pending rows.
	ctx := context.Background()
	for _, p := range []string{"left-pad", "is-odd", "lodash"} {
		if _, err := store.UpsertPendingApproval(ctx, "npmjs", p, "alice", ""); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.UpsertPendingApproval(ctx, "pypi", "requests", "bob", ""); err != nil {
		t.Fatal(err)
	}

	// Approve every pending package in npmjs only.
	resp := adminDo(t, http.MethodPost, srv.URL+"/approvals/approve-all",
		`{"repo":"npmjs","note":"batch reviewed"}`)
	mustStatus(t, resp, http.StatusOK)
	got := decodeAs[map[string]any](t, resp)
	if got["approved"].(float64) != 3 {
		t.Fatalf("approved = %v, want 3", got["approved"])
	}

	// npmjs now has no pending rows; pypi is untouched.
	if n, _ := store.CountApprovals(ctx, "npmjs", "pending"); n != 0 {
		t.Fatalf("npmjs pending = %d, want 0", n)
	}
	if n, _ := store.CountApprovals(ctx, "pypi", "pending"); n != 1 {
		t.Fatalf("pypi pending = %d, want 1", n)
	}

	// Re-running approves nothing.
	resp = adminDo(t, http.MethodPost, srv.URL+"/approvals/approve-all", `{"repo":"npmjs"}`)
	mustStatus(t, resp, http.StatusOK)
	if decodeAs[map[string]any](t, resp)["approved"].(float64) != 0 {
		t.Fatal("second run should approve 0")
	}

	// Unknown repo is a 404; missing repo resolves to an empty name (404 too).
	resp = adminDo(t, http.MethodPost, srv.URL+"/approvals/approve-all", `{"repo":"nope"}`)
	mustStatus(t, resp, http.StatusNotFound)
	resp.Body.Close()
}

func TestApprovalDeletedWithRepo(t *testing.T) {
	srv := newTestServer(t)
	id := mkProxyRepo(t, srv.URL, "npmjs")

	resp := adminDo(t, http.MethodPost, srv.URL+"/approvals",
		`{"repo":"npmjs","package":"lodash","status":"approved"}`)
	resp.Body.Close()

	resp = adminDo(t, http.MethodDelete, fmt.Sprintf("%s/repositories/%d", srv.URL, id), "")
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete repo: status=%d", resp.StatusCode)
	}
	resp.Body.Close()

	resp = adminDo(t, http.MethodGet, srv.URL+"/approvals?repo=npmjs", "")
	var list struct {
		Count int64 `json:"count"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&list)
	resp.Body.Close()
	if list.Count != 0 {
		t.Fatalf("approvals survived repo deletion: count=%d", list.Count)
	}
}
