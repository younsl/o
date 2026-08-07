package slackx

import (
	"log/slog"
	"strings"
)

// slogBridge adapts the slack-go logging interface to slog.
//
// Without it slack-go writes its own unstructured lines to stderr, so a Socket Mode
// reconnect or a write failure lands in the Pod log in a different format from every
// other line and is invisible to a log query that filters on the JSON fields.
//
// Everything arrives at info level because the library gives no severity to map: the
// same call carries a reconnect notice and a write failure. The component attribute is
// what a query filters on instead.
type slogBridge struct {
	logger *slog.Logger
}

// Output satisfies slack-go's logger interface. The calldepth argument is a stdlib
// log detail with no meaning here.
func (b slogBridge) Output(_ int, s string) error {
	b.logger.Info(strings.TrimSpace(s))
	return nil
}
