import React from 'react';

export const highlightYamlLine = (line: string): React.ReactNode => {
  if (/^\s*#/.test(line)) {
    return <span className="yaml-comment">{line}</span>;
  }
  const kvMatch = line.match(/^(\s*)([\w./-]+)(:)(.*)/);
  if (kvMatch) {
    const [, indent, key, colon, rest] = kvMatch;
    return (
      <>
        {indent}<span className="yaml-key">{key}</span><span className="yaml-colon">{colon}</span>{highlightYamlValue(rest)}
      </>
    );
  }
  const listMatch = line.match(/^(\s*)(- )(.*)/);
  if (listMatch) {
    const [, indent, dash, value] = listMatch;
    return (
      <>
        {indent}<span className="yaml-dash">{dash}</span>{highlightYamlValue(value)}
      </>
    );
  }
  return line;
};

export const highlightYamlValue = (value: string): React.ReactNode => {
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (/^(true|false)$/i.test(trimmed)) {
    return <>{value.slice(0, value.indexOf(trimmed))}<span className="yaml-bool">{trimmed}</span></>;
  }
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return <>{value.slice(0, value.indexOf(trimmed))}<span className="yaml-number">{trimmed}</span></>;
  }
  return <span className="yaml-string">{value}</span>;
};
