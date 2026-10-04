import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const sq = (categoryName: string, color: string, tokens: number) => ({
  categoryName,
  color,
  tokens,
  isFilled: true,
  percentage: 50,
  squareFullness: 1,
})

const BREAKDOWN = {
  categories: [
    { name: 'Messages', tokens: 100_000, color: 'permission', isDeferred: false, kind: 'used' as const },
    { name: 'Free space', tokens: 100_000, color: 'inactive', isDeferred: false, kind: 'free' as const },
  ],
  totalTokens: 100_000,
  maxTokens: 200_000,
  rawMaxTokens: 200_000,
  autocompactSource: 'model-default' as const,
  percentage: 50,
  gridRows: [[sq('Messages', 'permission', 100_000), sq('Free space', 'inactive', 100_000)]],
  model: 'test-model',
  memoryFiles: [],
  mcpTools: [],
  agents: [],
  isAutoCompactEnabled: false,
  apiUsage: null,
}

const USAGE = { model: 'test-model', input_tokens: 100, cache_creation_input_tokens: 400, cache_read_input_tokens: 2000, output_tokens: 50 }
const LIMITS = [{ kind: 'five_hour', percentUsed: 23.5, resetsAt: '1970-01-01T03:00:00.000Z' }]
const AGENTS = [{ id: 'a1', description: 'find auth code', type: 'Explore', status: 'running' }]
const STEP = { turnId: 't', index: 0, model: 'test-model', messageCount: 1 }
const PROPS = {
  title: 'Context',
  isFocused: false,
  bodyColumns: 40,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
}

// The world beneath the mod: a clock and a store in memory, a fixed breakdown, and counted model calls.
const world = (on: On) => {
  const calls = { forks: 0, compactions: 0 }
  const topic = { verdict: 'SAME', answer: 'Send anyway', asked: 0, entered: [] as string[] }
  const clock = mock.clock(on)
  mock.store(on)
  on('session.compact', async () => {
    calls.compactions += 1

    return { skip: 'test' }
  })
  on('model.fork', async () => {
    calls.forks += 1
    const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 }

    return { value: { isAnswered: true as const, text: 'ok', usage } }
  })
  on('turn.step', async function* () {
    return { turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: USAGE }
  })
  on('session.usage', async () => ({
    value: { startedAt: 0, context: { window: 200_000, breakdown: BREAKDOWN }, rateLimits: LIMITS, cost: { usd: 1.234 } },
  }))
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  on('model.complete', async () => ({ value: { isAnswered: true as const, text: topic.verdict, usage } }))
  // $.ui.ask is a tool call of AskUserQuestion: the person's pick comes back under the question.
  on('tool.call', { tool: 'AskUserQuestion' }, async (_, e) => {
    topic.asked += 1
    const question = e.questions[0]?.question ?? ''

    return { result: { questions: e.questions, answers: { [question]: topic.answer } } }
  })
  on('prompt.suggest', async (_, e) => ({ text: e.text, isShown: true }))
  on('prompt.submit', async (_, e) => {
    topic.entered.push(e.text)

    return { text: e.text }
  })
  on('agent.list', async () => ({ value: AGENTS }))
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('command.register', async (_, e) => ({ value: { command: e.name } }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('session.measure', async (_, e) => ({ changed: e.changed }))

  return { calls, clock, topic }
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`pane draws the breakdown and the cache timer (${surface})`, async ($, on) => {
    const { calls, clock } = world(on)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await $.session.measure({ context: { window: 200_000 }, rateLimits: [], changed: ['context'] })
    const ui = await $.ui.mount({ plugin: 'klod', surface, component: 'Pane', requestId: 'context-view', props: PROPS })

    expect(await ui.find({ text: '100.0k of 200.0k' })).toBeDefined()
    expect(await ui.find({ text: 'Messages   ' })).toBeDefined()
    expect(await ui.find({ text: 'Free space' })).toBeDefined()

    // The cache timer counts down from the last main-thread request.
    expect(await ui.find({ text: 'Prompt cache: no request yet' })).toBeDefined()
    for await (const _ of $.turn.step(STEP)) void _
    await clock.advance(61_000)
    expect(JSON.stringify(await ui.drawn())).toContain('58:59')

    // The request's tokens land in the counter: new input is uncached plus cache-written.
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toContain('"in ","500"')
    expect(drawn).toContain('"out ","50"')
    expect(drawn).toContain('1.23')

    // The plan's usage window and the running subagent are drawn beneath.
    expect(drawn).toContain('5h limit')
    expect(drawn).toContain('2h 59m')
    expect(drawn).toContain('Explore: find auth code')
  })
}

// Two simulated hours of one-second ticks take a few real seconds.
test('an idle session is refreshed once, then compacted', { timeoutMs: 30_000 }, async ($, on) => {
  const { calls, clock } = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.measure({ context: { window: 200_000 }, rateLimits: [], changed: ['context'] })
  const ui = await $.ui.mount({ plugin: 'klod', surface: 'terminal', component: 'Pane', requestId: 'context-view', props: PROPS })
  for await (const _ of $.turn.step(STEP)) void _

  // Five minutes before it lapses the mod refreshes it; at the next near-miss it compacts; then it rests.
  await clock.advance(55 * 60_000)
  expect(calls).toEqual({ forks: 1, compactions: 0 })
  expect(JSON.stringify(await ui.drawn())).toContain('refreshed')
  await clock.advance(56 * 60_000)
  expect(calls).toEqual({ forks: 1, compactions: 1 })
  expect(JSON.stringify(await ui.drawn())).toContain('compacted while idle')
})

test('the line under the bar switches the mode off', { timeoutMs: 30_000 }, async ($, on) => {
  const { calls, clock } = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.measure({ context: { window: 200_000 }, rateLimits: [], changed: ['context'] })
  const ui = await $.ui.mount({ plugin: 'klod', surface: 'terminal', component: 'Pane', requestId: 'context-view', props: PROPS })

  await ui.press({ key: 'keep-warm' })
  expect((await ui.find({ key: 'keep-warm' }))?.text).toContain('off')
  for await (const _ of $.turn.step(STEP)) void _
  await clock.advance(58 * 60_000)
  expect(calls).toEqual({ forks: 0, compactions: 0 })
})

test('a prompt on a new topic is held until the person decides', async ($, on) => {
  const { topic } = world(on)
  await $.session.measure({ context: { window: 200_000 }, rateLimits: [], changed: ['context'] })
  const submit = (text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

  // Nothing to compare the first prompt with, and a prompt on the same topic goes straight in.
  await submit('fix the login bug')
  await submit('now add a test for it')
  expect(topic).toMatchObject({ asked: 0, entered: ['fix the login bug', 'now add a test for it'] })

  topic.verdict = 'NEW'
  await submit('write me a haiku about autumn')
  expect(topic.asked).toBe(1)
  expect(topic.entered).toHaveLength(3)

  topic.answer = 'Cancel'
  expect(await submit('plan my holiday')).toMatchObject({ drop: 'Not sent. Press Tab to get the prompt back.' })
  expect(topic.entered).toHaveLength(3)
})
