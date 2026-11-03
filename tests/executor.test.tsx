import { expect, test } from 'claude-code/testing'

import { parsePlan } from '../hooks/register'
import { flowSvg } from '../hooks/view'
import type { AgentNode, Run } from '../types'

const PANE = {
  plugin: 'executor',
  component: 'Pane',
  requestId: 'executor-flow',
  props: {
    title: 'Executor',
    isFocused: false,
    bodyColumns: 120,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const node = (status: AgentNode['status'], model: string): AgentNode => ({
  role: 'coder',
  model,
  status,
  tokensIn: 1200,
  tokensOut: 300,
  tokensCached: 0,
  inChars: 900,
  outChars: 400,
  activity: ['Read src/app/tools/page.tsx'],
  toolCalls: 1,
})

test('a plan in a json fence parses, with its order', async () => {
  const plan = parsePlan(
    'Here it is.\n```json\n{"summary":"s","steps":[{"n":1,"title":"a","model":"haiku","files":["x.ts"],"dependsOn":[],"brief":"do a"},{"n":2,"title":"b","model":"sonnet","files":["x.ts"],"dependsOn":[1],"brief":"do b"}]}\n```',
  )
  expect(typeof plan).toBe('object')
  if (typeof plan === 'string') return
  expect(plan.steps.map(s => s.model)).toEqual(['haiku', 'sonnet'])
  expect(plan.steps[1]?.dependsOn).toEqual([1])
})

test('only an explicit review:false skips the review', async () => {
  const plan = (review: string) =>
    parsePlan(`\`\`\`json\n{${review}"steps":[{"n":1,"brief":"x"}]}\n\`\`\``)
  const of = (p: ReturnType<typeof parsePlan>) => (typeof p === 'string' ? p : p.review)
  expect(of(plan('"review":false,'))).toBe(false)
  expect(of(plan('"review":true,'))).toBe(true)
  expect(of(plan(''))).toBe(true)
  expect(of(plan('"review":"no",'))).toBe(true)
})

test('a brief carrying its own fenced code still parses (the fence inside a JSON string is not the end)', async () => {
  const brief = 'Replace the example:\\n```python\\nfoundry.write_xlsx(\\"r.xlsx\\", rows)\\n```\\nthen run the test.'
  const plan = parsePlan(
    `\`\`\`json\n{"summary":"s","steps":[{"n":1,"title":"a","model":"haiku","brief":"${brief}"},{"n":2,"brief":"b {x}"}]}\n\`\`\``,
  )
  expect(typeof plan).toBe('object')
  if (typeof plan === 'string') return
  expect(plan.steps[0]?.brief).toContain('```python')
  expect(plan.steps.length).toBe(2)
})

test('a plan that is not a plan is refused by name', async () => {
  expect(parsePlan('I could not plan this.')).toBe('the planner did not answer with a JSON plan')
  expect(
    parsePlan('```json\n{"steps":[{"n":1,"brief":"x","dependsOn":[7]}]}\n```'),
  ).toBe('step 1 depends on step 7, which is not in the plan')
  expect(parsePlan('```json\n{"steps":[{"n":1,"brief":""}]}\n```')).toBe('step 1 has no brief')
})

test('the flow drawing shows each agent, its state and what moves', async () => {
  const run: Run = {
    id: 'x1',
    task: 'Fix <the> settings page & dialog',
    status: 'coding',
    startedAt: 0,
    planner: { ...node('done', 'claude-opus-5-5'), role: 'planner', effort: 'medium' },
    steps: [
      { n: 1, title: 'Sticky footer', brief: 'b', files: ['a.tsx'], dependsOn: [], node: node('running', 'claude-sonnet-5-5') },
      { n: 2, title: 'Copy', brief: 'b', files: ['a.tsx'], dependsOn: [1], node: node('waiting', 'claude-haiku-5-5') },
    ],
    reviewer: { ...node('waiting', 'claude-opus-5-5'), role: 'reviewer' },
  }
  const svg = flowSvg(run, 5000, '1')
  expect(svg.startsWith('<svg')).toBe(true)
  expect(svg).toContain('OPUS · MED')
  expect(svg).toContain('SONNET')
  expect(svg).toContain('HAIKU')
  expect(svg).toContain('CODING')
  expect(svg).toContain('0 / 2 STEPS')
  expect(svg).toContain('01 / WORKING')
  expect(svg).toContain('02 / QUEUED')
  expect(svg).toContain('Starts after step 1')
  expect(svg).toContain('✓ PLAN READY · 2 STEPS')
  // The running coder says what it is doing, on its card and in the NOW line.
  expect(svg).toContain('▸ READ TOOLS/PAGE.TSX')
  expect(svg).toContain('Sonnet 5.5 · step 1 · read tools/page.tsx')
  expect(svg).not.toContain('<the>')
  // Only the running coder's orb spins.
  expect(svg.match(/animateTransform/g)?.length).toBe(1)
  // Dots ride only the line into the running coder: two of them.
  expect(svg.match(/<animateMotion/g)?.length).toBe(2)
  // The focused card is outlined.
  expect(svg).toContain('stroke-dasharray="3 3"')
})

test('a finished run says how it ended', async () => {
  const done = (verdict: string, status: Run['status']): string =>
    flowSvg(
      {
        id: 'x2',
        task: 't',
        status,
        startedAt: 0,
        endedAt: 65_000,
        verdict,
        planner: { ...node('done', 'claude-opus-5-5'), role: 'planner' },
        steps: [{ n: 1, title: 'a', brief: 'b', files: [], dependsOn: [], node: node('done', 'claude-haiku-5-5') }],
        reviewer: { ...node(verdict === 'NOT REVIEWED' ? 'skipped' : 'done', 'claude-opus-5-5'), role: 'reviewer' },
      },
      70_000,
      '',
    )
  expect(done('PASS', 'done')).toContain('✓ PASSED')
  expect(done('PASS', 'done')).toContain('Finished in 01:05')
  expect(done('NOT REVIEWED', 'done')).toContain('– SKIPPED · SMALL CHANGE')
  expect(done('NEEDS-WORK', 'failed')).toContain('! NEEDS WORK')
  expect(done('PASS', 'done')).not.toContain('animateMotion')
})

test('the pane says when there is nothing to show', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  for (const surface of ['terminal', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /no runs yet/ }))?.text).toBe('▶ EXECUTOR — no runs yet')
    await ui.unmount()
  }
})

test('a hand-back from an agent the executor did not spawn is let through', async ($, on) => {
  on('prompt.submit', (_, e) => ({ text: e.text, origin: e.origin }))
  const got = await $.prompt.submit({
    text: '<agent-message from="someone-else">report</agent-message>',
  })
  expect(got.drop).toBeUndefined()
})
