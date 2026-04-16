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

    #[test]
    fn tilde_without_prior_newline() {
        let mut detector = EscapeDetector::new();
        // Tilde in Normal state should not advance
        assert!(!detector.process(b'~'));
        assert!(!detector.process(b'.'));
    }

    #[test]
    fn dot_without_prior_tilde() {
        let mut detector = EscapeDetector::new();
        assert!(!detector.process(b'.'));
    }

    #[test]
    fn consecutive_newlines() {
        let mut detector = EscapeDetector::new();
        assert!(!detector.process(b'\n'));
        assert!(!detector.process(b'\n'));
        assert!(!detector.process(b'~'));
        assert!(detector.process(b'.'));
    }

    #[test]
    fn reset_after_non_tilde() {
        let mut detector = EscapeDetector::new();
        assert!(!detector.process(b'\n'));
        assert!(!detector.process(b'a')); // resets to Normal
        assert!(!detector.process(b'~')); // tilde in Normal, no effect
        assert!(!detector.process(b'.'));
    }

    #[test]
    fn double_escape_sequence() {
        let mut detector = EscapeDetector::new();
        // First escape
        assert!(!detector.process(b'\n'));
        assert!(!detector.process(b'~'));
        assert!(detector.process(b'.'));
        // Second escape (state was reset to Normal after detect)
        assert!(!detector.process(b'\n'));
        assert!(!detector.process(b'~'));
        assert!(detector.process(b'.'));
    }

    #[test]
    fn newline_after_tilde_resets() {
        let mut detector = EscapeDetector::new();
        assert!(!detector.process(b'\n'));
        assert!(!detector.process(b'~'));
        // Newline resets to AfterNewline instead of completing escape
        assert!(!detector.process(b'\n'));
        assert!(!detector.process(b'~'));
        assert!(detector.process(b'.'));
    }

    #[test]
    fn default_trait() {
        let d1 = EscapeDetector::new();
        let d2 = EscapeDetector::default();
        // Both start in Normal state - verify by running same sequence
        let mut d1 = d1;
        let mut d2 = d2;
        for &byte in &[b'\n', b'~', b'.'] {
            assert_eq!(d1.process(byte), d2.process(byte));
        }
    }
}
