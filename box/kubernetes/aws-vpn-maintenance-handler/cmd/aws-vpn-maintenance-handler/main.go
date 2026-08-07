// Command aws-vpn-maintenance-handler owns AWS Site-to-Site VPN tunnel endpoint
// maintenance.
//
// AWS queues endpoint replacements and, past a published deadline, applies them at a
// time of its choosing. This controller applies them earlier: in a maintenance
// window, one tunnel at a time, after a Slack approval, and only while the other
// tunnel is verifiably carrying traffic.
package main

import (
	"log/slog"
	"os"
	"strings"
)

func main() {
	// A failure before the config is read still has to look like every other line in
	// the Pod log, so the default logger is set up before anything can fail. The
	// daemon replaces it once the configured level and format are known.
	slog.SetDefault(newLogger("info", "json"))

	if err := newRootCommand().Execute(); err != nil {
		// Cobra is configured to silence errors so a failure is reported once, in the
		// process log format, rather than twice. Logging it here is what makes that
		// single report actually happen.
		slog.Error("aws-vpn-maintenance-handler failed", "error", err)
		os.Exit(1)
	}
}

// newLogger builds the slog handler used by the whole process.
func newLogger(level, format string) *slog.Logger {
	var lvl slog.Level
	switch strings.ToLower(level) {
	case "debug":
		lvl = slog.LevelDebug
	case "warn":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	default:
		lvl = slog.LevelInfo
	}
	opts := &slog.HandlerOptions{Level: lvl}
	var handler slog.Handler
	if strings.ToLower(format) == "text" {
		handler = slog.NewTextHandler(os.Stdout, opts)
	} else {
		handler = slog.NewJSONHandler(os.Stdout, opts)
	}
	return slog.New(handler)
}
