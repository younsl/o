import React from 'react';
import { Text } from '@backstage/ui';

/**
 * Minimal Slack mrkdwn renderer for the preview pane.
 *
 * Only the constructs the summary actually emits are handled: `*bold*`,
 * `_italic_`, and `<url|label>` links. Anything else is shown as written,
 * which is honest about what Slack will do with it.
 */
const TOKEN_RE = /(<[^<>|]+\|[^<>]+>|<[^<>]+>|\*[^*\n]+\*|_[^_\n]+_)/g;

const renderInline = (line: string, keyPrefix: string): React.ReactNode[] =>
  line.split(TOKEN_RE).map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (!part) return <React.Fragment key={key} />;

    const link = part.match(/^<([^<>|]+)\|([^<>]+)>$/);
    if (link) {
      return (
        <a
          key={key}
          href={link[1]}
          target="_blank"
          rel="noopener noreferrer"
          className="fc-slack-link"
        >
          {link[2]}
        </a>
      );
    }
    const bareLink = part.match(/^<([^<>|]+)>$/);
    if (bareLink) {
      return (
        <a
          key={key}
          href={bareLink[1]}
          target="_blank"
          rel="noopener noreferrer"
          className="fc-slack-link"
        >
          {bareLink[1]}
        </a>
      );
    }
    // Bold and italic can wrap a link, as the report title does, so the body
    // goes through the tokenizer again instead of being printed raw.
    if (/^\*[^*\n]+\*$/.test(part)) {
      return (
        <strong key={key}>{renderInline(part.slice(1, -1), `${key}-b`)}</strong>
      );
    }
    if (/^_[^_\n]+_$/.test(part)) {
      return <em key={key}>{renderInline(part.slice(1, -1), `${key}-i`)}</em>;
    }
    return <React.Fragment key={key}>{part}</React.Fragment>;
  });

export const SlackPreview = ({
  text,
  sample,
}: {
  text: string;
  sample: boolean;
}) => (
  <div className="fc-preview-split">
    <div className="fc-preview-pane">
      <Text as="div" variant="body-x-small" color="secondary">
        Message source
      </Text>
      <pre className="fc-wizard-preview">{text}</pre>
    </div>
    <div className="fc-preview-pane">
      <Text as="div" variant="body-x-small" color="secondary">
        As Slack renders it{sample ? ', with example numbers' : ''}
      </Text>
      <div className="fc-slack-card">
        <div className="fc-slack-body">
          {text.split('\n').map((line, index) => (
            <div
              key={`line-${index}`}
              className={line ? 'fc-slack-line' : 'fc-slack-blank'}
            >
              {renderInline(line, `l${index}`)}
            </div>
          ))}
        </div>
      </div>
    </div>
  </div>
);
