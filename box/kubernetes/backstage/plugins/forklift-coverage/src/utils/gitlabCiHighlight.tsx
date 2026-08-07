import React from 'react';

/**
 * Line based GitLab CI highlighter.
 *
 * A real YAML parse is not worth it here. The viewer renders one line per row
 * so it can flag the lines that reference Forklift, and a per-line tokenizer
 * keeps that structure intact.
 */

/** Keywords that only ever appear at the top level of a pipeline. */
const GLOBAL_KEYWORDS = new Set([
  'default',
  'include',
  'stages',
  'variables',
  'workflow',
]);

/** Keywords GitLab reserves inside a job, plus the shared global ones. */
const CI_KEYWORDS = new Set([
  ...GLOBAL_KEYWORDS,
  'after_script',
  'allow_failure',
  'artifacts',
  'before_script',
  'cache',
  'coverage',
  'dast_configuration',
  'dependencies',
  'environment',
  'except',
  'extends',
  'hooks',
  'id_tokens',
  'image',
  'inherit',
  'interruptible',
  'needs',
  'only',
  'pages',
  'parallel',
  'publish',
  'release',
  'resource_group',
  'retry',
  'rules',
  'script',
  'secrets',
  'services',
  'stage',
  'tags',
  'timeout',
  'trigger',
  'when',
]);

/** Splits `$VAR`, `${VAR}`, and `$CI_...` out of a value. */
const VARIABLE_RE = /(\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*)/g;

const withVariables = (text: string, keyPrefix: string): React.ReactNode[] =>
  // split() on a regex with one capture group yields text, capture, text, …
  // so odd indices are the variables. Testing the global regex per part would
  // be wrong, since its lastIndex carries between calls.
  text.split(VARIABLE_RE).map((part, index) =>
    index % 2 === 1 ? (
      <span key={`${keyPrefix}-v${index}`} className="fc-yaml-variable">
        {part}
      </span>
    ) : (
      <React.Fragment key={`${keyPrefix}-t${index}`}>{part}</React.Fragment>
    ),
  );

const highlightValue = (raw: string, keyPrefix: string): React.ReactNode => {
  if (raw.trim() === '') return raw;

  // Trailing comments are common on script lines, so split them off first.
  const commentAt = raw.search(/(^|\s)#/);
  if (commentAt >= 0) {
    const body = raw.slice(0, commentAt);
    const comment = raw.slice(commentAt);
    return (
      <>
        {highlightValue(body, `${keyPrefix}-b`)}
        <span className="fc-yaml-comment">{comment}</span>
      </>
    );
  }

  const leading = raw.slice(0, raw.length - raw.trimStart().length);
  const value = raw.trim();

  let className = 'fc-yaml-string';
  if (/^(true|false|null|~)$/i.test(value)) className = 'fc-yaml-bool';
  else if (/^-?\d+(\.\d+)?$/.test(value)) className = 'fc-yaml-number';
  else if (/^[&*][A-Za-z0-9_-]+$/.test(value)) className = 'fc-yaml-anchor';

  return (
    <>
      {leading}
      <span className={className}>{withVariables(value, keyPrefix)}</span>
    </>
  );
};

export const highlightGitlabCiLine = (
  line: string,
  keyPrefix: string,
): React.ReactNode => {
  if (line.trim() === '') return line;

  if (/^\s*#/.test(line)) {
    return <span className="fc-yaml-comment">{line}</span>;
  }

  const listMatch = line.match(/^(\s*)(-\s+)(.*)$/);
  if (listMatch) {
    const [, indent, dash, rest] = listMatch;
    // A list entry can itself be a mapping, e.g. `- name: build`.
    const inner = rest.match(/^([\w.$/-]+)(:)(\s*)(.*)$/);
    return (
      <>
        {indent}
        <span className="fc-yaml-punct">{dash}</span>
        {inner ? (
          <>
            <span className="fc-yaml-key">{inner[1]}</span>
            <span className="fc-yaml-punct">{inner[2]}</span>
            {inner[3]}
            {highlightValue(inner[4], `${keyPrefix}-li`)}
          </>
        ) : (
          highlightValue(rest, `${keyPrefix}-l`)
        )}
      </>
    );
  }

  const kvMatch = line.match(/^(\s*)([\w.$/-]+)(:)(.*)$/);
  if (kvMatch) {
    const [, indent, key, colon, rest] = kvMatch;
    const topLevel = indent.length === 0;
    let keyClass = 'fc-yaml-key';
    if (CI_KEYWORDS.has(key)) keyClass = 'fc-yaml-keyword';
    // A top-level key that is not a reserved word is a job name, the anchor
    // most people scan the file for.
    else if (topLevel) keyClass = 'fc-yaml-job';

    return (
      <>
        {indent}
        <span className={keyClass}>{key}</span>
        <span className="fc-yaml-punct">{colon}</span>
        {highlightValue(rest, keyPrefix)}
      </>
    );
  }

  return highlightValue(line, keyPrefix);
};
