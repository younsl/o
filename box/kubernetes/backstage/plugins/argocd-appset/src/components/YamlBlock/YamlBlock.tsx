import React from 'react';
import { CopyButton } from '../CopyButton';
import './YamlBlock.css';

interface Token {
  text: string;
  className: string;
}

const VALUE_CLASS = (value: string): string => {
  if (/^['"]/.test(value)) return 'yaml-string';
  if (/^-?\d+(\.\d+)*$/.test(value)) return 'yaml-number';
  if (/^(true|false|null|~)$/i.test(value)) return 'yaml-literal';
  return 'yaml-value';
};

/**
 * Tokenizes one line of YAML. Chart.yaml and rendered source blocks are flat
 * key/value documents with list items, so a line-oriented split covers them
 * without pulling in a highlighting library. Anything unrecognised falls
 * through as plain text rather than being mangled.
 */
export function tokenizeYamlLine(line: string): Token[] {
  if (line.trim() === '') return [{ text: line, className: '' }];

  if (/^\s*#/.test(line)) {
    return [{ text: line, className: 'yaml-comment' }];
  }

  const match = /^(\s*)(-\s+)?([^:#]+?)(\s*:)(\s*)(.*)$/.exec(line);
  if (!match) {
    // A bare list entry (`- item`) or a wrapped scalar.
    const listMatch = /^(\s*)(-\s+)(.*)$/.exec(line);
    if (listMatch) {
      return [
        { text: listMatch[1], className: '' },
        { text: listMatch[2], className: 'yaml-punct' },
        { text: listMatch[3], className: VALUE_CLASS(listMatch[3]) },
      ];
    }
    return [{ text: line, className: '' }];
  }

  const [, indent, dash, key, colon, space, rest] = match;
  const tokens: Token[] = [{ text: indent, className: '' }];
  if (dash) tokens.push({ text: dash, className: 'yaml-punct' });
  tokens.push({ text: key, className: 'yaml-key' });
  tokens.push({ text: colon, className: 'yaml-punct' });
  if (space) tokens.push({ text: space, className: '' });

  if (rest !== '') {
    const commentAt = rest.search(/\s#/);
    if (commentAt >= 0) {
      tokens.push({
        text: rest.slice(0, commentAt),
        className: VALUE_CLASS(rest.slice(0, commentAt)),
      });
      tokens.push({ text: rest.slice(commentAt), className: 'yaml-comment' });
    } else {
      tokens.push({ text: rest, className: VALUE_CLASS(rest) });
    }
  }

  return tokens;
}

export const YamlBlock = (props: {
  content: string;
  /** 1-indexed lines to mark as the ones actually read */
  highlightLines?: number[];
  /**
   * Notes shown after a line, keyed by 1-indexed line number. Deliberately not
   * part of `content`, so neither the copy button nor a manual selection picks
   * them up: what is copied has to be the file as the repository has it.
   */
  annotations?: Record<number, React.ReactNode>;
}) => {
  const highlighted = new Set(props.highlightLines ?? []);
  const lines = props.content.replace(/\n$/, '').split('\n');
  const gutterWidth = `${String(lines.length).length}ch`;

  return (
    <div className="yaml-block-wrapper">
      <CopyButton value={props.content} subject="file" className="yaml-copy-btn" />
      <pre className="yaml-block">
        {/*
          The inner element sizes itself to the widest line, so a highlighted row
          spans the whole scrollable width instead of stopping at the edge of the
          visible area once the block is scrolled sideways.
        */}
        <div className="yaml-lines">
          {lines.map((line, index) => {
            const lineNumber = index + 1;
            return (
              <div
                key={lineNumber}
                className={`yaml-line${highlighted.has(lineNumber) ? ' yaml-line-read' : ''}`}
              >
                <span className="yaml-gutter" style={{ width: gutterWidth }}>
                  {lineNumber}
                </span>
                <span className="yaml-code">
                  {tokenizeYamlLine(line).map((token, i) => (
                    <span key={i} className={token.className}>
                      {token.text}
                    </span>
                  ))}
                  {props.annotations?.[lineNumber] && (
                    <span className="yaml-annotation" aria-hidden="true">
                      {props.annotations[lineNumber]}
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </pre>
    </div>
  );
};
