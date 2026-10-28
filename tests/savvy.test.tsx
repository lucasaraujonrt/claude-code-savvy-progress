import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'savvy-progress',
  component: 'Pane',
  requestId: 'savvy-agents',
  props: {
    title: 'Agents',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('a full context offers a handoff, and writing it shows it in the pane', async ($, on) => {
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: 1_000 }))
  on('clock.every', () => ({ value: undefined }) as never)
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000, percent: 72 }, rateLimits: [], cost: { usd: 1.1 } },
  }))
  on('model.fork', () => ({ value: { isAnswered: true, text: '## Goal\nShip the mod.', usage: {} } }) as never)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await pane.find({ type: 'Text', text: /Contexto em 72%/ }))?.text).toContain('72%')
  await pane.press({ key: 'savvy-handoff-write' } as never)
  expect((await pane.find({ type: 'Text', text: /Handoff pronto/ }))?.text).toContain('Handoff pronto')
  await pane.unmount()
})

test('band counts the plan, pane lists an agent, a press opens it', async ($, on) => {
  on('command.register', () => ({ value: { command: 'savvy' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  // What another mod draws above the prompt, kept under the band.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>below</Text>
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
  on('clock.now', () => ({ value: 1_000 }))
  on('clock.every', () => ({ value: undefined }) as never)
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [], cost: { usd: 0.25 } },
  }))
  on('session.messages', () => ({
    value: [
      {
        role: 'assistant',
        text: 'Lendo o README',
        toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: '/repo/README.md' }, text: 'ok' }],
      },
    ],
  }) as never)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Research', activeForm: 'Researching', status: 'completed' },
      { content: 'Build page', activeForm: 'Building page', status: 'in_progress' },
    ],
  })
  await $.agent.spawn({ prompt: 'go', description: 'Build the landing page', subagentType: 'general-purpose' })

  const band = await $.ui.mount({
    plugin: 'savvy-progress',
    component: 'AbovePrompt',
    surface: 'terminal',
    props: { hasSurvey: false },
  } as never)
  expect((await band.find({ type: 'Text', text: /Building page/ }))?.text).toContain('Building page')
  expect((await band.find({ type: 'Text', text: /Tasks 1\/2/ }))?.text).toContain('Tasks 1/2')
  await band.unmount()

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ ...PANE, surface })
    expect((await pane.find({ type: 'Text', text: /Running · 1/ }))?.text).toBe('Running · 1')
    await pane.press({ key: 'savvy-open-a1' } as never)
    expect((await pane.find({ type: 'Text', text: /Read +\/repo\/README\.md/ }))?.text).toContain('✓')
    await pane.press({ key: 'savvy-back' } as never)
    expect((await pane.find({ type: 'Text', text: /Running · 1/ }))?.text).toBe('Running · 1')
    await pane.unmount()
  }
})
