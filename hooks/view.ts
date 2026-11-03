import type { AgentNode, Run } from '../types'

// The executor's picture: a retro arcade / CRT screen. Each agent is a pixel
// robot coloured by its model; a working robot bobs and blinks and says what
// it is doing in a speech bubble; briefs travel to the coders as packets on a
// conveyor. Everything else (briefs, reports, the activity log) lives behind a
// hover tooltip or the pane's details view, so the screen itself stays quiet.

export const PX = {
  bg: '#07100b',
  bezel: '#0d1a12',
  grid: '#10291b',
  phosphor: '#3dff8f',
  dim: '#2f6e4a',
  faint: '#1c3d2a',
  amber: '#ffb347',
  red: '#ff5c6c',
  white: '#e8fff1',
  opus: '#d39bff',
  sonnet: '#6cc4ff',
  haiku: '#4ff0d0',
}

const FONT = `ui-monospace, 'SF Mono', Menlo, Consolas, 'Courier New', monospace`

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
  return { name: model, short: model.toUpperCase().slice(0, 8), color: PX.dim }
}

// A 10×10 robot. H head, E eye, A antenna light, M mouth, B body.
const ROBOT = [
  '....AA....',
  '.....H....',
  '..HHHHHH..',
  '.HHEHHEHH.',
  '.HHHHHHHH.',
  '.HHMMMMHH.',
  '..HHHHHH..',
  '...BBBB...',
  '..BBBBBB..',
  '..B.BB.B..',
]

function robot(x: number, y: number, s: number, color: string, status: AgentNode['status']): string {
  const working = status === 'running'
  const off = status === 'waiting' || status === 'skipped'
  const face = status === 'failed' ? PX.red : PX.bg
  const cells: string[] = []
  ROBOT.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      const ch = row[c]
      if (ch === '.') continue
      let fill = color
      let extra = ''
      if (ch === 'E') {
        fill = status === 'failed' ? PX.red : working ? PX.white : PX.bg
        if (working) extra = `<animate attributeName="height" values="${s};${s};1;${s}" keyTimes="0;0.85;0.92;1" dur="2.6s" repeatCount="indefinite"/>`
      } else if (ch === 'M') fill = face
      else if (ch === 'A') {
        fill = working ? PX.amber : status === 'done' ? PX.phosphor : status === 'failed' ? PX.red : PX.faint
        if (working) extra = `<animate attributeName="opacity" values="1;0.2;1" dur="0.8s" repeatCount="indefinite"/>`
      } else if (ch === 'B') fill = color
      cells.push(
        `<rect x="${x + c * s}" y="${y + r * s}" width="${s}" height="${s}" fill="${fill}"${ch === 'B' ? ' opacity="0.7"' : ''}>${extra}</rect>`,
      )
    }
  })
  const bob = working
    ? `<animateTransform attributeName="transform" type="translate" values="0 0;0 -${Math.max(1, s / 2)};0 0" dur="0.9s" repeatCount="indefinite"/>`
    : ''
  return `<g opacity="${off ? 0.32 : 1}">${bob}${cells.join('')}</g>`
}

function stamp(status: AgentNode['status']): string {
  const word =
    status === 'done' ? 'DONE' : status === 'failed' ? 'FAIL' : status === 'running' ? 'WORKING' : status === 'skipped' ? 'SKIP' : 'IDLE'
  const color =
    status === 'done' ? PX.phosphor : status === 'failed' ? PX.red : status === 'running' ? PX.amber : PX.dim
  const blink = status === 'running' ? `<animate attributeName="opacity" values="1;0.35;1" dur="1.2s" repeatCount="indefinite"/>` : ''
  return `<tspan fill="${color}">${blink}${word}</tspan>`
}

/** "Edit src/app/tools/page.tsx" → "EDIT TOOLS/PAGE.TSX". */
export function doing(activity: string): string {
  const [verb, ...rest] = activity.split(' ')
  const arg = rest.join(' ')
  const short = /^[\w./()@[\]-]+\/[\w.@()[\]-]+$/.test(arg) ? arg.split('/').slice(-2).join('/') : arg
  return `${verb ?? ''} ${short}`.trim().toUpperCase()
}

function conveyor(x1: number, y1: number, x2: number, y2: number, labelAt: 'start' | 'end', label: string, live: boolean): string {
  const mx = Math.round((x1 + x2) / 2)
  const d = `M${x1},${y1} H${mx} V${y2} H${x2}`
  const packets = live
    ? [0, 0.5]
        .map(
          b =>
            `<rect width="5" height="5" x="-2.5" y="-2.5" fill="${PX.amber}"><animateMotion dur="1.6s" begin="${b * 1.6}s" repeatCount="indefinite" path="${d}"/></rect>`,
        )
        .join('')
    : ''
  return `<path d="${d}" fill="none" stroke="${live ? PX.amber : PX.faint}" stroke-width="2" stroke-dasharray="2 4"/>${packets}${
    label
      ? labelAt === 'end'
        ? `<text x="${x2 - 4}" y="${y2 - 5}" fill="${PX.dim}" font-size="9" text-anchor="end">${esc(label)}</text>`
        : `<text x="${x1 + 4}" y="${y1 - 5}" fill="${PX.dim}" font-size="9">${esc(label)}</text>`
      : ''
  }`
}

type Card = { id: string; label: string; node: AgentNode; tip: string; after?: number[] }

/**
 * One agent. `stack` (planner, reviewer): the robot, its words beneath it, so the
 * conveyors meet the robot and never cross text. `row` (a coder): the robot
 * left, its words to the right, one row of the CODE column.
 */
function agentCard(x: number, y: number, card: Card, now: number, layout: 'stack' | 'row', focused: boolean): string {
  const m = modelOf(card.node.model)
  const n = card.node
  const s = layout === 'stack' ? 5 : 4
  const size = 10 * s
  const last = n.activity[n.activity.length - 1]
  const tx = layout === 'stack' ? x : x + size + 12
  const ty = layout === 'stack' ? y + size + 18 : y + 11
  const width = layout === 'stack' ? 17 : 26
  const parts: string[] = [`<title>${esc(card.tip)}</title>`]
  if (focused)
    parts.push(`<rect x="${x - 6}" y="${y - 6}" width="${size + 12}" height="${size + 12}" fill="none" stroke="${PX.phosphor}" stroke-dasharray="3 3"/>`)
  parts.push(robot(x, y, s, m.color, n.status))
  parts.push(
    `<text x="${tx}" y="${ty}" fill="${PX.white}" font-size="${layout === 'stack' ? 12 : 11}" font-weight="700" letter-spacing="1">${esc(clip(card.label.toUpperCase(), width))}</text>`,
  )
  parts.push(
    `<text x="${tx}" y="${ty + 14}" fill="${m.color}" font-size="10" letter-spacing="1">${m.short}${n.effort ? `·${n.effort.toUpperCase().slice(0, 3)}` : ''}<tspan fill="${PX.dim}">  ${elapsed(n, now)}</tspan></text>`,
  )
  const after = card.after?.length ? `  AFTER ${card.after.join(',')}` : ''
  parts.push(
    `<text x="${tx}" y="${ty + 28}" font-size="10" letter-spacing="1">${stamp(n.status)}<tspan fill="${PX.dim}">${n.tokensOut ? `  OUT ${k(n.tokensOut)}` : ''}${n.status === 'waiting' ? after : ''}</tspan></text>`,
  )
  if (n.status === 'running' && last)
    parts.push(
      `<text x="${tx}" y="${ty + 42}" fill="${PX.amber}" font-size="9.5" letter-spacing="0.5">▸ ${esc(clip(doing(last), width + 6))}</text>`,
    )
  return `<g>${parts.join('')}</g>`
}

export function stageOf(run: Run): string {
  return run.status === 'planning'
    ? 'PLAN'
    : run.status === 'coding'
      ? 'CODE'
      : run.status === 'reviewing'
        ? 'REVIEW'
        : run.status === 'done'
          ? 'CLEAR'
          : 'GAME OVER'
}

export function totals(run: Run): [string, { in: number; cached: number; out: number; color: string }][] {
  const by = new Map<string, { in: number; cached: number; out: number; color: string }>()
  for (const n of [run.planner, ...run.steps.map(s => s.node), run.reviewer]) {
    const m = modelOf(n.model)
    const t = by.get(m.short) ?? { in: 0, cached: 0, out: 0, color: m.color }
    t.in += n.tokensIn
    t.cached += n.tokensCached
    t.out += n.tokensOut
    by.set(m.short, t)
  }
  return [...by.entries()].filter(([, t]) => t.in + t.out + t.cached > 0)
}

/** The whole screen for one run, at a fixed 760-pixel width the pane scales. */
export function arcadeSvg(run: Run, now: number, focus: string): string {
  const W = 760
  const steps = run.steps
  const rowH = 72
  const top = 82
  const stackH = 112 // a stacked card: the robot and three lines beneath it
  const colH = Math.max(1, steps.length) * rowH
  const H = Math.max(top + stackH + 52, top + colH + 46)
  // The planner and reviewer sit level with the middle of the CODE column.
  const midY = Math.max(top, top + colH / 2 - stackH / 2)
  const planX = 40
  const codeX = 236
  const codeEnd = 512 // where a coder's words end and its report leaves
  const revX = 600
  const parts: string[] = []

  parts.push(`<defs>
<pattern id="scan" width="4" height="3" patternUnits="userSpaceOnUse"><rect width="4" height="1" fill="#000" opacity="0.35"/></pattern>
<filter id="glow" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="1.1" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<radialGradient id="vig" cx="50%" cy="50%" r="75%"><stop offset="60%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#000" stop-opacity="0.55"/></radialGradient>
</defs>`)
  parts.push(`<rect width="${W}" height="${H}" rx="14" fill="${PX.bezel}"/>`)
  parts.push(`<rect x="6" y="6" width="${W - 12}" height="${H - 12}" rx="10" fill="${PX.bg}"/>`)

  const g: string[] = []
  // HUD.
  const total = totals(run).reduce((a, [, t]) => a + t.in + t.cached + t.out, 0)
  g.push(`<text x="24" y="32" fill="${PX.phosphor}" font-size="13" font-weight="700" letter-spacing="2">▶ EXECUTOR</text>`)
  g.push(`<text x="150" y="32" fill="${PX.dim}" font-size="11" letter-spacing="1">RUN ${esc(run.id.toUpperCase())}</text>`)
  const stage = stageOf(run)
  const stageColor = run.status === 'done' ? PX.phosphor : run.status === 'failed' ? PX.red : PX.amber
  g.push(
    `<text x="270" y="32" fill="${stageColor}" font-size="11" font-weight="700" letter-spacing="2">STAGE ${stage}${run.verdict ? ` · ${esc(run.verdict)}` : ''}</text>`,
  )
  g.push(
    `<text x="${W - 24}" y="32" fill="${PX.dim}" font-size="11" text-anchor="end" letter-spacing="1">TIME ${clock((run.endedAt ?? now) - run.startedAt)}  ·  TOKENS ${k(total)}</text>`,
  )
  g.push(`<rect x="24" y="42" width="${W - 48}" height="1" fill="${PX.faint}"/>`)
  // Column heads.
  for (const [x, t] of [
    [planX, 'PLAN'],
    [codeX, `CODE ×${steps.length || '?'}`],
    [revX, 'REVIEW'],
  ] as [number, string][])
    g.push(`<text x="${x}" y="62" fill="${PX.faint}" font-size="9.5" letter-spacing="3">${t}</text>`)

  // Conveyors first, so the robots sit on top: briefs out of the planner,
  // reports into the reviewer, each labelled with what it carries.
  steps.forEach((s, i) => {
    const y = top + i * rowH + 20
    g.push(
      conveyor(planX + 56, midY + 25, codeX - 10, y, 'end', s.node.inChars ? `BRIEF ${k(s.node.inChars)}` : '', s.node.status === 'running'),
    )
    g.push(
      conveyor(
        codeEnd,
        y,
        revX - 10,
        midY + 25,
        'start',
        s.node.outChars ? `REPORT ${k(s.node.outChars)}` : '',
        run.reviewer.status === 'running' && s.node.status === 'done',
      ),
    )
  })

  g.push(
    agentCard(
      planX,
      midY,
      { id: 'planner', label: 'Planner', node: run.planner, tip: run.planSummary ?? 'Reads the code and writes one brief per step.' },
      now,
      'stack',
      focus === 'planner',
    ),
  )
  if (!steps.length)
    g.push(
      `<text x="${codeX}" y="${midY + 30}" fill="${PX.dim}" font-size="11" letter-spacing="1">WAITING FOR THE PLAN<tspan><animate attributeName="opacity" values="1;0;1" dur="1s" repeatCount="indefinite"/>_</tspan></text>`,
    )
  steps.forEach((s, i) => {
    g.push(
      agentCard(
        codeX,
        top + i * rowH,
        {
          id: String(s.n),
          label: `${s.n}. ${s.title}`,
          node: s.node,
          after: s.dependsOn,
          tip: `${s.title}\n${s.files.join('\n')}${s.dependsOn.length ? `\nafter step ${s.dependsOn.join(', ')}` : ''}\n\n${clip(s.brief, 900)}`,
        },
        now,
        'row',
        focus === String(s.n),
      ),
    )
  })
  g.push(
    agentCard(
      revX,
      midY,
      { id: 'reviewer', label: run.verdict ? `Review · ${run.verdict}` : 'Review', node: run.reviewer, tip: run.reviewer.summary ?? 'Reads the diff against the task.' },
      now,
      'stack',
      focus === 'reviewer',
    ),
  )

  // Token bars along the bottom, one per model.
  const bars = totals(run)
  const max = Math.max(1, ...bars.map(([, t]) => t.in + t.cached + t.out))
  bars.forEach(([name, t], i) => {
    const x = 24 + i * 245
    const y = H - 26
    const w = Math.round(((t.in + t.cached + t.out) / max) * 110)
    g.push(`<text x="${x}" y="${y + 8}" fill="${t.color}" font-size="9.5" letter-spacing="1">${name}</text>`)
    g.push(`<rect x="${x + 50}" y="${y}" width="110" height="9" fill="${PX.faint}"/>`)
    g.push(`<rect x="${x + 50}" y="${y}" width="${w}" height="9" fill="${t.color}" opacity="0.85"/>`)
    g.push(`<text x="${x + 166}" y="${y + 8}" fill="${PX.dim}" font-size="9">${k(t.in + t.cached + t.out)}</text>`)
  })

  parts.push(`<g filter="url(#glow)" font-family="${FONT}">${g.join('\n')}</g>`)
  parts.push(`<rect x="6" y="6" width="${W - 12}" height="${H - 12}" rx="10" fill="url(#scan)" pointer-events="none"/>`)
  parts.push(`<rect x="6" y="6" width="${W - 12}" height="${H - 12}" rx="10" fill="url(#vig)" pointer-events="none"/>`)

  return `<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${parts.join('\n')}</svg>`
}
