package nodes

import (
	"context"
	"encoding/json"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	k8stesting "k8s.io/client-go/testing"

	"k8s.io/client-go/kubernetes/fake"
)

func newNode(name, providerID, instanceType, zone string, annotations map[string]string) *corev1.Node {
	return &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{
			Name:        name,
			Annotations: annotations,
			Labels: map[string]string{
				instanceTypeLabel: instanceType,
				zoneLabel:         zone,
			},
		},
		Spec: corev1.NodeSpec{ProviderID: providerID},
	}
}

func TestList(t *testing.T) {
	clientset := fake.NewClientset(
		newNode("ip-10-0-1-5", "aws:///ap-northeast-2a/i-0abc123", "m5.4xlarge", "ap-northeast-2a", map[string]string{"a": "b"}),
		newNode("virtual-1", "", "", "", nil),
	)
	c := &Client{nodes: clientset.CoreV1().Nodes()}

	got, err := c.List(context.Background(), "")
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("nodes = %d, want 2", len(got))
	}
	byName := map[string]Node{}
	for _, n := range got {
		byName[n.Name] = n
	}
	ec2 := byName["ip-10-0-1-5"]
	if ec2.InstanceID != "i-0abc123" {
		t.Errorf("instance ID = %q, want i-0abc123", ec2.InstanceID)
	}
	if ec2.InstanceType != "m5.4xlarge" || ec2.Zone != "ap-northeast-2a" {
		t.Errorf("instance type/zone = %q/%q, want m5.4xlarge/ap-northeast-2a", ec2.InstanceType, ec2.Zone)
	}
	if ec2.Annotations["a"] != "b" {
		t.Errorf("annotations = %v, want the existing annotations carried through", ec2.Annotations)
	}
	// A non-EC2 node still appears; the caller decides what to do with it.
	if byName["virtual-1"].InstanceID != "" {
		t.Errorf("instance ID = %q, want empty for a node with no providerID", byName["virtual-1"].InstanceID)
	}
}

func TestListPassesTheSelector(t *testing.T) {
	clientset := fake.NewClientset(newNode("ip-1", "aws:///az/i-1", "m5.large", "az", nil))
	var gotSelector string
	clientset.PrependReactor("list", "nodes", func(action k8stesting.Action) (bool, runtime.Object, error) {
		gotSelector = action.(k8stesting.ListAction).GetListRestrictions().Labels.String()
		return false, nil, nil
	})
	c := &Client{nodes: clientset.CoreV1().Nodes()}

	if _, err := c.List(context.Background(), "karpenter.sh/nodepool=default"); err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if gotSelector != "karpenter.sh/nodepool=default" {
		t.Errorf("selector = %q, want it forwarded to the API", gotSelector)
	}
}

func TestListPaginates(t *testing.T) {
	// A large cluster must not be listed in one unbounded request. The fake client
	// does not paginate on its own, so the Continue handling is driven directly.
	clientset := fake.NewClientset()
	calls := 0
	clientset.PrependReactor("list", "nodes", func(k8stesting.Action) (bool, runtime.Object, error) {
		calls++
		list := &corev1.NodeList{}
		if calls == 1 {
			list.Items = []corev1.Node{*newNode("ip-1", "aws:///az/i-1", "m5.large", "az", nil)}
			list.Continue = "next-page"
			return true, list, nil
		}
		list.Items = []corev1.Node{*newNode("ip-2", "aws:///az/i-2", "m5.large", "az", nil)}
		return true, list, nil
	})
	c := &Client{nodes: clientset.CoreV1().Nodes()}

	got, err := c.List(context.Background(), "")
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("nodes = %d, want both pages", len(got))
	}
	if calls != 2 {
		t.Errorf("list calls = %d, want 2", calls)
	}
}

func TestListError(t *testing.T) {
	clientset := fake.NewClientset()
	clientset.PrependReactor("list", "nodes", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, context.DeadlineExceeded
	})
	c := &Client{nodes: clientset.CoreV1().Nodes()}

	if _, err := c.List(context.Background(), ""); err == nil {
		t.Fatal("List() error = nil, want the API error surfaced")
	}
}

func TestAnnotateSetsAndRemoves(t *testing.T) {
	clientset := fake.NewClientset(newNode("ip-1", "aws:///az/i-1", "m5.large", "az", map[string]string{
		"keep":                     "yes",
		"external-ebs-autoresizer": "stale",
	}))
	var gotPatch []byte
	clientset.PrependReactor("patch", "nodes", func(action k8stesting.Action) (bool, runtime.Object, error) {
		gotPatch = action.(k8stesting.PatchAction).GetPatch()
		return false, nil, nil
	})
	c := &Client{nodes: clientset.CoreV1().Nodes()}

	err := c.Annotate(context.Background(), "ip-1",
		map[string]string{"a/recommendation": "increase"},
		[]string{"a/throughput-recommended-mibps"})
	if err != nil {
		t.Fatalf("Annotate() error = %v", err)
	}

	var patch struct {
		Metadata struct {
			Annotations map[string]*string `json:"annotations"`
		} `json:"metadata"`
	}
	if err := json.Unmarshal(gotPatch, &patch); err != nil {
		t.Fatalf("unmarshal patch %s: %v", gotPatch, err)
	}
	set, ok := patch.Metadata.Annotations["a/recommendation"]
	if !ok || set == nil || *set != "increase" {
		t.Errorf("patch set = %v, want increase", set)
	}
	// A removed key must encode as JSON null: that is what makes a merge patch
	// delete it rather than write the string "null".
	removed, ok := patch.Metadata.Annotations["a/throughput-recommended-mibps"]
	if !ok {
		t.Fatal("removed key absent from the patch")
	}
	if removed != nil {
		t.Errorf("removed key = %q, want null", *removed)
	}

	// The stored object keeps annotations the addon does not own.
	updated, err := clientset.CoreV1().Nodes().Get(context.Background(), "ip-1", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if updated.Annotations["keep"] != "yes" {
		t.Errorf("annotations = %v, want unrelated keys preserved", updated.Annotations)
	}
	if updated.Annotations["a/recommendation"] != "increase" {
		t.Errorf("annotations = %v, want the recommendation applied", updated.Annotations)
	}
}

func TestAnnotateNoopWithoutChanges(t *testing.T) {
	clientset := fake.NewClientset(newNode("ip-1", "aws:///az/i-1", "m5.large", "az", nil))
	patched := false
	clientset.PrependReactor("patch", "nodes", func(k8stesting.Action) (bool, runtime.Object, error) {
		patched = true
		return false, nil, nil
	})
	c := &Client{nodes: clientset.CoreV1().Nodes()}

	if err := c.Annotate(context.Background(), "ip-1", nil, nil); err != nil {
		t.Fatalf("Annotate() error = %v", err)
	}
	if patched {
		t.Error("an empty annotation set still issued a patch")
	}
}

func TestAnnotateError(t *testing.T) {
	clientset := fake.NewClientset()
	c := &Client{nodes: clientset.CoreV1().Nodes()}

	err := c.Annotate(context.Background(), "missing", map[string]string{"a/b": "c"}, nil)
	if err == nil {
		t.Fatal("Annotate() error = nil, want a not-found error")
	}
}

func TestInstanceIDFromProviderID(t *testing.T) {
	tests := []struct {
		providerID string
		want       string
	}{
		{providerID: "aws:///ap-northeast-2a/i-0abc123", want: "i-0abc123"},
		{providerID: "aws://ap-northeast-2a/i-0abc123", want: "i-0abc123"},
		// Fargate and other non-EC2 providers must not be mistaken for instances.
		{providerID: "fargate-ip-10-0-1-5.ap-northeast-2.compute.internal", want: ""},
		{providerID: "gce://project/zone/instance", want: ""},
		{providerID: "", want: ""},
		{providerID: "aws:///ap-northeast-2a/", want: ""},
		{providerID: "aws:///ap-northeast-2a/not-an-instance", want: ""},
	}
	for _, tt := range tests {
		if got := instanceIDFromProviderID(tt.providerID); got != tt.want {
			t.Errorf("instanceIDFromProviderID(%q) = %q, want %q", tt.providerID, got, tt.want)
		}
	}
}

func TestNewOutsideCluster(t *testing.T) {
	// Running the binary locally must fail cleanly rather than panic, because the
	// caller treats the failure as "disable the recommender".
	if _, err := New(); err == nil {
		t.Skip("running inside a cluster")
	}
}
