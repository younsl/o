package matcher

import "testing"

func mustNew(t *testing.T, include, exclude []string) *Matcher {
	t.Helper()
	m, err := New(include, exclude)
	if err != nil {
		t.Fatalf("New() failed: %v", err)
	}
	return m
}

func TestExcludePatterns(t *testing.T) {
	m := mustNew(t, []string{"*"}, []string{"**/.git/**", "**/node_modules/**"})

	if !m.ShouldExclude("project1/.git/config") {
		t.Error("expected project1/.git/config to be excluded")
	}
	if !m.ShouldExclude("src/node_modules/lib.js") {
		t.Error("expected src/node_modules/lib.js to be excluded")
	}
	if m.ShouldExclude("src/main.go") {
		t.Error("expected src/main.go not to be excluded")
	}
}

func TestExcludeAtRoot(t *testing.T) {
	m := mustNew(t, []string{"*"}, []string{"**/.git/**"})

	if !m.ShouldExclude(".git/config") {
		t.Error("expected .git/config to be excluded")
	}
}

func TestIncludePatterns(t *testing.T) {
	m := mustNew(t, []string{"*.txt"}, nil)

	if !m.ShouldInclude("file.txt") {
		t.Error("expected file.txt to be included")
	}
	if !m.ShouldInclude("readme.txt") {
		t.Error("expected readme.txt to be included")
	}
	if m.ShouldInclude("file.go") {
		t.Error("expected file.go not to be included")
	}
}

func TestNestedGlobPatterns(t *testing.T) {
	m := mustNew(t, []string{"*"}, []string{"**/groovy-dsl/**"})

	if !m.ShouldExclude("build/groovy-dsl/cache.jar") {
		t.Error("expected build/groovy-dsl/cache.jar to be excluded")
	}
	if !m.ShouldExclude("a/b/c/groovy-dsl/file.txt") {
		t.Error("expected a/b/c/groovy-dsl/file.txt to be excluded")
	}
	if m.ShouldExclude("build/other/file.jar") {
		t.Error("expected build/other/file.jar not to be excluded")
	}
}

func TestSimpleFilenamePattern(t *testing.T) {
	m := mustNew(t, []string{"*"}, []string{"app.log"})

	if !m.ShouldExclude("app.log") {
		t.Error("expected app.log to be excluded")
	}
	if m.ShouldExclude("project1/app.log") {
		t.Error("expected project1/app.log not to be excluded")
	}
}

func TestFileExtensionPattern(t *testing.T) {
	m := mustNew(t, []string{"*"}, []string{"*.log"})

	if !m.ShouldExclude("app.log") {
		t.Error("expected app.log to be excluded")
	}
	if !m.ShouldExclude("project1/debug.log") {
		t.Error("expected project1/debug.log to be excluded")
	}
	if m.ShouldExclude("app.txt") {
		t.Error("expected app.txt not to be excluded")
	}
}

func TestMiddleDoublestarPattern(t *testing.T) {
	m := mustNew(t, []string{"a/**/b"}, nil)

	if !m.ShouldInclude("a/b") {
		t.Error("expected a/b to be included")
	}
	if !m.ShouldInclude("a/x/y/b") {
		t.Error("expected a/x/y/b to be included")
	}
	if m.ShouldInclude("a/x") {
		t.Error("expected a/x not to be included")
	}
}

func TestCharacterClassPattern(t *testing.T) {
	m := mustNew(t, []string{"file[0-9].txt"}, []string{"[!a]*.tmp"})

	if !m.ShouldInclude("file1.txt") {
		t.Error("expected file1.txt to be included")
	}
	if m.ShouldInclude("filex.txt") {
		t.Error("expected filex.txt not to be included")
	}
	if !m.ShouldExclude("b123.tmp") {
		t.Error("expected b123.tmp to be excluded")
	}
	if m.ShouldExclude("a123.tmp") {
		t.Error("expected a123.tmp not to be excluded")
	}
}

func TestBraceAlternation(t *testing.T) {
	m := mustNew(t, []string{"file.{txt,md}"}, nil)
	if !m.ShouldInclude("file.txt") {
		t.Error("expected file.txt to be included")
	}
	if !m.ShouldInclude("file.md") {
		t.Error("expected file.md to be included")
	}
	if m.ShouldInclude("file.go") {
		t.Error("expected file.go not to be included")
	}
}

func TestUnclosedBrace(t *testing.T) {
	if _, err := New([]string{"file.{txt"}, nil); err == nil {
		t.Error("expected error for unclosed brace")
	}
	if _, err := New([]string{"file.txt}"}, nil); err == nil {
		t.Error("expected error for unmatched closing brace")
	}
}

func TestInvalidIncludePattern(t *testing.T) {
	if _, err := New([]string{"[invalid"}, nil); err == nil {
		t.Error("expected error for unclosed character class in include pattern")
	}
}

func TestInvalidExcludePattern(t *testing.T) {
	if _, err := New([]string{"*"}, []string{"[invalid"}); err == nil {
		t.Error("expected error for unclosed character class in exclude pattern")
	}
}

func TestTrailingBackslashPattern(t *testing.T) {
	if _, err := New([]string{`foo\`}, nil); err == nil {
		t.Error("expected error for trailing backslash")
	}
}

func TestEscapedWildcard(t *testing.T) {
	m := mustNew(t, []string{`literal\*star`}, nil)

	if !m.ShouldInclude("literal*star") {
		t.Error("expected literal*star to be included")
	}
	if m.ShouldInclude("literalXstar") {
		t.Error("expected literalXstar not to be included")
	}
}
