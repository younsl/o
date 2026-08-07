package promx

import (
	"context"
	"fmt"
	"strings"
)

// Profile is one known convention for exporting Site-to-Site VPN tunnel traffic to
// Prometheus. Exporters name the same CloudWatch metric differently and disagree on
// whether it lands as a counter or a gauge, so both belong in the profile.
type Profile struct {
	// Name identifies the profile in logs.
	Name string
	// Metric is the metric name carrying tunnel egress bytes.
	Metric string
	// MetricIn is the ingress counterpart. Both directions count, because
	// replacing a tunnel interrupts traffic either way, and a connection can be
	// busy inbound while its egress looks idle. Empty when the exporter publishes
	// only one direction.
	MetricIn string
	// VPNLabel carries the VPN connection ID.
	VPNLabel string
	// TunnelLabel carries the tunnel's outside IP. Empty when the exporter does
	// not break the metric down per tunnel, in which case the connection total is
	// used, which is the right signal anyway: replacing a tunnel moves its traffic
	// onto the peer.
	TunnelLabel string
	// Counter selects rate() over a monotonic counter. CloudWatch exporters that
	// publish the period Sum as a gauge need avg_over_time instead, because rate()
	// on a gauge is meaningless.
	Counter bool
}

// profiles are tried in order. The list covers the exporters that actually publish
// AWS/VPN tunnel metrics; the first one with data for the connection wins.
var profiles = []Profile{
	{
		Name:        "yet-another-cloudwatch-exporter",
		Metric:      "aws_ec2_vpn_tunnel_data_out_sum",
		MetricIn:    "aws_ec2_vpn_tunnel_data_in_sum",
		VPNLabel:    "dimension_VpnId",
		TunnelLabel: "dimension_TunnelIpAddress",
	},
	{
		Name:        "yet-another-cloudwatch-exporter (vpn namespace)",
		Metric:      "aws_vpn_tunnel_data_out_sum",
		MetricIn:    "aws_vpn_tunnel_data_in_sum",
		VPNLabel:    "dimension_VpnId",
		TunnelLabel: "dimension_TunnelIpAddress",
	},
	{
		Name:        "prometheus cloudwatch_exporter",
		Metric:      "aws_ec2_tunnel_data_out_sum",
		MetricIn:    "aws_ec2_tunnel_data_in_sum",
		VPNLabel:    "dimension_VpnId",
		TunnelLabel: "dimension_TunnelIpAddress",
	},
	{
		Name:        "cloudwatch_exporter (TunnelDataOut)",
		Metric:      "aws_vpn_tunnel_data_out_average",
		MetricIn:    "aws_vpn_tunnel_data_in_average",
		VPNLabel:    "dimension_VpnId",
		TunnelLabel: "dimension_TunnelIpAddress",
	},
	{
		Name:        "otel awscloudwatchmetrics receiver",
		Metric:      "amazonaws_com_AWS_VPN_TunnelDataOut",
		MetricIn:    "amazonaws_com_AWS_VPN_TunnelDataIn",
		VPNLabel:    "VpnId",
		TunnelLabel: "TunnelIpAddress",
		Counter:     true,
	},
}

// Detect finds the profile that has data for the given VPN connection.
//
// Probing beats asking an operator for PromQL: the query has to match whichever
// exporter that cluster happens to run, and a query written once by hand silently
// stops matching when the exporter is swapped.
func Detect(ctx context.Context, client *Client, vpnConnectionID string) (Profile, error) {
	var tried []string
	for _, p := range profiles {
		probe := fmt.Sprintf(`count(%s{%s="%s"})`, p.Metric, p.VPNLabel, vpnConnectionID)
		v, err := client.Query(ctx, probe)
		if err == nil && v > 0 {
			return p, nil
		}
		tried = append(tried, p.Metric)
	}
	return Profile{}, fmt.Errorf("no known VPN traffic metric found for %s (tried %s); "+
		"set trafficGate.mode to query and supply currentQuery to use a custom metric",
		vpnConnectionID, strings.Join(tried, ", "))
}

// sampleWindow is how much traffic counts as one point, both for "now" and for every
// historical point it is compared against. Deliberately not configurable: it has to
// match the exporter's CloudWatch period to mean anything, and it is the same
// question at both ends of the comparison.
const sampleWindow = "5m"

// TrafficQuery builds the one expression the gate reads, used for both the recent
// samples and the historical distribution.
//
// One expression rather than a current/baseline pair is the point: the verdict is
// where today's value falls within its own history, so the two must be the same
// measurement by construction rather than by an operator keeping two queries in step.
func (p Profile) TrafficQuery(v Vars) string {
	out := fmt.Sprintf("(%s or vector(0))", p.directionExpr(p.Metric, v))
	if p.MetricIn == "" {
		return out
	}
	// or vector(0) on each side, because a missing direction would otherwise empty
	// the whole expression and read as "no data" rather than "no traffic that way".
	return fmt.Sprintf("%s + (%s or vector(0))", out, p.directionExpr(p.MetricIn, v))
}

// directionExpr renders the aggregated traffic expression for one metric.
func (p Profile) directionExpr(metric string, v Vars) string {
	selector := fmt.Sprintf(`%s{%s="%s"}`, metric, p.VPNLabel, v.VPNConnectionID)
	if p.Counter {
		return fmt.Sprintf("sum(rate(%s[%s]))", selector, sampleWindow)
	}
	// The exporter publishes the CloudWatch period Sum as a gauge, so averaging the
	// recent samples is the closest thing to a rate.
	return fmt.Sprintf("sum(avg_over_time(%s[%s]))", selector, sampleWindow)
}

// String renders the profile for startup logs.
func (p Profile) String() string {
	kind := "gauge"
	if p.Counter {
		kind = "counter"
	}
	return fmt.Sprintf("%s (%s, %s by %s)", p.Name, p.Metric, kind, p.VPNLabel)
}
