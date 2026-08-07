package main

import (
	"context"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"

	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/awsx"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/config"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/version"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/window"
)

func newRootCommand() *cobra.Command {
	var configFile string

	root := &cobra.Command{
		Use:   "aws-vpn-maintenance-handler",
		Short: "Own AWS Site-to-Site VPN tunnel endpoint maintenance",
		Long: "Applies pending Site-to-Site VPN tunnel endpoint maintenance on your schedule instead of AWS's:\n" +
			"inside a maintenance window, one tunnel at a time, after a Slack approval, and only while the\n" +
			"connection's other tunnel is verifiably carrying traffic.",
		Version:       fmt.Sprintf("%s (commit %s)", version.Version, version.Commit),
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(_ *cobra.Command, _ []string) error {
			return runDaemon(configFile)
		},
	}
	root.PersistentFlags().StringVar(&configFile, "config", "",
		"path to the config file (defaults to $CONFIG_FILE, then "+config.DefaultConfigFile+")")

	root.AddCommand(
		newValidateCommand(&configFile),
		newStatusCommand(&configFile),
	)
	return root
}

// newValidateCommand checks the config without touching AWS or Kubernetes.
func newValidateCommand(configFile *string) *cobra.Command {
	return &cobra.Command{
		Use:   "validate",
		Short: "Validate the config file and print the effective settings",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			cfg, err := config.Load(*configFile)
			if err != nil {
				return err
			}
			win, err := window.New(window.Config{
				Timezone:     cfg.MaintenanceWindow.Timezone,
				CronSchedule: cfg.MaintenanceWindow.CronSchedule,
				Duration:     cfg.MaintenanceWindow.Duration.D(),
				MinRemaining: cfg.MaintenanceWindow.MinRemaining.D(),
			})
			if err != nil {
				return err
			}

			now := time.Now()
			open, detail := win.Open(now)
			w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
			fmt.Fprintf(w, "region\t%s\n", cfg.Region)
			fmt.Fprintf(w, "dry run\t%t\n", cfg.DryRun)
			fmt.Fprintf(w, "reconcile interval\t%s\n", cfg.ReconcileInterval)
			fmt.Fprintf(w, "tag filters\t%s\n", formatTagFilters(cfg))
			fmt.Fprintf(w, "maintenance window\t%s\n", win.String())
			fmt.Fprintf(w, "window open now\t%t\t%s\n", open, detail)
			fmt.Fprintf(w, "window next opens\t%s\n", win.NextOpen(now).Format("2006-01-02 15:04 MST"))
			fmt.Fprintf(w, "approvers\t%d Slack user(s)\n", len(cfg.Approval.SlackUserIDs))
			fmt.Fprintf(w, "approval timeout\t%s\n", cfg.Approval.Timeout)
			fmt.Fprintf(w, "peer min stable for\t%s\n", cfg.Safety.PeerMinStableFor)
			fmt.Fprintf(w, "peer min accepted routes\t%d\n", cfg.Safety.PeerMinAcceptedRoutes)
			fmt.Fprintf(w, "per-connection cooldown\t%s\n", cfg.Safety.PerConnectionCooldown)
			fmt.Fprintf(w, "verify timeout\t%s (poll %s)\n", cfg.Safety.VerifyTimeout, cfg.Safety.VerifyPollInterval)
			fmt.Fprintf(w, "escalate before\t%s\n", cfg.Safety.EscalateBefore)
			fmt.Fprintf(w, "traffic gate\t%s\n", describeTrafficGate(cfg))
			fmt.Fprintf(w, "state configmap\t%s/%s\n", cfg.PodNamespace, cfg.StateConfigMapName)
			return w.Flush()
		},
	}
}

// newStatusCommand prints telemetry and pending maintenance. Read-only, so it
// answers "what would this controller act on" without waiting for a window.
func newStatusCommand(configFile *string) *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Print tunnel telemetry and pending maintenance for the managed VPN connections (read-only)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cfg, err := config.Load(*configFile)
			if err != nil {
				return err
			}
			ctx := cmd.Context()
			if ctx == nil {
				ctx = context.Background()
			}
			client, err := awsx.New(ctx, cfg.Region)
			if err != nil {
				return err
			}

			filters := make([]awsx.TagFilter, 0, len(cfg.Targets.TagFilters))
			for _, f := range cfg.Targets.TagFilters {
				filters = append(filters, awsx.TagFilter{Key: f.Key, Value: f.Value})
			}
			conns, err := client.Discover(ctx, awsx.DiscoverInput{
				TagFilters: filters,
				ExcludeIDs: cfg.Targets.ExcludeConnectionIDs,
			})
			if err != nil {
				return err
			}
			if len(conns) == 0 {
				fmt.Println("no VPN connections match the configured tag filters")
				return nil
			}

			w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
			fmt.Fprintln(w, "CONNECTION\tNAME\tROUTING\tTUNNEL\tSTATUS\tROUTES\tSTABLE FOR\tLIFECYCLE\tPENDING\tAUTO-APPLY AFTER")
			now := time.Now()
			unmanaged := 0
			for _, conn := range conns {
				statuses, err := client.Statuses(ctx, conn)
				if err != nil {
					return err
				}
				for _, s := range statuses {
					if !s.Tunnel.LifecycleControl {
						unmanaged++
					}
					fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%d\t%s\t%s\t%s\t%s\n",
						conn.ID, orDash(conn.Name), routingMode(conn), s.Tunnel.OutsideIP,
						upDown(s.Tunnel.Up), s.Tunnel.AcceptedRoutes,
						truncateDuration(s.Tunnel.StableFor(now)),
						enabledDisabled(s.Tunnel.LifecycleControl),
						yesNo(s.Maintenance.Pending), formatTime(s.Maintenance.AutoAppliedAfter))
				}
			}
			if err := w.Flush(); err != nil {
				return err
			}
			// Without lifecycle control a tunnel can never be taken over, so this
			// is called out rather than left to be inferred from the column.
			if unmanaged > 0 {
				fmt.Printf("\n%d tunnel(s) have lifecycle control disabled and cannot be replaced early.\n"+
					"Enable it per tunnel with: aws ec2 modify-vpn-tunnel-options --enable-tunnel-lifecycle-control\n", unmanaged)
			}
			return nil
		},
	}
}

func formatTagFilters(cfg *config.Config) string {
	parts := make([]string, 0, len(cfg.Targets.TagFilters))
	for _, f := range cfg.Targets.TagFilters {
		if f.Value == "" {
			parts = append(parts, f.Key+"=<any>")
			continue
		}
		parts = append(parts, f.Key+"="+f.Value)
	}
	return strings.Join(parts, ", ")
}

// describeTrafficGate summarizes the gate in one line, including what an unreadable
// metric source would mean.
func describeTrafficGate(cfg *config.Config) string {
	t := cfg.TrafficGate
	if !t.Enabled {
		return "disabled (window and peer checks only)"
	}
	return strings.Join([]string{
		t.Endpoint,
		fmt.Sprintf("quiet at or below P%.0f of this window's own traffic", t.QuietPercentile),
		"onError " + t.OnError,
	}, ", ")
}

func routingMode(conn awsx.Connection) string {
	if conn.StaticRoutesOnly {
		return "static"
	}
	return "bgp"
}

func upDown(up bool) string {
	if up {
		return "UP"
	}
	return "DOWN"
}

func enabledDisabled(b bool) string {
	if b {
		return "on"
	}
	return "OFF"
}

func yesNo(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

func formatTime(t time.Time) string {
	if t.IsZero() {
		return "-"
	}
	return t.Local().Format("2006-01-02 15:04 MST")
}

func truncateDuration(d time.Duration) string {
	if d <= 0 {
		return "-"
	}
	return d.Round(time.Minute).String()
}
