/*
 * Argo CD UI extension for argocd-promotion-gate.
 *
 * This file only renders. It cannot block a sync, and it does not try to: the
 * ValidatingAdmissionWebhook is what enforces the gate, on every path
 * (UI, CLI, REST, auto-sync). What the panel adds is knowing the verdict
 * before pressing Sync instead of reading it in an error toast afterwards.
 *
 * The verdict is not recomputed here. It comes from the same engine the
 * webhook uses, over the Argo CD proxy extension, so the panel and the denial
 * can never disagree.
 *
 * Argo CD serves extensions as plain scripts and exposes React on window, so
 * this is hand-written with React.createElement: no build step, no bundle.
 *
 * Layout is not freehand either. Argo CD renders a status panel extension with
 * no wrapper at all:
 *
 *   statusExtensions.map(e => createElement(e.component, {application, openFlyout}))
 *
 * The registered title is only a React key and the flyout heading, so the
 * component has to produce a whole panel item itself. Using Argo CD's own
 * classes is what keeps this tile the same shape as the SYNC STATUS and HEALTH
 * tiles beside it: the item is a flex column with a separator, the label is the
 * title, item-value is the large line, and item__row is a right-aligned key
 * beside an ellipsised value.
 */
((() => {
  const React = window.React;

  // Argo CD proxies /extensions/<name>/... to the configured backend. The name
  // is substituted when the gate writes this file out, which keeps it in step
  // with whatever the operator registered in argocd-cm.
  const GATE_URL = '/extensions/__EXTENSION_NAME__/api/v1/gate';

  const STATE = {
    LOADING: 'loading',
    READY: 'ready',
    ERROR: 'error',
  };

  // Argo CD's own status colours, taken from the constants its bundle uses for
  // the tiles beside this one.
  const TONES = {
    ok: '#18BE94',
    blocked: '#E96D76',
    warn: '#f4c030',
    muted: '#CCD6DD',
  };

  // The label metrics Argo CD applies to SYNC STATUS and LAST SYNC.
  const LABEL_STYLE = {
    display: 'flex',
    alignItems: 'flex-start',
    fontSize: '12px',
    fontWeight: 600,
    color: '#6D7F8B',
    minHeight: '18px',
  };

  // The rule first and the exceptions second, because that is the order the
  // reader needs them in. Long enough to answer why a sync is blocked and short
  // enough to finish reading while hovering.
  const HELP =
    'Blocks this sync until the upstream environment is Synced and Healthy on the same image tag. ' +
    'Two cases always pass: an app with no upstream counterpart and a rollback to a revision ' +
    'already deployed here.';

  // Argo CD's help tooltips are tippy v5 instances, and tippy is bundled rather
  // than exposed, so an extension cannot create one. What it can do is emit the
  // same DOM: the stylesheet is already on the page, so `tippy-popper` and
  // `tippy-tooltip light-theme` render identically to the tooltip on SYNC
  // STATUS. Only the positioning has to be done by hand.
  const TOOLTIP_MAX_WIDTH = 350;
  const TOOLTIP_MARGIN = 8;
  const TOOLTIP_HIDE_DELAY = 120;

  let activeTooltip = null;
  let hideTimer = null;

  function removeTooltip() {
    if (hideTimer) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
    if (activeTooltip) {
      activeTooltip.remove();
      activeTooltip = null;
      window.removeEventListener('scroll', removeTooltip, true);
      window.removeEventListener('resize', removeTooltip);
    }
  }

  function showTooltip(reference, text) {
    removeTooltip();

    const popper = document.createElement('div');
    popper.className = 'tippy-popper';
    popper.setAttribute('x-placement', 'bottom');
    popper.style.cssText =
      'position:absolute;z-index:9999;visibility:visible;transition-duration:0ms;' +
      'will-change:transform;top:0;left:0;';
    popper.innerHTML =
      '<div class="tippy-tooltip light-theme" data-state="visible" tabindex="-1" data-interactive="" ' +
      'data-arrow="" data-animation="fade" role="tooltip" data-placement="bottom" ' +
      'style="max-width:' + TOOLTIP_MAX_WIDTH + 'px;transition-duration:300ms;top:10px;left:0;">' +
      '<div class="tippy-arrow"></div>' +
      '<div class="tippy-content" data-state="visible" style="transition-duration:300ms;">' +
      '<div></div></div></div>';
    // textContent rather than markup, because the help copy is not HTML and
    // should never be treated as such.
    popper.querySelector('.tippy-content > div').textContent = text;
    document.body.appendChild(popper);

    // Measure after insertion, the way a popper library does, then place it
    // centred under the reference and nudged inside the viewport.
    const rect = reference.getBoundingClientRect();
    const width = popper.offsetWidth;
    const centre = rect.left + rect.width / 2;
    const maxLeft = window.innerWidth - width - TOOLTIP_MARGIN;
    const left = Math.max(TOOLTIP_MARGIN, Math.min(centre - width / 2, Math.max(TOOLTIP_MARGIN, maxLeft)));
    const top = rect.bottom + window.scrollY;
    popper.style.transform = 'translate3d(' + Math.round(left + window.scrollX) + 'px, ' + Math.round(top) + 'px, 0)';

    const arrow = popper.querySelector('.tippy-arrow');
    if (arrow) {
      arrow.style.left = Math.round(centre - left - 8) + 'px';
    }

    // Interactive, like Argo CD's own: moving onto the tooltip keeps it open.
    popper.addEventListener('mouseenter', () => {
      if (hideTimer) {
        window.clearTimeout(hideTimer);
        hideTimer = null;
      }
    });
    popper.addEventListener('mouseleave', removeTooltip);

    // A tooltip pinned to a stale position is worse than none.
    window.addEventListener('scroll', removeTooltip, true);
    window.addEventListener('resize', removeTooltip);

    activeTooltip = popper;
  }

  function scheduleHide() {
    if (hideTimer) {
      window.clearTimeout(hideTimer);
    }
    hideTimer = window.setTimeout(removeTooltip, TOOLTIP_HIDE_DELAY);
  }

  // Kept deliberately short. item-value renders at 2em, so a sentence here
  // would push the whole panel into a horizontal scroll.
  const CODES = {
    Passed: {label: 'Ready', tone: 'ok'},
    NotGated: {label: 'Not gated', tone: 'muted'},
    Exempt: {label: 'Exempt', tone: 'muted'},
    UpstreamMissing: {label: 'No upstream', tone: 'muted'},
    UpstreamOutOfSync: {label: 'Blocked', tone: 'blocked'},
    UpstreamUnhealthy: {label: 'Blocked', tone: 'blocked'},
    ImageTagMismatch: {label: 'Tag mismatch', tone: 'blocked'},
    LookupFailed: {label: 'Unknown', tone: 'warn'},
  };

  // At most this many detail rows, so a multi-image mismatch cannot make the
  // tile taller than the panel.
  const MAX_ROWS = 3;

  function entry(verdict) {
    return CODES[verdict.code] || null;
  }

  function tone(verdict) {
    const found = entry(verdict);
    if (!found) {
      return verdict.allowed ? 'ok' : 'blocked';
    }
    // A verdict the gate allowed is never painted as a block, even when its
    // code usually means one (warn mode reports a mismatch and lets it pass).
    if (verdict.allowed && found.tone === 'blocked') {
      return 'warn';
    }
    return found.tone;
  }

  function label(verdict) {
    const found = entry(verdict);
    if (!found) {
      return verdict.allowed ? 'Ready' : 'Blocked';
    }
    if (verdict.allowed && found.tone === 'blocked') {
      return found.label + ' (warn)';
    }
    return found.label;
  }

  // The values behind the label. A tile that says only "Blocked" makes the
  // reader open something else to learn anything at all, so what they need in
  // order to act goes on the tile: which upstream, in what state, or which tag
  // differs.
  function rows(verdict) {
    const upstream = verdict.upstream || {};
    const images = verdict.images || [];
    const mismatched = images.filter(image => !image.matched);

    switch (verdict.code) {
      case 'ImageTagMismatch':
        return mismatched
          .slice(0, MAX_ROWS)
          .map(image => [
            image.repository,
            (image.desiredTag || 'none') + ' vs ' + (image.upstreamTag || 'none'),
          ]);
      case 'UpstreamOutOfSync':
        return [
          ['UPSTREAM', upstream.app || 'unknown'],
          ['SYNC', upstream.syncStatus || 'Unknown'],
        ];
      case 'UpstreamUnhealthy':
        return [
          ['UPSTREAM', upstream.app || 'unknown'],
          ['HEALTH', upstream.healthStatus || 'Unknown'],
        ];
      case 'UpstreamMissing':
        return [
          ['UPSTREAM', upstream.app || 'unknown'],
          ['STATE', 'does not exist'],
        ];
      case 'Passed': {
        const matched = images.filter(image => image.matched);
        const out = [['UPSTREAM', upstream.app || 'unknown']];
        if (matched.length > 0) {
          out.push(['TAG', matched[0].upstreamTag || 'unknown']);
        } else {
          out.push(['STATE', 'Synced and Healthy']);
        }
        return out;
      }
      case 'Exempt':
        return [['STATE', 'skip annotation is set']];
      case 'NotGated':
        return [['ENV', verdict.env || 'unknown']];
      case 'LookupFailed':
        return [
          ['UPSTREAM', upstream.app || 'unknown'],
          ['STATE', 'could not be read'],
        ];
      default:
        return [];
    }
  }

  // argocd-server does not add the application headers on the way through. It
  // reads them off the incoming request, uses them to authorize the call
  // against Argo CD RBAC, and only then proxies it. A request without them is
  // rejected with a plain text "Invalid headers", so the caller has to supply
  // them from the application it is rendering.
  function gateHeaders(application) {
    const metadata = (application && application.metadata) || {};
    const spec = (application && application.spec) || {};
    const namespace = metadata.namespace || 'argocd';
    const headers = {Accept: 'application/json'};
    if (metadata.name) {
      headers['Argocd-Application-Name'] = namespace + ':' + metadata.name;
    }
    if (spec.project) {
      headers['Argocd-Project-Name'] = spec.project;
    }
    return headers;
  }

  function useGate(application) {
    const [state, setState] = React.useState({status: STATE.LOADING});
    const metadata = (application && application.metadata) || {};
    const key = (metadata.namespace || '') + '/' + (metadata.name || '');

    React.useEffect(() => {
      let cancelled = false;

      // Read the body as text first. The proxy answers with plain text on its
      // own errors, and parsing that as JSON turns a clear "Invalid headers"
      // into an unrelated SyntaxError.
      fetch(GATE_URL, {headers: gateHeaders(application)})
        .then(response => response.text().then(body => ({ok: response.ok, status: response.status, body})))
        .then(({ok, status, body}) => {
          if (cancelled) {
            return;
          }
          let parsed = null;
          try {
            parsed = JSON.parse(body);
          } catch (_) {
            parsed = null;
          }
          if (!ok) {
            const reason = (parsed && parsed.error) || (body || '').trim() || 'request failed';
            setState({status: STATE.ERROR, error: 'HTTP ' + status + ': ' + reason});
            return;
          }
          if (!parsed) {
            setState({
              status: STATE.ERROR,
              error: 'the gate answered with something that is not JSON: ' + (body || '').trim().slice(0, 200),
            });
            return;
          }
          setState({status: STATE.READY, verdict: parsed});
        })
        .catch(error => {
          if (!cancelled) {
            setState({status: STATE.ERROR, error: String(error)});
          }
        });

      return () => {
        cancelled = true;
      };
      // Refetch when the page moves to a different application.
    }, [key]);

    return state;
  }

  // One panel item, built out of the same classes Argo CD uses for the tiles on
  // either side of it.
  function Item(props) {
    const children = [
      // Argo CD builds its own tile labels this way: a flex label carrying the
      // title, then a smaller span holding the font-awesome help icon. The
      // tooltip component it uses is internal, so the hover text rides on the
      // title attribute instead and the browser renders it.
      React.createElement(
        'label',
        {key: 'label', style: LABEL_STYLE},
        'PROMOTION GATE',
        React.createElement(
          'span',
          {key: 'help', style: {marginLeft: '5px'}},
          React.createElement(
            'span',
            {
              style: {fontSize: 'smaller'},
              onMouseEnter: event => showTooltip(event.currentTarget, HELP),
              onMouseLeave: scheduleHide,
            },
            ' ',
            React.createElement('i', {className: 'fa fa-question-circle help-tip'}),
          ),
        ),
      ),
      React.createElement(
        'div',
        {
          key: 'value',
          className: 'application-status-panel__item-value',
          style: {color: TONES[props.tone], cursor: props.onClick ? 'pointer' : undefined},
          onClick: props.onClick,
          title: props.hover || undefined,
        },
        props.value,
      ),
    ];

    (props.rows || []).forEach((row, index) => {
      children.push(
        React.createElement(
          'div',
          {key: 'row-' + index, className: 'application-status-panel__item__row'},
          React.createElement('div', null, row[0]),
          // The class already handles nowrap and the ellipsis, so a long value
          // truncates instead of widening the panel.
          React.createElement('div', {title: row[1]}, row[1]),
        ),
      );
    });

    return React.createElement('div', {className: 'application-status-panel__item'}, children);
  }

  function upstreamSentence(upstream) {
    if (!upstream) {
      return null;
    }
    if (!upstream.exists) {
      return 'Upstream ' + upstream.app + ' does not exist.';
    }
    return (
      'Upstream ' +
      upstream.app +
      ' is ' +
      (upstream.syncStatus || 'Unknown') +
      ' and ' +
      (upstream.healthStatus || 'Unknown') +
      '.'
    );
  }

  const flyoutStyles = {
    body: {padding: '16px', display: 'flex', flexDirection: 'column', gap: '14px'},
    heading: {fontSize: '13px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em'},
    text: {fontSize: '13px', lineHeight: 1.5},
    warning: {fontSize: '13px', lineHeight: 1.5, color: '#b07503'},
    table: {borderCollapse: 'collapse', fontSize: '12px', width: '100%'},
    th: {textAlign: 'left', padding: '4px 10px 4px 0', fontWeight: 600, whiteSpace: 'nowrap'},
    cell: {padding: '4px 10px 4px 0', whiteSpace: 'nowrap', fontFamily: 'monospace'},
    hint: {fontSize: '12px', opacity: 0.75},
  };

  function ImageTable(props) {
    const images = props.images || [];
    if (images.length === 0) {
      return null;
    }
    return React.createElement(
      'div',
      null,
      React.createElement('div', {style: flyoutStyles.heading}, 'Images'),
      React.createElement(
        'table',
        {style: flyoutStyles.table},
        React.createElement(
          'thead',
          null,
          React.createElement(
            'tr',
            null,
            React.createElement('th', {style: flyoutStyles.th}, 'Repository'),
            React.createElement('th', {style: flyoutStyles.th}, 'This environment'),
            React.createElement('th', {style: flyoutStyles.th}, 'Upstream'),
          ),
        ),
        React.createElement(
          'tbody',
          null,
          images.map((image, index) =>
            React.createElement(
              'tr',
              {key: index},
              React.createElement('td', {style: flyoutStyles.cell}, image.repository),
              React.createElement(
                'td',
                {style: {...flyoutStyles.cell, color: image.matched ? TONES.ok : TONES.blocked}},
                image.desiredTag || 'none',
              ),
              React.createElement('td', {style: flyoutStyles.cell}, image.upstreamTag || 'none'),
            ),
          ),
        ),
      ),
    );
  }

  // Everything the tile has no room for. Argo CD renders this in its own panel,
  // so ordinary block layout is fine here.
  function PromotionGateFlyout(props) {
    const state = useGate(props && props.application);

    if (state.status === STATE.LOADING) {
      return React.createElement('div', {style: flyoutStyles.body}, 'Checking the promotion gate...');
    }
    if (state.status === STATE.ERROR) {
      return React.createElement(
        'div',
        {style: flyoutStyles.body},
        React.createElement('div', {style: flyoutStyles.heading}, 'Gate unavailable'),
        React.createElement('div', {style: flyoutStyles.text}, state.error),
        React.createElement(
          'div',
          {style: flyoutStyles.hint},
          'A 400 about headers means the request reached the proxy without them. A 404 means the extension is not registered in argocd-cm. A 403 means Argo CD RBAC does not allow invoking it.',
        ),
      );
    }

    const verdict = state.verdict || {};
    return React.createElement(
      'div',
      {style: flyoutStyles.body},
      React.createElement('div', {style: flyoutStyles.heading}, label(verdict)),
      React.createElement('div', {style: flyoutStyles.text}, verdict.message || ''),
      upstreamSentence(verdict.upstream)
        ? React.createElement('div', {style: flyoutStyles.text}, upstreamSentence(verdict.upstream))
        : null,
      (verdict.warnings || []).map((warning, index) =>
        React.createElement('div', {key: index, style: flyoutStyles.warning}, warning),
      ),
      React.createElement(ImageTable, {images: verdict.images}),
    );
  }

  function PromotionGatePanel(props) {
    const state = useGate(props && props.application);
    // Argo CD passes openFlyout when a flyout component was registered. Guard
    // it so an older server that ignores the fourth argument still renders.
    const openFlyout = typeof props.openFlyout === 'function' ? props.openFlyout : undefined;

    if (state.status === STATE.LOADING) {
      return React.createElement(Item, {tone: 'muted', value: 'Checking'});
    }

    if (state.status === STATE.ERROR) {
      // A misconfigured extension has to be visible. A blank tile reads as
      // "nothing to worry about", which is the wrong thing to imply.
      return React.createElement(Item, {
        tone: 'warn',
        value: 'Unavailable',
        rows: [['ERROR', state.error]],
        hover: state.error,
        onClick: openFlyout,
      });
    }

    const verdict = state.verdict || {};
    return React.createElement(Item, {
      tone: tone(verdict),
      value: label(verdict),
      rows: rows(verdict),
      hover: verdict.message,
      onClick: openFlyout,
    });
  }

  // The fourth argument is the flyout. The registered title is the React key
  // and the flyout heading, not the tile label, which is why the component
  // renders its own.
  window.extensionsAPI.registerStatusPanelExtension(
    PromotionGatePanel,
    'Promotion Gate',
    'promotion.gate',
    PromotionGateFlyout,
  );
})());
