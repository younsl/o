package main

import (
	"github.com/spf13/cobra"

	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/version"
)

// newRootCommand builds the cobra command tree. The root command runs the
// controller; subcommands (validate, policies, instances) are operational
// helpers that need no running controller. A persistent --config flag, shared
// by every command, defaults to $CONFIG_FILE or the mounted config path.
func newRootCommand() *cobra.Command {
	var configFile string

	root := &cobra.Command{
		Use:           "external-ebs-autoresizer",
		Short:         "Grow standalone EC2 root volumes when disk usage crosses a threshold",
		Version:       version.Version,
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(_ *cobra.Command, _ []string) error {
			return runDaemon(configFile)
		},
	}
	root.PersistentFlags().StringVar(&configFile, "config", configFilePath(),
		"Path to the config file ($CONFIG_FILE, else the mounted default)")

	run := &cobra.Command{
		Use:   "run",
		Short: "Run the controller (the default when no subcommand is given)",
		RunE: func(_ *cobra.Command, _ []string) error {
			return runDaemon(configFile)
		},
	}
	validate := &cobra.Command{
		Use:   "validate",
		Short: "Load and validate the config file, then exit",
		RunE: func(_ *cobra.Command, _ []string) error {
			return runValidate(configFile)
		},
	}
	var withCount bool
	policies := &cobra.Command{
		Use:   "policies",
		Short: "Print the resolved resize policies and their effective settings",
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runPolicies(cmd.Context(), configFile, withCount)
		},
	}
	policies.Flags().BoolVar(&withCount, "count", false,
		"Discover instances via AWS and add a MATCHED column with the count each policy identifies")
	instances := &cobra.Command{
		Use:   "instances",
		Short: "List discovered instances grouped by the policy each matches (calls AWS)",
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runInstances(cmd.Context(), configFile)
		},
	}

	root.AddCommand(run, validate, policies, instances)
	return root
}
