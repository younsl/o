type Lang = 'yaml' | 'bash'

/**
 * Minimal, dependency-free syntax highlighter for YAML and bash code blocks.
 * Supports an additional `highlights` list whose occurrences render in accent
 * blue — used to visually flag values that came from the user's form input.
 *
 * Colour choices are CSS vars so the highlighter follows the app theme. Falls
 * back to reasonable literals when a var isn't defined.
 */

const C = {
  comment: 'var(--text-muted, #6b7280)',
  key: 'var(--syntax-key, #c084fc)',
  string: 'var(--syntax-string, #10b981)',
  number: 'var(--syntax-number, #f59e0b)',
  keyword: 'var(--syntax-keyword, #ef4444)',
  punctuation: 'var(--text-secondary)',
  dynamic: 'var(--accent)',
} as const

type Segment = { text: string; color?: string; bold?: boolean }

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Split plain text by any token in `highlights` and tag the matches. */
function applyHighlights(text: string, highlights: string[]): Segment[] {
  const tokens = Array.from(new Set(highlights.filter((h) => h && h.length > 0)))
  if (tokens.length === 0) return [{ text }]
  tokens.sort((a, b) => b.length - a.length)
  const re = new RegExp(`(${tokens.map(escapeRegex).join('|')})`, 'g')
  const out: Segment[] = []
  let last = 0
  for (const m of text.matchAll(re)) {
    if (m.index === undefined) continue
    if (m.index > last) out.push({ text: text.slice(last, m.index) })
    out.push({ text: m[0], color: C.dynamic, bold: true })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

/** Recursively apply highlights inside already-coloured segments. */
function expand(segments: Segment[], highlights: string[]): Segment[] {
  if (highlights.length === 0) return segments
  const out: Segment[] = []
  for (const seg of segments) {
    if (seg.color === C.dynamic) {
      out.push(seg)
      continue
    }
    for (const sub of applyHighlights(seg.text, highlights)) {
      if (sub.color === C.dynamic) {
        out.push(sub)
      } else {
        out.push({ ...seg, text: sub.text })
      }
    }
  }
  return out
}

// ── YAML tokenizer (line-based) ────────────────────────────────────────────

function tokenizeYamlValue(value: string): Segment[] {
  const trimmedLead = value.match(/^(\s*)/)?.[1] ?? ''
  const rest = value.slice(trimmedLead.length)

  if (rest.length === 0) return [{ text: value }]
  // Inline comment
  const cmt = rest.match(/^(.*?)(\s+#.*)$/)
  if (cmt) {
    const [, main, comment] = cmt
    return [
      ...(trimmedLead ? [{ text: trimmedLead }] : []),
      ...tokenizeYamlValue(main),
      { text: comment, color: C.comment },
    ]
  }
  // Quoted strings
  if (/^["'].*["']$/.test(rest)) {
    return [{ text: trimmedLead }, { text: rest, color: C.string }]
  }
  // Block scalar indicator
  if (rest === '|' || rest === '>' || rest === '|-' || rest === '>-') {
    return [{ text: trimmedLead }, { text: rest, color: C.punctuation }]
  }
  // Boolean / null
  if (/^(true|false|null|~)$/.test(rest)) {
    return [{ text: trimmedLead }, { text: rest, color: C.keyword }]
  }
  // Number
  if (/^-?\d+(\.\d+)?$/.test(rest)) {
    return [{ text: trimmedLead }, { text: rest, color: C.number }]
  }
  return [{ text: value }]
}

function tokenizeYamlLine(line: string): Segment[] {
  // Whole-line comment
  const whole = line.match(/^(\s*)(#.*)$/)
  if (whole) {
    return [{ text: whole[1] }, { text: whole[2], color: C.comment }]
  }
  // Document separator
  const sep = line.match(/^(\s*)(---|\.\.\.)\s*$/)
  if (sep) {
    return [{ text: sep[1] }, { text: sep[2], color: C.punctuation }]
  }
  // List item — strip "- " prefix and recurse on the remainder
  const list = line.match(/^(\s*)(-\s+)(.*)$/)
  if (list) {
    const [, indent, dash, rest] = list
    return [
      { text: indent },
      { text: dash, color: C.punctuation },
      ...tokenizeYamlLine(rest),
    ]
  }
  // Key: value
  const kv = line.match(/^(\s*)([A-Za-z_][\w.\-/]*)(:)(.*)$/)
  if (kv) {
    const [, indent, key, colon, rest] = kv
    return [
      { text: indent },
      { text: key, color: C.key },
      { text: colon, color: C.punctuation },
      ...tokenizeYamlValue(rest),
    ]
  }
  return [{ text: line }]
}

function tokenizeYaml(body: string): Segment[] {
  const out: Segment[] = []
  const lines = body.split('\n')
  lines.forEach((line, i) => {
    out.push(...tokenizeYamlLine(line))
    if (i < lines.length - 1) out.push({ text: '\n' })
  })
  return out
}

// ── Bash tokenizer (regex-based) ───────────────────────────────────────────

function tokenizeBash(body: string): Segment[] {
  const tokenRe = /(#[^\n]*)|("(?:\\.|[^"\\])*")|('(?:\\.|[^'\\])*')|(\$\{[A-Za-z_][\w]*\}|\$[A-Za-z_][\w]*)|(\b(?:if|then|else|elif|fi|for|in|do|done|while|case|esac|return|exit|echo|local|export|unset|set|function)\b)|(\s+-{1,2}[\w-]+)/g
  const out: Segment[] = []
  let last = 0
  for (const m of body.matchAll(tokenRe)) {
    if (m.index === undefined) continue
    if (m.index > last) out.push({ text: body.slice(last, m.index) })
    const [full, comment, dq, sq, variable, keyword, flag] = m
    if (comment) out.push({ text: comment, color: C.comment })
    else if (dq || sq) out.push({ text: (dq || sq)!, color: C.string })
    else if (variable) out.push({ text: variable, color: C.key })
    else if (keyword) out.push({ text: keyword, color: C.keyword })
    else if (flag) out.push({ text: flag, color: C.number })
    else out.push({ text: full })
    last = m.index + full.length
  }
  if (last < body.length) out.push({ text: body.slice(last) })
  return out
}

// ── Public component ───────────────────────────────────────────────────────

export function SyntaxHighlight({
  body,
  lang,
  highlights = [],
}: {
  body: string
  lang: Lang
  highlights?: string[]
}) {
  const base = lang === 'yaml' ? tokenizeYaml(body) : tokenizeBash(body)
  const segments = expand(base, highlights)
  return (
    <>
      {segments.map((s, i) => (
        <span
          key={i}
          style={{
            color: s.color ?? 'inherit',
            fontWeight: s.bold ? 600 : undefined,
          }}
        >
          {s.text}
        </span>
      ))}
    </>
  )
}
