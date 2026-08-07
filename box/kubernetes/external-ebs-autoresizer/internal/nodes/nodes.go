// Package nodes reads in-cluster Kubernetes Nodes and writes annotations back to
// them. It is the only place the addon touches cluster-scoped objects, and it is
// deliberately limited to list and annotate: the recommender publishes advice on
// the Node object and never taints, drains, or otherwise changes a Node's
// scheduling state.
package nodes

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
	typedcorev1 "k8s.io/client-go/kubernetes/typed/core/v1"
	"k8s.io/client-go/rest"
)

// Well-known Node labels the recommender reads instead of calling AWS. Both are
// set by the AWS cloud provider and by Karpenter, so the instance type of a Node
// is known without a DescribeInstances call.
const (
	instanceTypeLabel = "node.kubernetes.io/instance-type"
	zoneLabel         = "topology.kubernetes.io/zone"
)

// awsProviderPrefix is the providerID scheme of an EC2-backed Node
// (aws:///<availability-zone>/<instance-id>).
const awsProviderPrefix = "aws://"

// Node is the subset of a Kubernetes Node the recommender needs.
type Node struct {
	Name string
	// UID identifies the live Node object, so an Event recorded against it is
	// associated with this instance of the Node rather than a recycled name.
	UID string
	// InstanceID is the EC2 instance ID parsed from spec.providerID. Empty when
	// the Node is not EC2-backed (e.g. Fargate) or has no providerID yet.
	InstanceID string
	// InstanceType comes from the node.kubernetes.io/instance-type label.
	InstanceType string
	// Zone comes from the topology.kubernetes.io/zone label.
	Zone string
	// CreatedAt is the Node's creationTimestamp. It bounds how much history the
	// node can possibly have, which is what lets the recommender skip querying a
	// node too young to satisfy the confidence gate.
	CreatedAt time.Time
	// Annotations is the Node's current annotation set, used to skip a patch when
	// nothing changed.
	Annotations map[string]string
}

// Client lists and annotates Nodes.
type Client struct {
	nodes typedcorev1.NodeInterface
}

// New builds a Client from the in-cluster config. It fails outside a cluster,
// which the caller treats as "disable the recommender" rather than a fatal error.
func New() (*Client, error) {
	cfg, err := rest.InClusterConfig()
	if err != nil {
		return nil, fmt.Errorf("in-cluster config: %w", err)
	}
	clientset, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("kubernetes client: %w", err)
	}
	return &Client{nodes: clientset.CoreV1().Nodes()}, nil
}

// List returns every Node matching labelSelector (empty selects all Nodes),
// paginating so a large cluster never issues one unbounded request.
func (c *Client) List(ctx context.Context, labelSelector string) ([]Node, error) {
	const pageSize = 500
	var out []Node
	opts := metav1.ListOptions{LabelSelector: labelSelector, Limit: pageSize}
	for {
		page, err := c.nodes.List(ctx, opts)
		if err != nil {
			return nil, fmt.Errorf("list nodes: %w", err)
		}
		for i := range page.Items {
			n := &page.Items[i]
			out = append(out, Node{
				Name:         n.Name,
				UID:          string(n.UID),
				InstanceID:   instanceIDFromProviderID(n.Spec.ProviderID),
				InstanceType: n.Labels[instanceTypeLabel],
				Zone:         n.Labels[zoneLabel],
				CreatedAt:    n.CreationTimestamp.Time,
				Annotations:  n.Annotations,
			})
		}
		if page.Continue == "" {
			return out, nil
		}
		opts.Continue = page.Continue
	}
}

// Annotate writes set and deletes remove from the Node's annotations in one
// request. A merge patch is used rather than an update so concurrent writers (the
// cluster autoscaler, Karpenter, CSI drivers) never lose their own annotations to
// a stale resourceVersion, and no read-modify-write retry loop is needed. A key
// in remove that the Node does not have is a no-op, so the caller can pass the
// full key set it owns without reading the Node first.
func (c *Client) Annotate(ctx context.Context, name string, set map[string]string, remove []string) error {
	if len(set) == 0 && len(remove) == 0 {
		return nil
	}
	// A merge patch deletes a key by mapping it to JSON null, so the value type is
	// *string: a nil pointer encodes as null while a set value encodes as a string.
	values := make(map[string]*string, len(set)+len(remove))
	for k, v := range set {
		values[k] = &v
	}
	for _, k := range remove {
		values[k] = nil
	}
	patch, err := json.Marshal(map[string]any{
		"metadata": map[string]any{"annotations": values},
	})
	if err != nil {
		return fmt.Errorf("marshal annotation patch for node %s: %w", name, err)
	}
	if _, err := c.nodes.Patch(ctx, name, types.MergePatchType, patch, metav1.PatchOptions{}); err != nil {
		return fmt.Errorf("patch node %s annotations: %w", name, err)
	}
	return nil
}

// instanceIDFromProviderID extracts the EC2 instance ID from a Node providerID
// such as aws:///ap-northeast-2a/i-0abc123. It returns an empty string for any
// other scheme or shape, which callers treat as "not an EC2 node".
func instanceIDFromProviderID(providerID string) string {
	if !strings.HasPrefix(providerID, awsProviderPrefix) {
		return ""
	}
	_, rest, _ := strings.Cut(providerID, awsProviderPrefix)
	segments := strings.Split(strings.Trim(rest, "/"), "/")
	last := segments[len(segments)-1]
	if !strings.HasPrefix(last, "i-") {
		return ""
	}
	return last
}
