import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolUseSummary, TurnUsage } from 'claude-code'

import type { AgentRow, Cache, Handoff, Task, TaskStatus } from '../types'

const PANE = 'savvy-agents'
const PLAN_TOOL = 'mcp__ccd_turn__update_plan'

const plan = atom({ plugin: 'savvy-progress', key: 'plan' } as const, [])
const agents = atom({ plugin: 'savvy-progress', key: 'agents' } as const, [])
const tick = atom({ plugin: 'savvy-progress', key: 'tick' } as const, 0)
const lastTickAt = atom({ plugin: 'savvy-progress', key: 'lastTickAt' } as const, 0)
const totalTokens = atom({ plugin: 'savvy-progress', key: 'totalTokens' } as const, 0)
const turnStartedAt = atom({ plugin: 'savvy-progress', key: 'turnStartedAt' } as const, 0)
const isBandHidden = atom({ plugin: 'savvy-progress', key: 'isBandHidden' } as const, false)
const cache = atom({ plugin: 'savvy-progress', key: 'cache' } as const, {
  lastAt: 0,
  hit: 0,
  tokens: 0,
  model: '',
  isWorking: false,
  warnedAt: 0,
})
const selected = atom({ plugin: 'savvy-progress', key: 'selected' } as const, null)
const handoff = atom({ plugin: 'savvy-progress', key: 'handoff' } as const, { status: 'idle' })

// Past this share of the context window, long-chat answers degrade: time to move to a fresh chat.
const HANDOFF_AT = 60
const HANDOFF_PROMPT = `Write a handoff so a fresh chat can continue this work without this conversation. Use the user's language. At most 900 words, Markdown, these sections in order:
## Goal — one or two sentences.
## Where it stands — what works now, what is verified and what is not.
## Done — the main steps, briefly.
## Decisions — each with its reason, so they are not reopened.
## Files — the paths created or changed, one line each on why.
## Open — what is unfinished, unknown or waiting on someone.
## Next action — the one concrete thing to do first.
## Watch out — traps, constraints and preferences the user stated.
Facts only, from this conversation; no greeting, no closing line.`

// US$ per million tokens: input, output. Cache reads bill at 0.1x input, writes at 1.25x.
const OPUS: [RegExp, number, number] = [/opus|fable/i, 5, 25]
const PRICES: [RegExp, number, number][] = [[/haiku/i, 1, 5], [/sonnet/i, 3, 15], OPUS]

const PURPLE = '#8b7cf6'
const GREEN = '#3fb27f'
const AMBER = '#d99a2b'
const RED = '#d9603b'
const LEVELS: Record<string, [string, string]> = {
  low: ['light', GREEN],
  medium: ['medium', '#4a8fe7'],
  high: ['careful', AMBER],
  xhigh: ['heavy', RED],
  max: ['heavy', RED],
}

const WARN_MS = 30_000

function costOf(usage: TurnUsage): number {
  const [, inp, out] = PRICES.find(([re]) => re.test(usage.model)) ?? OPUS
  const input =
    usage.input_tokens +
    usage.cache_read_input_tokens * 0.1 +
    usage.cache_creation_input_tokens * 1.25

  return (input * inp + usage.output_tokens * out) / 1_000_000
}

function contextOf(usage: TurnUsage): number {
  return usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
}

function tokensOf(usage: TurnUsage): number {
  return contextOf(usage) + usage.output_tokens
}

function shortModel(model?: string): string {
  if (!model) return '—'
  const [, family, major, minor] = /(fable|opus|sonnet|haiku)[-_ ]?(\d+)[-.](\d+)/i.exec(model) ?? []
  if (!family) return model
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}.${minor}`
}

function money(usd: number): string {
  return `≈$${usd.toFixed(2)}`
}

function kTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`
}

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = `${s % 60}`.padStart(2, '0')
  return h > 0 ? `${h}:${`${m}`.padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function count(tasks: Task[]) {
  const done = tasks.filter(t => t.status === 'completed').length
  const current = tasks.find(t => t.status === 'in_progress')

  return { done, total: tasks.length, current }
}

// The update_plan tool replaces the list with `items`, or moves it with advance / done / start.
function applyPlanCall(tasks: Task[], e: Record<string, unknown>): Task[] {
  if (Array.isArray(e.items)) {
    return (e.items as { content?: unknown; status?: unknown }[]).map(item => ({
      content: String(item.content ?? ''),
      status: (['pending', 'in_progress', 'completed'].includes(String(item.status))
        ? item.status
        : 'pending') as TaskStatus,
    }))
  }

  const status: TaskStatus[] = tasks.map(t => t.status)
  if (e.advance === true) {
    const at = status.indexOf('in_progress')
    if (at >= 0) status[at] = 'completed'
    const pending = status.findIndex((s, i) => i > at && s === 'pending')
    if (pending >= 0) status[pending] = 'in_progress'
  }
  if (Array.isArray(e.done)) {
    for (const n of e.done as number[]) if (n >= 1 && n <= status.length) status[n - 1] = 'completed'
  }
  if (typeof e.start === 'number' && e.start >= 1 && e.start <= status.length) {
    for (let i = 0; i < status.length; i += 1) if (status[i] === 'in_progress') status[i] = 'pending'
    status[e.start - 1] = 'in_progress'
  }

  return tasks.map((t, i) => ({ ...t, status: status[i] ?? t.status }))
}

function todosToTasks(todos: unknown): Task[] {
  if (!Array.isArray(todos)) return []

  return todos.map((t: { content?: unknown; activeForm?: unknown; status?: unknown }) => ({
    content: String((t.status === 'in_progress' ? t.activeForm : t.content) ?? t.content ?? ''),
    status: t.status as TaskStatus,
  }))
}

// The one argument that says what a tool call was about, for a one-line summary.
function gist(use: ToolUseSummary): string {
  const input = use.input
  for (const key of ['description', 'file_path', 'command', 'pattern', 'query', 'url', 'path', 'prompt']) {
    const value = input[key]
    if (typeof value === 'string' && value) return value.replace(/^\/Users\/[^/]+\//, '~/')
  }
  return ''
}

// The terminal's bar: solid blocks done, a thin rule to go.
function textBar(fraction: number, width: number): [string, string] {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width)
  return ['▰'.repeat(filled), '▱'.repeat(width - filled)]
}

function noise(col: number, row: number, seed: number): number {
  const x = Math.sin(col * 12.9898 + row * 78.233 + seed * 3.7) * 43758.5453
  return x - Math.floor(x)
}

// The remote surfaces' bar: a field of pixels, dense where the work is done, with the count as a pill on the edge.
// Live, the lit pixels twinkle, the ones past the edge flicker on as if being worked, and a sheen sweeps the done part.
// The markup holds its own animation, so it stays the same string across redraws and the frame never restarts.
function svgBar(fraction: number, label: string, isLive: boolean): { source: string; width: number; height: number } {
  const cols = 72
  const rows = 4
  const cell = 4
  const width = cols * cell
  const height = 22
  const top = (height - rows * cell) / 2
  const edge = Math.round(Math.max(0, Math.min(1, fraction)) * cols)
  // The pill ends at the edge, so the flicker just past it stays visible; with no room before the edge, it starts the bar.
  const pillWidth = label.length * 7 + 20
  const pillX = Math.max(0, edge * cell - pillWidth)
  const frontier = label ? Math.max(edge, Math.ceil((pillX + pillWidth + 2) / cell)) : edge
  let pixels = ''
  for (let c = 0; c < cols; c += 1) {
    for (let r = 0; r < rows; r += 1) {
      const n = noise(c, r, 0)
      const x = c * cell
      const y = top + r * cell
      const size = cell - 1
      if (c < edge && n > 0.18) {
        const opacity = 0.45 + n * 0.55
        const twinkle = isLive
          ? `<animate attributeName="opacity" values="${opacity.toFixed(2)};${(opacity * 0.3).toFixed(2)};${opacity.toFixed(2)}" dur="${(1.1 + n * 1.8).toFixed(2)}s" begin="-${(n * 3).toFixed(2)}s" repeatCount="indefinite"/>`
          : ''
        pixels += `<rect x="${x}" y="${y}" width="${size}" height="${size}" fill="${PURPLE}" opacity="${opacity.toFixed(2)}">${twinkle}</rect>`
      } else if (isLive && c >= frontier && c < frontier + 6 && n > 0.35) {
        const dur = (0.7 + n * 1.2).toFixed(2)
        pixels += `<rect x="${x}" y="${y}" width="${size}" height="${size}" fill="${PURPLE}" opacity="0"><animate attributeName="opacity" values="0;${(0.9 - (c - frontier) * 0.12).toFixed(2)};0" dur="${dur}s" begin="-${(n * 2).toFixed(2)}s" repeatCount="indefinite"/></rect>`
      } else if (c >= edge && n > 0.9) {
        pixels += `<rect x="${x}" y="${y}" width="${size}" height="${size}" fill="#9a9a9a" opacity="0.28"/>`
      }
    }
  }
  const litWidth = edge * cell
  const sheen =
    isLive && litWidth > 0
      ? `<defs><linearGradient id="sheen"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient><clipPath id="lit"><rect x="0" y="${top}" width="${litWidth}" height="${rows * cell}"/></clipPath></defs>` +
        `<g clip-path="url(#lit)"><rect x="-48" y="${top}" width="48" height="${rows * cell}" fill="url(#sheen)"><animate attributeName="x" values="-48;${litWidth}" dur="${Math.max(1.2, litWidth / 120).toFixed(2)}s" repeatCount="indefinite"/></rect></g>`
      : ''
  pixels += sheen
  const pill = label
    ? `<rect x="${pillX}" y="0" width="${pillWidth}" height="${height}" rx="${height / 2}" fill="${PURPLE}"/>` +
      `<text x="${pillX + pillWidth / 2}" y="${height / 2 + 4}" text-anchor="middle" font-family="-apple-system,system-ui,sans-serif" font-size="12" font-weight="600" fill="#fff">${label}</text>`
    : ''
  const track = `<rect x="0" y="${top - 3}" width="${width}" height="${rows * cell + 6}" rx="${(rows * cell + 6) / 2}" fill="#9a9a9a" opacity="0.10"/>`

  return {
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${track}${pixels}${pill}</svg>`,
    width,
    height,
  }
}

type Tip = { short: string; long: string; color: string }

// What to do about the prompt cache now, from the last main response: a short form for the band, a long one for the pane.
function cacheTip(c: Cache, remaining: number, ttl: number): Tip | null {
  if (c.lastAt === 0) return null
  const [, inp] = PRICES.find(([re]) => re.test(c.model)) ?? OPUS
  const k = kTokens(c.tokens)
  const rewrite = money((c.tokens * inp * 1.25) / 1_000_000)
  const reread = money((c.tokens * inp * 0.1) / 1_000_000)
  const isLarge = c.tokens >= 100_000

  if (c.isWorking) {
    if (c.hit < 0.5 && c.tokens > 20_000) {
      return {
        short: 'reuso baixo',
        long: `Só ${Math.round(c.hit * 100)}% do contexto veio do cache. Trocar de modelo, mudar CLAUDE.md, MCPs ou o /compact reescrevem o prefixo: evite isso no meio de uma tarefa.`,
        color: AMBER,
      }
    }
    return null
  }

  if (remaining <= 0) {
    return {
      short: isLarge ? `frio · próxima ≈${rewrite}` : 'frio',
      long: isLarge
        ? `Cache frio com ${k} de contexto: a próxima mensagem reescreve tudo (${rewrite}, contra ${reread} quente). Mudou de assunto? /clear sai mais barato. Vai continuar? /compact antes.`
        : `Cache frio, mas o contexto é pequeno (${k}): a próxima mensagem custa pouco pra reaquecer.`,
      color: isLarge ? RED : '#888888',
    }
  }

  if (remaining <= Math.min(ttl / 5, 10 * 60_000)) {
    return {
      short: `manda algo em ${clock(remaining)}`,
      long: `Faltam ${clock(remaining)} pro cache esfriar. Se vai continuar, mande a próxima mensagem antes: ler ${k} do cache custa ${reread}, reescrever custa ${rewrite}.`,
      color: remaining <= WARN_MS ? RED : AMBER,
    }
  }

  if (c.hit < 0.5 && c.tokens > 20_000) {
    return {
      short: 'reuso baixo',
      long: `Só ${Math.round(c.hit * 100)}% da última resposta veio do cache: algo mudou no começo do contexto (modelo, CLAUDE.md, MCPs, /compact).`,
      color: AMBER,
    }
  }

  return {
    short: `${Math.round(c.hit * 100)}% reuso`,
    long: `Cache quente: ${Math.round(c.hit * 100)}% da última resposta veio dele. Pode pensar com calma, ainda tem ${clock(remaining)}.`,
    color: GREEN,
  }
}

function cacheColor(remaining: number, ttl: number): string {
  if (remaining <= WARN_MS) return RED
  return remaining < ttl / 3 ? AMBER : GREEN
}

// Writes the handoff over the session's own transcript, served from its prompt cache.
async function writeHandoff($: EngineInterface) {
  if ((await read($, handoff)).status === 'writing') return
  await update($, handoff, (): Handoff => ({ status: 'writing' }))
  void $.ui.open({ id: PANE, title: 'Agents' })
  const reply = await $.model.fork({ prompt: HANDOFF_PROMPT })
  const now = await $.clock.now()
  await update($, handoff, (): Handoff =>
    reply.isAnswered ? { status: 'ready', text: reply.text, at: now } : { status: 'failed', reason: reply.reason },
  )
}

async function compactWithHandoff($: EngineInterface, text: string) {
  try {
    const done = await $.session.compact({
      instructions: `Replace the conversation with this handoff, kept verbatim, as the summary:\n\n${text}`,
    })
    const note = 'skip' in done && done.skip ? `Não compactou: ${String(done.skip)}` : 'Conversa compactada com o handoff.'
    await update($, handoff, v => (v.status === 'ready' ? { ...v, note } : v))
  } catch {
    await update($, handoff, v => (v.status === 'ready' ? { ...v, note: 'Espere o turno acabar e tente de novo.' } : v))
  }
}

function setAgent($: EngineInterface,id: string, fn: (row: AgentRow) => AgentRow) {
  return update($, agents, list => list.map(row => (row.id === id ? fn(row) : row)))
}

export const register: Register = (on, options) => {
  const ttl = Number(options.cacheTtlMinutes ?? '60') * 60_000

  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    await $.command.register({
      name: 'savvy',
      description: 'Open the Savvy Progress pane: every agent, live',
    })
    await $.command.register({
      name: 'handoff',
      description: 'Write a handoff of this chat, to continue it in a fresh one',
    })
    void $.ui.open({ id: PANE, title: 'Agents' })

    // Redraws once a second while an agent runs or the cache counts down, and warns before it goes cold.
    $.clock.every(1000, async () => {
      const now = await $.clock.now()
      const list = await read($, agents)
      const c = await read($, cache)
      const remaining = c.lastAt > 0 ? ttl - (now - c.lastAt) : -1
      const isCounting = !c.isWorking && remaining > -1000
      if (!list.some(a => a.status === 'running') && !isCounting) return

      if (isCounting && remaining > 0 && remaining <= WARN_MS && c.warnedAt !== c.lastAt) {
        await update($, cache, v => ({ ...v, warnedAt: v.lastAt }))
        $.ui.toast(cacheTip(c, remaining, ttl)?.long ?? `Prompt cache esfria em ${Math.round(remaining / 1000)}s`)
      }
      if (now - (await read($, lastTickAt)) < 900) return
      await update($, lastTickAt, () => now)
      await update($, tick, n => n + 1)
    })

    return ran
  })

  on('command.run', { command: 'savvy' }, async $ => {
    await update($, isBandHidden, () => false)
    await $.ui.open({ id: PANE, title: 'Agents' })

    return { text: 'Savvy Progress: pane opened.' }
  })

  on('command.run', { command: 'handoff' }, async $ => {
    void writeHandoff($)

    return { text: 'Savvy Progress: writing the handoff in the Agents pane.' }
  })

  on('prompt.submit', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, turnStartedAt, () => now)
    await update($, cache, c => ({ ...c, isWorking: true }))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if ('deny' in started && started.deny) return started
    const id = started.agentId
    if (!id) return started
    const now = await $.clock.now()
    const row: AgentRow = {
      id,
      description: e.description || e.subagentType,
      type: e.subagentType,
      model: started.model,
      status: 'running',
      tokens: 0,
      costUsd: 0,
      contextTokens: 0,
      startedAt: now,
      tasks: [],
      toolCount: 0,
    }
    await update($, agents, list => [...list.filter(a => a.id !== id), row].slice(-40))

    return started
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const res = yield* next(e)
    const usage = res.usage
    if (!usage) return res

    await update($, totalTokens, n => n + tokensOf(usage))
    if (e.agentId) {
      await setAgent($, e.agentId, row => ({
        ...row,
        model: usage.model || e.model,
        effort: e.effort === undefined ? row.effort : String(e.effort),
        tokens: row.tokens + tokensOf(usage),
        costUsd: row.costUsd + costOf(usage),
        contextTokens: contextOf(usage),
      }))
    } else {
      const now = await $.clock.now()
      const input = contextOf(usage)
      await update($, cache, c => ({
        ...c,
        lastAt: now,
        hit: input > 0 ? usage.cache_read_input_tokens / input : 0,
        tokens: input,
        model: usage.model || e.model,
      }))
    }

    return res
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      const now = await $.clock.now()
      await setAgent($, e.agentId, row => ({
        ...row,
        status: e.isAborted ? 'killed' : e.reason === 'error' ? 'failed' : 'completed',
        endedAt: now,
      }))
    } else {
      await update($, cache, c => ({ ...c, isWorking: false }))
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const isTodo = e.tool === 'TodoWrite'
    const isPlan = e.tool === PLAN_TOOL
    const agentId = e.agentId
    if (agentId) {
      await setAgent($, agentId, row => ({ ...row, lastTool: e.tool, toolCount: (row.toolCount ?? 0) + 1 }))
    }

    const ran = await next(e)
    // Subagents here have no TodoWrite and are refused update_plan: a refused call changes no list.
    if ((!isTodo && !isPlan) || ran.deny !== undefined || ran.isError === true) return ran

    if (agentId) {
      await setAgent($, agentId, row => ({
        ...row,
        tasks: isTodo ? todosToTasks(input.todos) : applyPlanCall(row.tasks, input),
      }))
    } else if (isTodo) {
      await update($, plan, () => todosToTasks(input.todos))
    } else {
      await update($, plan, tasks => applyPlanCall(tasks, input))
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const tasks = await read($, plan)
    const list = await read($, agents)
    await read($, tick)
    const c = await read($, cache)
    const now = await $.clock.now()
    const running = list.filter(a => a.status === 'running').length
    const { done, total, current } = count(tasks)
    const isWorkIdle = (total === 0 || done === total) && running === 0
    const remaining = c.lastAt > 0 ? ttl - (now - c.lastAt) : -1
    const tip = cacheTip(c, remaining, ttl)
    // Idle, the band stays for a warm cache, or for a cold one big enough that the next message costs real money.
    const isCacheShown = !c.isWorking && tip !== null && (remaining > 0 || c.tokens >= 100_000)
    const contextPercent = (await $.session.usage()).context.percent ?? 0
    const needsHandoff = contextPercent >= HANDOFF_AT || (!c.isWorking && remaining <= 0 && c.tokens >= 100_000)

    if (e.props.hasSurvey || (isWorkIdle && !isCacheShown && !needsHandoff) || (await read($, isBandHidden))) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const handoffChip = needsHandoff ? (
      <Button key="savvy-handoff" plain onPress={() => void writeHandoff($)}>
        <Text color={AMBER}>{`⇄ ctx ${contextPercent}% · handoff`}</Text>
      </Button>
    ) : null
    const cacheChip = isCacheShown && tip ? (
      <Text wrap="truncate">
        <Text color={remaining > 0 ? cacheColor(remaining, ttl) : RED}>
          {remaining > 0 ? `◷ ${clock(remaining)} cache` : '◷ cache'}
        </Text>
        <Text color={tip.color === GREEN ? undefined : tip.color} dimColor={tip.color === GREEN}>{` · ${tip.short}`}</Text>
      </Text>
    ) : null
    const controls = (
      <Box flexDirection="row" gap={1}>
        <Button key="savvy-open" plain dimColor label="Agents" onPress={() => void $.ui.open({ id: PANE, title: 'Agents' })} />
        <Button key="savvy-hide" plain dimColor label="✕" onPress={() => update($, isBandHidden, () => true)} />
      </Box>
    )

    if (isWorkIdle) {
      return (
        <Box flexDirection="row" justifyContent="space-between" paddingX={1}>
          <Box flexDirection="row" gap={2}>
            {cacheChip}
            {handoffChip}
          </Box>
          {controls}
        </Box>
      )
    }

    const fraction = total > 0 ? done / total : 0
    const label = total > 0 ? `Tasks ${done}/${total}` : ''
    const title = current?.content ?? `${running} agent${running === 1 ? '' : 's'} working`
    const elements = $.ui.resolve(e)
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : undefined
    let bar
    if (Svg) {
      const svg = svgBar(fraction, label, c.isWorking || running > 0)
      bar = <Svg source={svg.source} alt={label || 'progress'} width={svg.width} height={svg.height} isInteractive />
    } else {
      const [lit, unlit] = textBar(fraction, 20)
      bar = (
        <Text>
          <Text color={PURPLE}>{lit}</Text>
          <Text dimColor>{unlit}</Text>
          {label ? <Text color={PURPLE} bold>{`  ${label}`}</Text> : null}
        </Text>
      )
    }

    return (
      <Box flexDirection="row" alignItems="center" gap={2} paddingX={1}>
        <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0}>
          <Text wrap="truncate">
            <Text color={PURPLE}>{'● '}</Text>
            <Text bold>{clip(title, 40)}</Text>
          </Text>
        </Box>
        <Box flexShrink={0}>{bar}</Box>
        {total > 0 && <Text tabular wrap="truncate">{`${Math.round(fraction * 100)}%`}</Text>}
        {running > 0 && <Text color={PURPLE} wrap="truncate">{`◆ ×${running}`}</Text>}
        {cacheChip}
        {handoffChip}
        {controls}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, agents)
    await read($, tick)
    const tokens = await read($, totalTokens)
    const since = await read($, turnStartedAt)
    const c = await read($, cache)
    const openId = await read($, selected)
    const usage = await $.session.usage()
    const now = await $.clock.now()
    const window = usage.context.window || 200_000
    const width = Math.max(10, (e.props.bodyColumns ?? 40) - 4)

    const meta = (a: AgentRow) => {
      const [level, color] = LEVELS[a.effort ?? ''] ?? ['', '#888888']
      return (
        <Text>
          {level ? <Text color={color}>{`${level} `}</Text> : null}
          <Text dimColor>{`${shortModel(a.model)}${a.effort ? ` · ${a.effort}` : ''} · ${a.type}`}</Text>
        </Text>
      )
    }
    const figures = (a: AgentRow) =>
      `ctx ${Math.round((a.contextTokens / window) * 100)}% · ${kTokens(a.tokens)} ${money(a.costUsd)} ${clock((a.endedAt ?? now) - a.startedAt)}`

    const open = list.find(a => a.id === openId)
    if (open) {
      const messages = await $.session.messages({ agentId: open.id })
      const rows = 'deny' in messages ? [] : messages
      const lines: { key: string; mark: string; color?: string; text: string; isDim?: boolean }[] = []
      for (const [i, m] of rows.entries()) {
        if (m.role !== 'assistant') continue
        if (m.text) lines.push({ key: `t${i}`, mark: '│', text: clip(m.text, width * 2), isDim: true })
        for (const use of m.toolUses) {
          const state = use.isError ? ['✕', RED] : use.text === undefined ? ['◌', AMBER] : ['✓', GREEN]
          lines.push({ key: use.tool_use_id, mark: state[0] ?? '', color: state[1], text: `${use.tool}  ${clip(gist(use), width - use.tool.length - 6)}` })
        }
      }
      const room = Math.max(4, (e.props.scroll?.bodyRows ?? 24) - 8)

      return (
        <Box flexDirection="column" gap={1}>
          <Button key="savvy-back" plain dimColor label="← Agents" onPress={() => update($, selected, () => null)} />
          <Box flexDirection="column">
            <Text bold>{open.description}</Text>
            {meta(open)}
            <Text dimColor tabular>{figures(open)}</Text>
          </Box>
          <Box flexDirection="column">
            {lines.length === 0 && <Text dimColor>Nada ainda.</Text>}
            {lines.slice(-room).map(l => (
              <Text key={l.key}>
                <Text color={l.color} dimColor={l.isDim}>{`${l.mark} `}</Text>
                <Text dimColor={l.isDim}>{l.text}</Text>
              </Text>
            ))}
          </Box>
        </Box>
      )
    }

    const running = list.filter(a => a.status === 'running')
    const finished = list.filter(a => a.status !== 'running').reverse()
    const planned = (await read($, plan)).filter(t => t.status === 'pending')
    const remaining = c.lastAt > 0 ? ttl - (now - c.lastAt) : -1
    const tip = cacheTip(c, remaining, ttl)

    const stat =(label: string, value: string, color?: string) => (
      <Box flexDirection="column" flexGrow={1} borderStyle="round" borderDimColor paddingX={1}>
        <Text dimColor size="caption">{label}</Text>
        <Text bold color={color}>{value}</Text>
      </Box>
    )

    const ho = await read($, handoff)
    const contextPercent = usage.context.percent ?? 0
    const { Markdown } = $.ui.resolve(e)
    const handoffSection =
      ho.status === 'ready' ? (
        <Box flexDirection="column" gap={1} borderStyle="round" borderDimColor paddingX={1}>
          <Text bold>⇄ Handoff pronto</Text>
          <Markdown text={ho.text} />
          <Box flexDirection="row" gap={2}>
            <Button key="savvy-handoff-compact" variant="primary" label="Começar limpo com ele" onPress={() => compactWithHandoff($, ho.text)} />
            <Button
              key="savvy-handoff-copy"
              plain
              dimColor
              label="Copiar"
              onPress={async press => {
                const copied = await $.ui.copy({ text: ho.text, surface: press.surface })
                const note = copied.isCopied ? 'Copiado.' : 'Não deu pra copiar aqui: selecione o texto acima.'
                await update($, handoff, v => (v.status === 'ready' ? { ...v, note } : v))
              }}
            />
            <Button key="savvy-handoff-drop" plain dimColor label="Descartar" onPress={() => update($, handoff, (): Handoff => ({ status: 'idle' }))} />
          </Box>
          {ho.note ? <Text dimColor>{ho.note}</Text> : null}
        </Box>
      ) : ho.status === 'writing' ? (
        <Text color={AMBER}>⇄ Escrevendo o handoff…</Text>
      ) : contextPercent >= HANDOFF_AT || ho.status === 'failed' ? (
        <Box flexDirection="column">
          <Text color={AMBER}>
            {ho.status === 'failed'
              ? `⇄ O handoff falhou (${ho.reason}).`
              : `⇄ Contexto em ${contextPercent}%: respostas pioram em conversa longa. Hora de passar pra uma conversa limpa.`}
          </Text>
          <Button key="savvy-handoff-write" plain label="Escrever handoff" onPress={() => void writeHandoff($)} />
        </Box>
      ) : null

    const card = (a: AgentRow) => {
      const [, color] = LEVELS[a.effort ?? ''] ?? ['', '#888888']
      const { done, total, current } = count(a.tasks)
      const isRunning = a.status === 'running'
      const fraction = total > 0 ? done / total : isRunning ? 0.5 : 1
      const filled = Math.round(fraction * width)
      const tools = a.toolCount ?? 0
      const step = total > 0 ? `${done}/${total}` : `${tools} tool${tools === 1 ? '' : 's'}`
      const doing = current?.content ?? (isRunning ? a.lastTool : undefined)
      const mark = a.status === 'completed' ? '✓' : isRunning ? '●' : '✕'
      const markColor = a.status === 'completed' || isRunning ? GREEN : RED

      return (
        <Box key={a.id} flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Button key={`savvy-open-${a.id}`} plain onPress={() => update($, selected, () => a.id)}>
              <Text bold>{a.description}</Text>
              <Text dimColor>{' ›'}</Text>
            </Button>
            <Text color={markColor}>{mark}</Text>
          </Box>
          {meta(a)}
          <Box flexDirection="row" justifyContent="space-between">
            <Text>{doing ? `${step} · ${doing}` : step}</Text>
            <Text dimColor tabular>{figures(a)}</Text>
          </Box>
          <Text>
            <Text color={color}>{'━'.repeat(filled)}</Text>
            <Text dimColor>{'━'.repeat(Math.max(0, width - filled))}</Text>
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          {stat('Cost', money(usage.cost?.usd ?? 0))}
          {stat('Tokens', kTokens(tokens))}
          {stat('Time', since ? clock(now - since) : '—')}
          {stat(
            'Cache',
            c.isWorking ? `${Math.round(c.hit * 100)}%` : remaining > 0 ? clock(remaining) : 'frio',
            c.isWorking ? undefined : remaining > 0 ? cacheColor(remaining, ttl) : RED,
          )}
        </Box>
        {tip && (
          <Text>
            <Text color={tip.color}>{'💡 '}</Text>
            <Text dimColor={tip.color === GREEN}>{tip.long}</Text>
          </Text>
        )}
        {handoffSection}
        {list.length === 0 && planned.length === 0 && (
          <Text dimColor>No agents yet. They show up here as soon as one starts.</Text>
        )}
        {running.length > 0 && <Text dimColor>{`Running · ${running.length}`}</Text>}
        {running.map(card)}
        {finished.length > 0 && <Text dimColor>{`Finished · ${finished.length}`}</Text>}
        {finished.slice(0, 12).map(card)}
        {planned.length > 0 && <Text dimColor>{`Planned · ${planned.length}`}</Text>}
        {planned.map((t, i) => (
          <Text key={`planned-${i}`} dimColor>{`◷ ${t.content}`}</Text>
        ))}
      </Box>
    )
  })
}
