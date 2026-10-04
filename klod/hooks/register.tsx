import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const PANE = 'context-view'
const TITLE = 'Context'
const breakdown = atom({ plugin: 'klod', key: 'breakdown' } as const, null)

// 'summary' estimates locally (no API calls), so it is cheap enough to run after every tool call.
const refresh = async ($: EngineInterface) => {
  const { context, cost, rateLimits } = await $.session.usage({ breakdown: 'summary' })
  const fresh = context.breakdown
  if (fresh) await update($, breakdown, () => fresh)
  if (cost) await update($, usd, () => cost.usd)
  await update($, limits, () => rateLimits)
}

// The plan's usage windows as the last response reported them; empty off a subscription.
const limits = atom({ plugin: 'klod', key: 'limits' } as const, [])
const LIMIT_NAMES: Record<string, string> = { five_hour: '5h limit', seven_day: '7d limit', spend_limit: 'Spend limit' }

// The session's subagents, and the tool each one is in the middle of.
const agents = atom({ plugin: 'klod', key: 'agents' } as const, [])
const agentTools = atom({ plugin: 'klod', key: 'agentTools' } as const, {})

const syncAgents = async ($: EngineInterface) => {
  const list = await $.agent.list()
  // Written only on a change: the list is asked every second.
  if (JSON.stringify(list) !== JSON.stringify(await read($, agents))) await update($, agents, () => list)
}

const until = (ms: number) => {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const [d, h, m] = [Math.floor(minutes / 1440), Math.floor(minutes / 60) % 24, minutes % 60]

  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
}

// What the model's requests added up to since the mod loaded, subagents included, in three plain kinds:
// input read for the first time (uncached, or being written to the cache), input reused from the cache
// at a reduced rate, and what the model wrote.
const tokens = atom({ plugin: 'klod', key: 'tokens' } as const, { fresh: 0, reused: 0, written: 0 })
// The engine's own total for the session at API prices: the one figure that weighs the three kinds.
const usd = atom({ plugin: 'klod', key: 'usd' } as const, null)

// Paul Tol's Bright set, colorblind-safe; the largest category takes the first color.
const PALETTE = ['#4477AA', '#EE6677', '#228833', '#CCBB44', '#66CCEE', '#AA3377', '#BBBBBB']

// When the last main-thread request was sent: each request reads the prompt cache, which restarts its lifetime.
const cachedAt = atom({ plugin: 'klod', key: 'cachedAt' } as const, null)
// The API does not tell a mod the cache's lifetime: 1h is this plan's, 5m applies on API keys and in usage overage.
const CACHE_TTL_MS = 60 * 60_000

// Keeping an idle session cheap, shortly before the cache lapses. The first near-miss after a real request
// sends a tiny tool-less request over the same transcript (billed a cache read of the whole context); the
// second compacts instead, so what is re-cached on return is small. After that the cache is left to lapse.
const REFRESH_BEFORE_MS = 5 * 60_000
const nearMisses = atom({ plugin: 'klod', key: 'refreshes' } as const, 0)
const isKeepWarm = atom({ plugin: 'klod', key: 'isKeepWarm' } as const, true)
let isRefreshing = false

const keepWarm = async ($: EngineInterface) => {
  if (isRefreshing || !(await read($, isKeepWarm))) return
  const at = await read($, cachedAt)
  const misses = await read($, nearMisses)
  if (at === null || misses >= 2) return
  const sentAt = await $.clock.now()
  const left = CACHE_TTL_MS - (sentAt - at)
  if (left > REFRESH_BEFORE_MS || left <= 0) return
  isRefreshing = true
  try {
    // Counted before it is answered, so a failing attempt is not retried every second.
    await update($, nearMisses, n => n + 1)
    if (misses === 0) {
      const reply = await $.model.fork({ prompt: 'Reply with the single word: ok' })
      if ('usage' in reply && reply.usage.cache_read_input_tokens > 0) await update($, cachedAt, () => sentAt)
    } else {
      await $.session.compact()
      await update($, cachedAt, () => null)
      void refresh($)
    }
  } catch {
    // A compaction is refused while a turn runs: that turn's own requests keep the cache warm.
  } finally {
    isRefreshing = false
  }
}

const toggleKeepWarm = async ($: EngineInterface) => {
  const isOn = !(await read($, isKeepWarm))
  await update($, isKeepWarm, () => isOn)
  await $.store.set('isKeepWarm', isOn)
}

// The new-topic warning: before a prompt enters a large context, a small model judges whether it carries
// on from the person's last few prompts, and when it does not the person is asked whether to clear first.
const WARN_FROM_TOKENS = 50_000
const SEND = 'Send anyway'
const CLEAR = 'Clear, then send'
const CANCEL = 'Cancel'
const recentPrompts = atom({ plugin: 'klod', key: 'recentPrompts' } as const, [])
const isTopicCheck = atom({ plugin: 'klod', key: 'isTopicCheck' } as const, true)

const isNewTopic = async ($: EngineInterface, recent: readonly string[], text: string) => {
  const reply = await $.model.complete({
    model: 'haiku',
    maxTokens: 5,
    timeoutMs: 6000,
    system:
      'You judge whether a new message continues the task a user has been working on with a coding assistant. ' +
      'Answer with one word: SAME or NEW. Answer NEW only when the message clearly starts an unrelated task. ' +
      'Short replies, follow-ups, corrections and questions about the work so far are SAME. When unsure, SAME.',
    prompt: `Earlier messages, oldest first:\n${recent.map(p => `- ${p}`).join('\n')}\n\nNew message:\n${text.slice(0, 600)}`,
  })

  // No answer (an error, the timeout) never holds a prompt back.
  return reply.isAnswered && reply.text.trim().toUpperCase().startsWith('NEW')
}

const toggleTopicCheck = async ($: EngineInterface) => {
  const isOn = !(await read($, isTopicCheck))
  await update($, isTopicCheck, () => isOn)
  await $.store.set('isTopicCheck', isOn)
}

const fmt = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'context-view',
      description: 'Show the live context window in a pane',
    })
    if ((await $.store.get('isKeepWarm')) === false) await update($, isKeepWarm, () => false)
    if ((await $.store.get('isTopicCheck')) === false) await update($, isTopicCheck, () => false)
    $.clock.every(1000, () => {
      $.ui.invalidate('ui.render')
      void keepWarm($)
      void syncAgents($)
    })
    void $.ui.open({ id: PANE, title: TITLE })
    void refresh($)

    return next(e)
  })

  on('command.run', { command: 'context-view' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    await refresh($)

    return { text: 'Context pane opened.' }
  })

  // Live while Claude works: every model request of the main thread, as it leaves and as it is answered.
  on('turn.step', async function* ($, e, next) {
    // The cache timer follows the main thread alone: not a subagent's request, and not the keep-warm
    // requests themselves, which must not earn another round.
    const isMain = e.agentId === undefined && !isRefreshing
    if (isMain) {
      const sentAt = await $.clock.now()
      await update($, cachedAt, () => sentAt)
      await update($, nearMisses, () => 0)
      void refresh($)
    }
    const answered = yield* next(e)
    const used = answered.usage
    if (used) {
      await update($, tokens, t => ({
        fresh: t.fresh + used.input_tokens + used.cache_creation_input_tokens,
        reused: t.reused + used.cache_read_input_tokens,
        written: t.written + used.output_tokens,
      }))
    }
    if (isMain) void refresh($)

    return answered
  })

  on('prompt.submit', async ($, e, next) => {
    const text = e.text.trim()
    // The person's own typed prompts alone; one with attachments could not be sent again after a clear.
    if (e.origin.kind !== 'composer' || text.startsWith('/') || e.attachments !== undefined) return next(e)
    const recent = await read($, recentPrompts)
    const remember = () => update($, recentPrompts, list => [...list, text.slice(0, 300)].slice(-6))
    const size = (await read($, breakdown))?.totalTokens ?? 0
    const isChecked = (await read($, isTopicCheck)) && e.turnId === undefined && recent.length > 0
    if (!isChecked || size < WARN_FROM_TOKENS || !(await isNewTopic($, recent, text))) {
      await remember()

      return next(e)
    }

    // Dismissed (Esc) is Cancel.
    const answer = await $.ui
      .ask(`This looks like a new topic, and ${fmt(size)} tokens of context would be sent with it. Clear first?`, {
        header: 'New topic',
        options: [SEND, CLEAR, CANCEL],
      })
      .catch(() => CANCEL)
    if (answer === SEND) {
      await remember()

      return next(e)
    }
    // Either way the prompt is offered back in the box (Tab takes it), so a failed clear loses nothing.
    void $.prompt.suggest({ text: e.text })
    if (answer !== CLEAR) return { drop: 'Not sent. Press Tab to get the prompt back.' }
    await update($, recentPrompts, () => [text.slice(0, 300)])
    // Queued behind this hook: the clear, then the prompt again as the person's own words.
    void $.command
      .run({ command: 'clear' })
      .then(() => $.prompt.submit({ text: e.text, asUser: true }))
      .catch(() => $.ui.toast('Could not clear. Press Tab to get the prompt back.'))

    return { drop: 'Clearing the conversation, then sending.' }
  })

  // A cleared or ended session leaves no topic to compare with.
  on('session.end', async ($, e, next) => {
    await update($, recentPrompts, () => [])

    return next(e)
  })

  // Which tool a subagent is in the middle of.
  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    if (id === undefined) return next(e)
    await update($, agentTools, tools => ({ ...tools, [id]: e.tool }))
    try {
      return await next(e)
    } finally {
      await update($, agentTools, ({ [id]: _, ...tools }) => tools)
    }
  })

  // End of turn, compaction, /clear.
  on('session.measure', ($, e, next) => {
    void refresh($)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const b = await read($, breakdown)
    if (!b) return <Text dimColor>Measuring…</Text>

    // Solid cells, two wide so they read as squares, one wide when the pane is too narrow
    // (4 = the grid's outline and the pane's padding).
    const cell = (b.gridRows[0]?.length ?? 0) * 2 + 4 <= e.props.bodyColumns ? '██' : '█'

    // Own palette for what occupies the window; the free space is left empty, the buffer recedes in grey.
    const used = b.categories.filter(c => c.kind === 'used' && c.tokens > 0).sort((x, y) => y.tokens - x.tokens)
    const rest = b.categories.filter(c => c.kind !== 'used' && c.tokens > 0)
    const colors = new Map(used.map((c, i) => [c.name, PALETTE[i % PALETTE.length]]))
    const kinds = new Map(b.categories.map(c => [c.name, c.kind]))
    const paint = (name: string) =>
      colors.get(name) !== undefined
        ? { color: colors.get(name) }
        : { color: 'inactive', dimColor: true }
    const gridWidth = (b.gridRows[0]?.length ?? 0) * cell.length
    const fill = (name: string) => (kinds.get(name) === 'free' ? ' '.repeat(cell.length) : cell)

    const at = await read($, cachedAt)
    const refreshed = await read($, nearMisses)
    const isOn = await read($, isKeepWarm)
    const spent = await read($, tokens)
    const cost = await read($, usd)
    const left = at === null ? null : CACHE_TTL_MS - ((await $.clock.now()) - at)
    const clock = (ms: number) =>
      `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`
    const barWidth = gridWidth + 2
    const warm = Math.ceil((Math.max(0, left ?? 0) / CACHE_TTL_MS) * barWidth)

    const now = await $.clock.now()
    const windows = await read($, limits)
    const all = await read($, agents)
    const tools = await read($, agentTools)
    // Every running agent, and the last three that ended.
    const shown = [...all.filter(a => a.status === 'running'), ...all.filter(a => a.status !== 'running').slice(-3)]
    const lineWidth = e.props.bodyColumns - 2

    const rows = [...used, ...rest]
    const nameWidth = Math.max(...rows.map(c => c.name.length))
    const pct = (n: number) => `${((n / b.rawMaxTokens) * 100).toFixed(1)}%`

    return (
      <Box
        flexDirection="column"
        backgroundColor="#000000"
        paddingX={1}
        width={e.props.bodyColumns}
        minHeight={e.props.scroll.bodyRows}
      >
        <Text>
          <Text bold>{b.percentage}%</Text>
          <Text dimColor>
            {' '}
            {fmt(b.totalTokens)} of {fmt(b.rawMaxTokens)} · {b.model}
          </Text>
        </Text>
        {/* Outline of eighth-blocks hugging the cells: a border's line runs mid-cell, which leaves
            twice the gap above and below as left and right. */}
        <Text dimColor> {'▁'.repeat(gridWidth)}</Text>
        {b.gridRows.map(row => (
          <Text>
            <Text dimColor>▕</Text>
            {row.map(sq => (
              <Text {...paint(sq.categoryName)}>{fill(sq.categoryName)}</Text>
            ))}
            <Text dimColor>▏</Text>
          </Text>
        ))}
        <Text dimColor> {'▔'.repeat(gridWidth)}</Text>
        <Text> </Text>
        {rows.map(c => (
          <Text dimColor={c.kind !== 'used'}>
            <Text {...paint(c.name)}>{c.kind === 'buffer' || c.kind === 'used' ? '██' : '  '}</Text> {c.name.padEnd(nameWidth)}{' '}
            {fmt(c.tokens).padStart(7)} {(c.kind === 'deferred' ? '' : pct(c.tokens)).padStart(6)}
          </Text>
        ))}
        <Text> </Text>
        {left === null ? (
          <Text dimColor>Prompt cache: {refreshed >= 2 ? 'compacted while idle' : 'no request yet'}</Text>
        ) : left <= 0 ? (
          <Text>
            Prompt cache <Text bold>expired</Text>
          </Text>
        ) : (
          <Text>
            Prompt cache <Text bold>{clock(left)}</Text>
            <Text dimColor>
              {' '}
              left of {CACHE_TTL_MS / 60_000}m{refreshed > 0 ? ' · refreshed' : ''}
            </Text>
          </Text>
        )}
        <Text>
          <Text color={PALETTE[0]}>{'█'.repeat(warm)}</Text>
          <Text color="inactive" dimColor>
            {'█'.repeat(barWidth - warm)}
          </Text>
        </Text>
        <Button
          key="keep-warm"
          plain
          dimColor
          label={`auto refresh, then compact: ${isOn ? 'on' : 'off'}`}
          onPress={() => void toggleKeepWarm($)}
        />
        <Button
          key="topic-check"
          plain
          dimColor
          label={`new-topic warning: ${(await read($, isTopicCheck)) ? 'on' : 'off'}`}
          onPress={() => void toggleTopicCheck($)}
        />
        <Text> </Text>
        {/* in: input read for the first time (reused cache reads left out); api: the session at API prices. */}
        <Text>
          <Text color="#4477AA">in {fmt(spent.fresh)}</Text>
          <Text dimColor> · </Text>
          <Text color="#EE6677">out {fmt(spent.written)}</Text>
          {cost !== null && <Text dimColor> · </Text>}
          {cost !== null && <Text color="#777777">api {cost.toFixed(2)}$</Text>}
        </Text>
        {windows.length > 0 && <Text> </Text>}
        {windows.map(w => {
          const filled = Math.round((Math.min(100, w.percentUsed) / 100) * barWidth)
          const color = w.percentUsed >= 95 ? '#EE6677' : w.percentUsed >= 80 ? '#CCBB44' : PALETTE[0]

          return (
            <Box flexDirection="column">
              <Text>
                {LIMIT_NAMES[w.kind] ?? w.kind} <Text bold>{w.percentUsed}%</Text>
                {w.resetsAt !== undefined && <Text dimColor> · resets in {until(Date.parse(w.resetsAt) - now)}</Text>}
              </Text>
              <Text>
                <Text color={color}>{'█'.repeat(filled)}</Text>
                <Text color="inactive" dimColor>
                  {'█'.repeat(barWidth - filled)}
                </Text>
              </Text>
            </Box>
          )
        })}
        {shown.length > 0 && <Text> </Text>}
        {shown.length > 0 && (
          <Text>
            Agents <Text dimColor>· {all.filter(a => a.status === 'running').length} running</Text>
          </Text>
        )}
        {shown.map(a => {
          const isRunning = a.status === 'running'
          const mark = isRunning ? '●' : a.status === 'completed' ? '✓' : '✗'
          const color = isRunning ? '#228833' : a.status === 'completed' ? 'inactive' : '#EE6677'
          const doing = isRunning && tools[a.id] !== undefined ? ` · ${tools[a.id]}` : ''

          return (
            <Text dimColor={!isRunning}>
              <Text color={color}>{mark}</Text> {`${a.type}: ${a.description}${doing}`.slice(0, lineWidth - 2)}
            </Text>
          )
        })}
      </Box>
    )
  })
}
