package a2a

// Failures here have two audiences that want opposite things. The log wants
// the whole chain, down to the controller's own words, or an incident has
// nothing to work from. Slack wants one line a responder can read at a glance,
// and every stage name, retry count, and response body dumped into a thread
// buries the part that says what to do next.
//
// Error carries both: Error() keeps the chain for the log, and UserMessage()
// is what the bridge posts.

// Error pairs an internal error with the single line describing it to a human.
type Error struct {
	summary string
	err     error
}

func (e *Error) Error() string { return e.err.Error() }

func (e *Error) Unwrap() error { return e.err }

// UserMessage returns the one-line summary meant for Slack.
func (e *Error) UserMessage() string { return e.summary }

// fail wraps err with the summary a human should see instead of it.
func fail(summary string, err error) error {
	return &Error{summary: summary, err: err}
}
