import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { AgentNode, NodeStatus, Run, Step } from '../types'
import { arcadeSvg, clip, elapsed, k, modelOf, stageOf, totals } from './view'

// The executor: Opus 5.5 plans (medium effort), Sonnet 5.5 or Haiku 5.5 codes
// each step the plan names, Opus 5.5 reviews the diff. The model calls one tool
// (`mcp__executor__run`), which answers at once; the pipeline runs in the
// background, the pane draws it live, and the report arrives as a new prompt.
//
// It runs in the background because a hook has 10s of its own time and waiting
// on a subagent's answer is the hook's own time: a blocking tool would be cut
// off mid-plan.

const PANE = 'executor-flow'
const MODELS = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
} as const
const AGENT = {
  planner: 'executor:planner',
  reviewer: 'executor:reviewer',
  sonnet: 'executor:coder-sonnet',
  haiku: 'executor:coder-haiku',
} as const
const MAX_STEPS = 8
const KEEP_RUNS = 6

const runs = atom({ plugin: 'executor', key: 'runs' } as const, [], {
  shape: 'runs-1',
})
const selected = atom({ plugin: 'executor', key: 'selected' } as const, 0)
const focus = atom({ plugin: 'executor', key: 'focus' } as const, '')

// ── Prompts ────────────────────────────────────────────────────────────────

const PLANNER_PROMPT = `You are the PLANNER of a three-stage executor: you plan, cheaper models code, a reviewer checks.
You read code and write a plan. You NEVER edit, create or delete files, and you never commit.

Read enough of the repository to be specific (use Read and read-only Bash: ls, grep, git log, sed -n).

The repository's CLAUDE.md is NOT in your context, on purpose: in this repository it is very large, and loading it whole
into every agent was most of the executor's cost. Never Read it whole. Look things up instead:
  grep -n -i '<term>' CLAUDE.md | head        then        sed -n '<from>,<to>p' CLAUDE.md
for the terms the task touches (the files, the feature names, "test", "permission", ...).
The coders and the reviewer do not see CLAUDE.md either: copy every rule that matters for a step INTO that step's brief.

Answer with ONE fenced json block and nothing after it:

\`\`\`json
{
  "summary": "one paragraph: what will change and why",
  "review": true,
  "steps": [
    {
      "n": 1,
      "title": "short imperative title",
      "model": "haiku",
      "files": ["path/relative/to/repo.tsx"],
      "dependsOn": [],
      "brief": "the coder's whole context"
    }
  ]
}
\`\`\`

Rules:
- 1 to ${MAX_STEPS} steps. Fewer is better: one step per coherent change, not per line.
- A brief is the coder's ENTIRE context. The coder has not seen the task, the conversation or the code you read.
  Name exact files, the components or functions, what to change and why, the surrounding conventions to match,
  and the targeted test or typecheck command to run (never a whole suite).
- "model": choose per step. Haiku costs about a twentieth of Sonnet, so prefer it whenever your brief settles the change:
  "haiku" when the brief names the exact file, the exact place and the exact change (copy, classes, a prop, a guard,
  a test whose cases you spell out, a rename) — the coder only has to carry it out.
  "sonnet" when the coder must make decisions you could not settle in the brief: reading code you did not read,
  design or layout judgement, an algorithm, or tests whose cases it has to work out.
  A brief detailed enough for Haiku is cheaper than a vague one handed to Sonnet.
- "review": false when the whole change is small and fully specified by your briefs (a few lines, copy, styling,
  nothing touching permissions, data, security or shared logic) and each brief names a test or typecheck that proves it.
  true otherwise. When unsure, true. Without a review the caller checks the diff itself.
- Steps with no dependsOn run IN PARALLEL. Two steps that touch the same file MUST be ordered with dependsOn.
- Never plan a commit, a push, a deploy or a database write.`

const CODER_PROMPT = `You are a CODER in an executor. You receive one brief from a planner and carry out exactly that brief.

- Read the files the brief names before editing. Match the surrounding code's style, naming and comment density.
- Do only what the brief asks. If something in the brief is wrong or impossible, stop and say so rather than guess.
- Run only the targeted tests or typecheck the brief names. Never run whole suites, never commit, never push.
- Other coders may be editing other files at the same time: touch only the files your brief names.
- The repository's CLAUDE.md is not in your context and you should not read it: the brief carries the rules that matter.

Finish with a short report:
CHANGED: the files you changed
DID: what you did, in two or three lines
CHECKED: the command you ran and its result
OPEN: anything you could not do (or "none")`

const REVIEWER_PROMPT = `You are the REVIEWER of an executor. A planner planned a task and coders carried out the steps.
You check the result. You NEVER edit files.

Inspect the working tree (git status, git diff, Read). The repository's CLAUDE.md is not in your context; if a finding turns on one of its rules, grep it for that rule
(grep -n -i '<term>' CLAUDE.md) rather than reading it whole. Judge whether the change does what the TASK asked,
whether each step did its brief, and whether anything is broken, missing or out of scope.

First line exactly: VERDICT: PASS  or  VERDICT: NEEDS-WORK
Then findings, most important first, each with file:line and what to do. Keep it short.`

// ── Waiting for an agent's answer ──────────────────────────────────────────

type Answer = {
  answer: string
  reason: string
  usage?: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens: number
    cache_creation_input_tokens: number
  }
}

// A subagent's answer is its own turn.complete. The spawn resolves once the
// agent started, so the answer can in principle land before we hold its id:
// keep both halves and meet them by agentId.
const waiting = new Map<string, (a: Answer) => void>()
const early = new Map<string, Answer>()
// agentId → where to record its tool calls.
const owners = new Map<string, { runId: string; slot: 'planner' | 'reviewer' | number }>()
// Every agent id this mod spawned. Each one's report is also handed back to the
// main conversation as a peer message; the pane already holds it, so it is
// dropped there rather than read twice (see the prompt.submit hook).
const ours = new Set<string>()
const REPORT_CAP = 12_000

function answerOf(agentId: string): Promise<Answer> {
  const got = early.get(agentId)
  if (got) {
    early.delete(agentId)
    return Promise.resolve(got)
  }
  return new Promise(resolve => waiting.set(agentId, resolve))
}

// ── State helpers ──────────────────────────────────────────────────────────

function node(role: AgentNode['role'], model: string, effort?: string): AgentNode {
  return {
    role,
    model,
    effort,
    status: 'waiting',
    tokensIn: 0,
    tokensOut: 0,
    tokensCached: 0,
    inChars: 0,
    outChars: 0,
    activity: [],
    toolCalls: 0,
  }
}

type $Like = Parameters<Parameters<Register>[0]>[2] extends infer H
  ? H extends (...a: infer A) => unknown
    ? A[0]
    : never
  : never

function patchRun($: $Like, runId: string, fn: (r: Run) => Run) {
  return update($, runs, list => list.map(r => (r.id === runId ? fn(r) : r)))
}

function patchSlot(
  $: $Like,
  runId: string,
  slot: 'planner' | 'reviewer' | number,
  fn: (n: AgentNode) => AgentNode,
) {
  return patchRun($, runId, r => {
    if (slot === 'planner') return { ...r, planner: fn(r.planner) }
    if (slot === 'reviewer') return { ...r, reviewer: fn(r.reviewer) }
    return {
      ...r,
      steps: r.steps.map(s => (s.n === slot ? { ...s, node: fn(s.node) } : s)),
    }
  })
}

// ── Running one agent ──────────────────────────────────────────────────────

async function runAgent(
  $: $Like,
  runId: string,
  slot: 'planner' | 'reviewer' | number,
  subagentType: string,
  prompt: string,
  description: string,
): Promise<Answer> {
  const startedAt = Date.now()
  await patchSlot($, runId, slot, n => ({
    ...n,
    status: 'running',
    startedAt,
    inChars: prompt.length,
    prompt: clip(prompt, REPORT_CAP),
  }))
  const spawned = await $.agent.spawn({ subagentType, prompt, description })
  if (spawned.deny !== undefined || !spawned.agentId) {
    const reason = spawned.deny ?? 'the agent did not start'
    await patchSlot($, runId, slot, n => ({
      ...n,
      status: 'failed',
      endedAt: Date.now(),
      summary: reason,
    }))
    return { answer: '', reason: `refused: ${reason}` }
  }
  owners.set(spawned.agentId, { runId, slot })
  ours.add(spawned.agentId)
  await patchSlot($, runId, slot, n => ({ ...n, agentId: spawned.agentId, model: spawned.model || n.model }))

  const got = await answerOf(spawned.agentId)
  owners.delete(spawned.agentId)
  const ok = got.reason === 'answer' && got.answer.trim() !== ''
  await patchSlot($, runId, slot, n => ({
    ...n,
    status: ok ? 'done' : 'failed',
    endedAt: Date.now(),
    outChars: got.answer.length,
    tokensIn: (got.usage?.input_tokens ?? 0) + (got.usage?.cache_creation_input_tokens ?? 0),
    tokensCached: got.usage?.cache_read_input_tokens ?? 0,
    tokensOut: got.usage?.output_tokens ?? 0,
    summary: firstLines(got.answer, 3) || `ended: ${got.reason}`,
    report: clip(got.answer, REPORT_CAP),
  }))
  return got
}

function firstLines(text: string, n: number): string {
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .slice(0, n)
    .join(' · ')
    .slice(0, 280)
}

// ── Parsing the plan ───────────────────────────────────────────────────────

type PlanStep = {
  n: number
  title: string
  model: 'sonnet' | 'haiku'
  files: string[]
  dependsOn: number[]
  brief: string
}

export function parsePlan(text: string): { summary: string; review: boolean; steps: PlanStep[] } | string {
  const fenced = /```json\s*([\s\S]*?)```/i.exec(text)
  const raw = fenced?.[1] !== undefined ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return 'the planner did not answer with a JSON plan'
  }
  const d = data as { summary?: unknown; review?: unknown; steps?: unknown }
  if (!Array.isArray(d.steps) || d.steps.length === 0) return 'the plan has no steps'
  if (d.steps.length > MAX_STEPS) return `the plan has ${d.steps.length} steps (at most ${MAX_STEPS})`
  const steps: PlanStep[] = []
  for (const [i, s] of (d.steps as Record<string, unknown>[]).entries()) {
    const n = typeof s.n === 'number' ? s.n : i + 1
    const brief = typeof s.brief === 'string' ? s.brief : ''
    if (!brief.trim()) return `step ${n} has no brief`
    steps.push({
      n,
      title: typeof s.title === 'string' ? s.title : `Step ${n}`,
      model: s.model === 'haiku' ? 'haiku' : 'sonnet',
      files: Array.isArray(s.files) ? s.files.filter((f): f is string => typeof f === 'string') : [],
      dependsOn: Array.isArray(s.dependsOn)
        ? s.dependsOn.filter((x): x is number => typeof x === 'number')
        : [],
      brief,
    })
  }
  const ids = new Set(steps.map(s => s.n))
  if (ids.size !== steps.length) return 'two steps share a number'
  for (const s of steps) {
    for (const dep of s.dependsOn) {
      if (!ids.has(dep)) return `step ${s.n} depends on step ${dep}, which is not in the plan`
      if (dep === s.n) return `step ${s.n} depends on itself`
    }
  }
  // Only an explicit false skips the review: a missing or malformed field reviews.
  return { summary: typeof d.summary === 'string' ? d.summary : '', review: d.review !== false, steps }
}

// ── The pipeline ───────────────────────────────────────────────────────────

async function pipeline($: $Like, runId: string, task: string, context: string) {
  try {
    // 1. Plan.
    const planAsk = `TASK\n${task}${context ? `\n\nCONTEXT FROM THE PERSON\n${context}` : ''}`
    const planned = await runAgent($, runId, 'planner', AGENT.planner, planAsk, 'executor: plan')
    const plan = parsePlan(planned.answer)
    if (typeof plan === 'string') throw new Error(`planning failed: ${plan}`)

    const steps: Step[] = plan.steps.map(s => ({
      n: s.n,
      title: s.title,
      brief: s.brief,
      files: s.files,
      dependsOn: s.dependsOn,
      node: node('coder', MODELS[s.model]),
    }))
    await patchRun($, runId, r => ({ ...r, status: 'coding', planSummary: plan.summary, steps }))

    // 2. Code: every step whose dependencies are done starts at once.
    const state = new Map<number, NodeStatus>(steps.map(s => [s.n, 'waiting']))
    const reports = new Map<number, string>()
    await new Promise<void>(resolve => {
      const pump = () => {
        for (const s of steps) {
          if (state.get(s.n) !== 'waiting') continue
          const deps = s.dependsOn.map(d => state.get(d))
          if (deps.some(d => d === 'failed' || d === 'skipped')) {
            state.set(s.n, 'skipped')
            void patchSlot($, runId, s.n, n => ({ ...n, status: 'skipped', summary: 'a step it depends on failed' }))
            continue
          }
          if (!deps.every(d => d === 'done')) continue
          state.set(s.n, 'running')
          const model = plan.steps.find(p => p.n === s.n)!.model
          const ask = `BRIEF (step ${s.n} of ${steps.length}: ${s.title})\n${s.brief}${
            s.files.length ? `\n\nFILES\n${s.files.join('\n')}` : ''
          }`
          void runAgent($, runId, s.n, AGENT[model], ask, `executor: step ${s.n}`).then(got => {
            const ok = got.reason === 'answer' && got.answer.trim() !== ''
            state.set(s.n, ok ? 'done' : 'failed')
            reports.set(s.n, got.answer || `(no report: ${got.reason})`)
            pump()
          })
        }
        const open = [...state.values()].some(v => v === 'waiting' || v === 'running')
        if (!open) resolve()
        else if (![...state.values()].includes('running')) {
          // Waiting steps nothing can start: a dependency cycle.
          for (const [n, v] of state) {
            if (v !== 'waiting') continue
            state.set(n, 'skipped')
            void patchSlot($, runId, n, x => ({ ...x, status: 'skipped', summary: 'dependency cycle' }))
          }
          resolve()
        }
      }
      pump()
    })

    // 3. Review — unless the planner said the change is too small to need one.
    // A step that did not finish always gets a review: that is when it matters.
    const failed = [...state.values()].filter(v => v !== 'done').length
    if (!plan.review && failed === 0) {
      await patchSlot($, runId, 'reviewer', n => ({ ...n, status: 'skipped', summary: 'the planner judged the change small enough to skip review' }))
      await patchRun($, runId, r => ({ ...r, status: 'done', endedAt: Date.now(), verdict: 'NOT REVIEWED' }))
      await $.prompt.submit({
        text: [
          `[executor ${runId}] finished — not reviewed (the planner judged it small), ${steps.length} of ${steps.length} steps done.`,
          `PLAN: ${plan.summary}`,
          ...steps.map(
            s =>
              `--- step ${s.n} · ${modelOf(s.node.model).name} · ${state.get(s.n)} · ${s.title}\n${clip(reports.get(s.n) ?? '', 1500)}`,
          ),
          `No reviewer ran: check the diff yourself before telling the person it is done.`,
        ].join('\n\n'),
      })
      return
    }
    await patchRun($, runId, r => ({ ...r, status: 'reviewing' }))
    const reviewAsk = [
      `TASK\n${task}`,
      `PLAN\n${plan.summary}`,
      ...steps.map(
        s => `STEP ${s.n} — ${s.title} [${state.get(s.n)}]\nBRIEF\n${s.brief}\nREPORT\n${reports.get(s.n) ?? '(did not run)'}`,
      ),
    ].join('\n\n')
    const reviewed = await runAgent($, runId, 'reviewer', AGENT.reviewer, reviewAsk, 'executor: review')
    const verdict = /VERDICT:\s*(PASS|NEEDS-WORK)/i.exec(reviewed.answer)?.[1]?.toUpperCase()

    await patchRun($, runId, r => ({
      ...r,
      status: failed === 0 && verdict === 'PASS' ? 'done' : 'failed',
      endedAt: Date.now(),
      verdict: verdict ?? 'NO VERDICT',
    }))

    // 4. One message back to the main conversation. The agents' own hand-backs
    // are dropped (they are in the pane), so this is the only copy it reads:
    // each coder's report capped, the review whole, no task (the caller wrote it).
    await $.prompt.submit({
      text: [
        `[executor ${runId}] finished — reviewer: ${verdict ?? 'no verdict'}, ${steps.length - failed} of ${steps.length} steps done.`,
        `PLAN: ${plan.summary}`,
        ...steps.map(
          s =>
            `--- step ${s.n} · ${modelOf(s.node.model).name} · ${state.get(s.n)} · ${s.title}\n${clip(reports.get(s.n) ?? '', 1500)}`,
        ),
        `--- review\n${reviewed.answer}`,
        `Full briefs and reports are in the Executor pane. Check the diff yourself before telling the person it is done.`,
      ].join('\n\n'),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await patchRun($, runId, r => ({ ...r, status: 'failed', endedAt: Date.now(), error: message }))
    await $.prompt.submit({ text: `[executor ${runId}] failed: ${message}` })
  }
}

// ── Hooks ──────────────────────────────────────────────────────────────────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.agent.register({
      name: 'planner',
      description: 'Executor planner (Opus 5.5, medium): reads the code, writes one brief per step.',
      prompt: PLANNER_PROMPT,
      model: MODELS.opus,
      effort: 'medium',
      tools: ['Read', 'Bash'],
      omitClaudeMd: true,
    })
    await $.agent.register({
      name: 'reviewer',
      description: 'Executor reviewer (Opus 5.5, medium): checks the diff against the task.',
      prompt: REVIEWER_PROMPT,
      model: MODELS.opus,
      effort: 'medium',
      tools: ['Read', 'Bash'],
      omitClaudeMd: true,
    })
    await $.agent.register({
      name: 'coder-sonnet',
      description: 'Executor coder (Sonnet 5.5): carries out one brief that needs judgement.',
      prompt: CODER_PROMPT,
      model: MODELS.sonnet,
      tools: ['Read', 'Edit', 'Write', 'Bash'],
      omitClaudeMd: true,
    })
    await $.agent.register({
      name: 'coder-haiku',
      description: 'Executor coder (Haiku 5.5): carries out one fully specified brief.',
      prompt: CODER_PROMPT,
      model: MODELS.haiku,
      tools: ['Read', 'Edit', 'Write', 'Bash'],
      omitClaudeMd: true,
    })
    await $.tool.register({
      name: 'run',
      description:
        'Run a coding task through the executor: Opus 5.5 (medium effort) plans and writes one brief per step, ' +
        'Haiku 5.5 or Sonnet 5.5 coders carry out the steps (independent steps in parallel), Opus 5.5 reviews the diff (skipped when the planner judges the change small). ' +
        'Answers at once with a run id; the full report (plan, each coder report, the review) arrives later as a new message. ' +
        'The person watches it live in the "Executor" pane (/executor). Give the task in full: the planner has not seen this conversation.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The task, complete and self-contained.' },
          context: {
            type: 'string',
            description: 'Anything the planner should know: file paths, what the person said, screenshots described in words.',
          },
        },
        required: ['task'],
      },
      isDeferred: false,
    })
    await $.command.register({ name: 'executor', description: 'Show the executor flow pane' })
    // A running card shows its elapsed time: redraw once a second while anything runs.
    $.clock.every(1000, async () => {
      const list = await read($, runs)
      if (list.some(r => r.status === 'planning' || r.status === 'coding' || r.status === 'reviewing'))
        await update($, runs, l => [...l])
    })
    return next(e)
  })

  // The agent types are the executor's own: the model reaches them through the tool.
  for (const name of Object.values(AGENT)) on('agent.offer', { agent: name }, () => ({ isOffered: false }))

  on('command.run', { command: 'executor' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Executor' })
    return { text: 'Executor pane opened.' }
  })

  on('tool.call', { tool: 'mcp__executor__run' }, async ($, e) => {
    const input = e as unknown as { task?: unknown; context?: unknown }
    const task = typeof input.task === 'string' ? input.task.trim() : ''
    if (!task) return { deny: 'task is required' }
    const context = typeof input.context === 'string' ? input.context : ''
    const id = `x${(Date.now() % 1_000_000).toString(36)}`
    const run: Run = {
      id,
      task,
      status: 'planning',
      startedAt: Date.now(),
      planner: node('planner', MODELS.opus, 'medium'),
      steps: [],
      reviewer: node('reviewer', MODELS.opus, 'medium'),
    }
    await update($, runs, list => [run, ...list].slice(0, KEEP_RUNS))
    await update($, selected, () => 0)
    await $.ui.open({ id: PANE, title: 'Executor' })
    // Started after this hook returns, on purpose (see the top of the file).
    void pipeline($, id, task, context)
    // A plugin tool's result is a string or a list of blocks, never an object.
    return {
      result: `Executor run ${id} started. Planning has begun; the report arrives as a new message when the review is done, and the Executor pane shows it live.`,
    }
  })

  // Every tool call a subagent of ours makes: record it on its card.
  on('tool.call', async ($, e, next) => {
    const owner = e.agentId ? owners.get(e.agentId) : undefined
    if (owner) {
      const raw = e as unknown as Record<string, unknown>
      const arg = String(raw.file_path ?? raw.command ?? raw.pattern ?? raw.path ?? '')
      // Paths inside the session's directory are shown relative to it.
      const root = `${await $.session.cwd()}/`
      const rel = arg.startsWith(root) ? arg.slice(root.length) : arg
      const short = `${e.tool} ${clip(rel, 70)}`.trim()
      await patchSlot($, owner.runId, owner.slot, n => ({
        ...n,
        toolCalls: n.toolCalls + 1,
        activity: [...n.activity, short].slice(-6),
      }))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      const got: Answer = { answer: e.answer, reason: e.reason, usage: e.usage }
      const resolve = waiting.get(e.agentId)
      if (resolve) {
        waiting.delete(e.agentId)
        resolve(got)
      } else if (owners.has(e.agentId) || early.size < 50) {
        early.set(e.agentId, got)
      }
    }
    return next(e)
  })

  // An agent of ours hands its report back to the main conversation as a peer
  // message. The pane already shows it and the run's closing message quotes it,
  // so reading it a second time there only spends context.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'peer') {
      const from = /<agent-message from="([^"]+)"/.exec(e.text)?.[1]
      if (from && ours.has(from)) return { drop: 'Executor: this agent’s report is in the Executor pane.' }
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = await read($, runs)
    const at = Math.min(await read($, selected), Math.max(0, list.length - 1))
    const open = await read($, focus)
    const run = list[at]
    if (!run)
      return (
        <Box flexDirection="column">
          <Text>▶ EXECUTOR — no runs yet</Text>
          <Text dimColor>Ask Claude to run a task through the executor.</Text>
        </Box>
      )
    const now = Date.now()
    const cards: { id: string; label: string; node: AgentNode; brief?: string }[] = [
      { id: 'planner', label: 'Plan', node: run.planner },
      ...run.steps.map(s => ({ id: String(s.n), label: `${s.n}`, node: s.node, brief: s.brief })),
      { id: 'reviewer', label: 'Review', node: run.reviewer },
    ]
    const toggle = (id: string) => () => void update($, focus, f => (f === id ? '' : id))
    const picked = cards.find(c => c.id === open)
    const rich = ui as Record<string, unknown>
    const Svg = rich.Svg as ((p: unknown) => unknown) | undefined
    const Markdown = rich.Markdown as ((p: unknown) => unknown) | undefined
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const el = (C: unknown, props: Record<string, unknown>) => (h as any)(C, props)
    const mark = { done: '●', running: '◐', waiting: '○', failed: '✕', skipped: '–' } as const

    return (
      <Box flexDirection="column" gap={1}>
        {Svg ? (
          el(Svg, {
            source: arcadeSvg(run, now, open),
            alt: `Executor run ${run.id}, stage ${stageOf(run)}: planner ${run.planner.status}, ${run.steps.length} coders, review ${run.reviewer.status}`,
            isInteractive: true,
          })
        ) : (
          <Box flexDirection="column">
            <Text bold>
              ▶ EXECUTOR {run.id} · {stageOf(run)} {run.verdict ? `· ${run.verdict}` : ''}
            </Text>
            {cards.map(c => (
              <Text>
                {mark[c.node.status]} {c.id === 'planner' ? 'Planner' : c.id === 'reviewer' ? 'Review' : `Step ${c.label}`} · {modelOf(c.node.model).name} · {elapsed(c.node, now)}
              </Text>
            ))}
          </Box>
        )}

        <Box flexDirection="row" gap={1}>
          {cards.map(c => (
            <Button key={`agent-${c.id}`} onPress={toggle(c.id)}>
              {open === c.id ? '▾ ' : ''}
              {mark[c.node.status]} {c.label}
            </Button>
          ))}
          {list.length > 1 && at < list.length - 1 && (
            <Button key="older" label="◀ older run" onPress={() => void update($, selected, x => Math.min(x + 1, list.length - 1))} />
          )}
          {at > 0 && <Button key="newer" label="newer run ▶" onPress={() => void update($, selected, x => Math.max(0, x - 1))} />}
        </Box>

        {run.error && <Text color="red">{run.error}</Text>}

        {picked && (
          <Box flexDirection="column" gap={1}>
            <Text bold>
              {picked.id === 'planner' ? 'Planner' : picked.id === 'reviewer' ? 'Review' : `Step ${picked.label}`} · {modelOf(picked.node.model).name}
              {picked.node.effort ? ` · ${picked.node.effort}` : ''} · {picked.node.status} · {elapsed(picked.node, now)} · in {k(picked.node.tokensIn)} · cached {k(picked.node.tokensCached)} · out {k(picked.node.tokensOut)}
            </Text>
            <Text dimColor>HANDED IN</Text>
            {Markdown ? el(Markdown, { text: clip(picked.brief ?? picked.node.prompt ?? '—', 4000) }) : <Text>{clip(picked.brief ?? picked.node.prompt ?? '—', 4000)}</Text>}
            <Text dimColor>HANDED BACK</Text>
            {Markdown
              ? el(Markdown, { text: clip(picked.node.report ?? (picked.node.status === 'running' ? 'Still working…' : '—'), 4000) })
              : <Text>{clip(picked.node.report ?? '—', 4000)}</Text>}
            {picked.node.activity.length > 0 && <Text dimColor>LAST TOOL CALLS ({picked.node.toolCalls} in all)</Text>}
            {picked.node.activity.map(a => (
              <Text dimColor>  {a}</Text>
            ))}
          </Box>
        )}

        {!picked && totals(run).length > 0 && !Svg && (
          <Text dimColor>
            {totals(run)
              .map(([name, t]) => `${name} ${k(t.in + t.cached + t.out)}`)
              .join(' · ')}
          </Text>
        )}
      </Box>
    )
  })
}
