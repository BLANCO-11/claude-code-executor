# executor

A Claude Code mod that splits a coding task across models:

- **Opus 5.5 (medium effort)** plans: it reads the code and writes one self-contained brief per step.
- **Haiku 5.5 or Sonnet 5.5** coders carry out the steps. Haiku takes fully specified edits; Sonnet takes steps that need judgement. Independent steps run in parallel.
- **Opus 5.5** reviews the diff. The planner may skip the review for a small, fully specified change; a step that fails always gets one.

The model calls one tool, `run`, and the report comes back as a message when the work is done. The **Executor** pane (`/executor`) shows each agent live: what it is doing, what it was handed and what it handed back, and the tokens each model used.

**Your own briefs.** When the calling conversation has already read the code, it passes `steps` (each with its files, model and the `check` that proves it) and the planner is skipped, so the code is read for planning once instead of twice. A brief without files or a check is refused before anything runs. A step counts as done only when its coder reports `CHECK: PASS`. The Opus review then runs only with `review: true` or when a step failed; otherwise the caller checks the diff itself.

Agents start without the repository's `CLAUDE.md`, so a very large one is not re-read by every agent; the planner looks up the rules it needs and copies them into the briefs.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install executor --marketplace BLANCO-11/claude-code-executor
```

From a shell:

```
claude plugin install executor --marketplace BLANCO-11/claude-code-executor
```

Answer `y` to add the marketplace, then choose a scope.

The repository is public, so any machine can install it.

## Tests

```
claude plugin test .
```
