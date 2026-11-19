// dsh-approval-explainer Client half: a right-sidebar tab listing recorded
// approvals (risk tag, tool, action, note, expandable raw command, time).
// Reads the Host's `approvalExplainers` wire session projection via the standard
// session `useProjection` hook.
//
// NOTE: This module intentionally registers ONLY into `sidebar.right.pane.tab`.
// It must NOT register into `conversation.approval.detail` (a `single` slot owned
// by dsh-client-ui-chat): doing so shares the slot at the same priority and makes
// the required ui-chat entry fail to activate, which breaks web boot.

window.__ModuleLoader__.load({
  id: 'dsh-approval-explainer',
  factory(require) {
    const React = require('react');
    const { useState } = React;
    const h = React.createElement;

    const TAB_ID = 'dsh-approval-explainer/approvals';
    const KIND = 'approval-records';
    const NS = 'approvalExplainer';
    const PROJECTION_KEY = 'approvalExplainers';

    const dicts = {
      zh: {
        'tab.title': '授权记录',
        'tab.description': '最近的授权提示、命令说明与结果',
        'empty': '还没有授权记录',
        'show': '原始命令',
        'outcome.allowed-once': '已允许',
        'outcome.rejected': '已拒绝',
        'outcome.cancelled': '已取消',
        'outcome.unavailable': '未处理',
      },
      en: {
        'tab.title': 'Approvals',
        'tab.description': 'Recent approval prompts, command explanations and outcomes',
        'empty': 'No approval records yet',
        'show': 'Raw command',
        'outcome.allowed-once': 'Allowed',
        'outcome.rejected': 'Rejected',
        'outcome.cancelled': 'Cancelled',
        'outcome.unavailable': 'Unhandled',
      },
    };

    function riskColor(risk) {
      if (risk === 'danger') return 'var(--dsw-alias-state-error-primary, #d64545)';
      if (risk === 'caution') return 'var(--dsw-alias-state-warn-primary, #c07f00)';
      return 'var(--dsw-alias-state-success-primary, #2f9e63)';
    }
    function outcomeLabel(t, outcome) {
      return outcome ? t('outcome.' + outcome) : '';
    }
    // Local `yyyy-MM-dd HH:mm:ss`.
    function fmtTime(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
      const d = new Date(ms);
      const p = (n) => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
        + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }

    // Style-reset disclosure button + the revealed raw text.
    const toggleStyle = {
      all: 'unset', cursor: 'pointer', display: 'inline-flex', alignItems: 'center',
      gap: '4px', color: 'var(--dsw-alias-label-secondary)',
      fontSize: '11px', lineHeight: 1.4, userSelect: 'none',
    };
    const rawStyle = {
      color: 'var(--dsw-alias-label-tertiary)',
      fontFamily: 'var(--ds-font-family-code, monospace)',
      fontSize: '11px', lineHeight: 1.5, whiteSpace: 'pre-wrap',
      wordBreak: 'break-all', marginTop: '4px',
    };

    // One history card in the right-sidebar list.
    function RecordCard({ record, t }) {
      const r = record;
      const [showRaw, setShowRaw] = useState(false);
      const color = riskColor(r.risk);
      const labels = r.labels || {};
      const tagText = (labels.tag && (labels.tag.zh || labels.tag.en)) || r.risk || '';
      const riskDesc = (labels.zh || labels.en) || '';
      const toolText = (r.toolLabel && (r.toolLabel.zh || r.toolLabel.en)) || r.toolName || '';
      const raw = r.raw || r.command || '';
      const outcomeText = outcomeLabel(t, r.outcome);
      const timeText = fmtTime(r.time);
      const cardStyle = {
        display: 'flex', flexDirection: 'column', gap: '5px',
        flexShrink: 0, padding: '9px 11px', marginBottom: '8px',
        borderRadius: '10px',
        background: 'var(--dsw-specific-input-major, var(--dsw-alias-surface, #fff))',
        border: '1px solid var(--dsw-alias-border-l2, #e6e6e6)',
        borderLeft: '4px solid ' + color,
        fontSize: '12px', lineHeight: 1.45,
      };
      const tagStyle = {
        color, fontWeight: 700, whiteSpace: 'nowrap', fontSize: '11px',
        background: 'color-mix(in srgb, ' + color + ' 14%, transparent)',
        border: '1px solid ' + color, borderRadius: '6px', padding: '1px 7px',
      };
      const timeStyle = {
        color: 'var(--dsw-alias-text-tertiary)', fontSize: '10px',
        fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', flex: '0 0 auto',
      };
      return h('div', { style: cardStyle },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' } },
          h('span', { style: tagStyle }, '【' + tagText + '】' + (riskDesc ? ' ' + riskDesc : '')),
          outcomeText ? h('span', {
            style: { color: 'var(--dsw-alias-text-tertiary)', fontSize: '11px', whiteSpace: 'nowrap' },
          }, outcomeText) : null,
        ),
        h('div', { style: { color: 'var(--dsw-alias-text-tertiary)', fontSize: '11px' } }, toolText),
        h('div', { style: { color: 'var(--dsw-alias-text-primary)', fontSize: '13px', fontWeight: 500 } }, r.zh || r.en || ''),
        r.note ? h('div', { style: { color: 'var(--dsw-alias-text-secondary)' } }, r.note) : null,
        // Bottom: [▸ 原始命令 ......... time] on one row; the expanded raw command
        // spans full width below, so the time never drops below the toggle.
        h('div', { style: { marginTop: '2px', display: 'flex', flexDirection: 'column', gap: '2px' } },
          h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px' } },
            raw
              ? h('button', {
                type: 'button', style: toggleStyle, title: raw, 'aria-expanded': showRaw,
                onClick: () => { setShowRaw((v) => !v); },
              }, (showRaw ? '▾ ' : '▸ ') + t('show'))
              : h('span'),
            timeText ? h('span', { style: timeStyle }, timeText) : null,
          ),
          raw && showRaw ? h('div', { style: rawStyle }, raw) : null,
        ),
      );
    }

    // Body component. Session scope provides `useProjection`.
    function ApprovalListBody(props) {
      const useProjection = props.useProjection;
      const records = useProjection(PROJECTION_KEY);
      const list = Array.isArray(records) ? records : [];
      const t = props.t || ((k) => k);
      // The host wraps this in `.tabBody` (height:100%, overflow:hidden, flex
      // column) - it clips rather than scrolls, so this root fills it and owns
      // the vertical scroll.
      return h('div', {
        style: {
          flex: '1 1 auto', minHeight: 0, height: '100%',
          boxSizing: 'border-box', overflowY: 'auto', overflowX: 'hidden',
          padding: '10px', display: 'flex', flexDirection: 'column',
        },
      },
        list.length === 0
          ? h('div', { style: { color: 'var(--dsw-alias-text-tertiary)', fontSize: '12px', padding: '12px 6px' } }, t('empty'))
          : list.map((r) => h(RecordCard, { key: r.id, record: r, t })),
      );
    }

    return {
      inject: ['slots', 'sessions', 'uiSession', 'sidebarRightTabs', 'sidebarRight', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        ctx.effect(() => ctx.locale.register(NS, {
          zh: dicts.zh, en: dicts.en, ja: dicts.en, es: dicts.en,
          fr: dicts.en, de: dicts.en, ru: dicts.en, pt: dicts.en,
        }), 'approval-explainer: dictionaries');

        // Stage 1: page tab type.
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: KIND,
          priority: 'extension',
          title: () => t('tab.title'),
          guide: [
            { id: KIND, order: 120, title: () => t('tab.title'), description: () => t('tab.description') },
          ],
        }), 'approval-explainer: tab type');

        // Stage 2: the tab body.
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
          locale: NS,
        }, ApprovalListBody));
      },
    };
  },
});
