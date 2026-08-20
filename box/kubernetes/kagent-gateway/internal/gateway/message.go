package gateway

import "errors"

// userMessage picks the line a Slack thread should show for err. An error that
// carries its own summary supplies it; anything else is a fault nobody reading
// the thread can act on, so it gets a fixed line and the detail stays in the
// log the handler already wrote.
func userMessage(err error) string {
	if carrier, ok := errors.AsType[interface {
		error
		UserMessage() string
	}](err); ok {
		return carrier.UserMessage()
	}
	return "an internal error occurred. check the gateway log."
}
