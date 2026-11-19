// approval-explainer translator
// Deterministic, dictionary-based command translator + dangerous-action detector.
// Returns plain-language (zh/en) text and a risk grade for an approval request,
// so the user sees what the agent actually wants to do instead of raw shell
// text. No network / LLM dependency: pattern-based, instant, and safe (a
// failure always falls back to the original request copy).

export const RISK = {
  safe:    { en: 'Routine operation',                   zh: '常规操作',                     level: { en: 'low',    zh: '低' }, tag: { en: 'Low risk',    zh: '低危' } },
  caution: { en: 'Modifies or replaces data',           zh: '会修改或覆盖数据',             level: { en: 'medium', zh: '中' }, tag: { en: 'Medium risk', zh: '中危' } },
  danger:  { en: 'Dangerous / potentially destructive', zh: '危险操作 / 可能造成不可逆影响', level: { en: 'high',   zh: '高' }, tag: { en: 'High risk',   zh: '高危' } },
}

// --- English → Chinese translation for descriptive text --------------------
// The harness (and sometimes the model) emits English prose in approval
// reasons. Translation is deterministic: known harness phrases are replaced
// exactly, then any leftover English words are glossary-translated. Text that
// already contains Chinese is returned unchanged.
const ZH_PHRASES = [
  [/profile changes persist across sessions;\s*installed host code runs outside the workspace sandbox\.?/gi,
    '更改插件配置会跨会话保留；已安装的 Host 代码会在文件沙箱之外运行。'],
  [/profile changes persist across sessions/gi, '更改插件配置会跨会话保留'],
  [/installed host code runs outside the workspace sandbox/gi, '已安装的 Host 代码会在文件沙箱之外运行'],
  [/allow this operation with (\S+) permissions:?\s*/gi, '允许本次操作使用 $1 权限：'],
  [/escalate sandbox to ([\w-]+):?\s*/gi, '将沙箱提升到 $1：'],
  [/\brequires?\s+approval\b/gi, '需要审批'],
  [/\bis not available\b/gi, '不可用'],
  [/\bthis (?:action|operation)\b/gi, '该操作'],
]

const ZH_WORDS = {
  profile: '配置', profiles: '配置', session: '会话', sessions: '会话', plugin: '插件', plugins: '插件',
  bundle: '插件包', bundles: '插件包', install: '安装', installed: '已安装', installs: '安装',
  remove: '移除', uninstall: '卸载', enable: '启用', disable: '停用', update: '更新',
  sandbox: '沙箱', workspace: '工作区', file: '文件', files: '文件', directory: '目录', folder: '文件夹',
  command: '命令', commands: '命令', operation: '操作', operations: '操作',
  permission: '权限', permissions: '权限', access: '访问', full: '完全',
  read: '读取', write: '写入', writes: '写入', modify: '修改', overwrite: '覆盖', create: '创建', delete: '删除',
  move: '移动', rename: '重命名', code: '代码', host: 'Host',
  run: '运行', runs: '运行', running: '运行', outside: '在……之外', inside: '在……之内',
  persist: '保留', persists: '保留', across: '跨', because: '因为', need: '需要', needs: '需要', needed: '需要',
  clean: '清理', temp: '临时', temporary: '临时', legacy: '旧版', migration: '迁移', database: '数据库',
  process: '进程', service: '服务', network: '网络', download: '下载', upload: '上传', system: '系统',
  current: '当前', all: '所有', every: '每个', only: '仅',
  and: '并', or: '或', with: '用', without: '不使用', will: '将', may: '可能', can: '可以', cannot: '无法',
  the: '', a: '', an: '', to: '', of: '', for: '', is: '是', are: '是', it: '', this: '该', that: '该',
}

/** Glossary-translate leftover English words (only on prose-like text). */
function glossary(text) {
  return text
    .replace(/[A-Za-z][A-Za-z'-]*/g, (w) => {
      const key = w.toLowerCase()
      return Object.prototype.hasOwnProperty.call(ZH_WORDS, key) ? ZH_WORDS[key] : w
    })
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([，。；：])/g, '$1')
    .trim()
}

/**
 * Translate English descriptive text into Chinese deterministically.
 * @param {string} text - text that may contain English prose.
 * @returns {string} Chinese when translated, or the input when it is already
 *   Chinese / non-prose (identifiers, JSON, paths are left untouched).
 */
export function translateToZh(text) {
  const s = String(text == null ? '' : text).trim()
  if (!s) return s
  if (/[\u4e00-\u9fff]/.test(s)) return s
  let out = s
  for (const [re, zh] of ZH_PHRASES) out = out.replace(re, zh)
  // Only attempt word glossary on prose (no code punctuation that could be an
  // identifier, path, or JSON payload).
  if (/[A-Za-z]/.test(out) && !/[{}"@/\\]/.test(out)) out = glossary(out)
  return out
}

export const MODES = {
  'read-only':          { en: 'read-only (cannot modify anything)', zh: '只读（无法修改任何内容）' },
  'workspace-write':    { en: 'workspace write access',             zh: '工作区写入权限' },
  'danger-full-access': { en: 'full system access',                 zh: '系统完全访问权限' },
}

/** Strip shell quoting from a token ("x", 'x', x). */
function bare(tok) {
  if (typeof tok !== 'string') return String(tok)
  const t = tok.trim()
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))))
    return t.slice(1, -1)
  return t
}

/** Split a shell command line into tokens without expanding variables. */
function tokens(cmd) {
  const out = []
  const re = /("[^"]*"|'[^']*'|\S+)/g
  let m
  while ((m = re.exec(cmd || '')) !== null) out.push(m[1])
  return out
}

/** Path-looking argument tokens. */
function pathTargets(list) {
  return list
    .map((t) => bare(t))
    .filter((t) => t && ((t.startsWith('.') && t.length > 1) || t.startsWith('/') || t.startsWith('~')
      || t.includes('/') || t.includes('\\') || /^[a-zA-Z]:\\/.test(t)))
}

/** Bare (non-flag, non key=value) argument tokens, as fallback targets. */
function argTargets(list) {
  return list.map((t) => bare(t)).filter((t) => t && !t.startsWith('-') && !/^[\w./:{}-]*=/.test(t))
}

/**
 * Rule table. Each entry: name, optional risk, test(list, ctx), describe(ctx).
 * ctx = { raw, list, args, path, from, to, device }.
 */
const RULES = [
  {
    name: 'rm delete',
    test: (l) => /^(rm|del|rd|rmdir|rmtree|remove-item)$/i.test(l[0] || ''),
    describe: (ctx) => {
      const viaTokens = [...pathTargets(ctx.list || []), ...argTargets((ctx.list || []).slice(1))]
      const viaArgs = [...(ctx.args?.paths || []), ...(ctx.args?.targets || []), ...(ctx.args?.path ? [ctx.args.path] : [])]
      const targets = [...new Set([...viaArgs, ...viaTokens])].filter(Boolean)
      const text = targets.length ? targets.join(', ') : 'the specified files/directories'
      const lower = ctx.raw.toLowerCase()
      const recursive = /(-[a-z]*r[a-z]*|-rf|--recursive)\b|recurse/i.test(lower)
      const wipingRoot = targets.some((t) => /^\/+$/.test(t) || /^\/\/\.?$/.test(t) || /^(\\|[a-zA-Z]:\\|\.)$/.test(t))
      const risk = wipingRoot && recursive ? 'danger' : (recursive ? 'caution' : 'caution')
      return {
        risk,
        en: `Permanently delete ${text}; deleted items cannot be recovered`,
        zh: `永久删除“${text}”，删除后无法恢复`,
      }
    },
  },
  {
    name: 'disk format', risk: 'danger',
    test: (l) => /^(mkfs|mkfs\.\w+|mkswap|format-disk|format-volume|format)$/i.test(l[0] || ''),
    describe: () => ({ en: 'Format a disk/filesystem — erases all existing data on it', zh: '格式化磁盘或文件系统，会清除其上的全部现存数据' }),
  },
  {
    name: 'disk partition', risk: 'danger',
    test: (l) => ['fdisk', 'parted', 'sfdisk', 'gdisk'].includes(l[0]) || /^(initialize-disk|clear-disk|new-partition|remove-partition)$/i.test(l[0] || ''),
    describe: () => ({ en: 'Modify the disk partition table — repartitioning can destroy existing partitions and data', zh: '修改磁盘分区表，重新分区可能破坏现有分区和数据' }),
  },
  {
    name: 'dd block write', risk: 'danger',
    test: (l) => l[0] === 'dd',
    describe: (ctx) => ({ en: `Write raw byte blocks with dd${ctx.device ? ` to ${ctx.device}` : ''} — can overwrite a disk or partition with no recovery`, zh: `使用 dd 执行块级写入${ctx.device ? `，目标为“${ctx.device}”` : ''}，可能直接覆盖磁盘或分区且无法恢复` }),
  },
  {
    name: 'shutdown / power', risk: 'danger',
    test: (l) => ['shutdown', 'reboot', 'poweroff', 'halt'].includes(l[0]) || (l[0] === 'systemctl' && ['poweroff', 'reboot', 'halt'].includes(l[1])) || /^(stop-computer|restart-computer)$/i.test(l[0] || ''),
    describe: () => ({ en: 'Shut down or restart the computer', zh: '关闭或重启计算机' }),
  },
  {
    name: 'service critical stop', risk: 'danger',
    test: (l) => (l[0] === 'systemctl' && ['stop', 'disable', 'mask'].includes(l[1])) || (l[0] === 'service' && l[1] === 'stop') || /^stop-service$/i.test(l[0] || ''),
    describe: (ctx) => {
      const name = (ctx.args?.service) || ctx.list?.find((t) => !['systemctl', 'stop', 'disable', 'mask', 'service'].includes(t) && !t.startsWith('--')) || 'a system service'
      return { en: `Stop or disable a system service (${name})`, zh: `停止或禁用系统服务“${name}”` }
    },
  },
  {
    name: 'chmod recursive', risk: 'danger',
    test: (l) => l[0] === 'chmod' && /-R/.test(l[1] ?? ''),
    describe: (ctx) => {
      const target = pathTargets(ctx.list || []).join(', ') || 'a directory tree'
      return { en: `Recursively change permissions of ${target} — recursive permission changes on system files can break the system`, zh: `递归修改“${target}”的权限，对系统文件递归改权限可能导致系统无法运行` }
    },
  },
  {
    name: 'chown recursive', risk: 'caution',
    test: (l) => l[0] === 'chown' && /-R/.test(l[1] ?? ''),
    describe: (ctx) => {
      const target = pathTargets(ctx.list || []).join(', ') || 'a directory tree'
      return { en: `Recursively change the owner of ${target}`, zh: `递归修改“${target}”的所有者` }
    },
  },
  {
    name: 'sudo', risk: 'caution',
    test: (l) => l[0] === 'sudo' || l[0] === 'doas',
    describe: (ctx) => ({ en: `Run a command with administrator/root privileges (${ctx.raw})`, zh: `以管理员/root 权限执行命令（${ctx.raw}）` }),
  },
  {
    name: 'pipe-to-shell', risk: 'danger',
    test: (_l, ctx) => /\|\s*(ba)?sh\b/.test(ctx.raw) || /\|\s*(pw)?powershell\b/i.test(ctx.raw),
    describe: () => ({ en: 'Download content over the network and pipe it straight into a shell — could run arbitrary remote code without inspection', zh: '把网络下载的内容直接通过管道交给 Shell 执行（未先检查），可能运行任意远程代码' }),
  },
  {
    name: 'database drop', risk: 'danger',
    test: (_l, ctx) => /\bD\s*R\s*O\s*P\s+(DATABASE|SCHEMA|TABLE)\b|\bTRUNCATE\s+(TABLE|SCHEMA)\b|\bDELETE\s+FROM\b/i.test(ctx.raw),
    describe: () => ({ en: 'Drop, truncate, or clear a database / table — permanent data loss', zh: '删除、清空或截断数据库或数据表内容，属于永久性数据丢失' }),
  },
  {
    name: 'git destructive', risk: 'caution',
    test: (_l, ctx) => /git\s+(push|reset)\s+--?(force|hard)|git\s+clean\s+(-f|--force)/i.test(ctx.raw),
    describe: () => ({ en: 'Force-push, hard-reset, or force-clean a git repository — rewrites history or discards working changes', zh: '对 Git 仓库执行强制推送 / 硬重置 / 强制清理，会改写历史或丢弃未提交的更改' }),
  },
  {
    name: 'kill process', risk: 'caution',
    test: (l) => (l[0] === 'kill' && l.includes('-9')) || l[0] === 'killall' || l[0] === 'taskkill' || /^stop-process$/i.test(l[0] || ''),
    describe: (ctx) => {
      const target = ctx.args?.pid || ctx.args?.name || ctx.list?.slice(1).join(' ') || 'a running process'
      return { en: `Force-terminate a running process (${target})`, zh: `强制终止正在运行的进程“${target}”` }
    },
  },
  {
    name: 'network download', risk: 'caution',
    test: (l) => ['wget', 'curl', 'aria2c'].includes(l[0]) || /^(iwr|invoke-webrequest|invoke-restmethod)$/i.test(l[0] || ''),
    describe: (ctx) => ({ en: `Download from the network (${ctx.raw})`, zh: `从网络下载数据或文件（${ctx.raw}）` }),
  },
  {
    name: 'invoke expression', risk: 'danger',
    test: (_l, ctx) => /\biex\b/i.test(ctx.list?.[0] || '') || /invoke-expression/.test(ctx.raw) || /(?:&|\|)\s*iex\b/i.test(ctx.raw),
    describe: () => ({ en: 'Dynamically build and execute a PowerShell expression (Invoke-Expression) — can run arbitrary code if fed unvetted input', zh: '动态构造并执行 PowerShell 表达式（Invoke-Expression），输入未经验证可能运行任意代码' }),
  },
]

/** Detect risk from a raw command string independent of structural rules. */
export function detectRisk(raw) {
  const lower = (raw || '').toLowerCase()
  const hard = [
    /rm\s+(-\w*r\w*\s+)*[a-z]*f?\s+\/(\s|\*|$)/,
    /rm\s+-rf\s+\/\s*\*/,
    /dd\s+.*\bof=\/dev\//,
    /mkfs(\.\w+)?\s+/,
    /\b(fdisk|parted)\s+/,
    /^\s*(shutdown|reboot|poweroff|halt)\b/,
    /systemctl\s+(stop|disable|mask)\b/,
    /(curl|wget)[^\r\n;|]*\|\s*(ba)?sh\b/,
    /\bd\s*r\s*o\s*p\s+database\b/,
    /\btruncate\s+table\b/,
    /\|\s*iex\b/,
    /invoke-expression\s*\(/,
  ]
  for (const re of hard) if (re.test(lower)) return 'danger'
  const soft = [
    /\b(sudo|doas)\b/,
    /rm\s+-rf\b/,
    /\brm\s+-\w*r\w*\b/,
    /\b(wget|curl)\b/,
    /\biwr\b|invoke-webrequest/,
    /git\s+(push|reset)\s+--?(force|hard)/,
    /git\s+clean\s+-f/,
    /chmod\s+-R/, /chown\s+-R/,
    /kill\s+-9\b/, /\bkillall\b/,
    /docker\s+(rmi|rm|image\s+rm)\b/,
    /npm\s+publish\b/, /pnpm\s+publish\b/,
    />\s*[\w./\\:*-]+/,
    /remove-item/,
  ]
  for (const re of soft) if (re.test(lower)) return 'caution'
  return 'safe'
}

// --- File-operation tools (fs write / edit / delete / rename) -------------- 
const FS_RULES = [
  { name: 'fs write', risk: 'caution', test: (t) => t === 'write', describe: (ctx) => ({ en: `Create or overwrite the file \u201C${ctx.path}\u201D`, zh: `创建或覆盖写入文件\u201C${ctx.path}\u201D` }) },
  { name: 'fs edit', risk: 'caution', test: (t) => t === 'edit', describe: (ctx) => ({ en: `Modify the file \u201C${ctx.path}\u201D`, zh: `修改文件\u201C${ctx.path}\u201D` }) },
  { name: 'fs delete', risk: 'caution', test: (t) => t === 'delete' || t === 'deleteFile', describe: (ctx) => ({ en: `Delete the file/path \u201C${ctx.path}\u201D`, zh: `删除文件或路径\u201C${ctx.path}\u201D` }) },
  { name: 'fs rename', risk: 'caution', test: (t) => t === 'rename' || t === 'move', describe: (ctx) => ({ en: `Move or rename \u201C${ctx.from || ''}\u201D to \u201C${ctx.to || ''}\u201D`, zh: `将\u201C${ctx.from || ''}\u201D移动或重命名为\u201C${ctx.to || ''}\u201D` }) },
]

// --- Friendly tool labels --------------------------------------------------
const TOOL_LABELS = {
  plugin_manager: { zh: '插件管理', en: 'Plugin manager' },
  bash: { zh: 'Shell 命令（bash）', en: 'Shell command (bash)' },
  pwsh: { zh: 'PowerShell 命令', en: 'PowerShell command' },
  powershell: { zh: 'PowerShell 命令', en: 'PowerShell command' },
  shell: { zh: 'Shell 命令', en: 'Shell command' },
  sh: { zh: 'Shell 命令', en: 'Shell command' },
  cmd: { zh: '命令行（cmd）', en: 'Command prompt (cmd)' },
  write: { zh: '写入文件', en: 'Write file' },
  edit: { zh: '修改文件', en: 'Edit file' },
  delete: { zh: '删除文件', en: 'Delete file' },
  deleteFile: { zh: '删除文件', en: 'Delete file' },
  rename: { zh: '移动/重命名', en: 'Move or rename' },
  move: { zh: '移动/重命名', en: 'Move or rename' },
  read: { zh: '读取文件', en: 'Read file' },
  glob: { zh: '查找文件', en: 'Find files' },
  grep: { zh: '搜索内容', en: 'Search contents' },
  web_fetch: { zh: '访问网页', en: 'Fetch web page' },
  web_search: { zh: '网络搜索', en: 'Web search' },
  subagent: { zh: '派生子任务', en: 'Delegate subagent' },
  workflow: { zh: '运行工作流', en: 'Run workflow' },
  schedule_create: { zh: '创建定时任务', en: 'Create schedule' },
  present: { zh: '交付文件', en: 'Deliver files' },
}

/** Human-readable label for a tool name. */
export function toolLabel(name) {
  return TOOL_LABELS[name] || { zh: name || '工具', en: name || 'tool' }
}

// --- plugin_manager action labels -----------------------------------------
const PLUGIN_ACTIONS = {
  install_bundle: { zh: '安装插件包', en: 'Install plugin bundle', risk: 'caution' },
  remove_bundle: { zh: '移除（卸载）插件包', en: 'Remove (uninstall) the plugin bundle', risk: 'caution' },
  set_bundle: { zh: '启用或停用插件包', en: 'Enable or disable a plugin bundle', risk: 'caution' },
  set_plugin: { zh: '启用或停用插件', en: 'Enable or disable a plugin', risk: 'caution' },
  list_plugins: { zh: '查看插件列表（只读）', en: 'List plugins (read-only)', risk: 'safe' },
  list_bundles: { zh: '查看插件包列表（只读）', en: 'List plugin bundles (read-only)', risk: 'safe' },
  list: { zh: '查看列表（只读）', en: 'List (read-only)', risk: 'safe' },
}

/** Turn an args object into short "key: value" pairs (zh/en neutral). */
function argPairs(args, locale) {
  if (!args || typeof args !== 'object') return ''
  const parts = []
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue
    let val = typeof v === 'string' ? v : JSON.stringify(v)
    if (typeof val === 'string' && val.length > 100) val = val.slice(0, 97) + '…'
    parts.push(`${k}=${val}`)
  }
  return parts.join(locale === 'en' ? '; ' : '，')
}

/** Describe a plugin_manager call from its arguments. */
function describePluginManager(ctx) {
  const a = ctx.args || {}
  const action = typeof a.action === 'string' ? a.action : ''
  const target = a.target ?? a.name ?? a.bundle ?? a.id ?? ''
  const spec = PLUGIN_ACTIONS[action]
  const zhAct = spec ? spec.zh : `执行插件管理操作「${action || '未知'}」`
  const enAct = spec ? spec.en : `Run plugin manager action "${action || 'unknown'}"`
  const targetText = typeof target === 'string' ? target : (target === '' ? '' : JSON.stringify(target))
  const zh = targetText ? `${zhAct}：${targetText}` : zhAct
  const en = targetText ? `${enAct}: ${targetText}` : enAct
  const extra = argPairs(Object.fromEntries(Object.entries(a).filter(([k]) => !['action', 'target', 'name', 'bundle', 'id'].includes(k))), 'zh')
  const zh2 = extra ? `${zh}（其他参数：${extra}）` : zh
  const en2 = extra ? `${en} (other args: ${argPairs(Object.fromEntries(Object.entries(a).filter(([k]) => !['action', 'target', 'name', 'bundle', 'id'].includes(k))), 'en')})` : en
  return { zh: zh2, en: en2, risk: spec ? spec.risk : 'caution' }
}

/** Describe an arbitrary tool call from its arguments. */
function describeGeneric(ctx) {
  const pairs = argPairs(ctx.args, 'zh')
  const pairsEn = argPairs(ctx.args, 'en')
  const label = toolLabel(ctx.toolName)
  const zh = pairs ? `调用工具「${label.zh}」执行：${pairs}` : `调用工具「${label.zh}」`
  const en = pairsEn ? `Call tool "${label.en}" with: ${pairsEn}` : `Call tool "${label.en}"`
  let risk = 'safe'
  const joined = JSON.stringify(ctx.args || {}).toLowerCase()
  if (/(remove|delete|uninstall|drop|write|edit|install|set_|overwrite|kill|stop)/.test(joined)) risk = 'caution'
  return { zh, en, risk }
}

/** Severity rank for merging risk levels. */
const RISK_RANK = { safe: 0, caution: 1, danger: 2 }
function maxRisk(a, b) {
  return (RISK_RANK[b] || 0) > (RISK_RANK[a] || 0) ? b : a
}

/**
 * Translate one approval request into a human-readable description + risk grade.
 * Routes by tool family: shell commands, file operations, plugin management, or
 * a generic argument-based description. The returned zh/en is the *action*
 * detail (what the tool will do), never the requester's raw reason.
 * @param {object=} input - { toolName, command, reason, args }
 * @returns {{en:string, zh:string, risk:'safe'|'caution'|'danger', labels:{en:string,zh:string}}}
 */
export function humanize(input = {}) {
  const { toolName, command, reason, args } = input
  const raw = (command || '').trim()
  const list = tokens(raw)
  const lowerTool = (toolName || '').toLowerCase()
  const ctx = {
    raw, list, args: args || {}, toolName,
    path: args?.file_path || args?.path || args?.target || '',
    from: args?.from || args?.old_path || '',
    to: args?.to || args?.new_path || '',
  }
  const idx = list.findIndex((t) => t.startsWith('of='))
  if (idx >= 0) ctx.device = bare(list[idx].slice(3)) || null

  let translation = null
  let risk = detectRisk(raw)

  const fsRule = FS_RULES.find((r) => r.test(lowerTool))
  if (fsRule) {
    translation = fsRule.describe(ctx)
    risk = risk === 'danger' ? risk : fsRule.risk
  } else if (['bash', 'pwsh', 'shell', 'powershell', 'sh', 'cmd'].includes(lowerTool) && raw) {
    const ruleDesc = RULES.find((r) => r.test(list, ctx))
    if (ruleDesc) {
      let built = null
      try { built = ruleDesc.describe(ctx) } catch { built = null }
      if (built) {
        translation = { en: built.en, zh: built.zh }
        const builtRisk = built.risk || ruleDesc.risk
        if (builtRisk) risk = risk === 'danger' ? risk : builtRisk
      }
    }
    if (!translation) {
      const kind = ['pwsh', 'powershell'].includes(lowerTool) ? 'PowerShell' : 'shell'
      translation = { en: `Execute a ${kind} command: ${raw}`, zh: `执行 ${kind} 命令：${raw}` }
    }
  } else if (lowerTool === 'plugin_manager') {
    const d = describePluginManager(ctx)
    translation = { en: d.en, zh: d.zh }
    risk = maxRisk(risk, d.risk)
  } else if (ctx.args && typeof ctx.args === 'object' && Object.keys(ctx.args).length > 0) {
    const d = describeGeneric(ctx)
    translation = { en: d.en, zh: d.zh }
    risk = maxRisk(risk, d.risk)
  } else {
    // No command and no args: fall back to the requester's reason, but mark it.
    const base = (reason || 'Approve this operation').trim()
    translation = { en: base, zh: base }
  }

  const labels = RISK[risk] || RISK.safe
  return { en: translation.en, zh: translation.zh, risk, labels }
}

/** Humanize a sandbox permission mode to a short phrase. */
export function modeText(mode) {
  return MODES[mode] || { en: mode || 'privileged', zh: mode || '受限权限' }
}
