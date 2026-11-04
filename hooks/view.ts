import type { AgentNode, Run, Step } from '../types'

// The executor's picture: one dark panel, read left to right. A header with
// the run's state, the goal, then three columns — the planner, one card per
// coding step, the reviewer — joined by thin lines a dot travels along while
// data moves. Beneath them, one sentence saying what is happening now, and the
// tokens each model has used: input and output only, since a cache read
// costs a tenth of fresh input and would drown the number that matters. The
// advanced view splits them into in, cached and out. Colour carries state, so the words stay short:
// cyan is working, green is done, amber needs a look, red failed, grey waits.

export const PX = {
  bg: '#0a0f1d',
  panel: '#0e1528',
  card: '#111a30',
  cardHi: '#14203b',
  line: '#1f2b47',
  text: '#e8eefb',
  muted: '#93a0bd',
  faint: '#53617f',
  cyan: '#7dd3fc',
  green: '#6ee7b7',
  amber: '#fbbf24',
  red: '#f87171',
  opus: '#a78bfa',
  sonnet: '#60a5fa',
  haiku: '#5eead4',
}

const FONT = `ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace`

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s
}

export function k(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return `${n}`
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export function elapsed(n: AgentNode, now: number): string {
  return n.startedAt !== undefined ? clock((n.endedAt ?? now) - n.startedAt) : '--:--'
}

export function modelOf(model: string): { name: string; short: string; color: string } {
  if (model.includes('opus')) return { name: 'Opus 5.5', short: 'OPUS', color: PX.opus }
  if (model.includes('haiku')) return { name: 'Haiku 5.5', short: 'HAIKU', color: PX.haiku }
  if (model.includes('sonnet')) return { name: 'Sonnet 5.5', short: 'SONNET', color: PX.sonnet }
  return { name: model, short: model.toUpperCase().slice(0, 8), color: PX.faint }
}

/** "Edit src/app/tools/page.tsx" → "EDIT TOOLS/PAGE.TSX". */
export function doing(activity: string): string {
  const [verb, ...rest] = activity.split(' ')
  const arg = rest.join(' ')
  const short = /^[\w./()@[\]-]+\/[\w.@()[\]-]+$/.test(arg) ? arg.split('/').slice(-2).join('/') : arg
  return `${verb ?? ''} ${short}`.trim().toUpperCase()
}

/** A node's state as a word and a colour. */
function stateOf(n: AgentNode): { word: string; color: string } {
  switch (n.status) {
    case 'running':
      return { word: 'WORKING', color: PX.cyan }
    case 'done':
      return { word: 'DONE', color: PX.green }
    case 'failed':
      return { word: 'FAILED', color: PX.red }
    case 'skipped':
      return { word: 'SKIPPED', color: PX.faint }
    default:
      return { word: 'QUEUED', color: PX.faint }
  }
}

export function stageOf(run: Run): string {
  return run.status === 'planning'
    ? 'PLAN'
    : run.status === 'coding'
      ? 'CODE'
      : run.status === 'reviewing'
        ? 'REVIEW'
        : run.status === 'done'
          ? 'DONE'
          : 'FAILED'
}

function runState(run: Run): { word: string; color: string } {
  if (run.status === 'done') return { word: run.verdict === 'NOT REVIEWED' || run.verdict === 'NOT ASKED' ? 'DONE · NOT REVIEWED' : 'DONE', color: PX.green }
  if (run.status === 'failed')
    return run.verdict === 'NEEDS-WORK' ? { word: 'NEEDS WORK', color: PX.amber } : { word: 'FAILED', color: PX.red }
  const word = run.status === 'planning' ? 'PLANNING' : run.status === 'coding' ? 'CODING' : 'REVIEWING'
  return { word, color: PX.cyan }
}

export type Tally = { in: number; written: number; cached: number; out: number; usd: number; color: string }

// List prices in $ per million tokens: input, output, cache read. A cache
// write bills at 1.25× input. Haiku's rate is the one for prompts of 100K
// tokens or fewer, which a coder's prompt always is.
const PRICE: Record<string, [number, number, number]> = {
  OPUS: [4, 20, 0.2],
  SONNET: [2, 10, 0.2],
  HAIKU: [0.1, 0.5, 0.01],
}

/** An estimate at list price; 0 for a model the table does not know. */
export function costOf(short: string, n: { tokensIn: number; tokensWritten?: number; tokensCached: number; tokensOut: number }): number {
  const p = PRICE[short]
  if (!p) return 0
  const written = n.tokensWritten ?? 0
  return ((n.tokensIn - written) * p[0] + written * p[0] * 1.25 + n.tokensCached * p[2] + n.tokensOut * p[1]) / 1_000_000
}

export function usd(x: number): string {
  return x >= 1 ? `$${x.toFixed(2)}` : x >= 0.01 ? `$${x.toFixed(2)}` : x > 0 ? '<$0.01' : '$0'
}

export function totals(run: Run): [string, Tally][] {
  const by = new Map<string, Tally>()
  for (const n of [run.planner, ...run.steps.map(s => s.node), run.reviewer]) {
    const m = modelOf(n.model)
    const t = by.get(m.short) ?? { in: 0, written: 0, cached: 0, out: 0, usd: 0, color: m.color }
    t.in += n.tokensIn
    t.written += n.tokensWritten ?? 0
    t.cached += n.tokensCached
    t.out += n.tokensOut
    t.usd += costOf(m.short, n)
    by.set(m.short, t)
  }
  return [...by.entries()].filter(([, t]) => t.in + t.out + t.cached > 0)
}

/** The tokens worth watching: fresh input (cache writes included) and output. Cache reads are left out. */
export function spent(t: { in: number; out: number }): number {
  return t.in + t.out
}

/** One agent's tokens, as the pane writes them: the spent total, or the full split in the advanced view. */
export function tokenLine(
  n: { model: string; tokensIn: number; tokensWritten?: number; tokensCached: number; tokensOut: number },
  advanced: boolean,
): string {
  const cost = `≈ ${usd(costOf(modelOf(n.model).short, n))}`
  return advanced
    ? `in ${k(n.tokensIn)} · cached ${k(n.tokensCached)} · out ${k(n.tokensOut)} · ${cost}`
    : `new tokens ${k(spent({ in: n.tokensIn, out: n.tokensOut }))} · ${cost}`
}

function statusGlyph(n: AgentNode): string {
  return n.status === 'done' ? '✓' : n.status === 'failed' ? '✕' : n.status === 'running' ? '●' : n.status === 'skipped' ? '–' : '○'
}

/** The agent's mark: a ring in its model's colour; a dot orbits it while it works. */
function orb(cx: number, cy: number, color: string, n: AgentNode): string {
  const s = stateOf(n)
  const dim = n.status === 'waiting' || n.status === 'skipped'
  const parts = [
    `<circle cx="${cx}" cy="${cy}" r="14" fill="${PX.bg}" stroke="${color}" stroke-width="1.5" opacity="${dim ? 0.45 : 1}"/>`,
    `<circle cx="${cx}" cy="${cy}" r="5" fill="${n.status === 'failed' ? PX.red : color}" opacity="${dim ? 0.45 : 1}"/>`,
  ]
  if (n.status === 'running')
    parts.push(
      `<g><animateTransform attributeName="transform" type="rotate" from="0 ${cx} ${cy}" to="360 ${cx} ${cy}" dur="2.4s" repeatCount="indefinite"/><circle cx="${cx}" cy="${cy - 14}" r="2.6" fill="${s.color}"/></g>`,
      `<circle cx="${cx}" cy="${cy}" r="19" fill="none" stroke="${s.color}" stroke-width="1" opacity="0.35"/>`,
    )
  else if (n.status === 'done' || n.status === 'failed')
    parts.push(`<circle cx="${cx + 10}" cy="${cy - 10}" r="3" fill="${s.color}"/>`)
  return parts.join('')
}

/** A thin curved line between two points; a dot rides it while data moves. */
function link(x1: number, y1: number, x2: number, y2: number, live: boolean, label: string, labelAt: 'start' | 'end'): string {
  const mx = (x1 + x2) / 2
  const d = `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`
  const out = [
    `<path d="${d}" fill="none" stroke="${live ? PX.cyan : PX.line}" stroke-width="${live ? 1.4 : 1}" opacity="${live ? 0.8 : 1}"/>`,
  ]
  if (live)
    out.push(
      `<circle r="2.6" fill="${PX.cyan}"><animateMotion dur="1.8s" repeatCount="indefinite" path="${d}"/></circle>`,
      `<circle r="2.6" fill="${PX.cyan}" opacity="0.5"><animateMotion dur="1.8s" begin="0.9s" repeatCount="indefinite" path="${d}"/></circle>`,
    )
  if (label)
    out.push(
      // Beside the card it belongs to, never over the planner's or the reviewer's words.
      labelAt === 'end'
        ? `<text x="${x2 - 6}" y="${y2 - 6}" fill="${PX.faint}" font-size="9" text-anchor="end" letter-spacing="1">${esc(label)}</text>`
        : `<text x="${x1 + 6}" y="${y1 - 6}" fill="${PX.faint}" font-size="9" letter-spacing="1">${esc(label)}</text>`,
    )
  return out.join('')
}

/** Word-wrap into at most `lines` lines of `width` characters, the last clipped. */
function wrap(text: string, width: number, lines: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ')
  const out: string[] = []
  let cur = ''
  for (const w of words) {
    if (!cur) cur = w
    else if (cur.length + 1 + w.length <= width) cur += ` ${w}`
    else {
      out.push(cur)
      cur = w
    }
  }
  if (cur) out.push(cur)
  if (out.length > lines) out.splice(lines - 1, out.length, `${out[lines - 1]} ${out.slice(lines).join(' ')}`)
  return out.map(l => clip(l, width))
}

/** The planner or the reviewer: an orb, its name, its model, one status line and a note. */
function sideNode(
  x: number,
  y: number,
  name: string,
  n: AgentNode,
  note: { text: string; color: string } | null,
  detail: string,
  now: number,
  focused: boolean,
  tip: string,
): string {
  const m = modelOf(n.model)
  const s = stateOf(n)
  const out = [`<title>${esc(tip)}</title>`]
  if (focused)
    out.push(
      `<rect x="${x - 14}" y="${y - 14}" width="196" height="186" rx="10" fill="${PX.cardHi}" stroke="${PX.cyan}" stroke-opacity="0.6" stroke-dasharray="3 3"/>`,
    )
  out.push(orb(x + 16, y + 16, m.color, n))
  out.push(`<text x="${x}" y="${y + 62}" fill="${PX.text}" font-size="14" font-weight="700" letter-spacing="1.5">${esc(name)}</text>`)
  out.push(
    `<text x="${x}" y="${y + 80}" fill="${m.color}" font-size="10.5" font-weight="700" letter-spacing="1.5">${m.short}${n.effort ? ` · ${esc(n.effort.toUpperCase().slice(0, 3))}` : ''}<tspan fill="${PX.faint}" font-weight="400">  ${elapsed(n, now)}</tspan></text>`,
  )
  out.push(
    `<text x="${x}" y="${y + 98}" fill="${s.color}" font-size="10.5" font-weight="700" letter-spacing="1.5">${statusGlyph(n)} ${s.word}</text>`,
  )
  if (note)
    out.push(`<text x="${x}" y="${y + 124}" fill="${note.color}" font-size="10.5" font-weight="700" letter-spacing="1">${esc(note.text)}</text>`)
  if (detail)
    wrap(detail, 26, 3).forEach((line, i) =>
      out.push(`<text x="${x}" y="${y + (note ? 142 : 124) + i * 15}" fill="${PX.muted}" font-size="10.5">${esc(line)}</text>`),
    )
  return `<g>${out.join('')}</g>`
}

/** What a step's card says beneath its title. */
function stepLine(s: Step, steps: Step[]): string {
  const n = s.node
  const last = n.activity[n.activity.length - 1]
  if (n.status === 'running') return last ? `▸ ${doing(last)}` : 'Reading the brief…'
  if (n.status === 'waiting') {
    const open = s.dependsOn.filter(d => steps.find(x => x.n === d)?.node.status !== 'done')
    return open.length ? `Starts after step ${open.join(', ')}` : 'Starts next'
  }
  const said = n.summary
    ?.split('\n')
    .map(l => l.trim())
    .find(l => /^DID:/i.test(l) || /^OPEN:/i.test(l) || (l && !/^CHANGED:/i.test(l)))
  if (said) return said.replace(/^\w+:\s*/, '')
  return s.files.map(f => f.split('/').slice(-1)[0]).join(', ')
}

function stepCard(x: number, y: number, w: number, h: number, s: Step, steps: Step[], now: number, focused: boolean): string {
  const n = s.node
  const m = modelOf(n.model)
  const st = stateOf(n)
  const live = n.status === 'running'
  // Characters that fit before the orb: 14px bold titles run ~8.6px a character, 10.5px lines ~6.4px.
  const titleChars = Math.floor((w - 80) / 8.6)
  const lineChars = Math.floor((w - 80) / 6.4)
  const tip = `${s.title}\n${s.files.join('\n')}${s.dependsOn.length ? `\nafter step ${s.dependsOn.join(', ')}` : ''}\n\n${clip(s.brief, 900)}`
  const out = [`<title>${esc(tip)}</title>`]
  out.push(
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${live || focused ? PX.cardHi : PX.card}" stroke="${focused ? PX.cyan : PX.line}"${focused ? ' stroke-dasharray="3 3"' : ''}/>`,
  )
  // The left edge carries the state's colour.
  out.push(
    `<rect x="${x}" y="${y + 10}" width="3" height="${h - 20}" rx="1.5" fill="${st.color}" opacity="${n.status === 'waiting' ? 0.35 : 0.9}"/>`,
  )
  out.push(
    `<text x="${x + 20}" y="${y + 22}" fill="${st.color}" font-size="10" font-weight="700" letter-spacing="1.5">${String(s.n).padStart(2, '0')} / ${st.word}</text>`,
  )
  out.push(
    `<text x="${x + 20}" y="${y + 43}" fill="${n.status === 'waiting' || n.status === 'skipped' ? PX.muted : PX.text}" font-size="14" font-weight="700">${esc(clip(s.title, titleChars))}</text>`,
  )
  const line = stepLine(s, steps)
  if (line) out.push(`<text x="${x + 20}" y="${y + 62}" fill="${live ? PX.cyan : PX.muted}" font-size="10.5">${esc(clip(line, lineChars))}</text>`)
  out.push(
    `<text x="${x + 20}" y="${y + h - 12}" fill="${m.color}" font-size="9.5" font-weight="700" letter-spacing="1.5">${m.short}<tspan fill="${PX.faint}" font-weight="400"> · ${elapsed(n, now)}${n.tokensIn + n.tokensOut ? ` · ${k(n.tokensIn + n.tokensOut)} NEW · ≈ ${usd(costOf(m.short, n))}` : ''}${n.toolCalls ? ` · ${n.toolCalls} CALLS` : ''}</tspan></text>`,
  )
  out.push(orb(x + w - 34, y + h / 2, m.color, n))
  return `<g>${out.join('')}</g>`
}

/** The sentence under the columns: what is happening right now. */
function nowLine(run: Run, now: number): { text: string; color: string } {
  if (run.status === 'failed' && run.error) return { text: run.error, color: PX.red }
  const running = [run.planner, ...run.steps.map(s => s.node), run.reviewer].filter(n => n.status === 'running')
  if (running.length) {
    const one = running[0]!
    const who = one === run.planner ? 'planner' : one === run.reviewer ? 'reviewer' : `step ${run.steps.find(s => s.node === one)?.n}`
    const last = one.activity[one.activity.length - 1]
    const more = running.length > 1 ? `  (+${running.length - 1} more working)` : ''
    return { text: `${modelOf(one.model).name} · ${who} · ${last ? doing(last).toLowerCase() : 'thinking'}${more}`, color: PX.text }
  }
  if (run.status === 'done')
    return {
      text: `Finished in ${clock((run.endedAt ?? now) - run.startedAt)} — ${run.verdict === 'NOT REVIEWED' ? 'not reviewed, so check the diff' : 'the reviewer passed it'}.`,
      color: PX.green,
    }
  if (run.verdict === 'NEEDS-WORK') return { text: 'The reviewer asked for changes. Open Review to read its findings.', color: PX.amber }
  if (run.status === 'failed') return { text: 'A step failed. Open it to read its report.', color: PX.red }
  return { text: 'Waiting…', color: PX.muted }
}

/** The whole picture for one run, at a fixed 980-pixel width the pane scales. */
export function flowSvg(run: Run, now: number, focus: string, advanced = false): string {
  const W = 980
  const pad = 28
  const steps = run.steps
  const cardH = 92
  const gap = 12
  const colTop = 152
  const colH = Math.max(186, steps.length ? steps.length * cardH + (steps.length - 1) * gap : cardH)
  const bodyEnd = colTop + colH + 24
  const H = bodyEnd + 92 + Math.max(1, totals(run).length) * 24
  const planX = pad + 24
  const codeX = 290
  const codeW = 380
  const revX = codeX + codeW + 120
  const sideY = colTop + colH / 2 - 70
  const live = run.status === 'planning' || run.status === 'coding' || run.status === 'reviewing'
  const parts: string[] = []
  const g: string[] = []

  parts.push(
    `<defs><radialGradient id="glow" cx="50%" cy="38%" r="70%"><stop offset="0%" stop-color="#1b2550" stop-opacity="0.55"/><stop offset="100%" stop-color="${PX.panel}" stop-opacity="0"/></radialGradient></defs>`,
  )
  parts.push(`<rect width="${W}" height="${H}" rx="16" fill="${PX.bg}"/>`)
  parts.push(`<rect x="8" y="8" width="${W - 16}" height="${H - 16}" rx="12" fill="${PX.panel}" stroke="${PX.line}"/>`)
  parts.push(`<rect x="8" y="8" width="${W - 16}" height="${H - 16}" rx="12" fill="url(#glow)"/>`)

  // Header.
  const rs = runState(run)
  const total = totals(run).reduce((a, [, t]) => a + spent(t), 0)
  const cost = totals(run).reduce((a, [, t]) => a + t.usd, 0)
  g.push(`<text x="${pad + 4}" y="50" fill="${PX.cyan}" font-size="17" font-weight="700" letter-spacing="2.5">◆ EXECUTOR</text>`)
  g.push(`<text x="${pad + 190}" y="49" fill="${PX.muted}" font-size="11" letter-spacing="1.5">RUN ${esc(run.id.toUpperCase())}</text>`)
  g.push(
    `<circle cx="${pad + 318}" cy="45" r="3.5" fill="${rs.color}">${live ? '<animate attributeName="opacity" values="1;0.3;1" dur="1.4s" repeatCount="indefinite"/>' : ''}</circle>`,
  )
  g.push(`<text x="${pad + 330}" y="49" fill="${rs.color}" font-size="11" font-weight="700" letter-spacing="1.5">${esc(rs.word)}</text>`)
  g.push(
    `<text x="${W - pad - 4}" y="49" fill="${PX.muted}" font-size="11" letter-spacing="1.5" text-anchor="end">TIME <tspan fill="${PX.text}">${clock((run.endedAt ?? now) - run.startedAt)}</tspan>    NEW TOKENS <tspan fill="${PX.text}">${k(total)}</tspan>    COST <tspan fill="${PX.text}">≈ ${usd(cost)}</tspan><title>New tokens: fresh input, cache writes and output across every agent in this run. Cache reads are left out. Cost is an estimate at list price, cache reads included.</title></text>`,
  )
  g.push(`<rect x="${pad}" y="70" width="${W - pad * 2}" height="1" fill="${PX.line}"/>`)

  // Goal.
  const doneSteps = steps.filter(s => s.node.status === 'done').length
  g.push(`<text x="${pad + 4}" y="99" fill="${PX.faint}" font-size="10" letter-spacing="2">GOAL</text>`)
  g.push(
    `<text x="${pad + 64}" y="99" fill="${PX.text}" font-size="12.5">${esc(clip(run.task.replace(/\s+/g, ' '), 96))}<title>${esc(clip(run.task, 1500))}</title></text>`,
  )
  g.push(
    `<text x="${W - pad - 4}" y="99" fill="${PX.cyan}" font-size="10.5" font-weight="700" letter-spacing="1.5" text-anchor="end">${steps.length ? `${doneSteps} / ${steps.length} STEPS` : 'PLANNING'}</text>`,
  )
  g.push(`<rect x="${pad}" y="118" width="${W - pad * 2}" height="1" fill="${PX.line}"/>`)

  // Column heads.
  g.push(`<text x="${planX}" y="${colTop - 12}" fill="${PX.faint}" font-size="10" letter-spacing="2">PLAN</text>`)
  g.push(
    `<text x="${codeX}" y="${colTop - 12}" fill="${PX.faint}" font-size="10" letter-spacing="2">STAGE / CODE${steps.length ? ` ×${steps.length}` : ''}</text>`,
  )
  g.push(`<text x="${revX}" y="${colTop - 12}" fill="${PX.faint}" font-size="10" letter-spacing="2">REVIEW</text>`)

  // Lines first, so the cards sit on them: briefs out of the planner, reports into the reviewer.
  const orbY = sideY + 16
  steps.forEach((s, i) => {
    const y = colTop + i * (cardH + gap) + cardH / 2
    g.push(link(planX + 40, orbY, codeX - 4, y, s.node.status === 'running', s.node.inChars ? `BRIEF ${k(s.node.inChars)}` : '', 'end'))
    g.push(
      link(
        codeX + codeW + 4,
        y,
        revX - 8,
        orbY,
        run.reviewer.status === 'running' && s.node.status === 'done',
        s.node.outChars ? `REPORT ${k(s.node.outChars)}` : '',
        'start',
      ),
    )
  })

  // The planner.
  g.push(
    sideNode(
      planX,
      sideY,
      'PLANNER',
      run.planner,
      run.planner.status === 'done'
        ? { text: `✓ PLAN READY · ${steps.length} STEP${steps.length === 1 ? '' : 'S'}`, color: PX.cyan }
        : run.planner.status === 'skipped'
          ? { text: `– SKIPPED · ${steps.length} BRIEF${steps.length === 1 ? '' : 'S'} GIVEN`, color: PX.muted }
          : null,
      run.planner.status === 'running' ? 'Reading the code and writing one brief per step.' : '',
      now,
      focus === 'planner',
      run.planSummary ?? 'Reads the code and writes one brief per step.',
    ),
  )

  // The steps, or a placeholder until the plan lands.
  if (!steps.length) {
    g.push(`<rect x="${codeX}" y="${colTop}" width="${codeW}" height="${cardH}" rx="10" fill="none" stroke="${PX.line}" stroke-dasharray="4 4"/>`)
    g.push(
      `<text x="${codeX + codeW / 2}" y="${colTop + cardH / 2 + 4}" fill="${PX.muted}" font-size="11" letter-spacing="1.5" text-anchor="middle">${
        run.status === 'failed' ? 'NO PLAN' : 'WAITING FOR THE PLAN<tspan><animate attributeName="opacity" values="1;0;1" dur="1s" repeatCount="indefinite"/>_</tspan>'
      }</text>`,
    )
  }
  steps.forEach((s, i) => g.push(stepCard(codeX, colTop + i * (cardH + gap), codeW, cardH, s, steps, now, focus === String(s.n))))

  // The reviewer, with its verdict and first finding.
  const v = run.verdict
  const note =
    v === 'PASS'
      ? { text: '✓ PASSED', color: PX.green }
      : v === 'NEEDS-WORK'
        ? { text: '! NEEDS WORK', color: PX.amber }
        : v === 'NOT REVIEWED'
          ? { text: '– SKIPPED · SMALL CHANGE', color: PX.muted }
          : v === 'NOT ASKED'
            ? { text: '– SKIPPED · NOT ASKED', color: PX.muted }
          : v
            ? { text: v, color: PX.red }
            : null
  const finding =
    run.reviewer.summary
      ?.split('\n')
      .map(l => l.trim())
      .filter(l => l && !/^VERDICT:/i.test(l))[0]
      ?.replace(/^[-*\d.\s]+/, '') ?? (run.reviewer.status === 'running' ? 'Reading the diff against the task.' : '')
  g.push(sideNode(revX, sideY, 'REVIEW', run.reviewer, note, finding, now, focus === 'reviewer', run.reviewer.summary ?? 'Reads the diff against the task.'))

  // Now.
  g.push(`<rect x="${pad}" y="${bodyEnd}" width="${W - pad * 2}" height="1" fill="${PX.line}"/>`)
  const nl = nowLine(run, now)
  g.push(`<text x="${pad + 4}" y="${bodyEnd + 32}" fill="${PX.faint}" font-size="10" letter-spacing="2">NOW</text>`)
  g.push(
    `<circle cx="${pad + 70}" cy="${bodyEnd + 28}" r="4" fill="${nl.color}">${live ? '<animate attributeName="opacity" values="1;0.35;1" dur="1.2s" repeatCount="indefinite"/>' : ''}</circle>`,
  )
  g.push(`<text x="${pad + 84}" y="${bodyEnd + 32}" fill="${nl.color}" font-size="12">${esc(clip(nl.text, 120))}</text>`)

  // Telemetry: one row per model. What was spent and what it cost; the
  // advanced view adds where the input came from.
  const rows = totals(run)
  const max = Math.max(1, ...rows.map(([, t]) => spent(t)))
  const x0 = pad + 4
  const barW = 220
  const col = { bar: x0 + 80, spent: x0 + 320, usd: x0 + 400, in: x0 + 500, cached: x0 + 650, out: x0 + 780 }
  const top = bodyEnd + 66
  const head = (x: number, label: string) =>
    `<text x="${x}" y="${top}" fill="${PX.faint}" font-size="9" letter-spacing="1.5">${label}</text>`
  if (rows.length) {
    g.push(head(x0, 'MODEL'), head(col.bar, 'SHARE OF NEW TOKENS'), head(col.spent, 'NEW'), head(col.usd, 'COST'))
    if (advanced) g.push(head(col.in, 'INPUT (W = CACHE WRITE)'), head(col.cached, 'CACHE READ'), head(col.out, 'OUTPUT'))
  }
  rows.forEach(([name, t], i) => {
    const y = top + 20 + i * 24
    const sum = spent(t)
    const cell = (x: number, v: string, fill: string = PX.muted) => `<text x="${x}" y="${y}" fill="${fill}" font-size="10.5">${v}</text>`
    g.push(`<text x="${x0}" y="${y}" fill="${t.color}" font-size="10" font-weight="700" letter-spacing="1.5">${name}</text>`)
    g.push(`<rect x="${col.bar}" y="${y - 8}" width="${barW}" height="8" rx="4" fill="${PX.line}"/>`)
    g.push(`<rect x="${col.bar}" y="${y - 8}" width="${Math.max(4, Math.round((sum / max) * barW))}" height="8" rx="4" fill="${t.color}" opacity="0.85"/>`)
    g.push(cell(col.spent, k(sum), PX.text), cell(col.usd, `≈ ${usd(t.usd)}`, PX.text))
    if (advanced)
      g.push(
        cell(col.in, `${k(t.in)}${t.written ? `<tspan fill="${PX.faint}"> (${k(t.written)} W)</tspan>` : ''}`),
        cell(col.cached, k(t.cached)),
        cell(col.out, k(t.out)),
      )
  })
  if (!rows.length) g.push(`<text x="${x0}" y="${top + 4}" fill="${PX.faint}" font-size="10" letter-spacing="1.5">NO TOKENS YET</text>`)

  parts.push(`<g font-family="${FONT}">${g.join('\n')}</g>`)
  return `<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${parts.join('\n')}</svg>`
}
