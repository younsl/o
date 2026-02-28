//! SSH-style escape sequence detection.

/// Escape sequence state machine.
#[derive(Debug, Clone, Copy, PartialEq)]
enum State {
    Normal,
    AfterNewline,
    AfterTilde,
}

/// Detects SSH-style escape sequences (Enter ~ .).
pub struct EscapeDetector {
    state: State,
}

impl EscapeDetector {
    pub fn new() -> Self {
        Self {
            state: State::Normal,
        }
    }

    /// Process a byte. Returns true if disconnect sequence detected.
    pub fn process(&mut self, byte: u8) -> bool {
        match (self.state, byte) {
            // Newline transitions to AfterNewline
            (_, b'\n') | (_, b'\r') => {
                self.state = State::AfterNewline;
                false
            }
            // Tilde after newline
            (State::AfterNewline, b'~') => {
                self.state = State::AfterTilde;
                false
            }
            // Dot after tilde = disconnect
            (State::AfterTilde, b'.') => {
                self.state = State::Normal;
                true
            }
            // Anything else resets
            _ => {
                self.state = State::Normal;
                false
            }
        }
    }
}

impl Default for EscapeDetector {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_escape_sequence() {
        let mut detector = EscapeDetector::new();

        // Normal input doesn't trigger
        assert!(!detector.process(b'a'));
        assert!(!detector.process(b'b'));

        // Enter ~ . triggers disconnect
        assert!(!detector.process(b'\n'));
        assert!(!detector.process(b'~'));
        assert!(detector.process(b'.'));
    }

    #[test]
    fn test_incomplete_sequence() {
        let mut detector = EscapeDetector::new();

        // Enter ~ (something else) doesn't trigger
        assert!(!detector.process(b'\n'));
        assert!(!detector.process(b'~'));
        assert!(!detector.process(b'x'));

        // State should be reset
        assert!(!detector.process(b'.'));
    }

    #[test]
    fn test_carriage_return() {
        let mut detector = EscapeDetector::new();

        // CR also works as newline
        assert!(!detector.process(b'\r'));
        assert!(!detector.process(b'~'));
        assert!(detector.process(b'.'));
    }
}
