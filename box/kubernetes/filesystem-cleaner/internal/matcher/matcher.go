// Package matcher implements include/exclude glob pattern matching for
// relative file paths.
//
// The semantics mirror the Rust globset crate with its default settings
// (literal_separator=false), which this project used before the Go port:
//   - `*` and `?` match any characters, including `/`
//   - `**` as a full path component matches zero or more components
//     (leading `**/`, trailing `/**`, middle `/**/`, or bare `**`)
//   - character classes like `[abc]` and negation `[!abc]` are supported
//   - brace alternation like `{a,b}` is supported
package matcher

import (
	"fmt"
	"regexp"
	"strings"
)

// Matcher decides whether a relative path should be included in or excluded
// from a cleanup run.
type Matcher struct {
	include []*regexp.Regexp
	exclude []*regexp.Regexp
}

// New compiles include and exclude glob patterns into a Matcher.
func New(includePatterns, excludePatterns []string) (*Matcher, error) {
	include, err := compileAll(includePatterns)
	if err != nil {
		return nil, fmt.Errorf("invalid include pattern: %w", err)
	}
	exclude, err := compileAll(excludePatterns)
	if err != nil {
		return nil, fmt.Errorf("invalid exclude pattern: %w", err)
	}
	return &Matcher{include: include, exclude: exclude}, nil
}

// ShouldInclude reports whether the path matches any include pattern.
func (m *Matcher) ShouldInclude(path string) bool {
	return matchAny(m.include, path)
}

// ShouldExclude reports whether the path matches any exclude pattern.
func (m *Matcher) ShouldExclude(path string) bool {
	return matchAny(m.exclude, path)
}

func matchAny(patterns []*regexp.Regexp, path string) bool {
	for _, re := range patterns {
		if re.MatchString(path) {
			return true
		}
	}
	return false
}

func compileAll(patterns []string) ([]*regexp.Regexp, error) {
	compiled := make([]*regexp.Regexp, 0, len(patterns))
	for _, p := range patterns {
		re, err := compile(p)
		if err != nil {
			return nil, err
		}
		compiled = append(compiled, re)
	}
	return compiled, nil
}

// compile translates one glob pattern into an anchored regular expression.
func compile(pattern string) (*regexp.Regexp, error) {
	var b strings.Builder
	b.WriteString("(?s)^")

	components := strings.Split(pattern, "/")
	for idx, comp := range components {
		first := idx == 0
		last := idx == len(components)-1

		if comp == "**" {
			// `**` is only special as a full path component; the joining
			// slashes are folded into the emitted regex.
			switch {
			case first && last:
				b.WriteString(".*")
			case first:
				b.WriteString("(?:.*/)?")
			case last:
				b.WriteString("/.*")
			default:
				b.WriteString("/(?:.*/)?")
			}
			continue
		}

		if !first && components[idx-1] != "**" {
			b.WriteString("/")
		}
		if err := translateComponent(comp, &b); err != nil {
			return nil, fmt.Errorf("pattern %q: %w", pattern, err)
		}
	}

	b.WriteString("$")
	re, err := regexp.Compile(b.String())
	if err != nil {
		return nil, fmt.Errorf("pattern %q: %w", pattern, err)
	}
	return re, nil
}

func translateComponent(comp string, b *strings.Builder) error {
	braceDepth := 0
	for i := 0; i < len(comp); {
		switch c := comp[i]; c {
		case '*':
			b.WriteString(".*")
			for i < len(comp) && comp[i] == '*' {
				i++
			}
		case '?':
			b.WriteString(".")
			i++
		case '[':
			n, err := translateCharClass(comp[i:], b)
			if err != nil {
				return err
			}
			i += n
		case '{':
			b.WriteString("(?:")
			braceDepth++
			i++
		case '}':
			if braceDepth == 0 {
				return fmt.Errorf("unmatched closing brace")
			}
			b.WriteString(")")
			braceDepth--
			i++
		case ',':
			if braceDepth > 0 {
				b.WriteString("|")
			} else {
				b.WriteString(",")
			}
			i++
		case '\\':
			if i+1 >= len(comp) {
				return fmt.Errorf("trailing backslash")
			}
			b.WriteString(regexp.QuoteMeta(string(comp[i+1])))
			i += 2
		default:
			b.WriteString(regexp.QuoteMeta(string(c)))
			i++
		}
	}
	if braceDepth != 0 {
		return fmt.Errorf("unclosed brace")
	}
	return nil
}

// translateCharClass translates a glob character class starting at s[0] == '['
// and returns the number of bytes consumed.
func translateCharClass(s string, b *strings.Builder) (int, error) {
	b.WriteString("[")
	i := 1
	if i < len(s) && (s[i] == '!' || s[i] == '^') {
		b.WriteString("^")
		i++
	}
	// A `]` immediately after the (possibly negated) opening bracket is a
	// literal member of the class, not the closing bracket.
	if i < len(s) && s[i] == ']' {
		b.WriteString(`\]`)
		i++
	}
	for i < len(s) {
		switch s[i] {
		case ']':
			b.WriteString("]")
			return i + 1, nil
		case '\\':
			b.WriteString(`\\`)
		case '[':
			b.WriteString(`\[`)
		default:
			b.WriteByte(s[i])
		}
		i++
	}
	return 0, fmt.Errorf("unclosed character class")
}
