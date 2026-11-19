// approval-explainer plugin entry (Host half)
//
// 1) Enriches every approval/request waterfall BEFORE the Remote-Event forwarder
//    (prepend + global), rewriting the localized displayReason with a plain-Chinese
//    translation of the command and a dangerous-action flag, and re-presents it
//    through the normal approval dialog.
// 2) Maintains a session projection `approvalExplainers` that folds logged
//    approval audit events + correlated tool calls into a per-session history
//    list (explanation + command + outcome). The Client reads it via
//    useProjection('approvalExplainers') and renders the right-sidebar list.
//
// The plugin is strictly additive: it never grants, denies, or otherwise decides
// an approval (it only rewrites the text shown and derives display data from the
// already-logged events). Every failure falls back to the untouched request.

import { RISK, humanize, modeText, toolLabel, translateToZh } from './translator.js'

// Locales we localize. Non-Chinese locales fall back to English text so the
// approval dialog always shows readable copy in the active language.
const SUPPORTED = ['en', 'zh', 'ja', 'es', 'fr', 'de', 'ru', 'pt']

// Key of the client-visible wire projection this plugin owns.
export const PROJECTION_KEY = 'approvalExplainers'

/** Tools whose arguments we capture (for command/path/action descriptions). */
const RECORDED_TOOL = new Set([
  'bash', 'pwsh', 'shell', 'powershell', 'sh', 'cmd',
  'write', 'edit', 'delete', 'deleteFile', 'rename', 'move',
  'plugin_manager',
])

/**
 * Best-effort extraction of the raw command + primary path for a correlated tool
 * call, from the live agent's session (defensive; never throws).
 */
function extractToolCall(agent, callId) {
  try {
    if (!agent || callId === undefined || callId === null) return null
    const session = agent.session
    if (!session || typeof session.snapshotEvents !== 'function') return null
    const events = session.snapshotEvents()
    if (!Array.isArray(events)) return null
    for (const ev of events) {
      if (!ev || ev.type !== 'tool/call' || !ev.data) continue
      if (ev.data.callId === callId) {
        let args = {}
        if (typeof ev.data.arguments === 'string' && ev.data.arguments) {
          try { args = JSON.parse(ev.data.arguments) } catch { args = {} }
        } else if (ev.data.arguments && typeof ev.data.arguments === 'object') {
          args = ev.data.arguments
        }
        return { name: ev.data.name, args }
      }
    }
  } catch {
    /* defensive: never break an approval because of lookup failure */
  }
  return null
}

/** Pick the raw command text from parsed tool-call arguments, if any. */
function commandOf(args) {
  if (typeof args?.command === 'string' && args.command) return args.command
  if (typeof args?.commandline === 'string' && args.commandline) return args.commandline
  return null
}

/** Pick a primary path from parsed tool-call arguments, if any. */
function pathOf(args) {
  if (typeof args?.file_path === 'string' && args.file_path) return args.file_path
  if (typeof args?.path === 'string' && args.path) return args.path
  if (typeof args?.target === 'string' && args.target) return args.target
  return null
}

/** JSON stringify with truncation and error containment. */
function safeStringify(value, max = 400) {
  try {
    const s = JSON.stringify(value)
    if (typeof s !== 'string') return ''
    return s.length > max ? s.slice(0, max - 1) + '…' : s
  } catch {
    return ''
  }
}

/** Bound stored tool args so projection state stays small (checkpointed to disk). */
function boundedArgs(args) {
  try {
    const s = JSON.stringify(args || {})
    if (s.length <= 1200) return args || {}
    return { __summary: s.slice(0, 600) + '…' }
  } catch {
    return {}
  }
}

/**
 * Clean a raw request reason into a short human note: strip escalation prefixes
 * and auto-generated `<toolName> {json}.` summaries, and drop text that merely
 * restates the action. Returns '' when nothing distinct remains.
 */
function cleanReason(rawStr, toolName, actionText) {
  let r = String(rawStr || '')
    .replace(/^Allow this operation with \S+ permissions:\s*/i, '')
    .replace(/^escalate sandbox to [\w-]+:\s*/i, '')
    .trim()
  if (toolName) {
    const esc = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp('^' + esc + '\\s*\\{[\\s\\S]*\\}\\s*[.。;；]?\\s*')
    r = r.replace(re, '').trim()
  }
  if (r && actionText && (actionText.includes(r) || r.includes(actionText))) return ''
  return r
}

/** Pull a short human note from a request's copy. */
function justification(req, toolName, actionText) {
  return cleanReason(req?.reason ?? req?.displayReason?.en ?? '', toolName, actionText)
}

/**
 * Build the enriched, reorganized displayReason map.
 * One line per locale: `⚠️【高危】label ｜ 工具：… ｜ 操作：… ｜ 备注：… ｜ 权限：…`.
 */
function buildDisplay(req, toolCall, translation, mode, note) {
  const toolName = toolCall?.name || req?.toolName
  const label = toolLabel(toolName)
  const cmd = commandOf(toolCall?.args)
  const riskLabel = translation.labels
  const riskEmoji = translation.risk === 'danger' ? '⚠️' : translation.risk === 'caution' ? '✎' : '✓'
  const scope = mode ? modeText(mode) : null
  const noteZh = note ? translateToZh(note) : ''
  // The host approval card renders the title in one paragraph (newlines
  // collapse), so build a single wrapped line: a leading risk tag for instant
  // recognition, then labeled sections separated by a visible ｜ bar. A shell
  // command is kept inline only when short; longer payloads (e.g. JSON args)
  // already show in the card's correlated-detail region below.
  const showRaw = cmd && cmd.length <= 120 ? cmd : null

  const compose = (locale) => {
    const zh = locale === 'zh'
    const parts = []
    const tag = zh ? riskLabel.tag.zh : riskLabel.tag.en
    const labelText = zh ? riskLabel.zh : riskLabel.en
    parts.push(`${riskEmoji}【${tag}】${labelText}`)
    parts.push(zh ? `工具：${label.zh}` : `Tool: ${label.en}`)
    parts.push(zh ? `操作：${translation.zh}` : `Action: ${translation.en}`)
    if (note) parts.push(zh ? `备注：${noteZh}` : `Note: ${note}`)
    if (scope) parts.push(zh ? `权限：${scope.zh}` : `Access: ${scope.en}`)
    if (showRaw) parts.push(zh ? `原始：${showRaw}` : `Raw: ${showRaw}`)
    return parts.join(' ｜ ')
  }

  const display = {}
  for (const loc of SUPPORTED) display[loc] = compose(loc)
  return display
}

/** Extract the sandbox mode an escalation request targets, if any. */
function modeOf(text) {
  const m = /(read-only|workspace-write|danger-full-access)/.exec(text || '')
  return m ? m[1] : undefined
}

/**
 * Session projection: fold approval audit + tool-call events into a per-session
 * history of approval records. `state` is plain JSON and never mutated; a
 * relevant event returns a fresh state, anything else returns the same reference.
 */
function projectionInit() {
  return { calls: {}, records: [] }
}

/** Parse tool-call `arguments` (a JSON string, or an object) into a plain object. */
function parseArgs(args) {
  if (typeof args === 'string' && args) {
    try { return JSON.parse(args) } catch { return {} }
  }
  if (args && typeof args === 'object') return args
  return {}
}

function projectionApply(state, event) {
  const d = event.data
  if (event.type === 'tool/call' && d && RECORDED_TOOL.has(d.name) && d.callId !== undefined) {
    const parsed = parseArgs(d.arguments)
    const command = commandOf(parsed)
    const path = pathOf(parsed)
    const args = boundedArgs(parsed)
    const prev = state.calls[d.callId]
    if (prev && prev.command === command && prev.path === path && safeStringify(prev.args) === safeStringify(args)) return state
    return { ...state, calls: { ...state.calls, [d.callId]: { name: d.name, command, path, args } } }
  }
  if (event.type === 'approval/asked' && d && d.id !== undefined) {
    if (state.records.some((r) => r.id === d.id)) return state
    const time = typeof event.time === 'number' ? event.time : Date.now()
    return {
      ...state,
      records: [...state.records, {
        id: d.id, time, toolName: d.toolName,
        ...(d.callId !== undefined ? { callId: d.callId } : {}),
        ...(d.reason !== undefined ? { reason: d.reason } : {}),
      }],
    }
  }
  if (event.type === 'approval/decided' && d && d.id !== undefined) {
    let changed = false
    const records = state.records.map((r) => {
      if (r.id !== d.id || r.outcome === d.outcome) return r
      changed = true
      return { ...r, outcome: d.outcome }
    })
    if (!changed) return state
    return { ...state, records }
  }
  return state
}

/** Build the client-facing records list (explanation + command + outcome). */
function projectionView(state) {
  const list = []
  for (const r of state.records) {
    const call = r.callId !== undefined ? state.calls[r.callId] : undefined
    const command = call?.command ?? null
    const args = call?.args
    const mode = modeOf(r.reason)
    let translation
    try {
      translation = humanize({ toolName: r.toolName, command, reason: r.reason, args })
    } catch {
      translation = { en: r.reason || '', zh: r.reason || '', risk: 'safe', labels: RISK.safe }
    }
    if (translation.risk === 'safe' && mode === 'danger-full-access') {
      translation = { ...translation, risk: 'caution', labels: RISK.caution }
    }
    const label = toolLabel(r.toolName)
    const note = cleanReason(r.reason, r.toolName, translation.en)
    const noteZh = note ? translateToZh(note) : null
    const raw = command || (args && Object.keys(args).length ? safeStringify(args, 300) : (call?.path ?? null))
    list.push({
      id: r.id,
      time: r.time,
      toolName: r.toolName,
      toolLabel: label,
      callId: r.callId ?? null,
      command,
      raw,
      note: noteZh,
      ...(note ? { noteEn: note } : {}),
      ...(mode ? { mode } : {}),
      risk: translation.risk,
      labels: translation.labels,
      zh: translation.zh,
      en: translation.en,
      outcome: r.outcome ?? null,
    })
  }
  // newest first
  list.sort((a, b) => b.time - a.time)
  return list
}

/** Identity-parse "schema" so the projection needs no zod dependency (runtime only calls .parse). */
function passthroughSchema() {
  return { parse: (v) => v }
}

/** The wire session projection definition. */
export function projectionDefinition() {
  return {
    key: PROJECTION_KEY,
    stateVersion: 1,
    stateSchema: passthroughSchema(),
    init: projectionInit,
    apply: projectionApply,
    wire: {
      viewSchema: passthroughSchema(),
      view: projectionView,
    },
  }
}

/** Host plugin entry. `sessionProjections` is declared so it is mounted before apply. */
export const inject = ['sessionProjections']
export async function apply(ctx) {
  // Existing enrichment of the approval dialog. `prepend + global` runs first.
  ctx.on('approval/request', async (req, next) => {
    try {
      const enText = req?.displayReason?.en || req?.reason || ''
      const mode = modeOf(enText)
      const toolCall = extractToolCall(req?.agent, req?.callId)
      const toolName = toolCall?.name || req?.toolName
      const rawCommand = commandOf(toolCall?.args)

      let translation
      try {
        translation = humanize({ toolName, command: rawCommand, reason: req?.reason, args: toolCall?.args })
      } catch {
        translation = null
      }

      if (translation) {
        let effective = translation
        if (translation.risk === 'safe' && mode === 'danger-full-access') {
          effective = { ...translation, risk: 'caution', labels: RISK.caution }
        }
        const note = justification(req, toolName, effective.en)
        const display = buildDisplay(req, toolCall, effective, mode, note)
        // Same-process Request object shared through the waterfall: the
        // Remote-Event forwarder after this listener serializes the enriched
        // displayReason to the client approval dialog.
        req.displayReason = display
      }
    } catch {
      /* never let an enrichment failure break the approval flow */
    }
    return next()
  }, { prepend: true, global: true })

  // Record history for the right-sidebar list via a wire session projection.
  // The projection is an additive display aid: any failure to register it (sync
  // or async rejection) must NEVER fail the plugin fiber or block boot, so both
  // are contained here.
  try {
    ctx.effect(async () => {
      try {
        const handle = await ctx.sessionProjections.register(projectionDefinition())
        return () => { try { void handle.dispose() } catch { /* ignore */ } }
      } catch (error) {
        ctx.logger?.warn?.('approval-explainer: projection unavailable: %s', String(error))
        return () => {}
      }
    })
  } catch (error) {
    ctx.logger?.warn?.('approval-explainer: projection setup skipped: %s', String(error))
  }
}
