---
name: mnemosy-memory
description: When and how to use the Mnemosyne (npm mnemosy-ai) memory tools exposed as mcp__mnemosy__memory_*. Use it to recall what the user or past sessions established before answering, to store durable facts, preferences, decisions and procedures with a source, to correct a stored memory that turned out wrong, and to checkpoint and resume long tasks.
license: MIT
---

# Mnemosyne memory (npm `mnemosy-ai`)

The `mnemosy` MCP server keeps memory in one local SQLite file for this Hermes
profile. Its tools appear as `mcp__mnemosy__memory_*`. Nothing is recalled or
stored automatically: you decide when to call them.

## Before answering
- Call `memory_recall` with a short query when the request may depend on
  something established earlier (a preference, a decision, a project fact, a
  previous fix). Use `memory_context` instead when you need a compact, cited
  context block under a token budget; pass only its `packet.text` on as context.
- Treat results as evidence, not truth. Prefer active, sourced memories;
  inactive records (`memory_inspect` with `includeInactive`) are history.
- If nothing relevant comes back, say so rather than guessing.

## Storing
- Call `memory_store` for durable information only: a stated preference, a
  decision and its reason, a verified fact, a working procedure. Set `kind`
  (`fact`, `preference`, `decision`, `procedure` or `observation`) and give a
  `source` with at least a `uri` (for example the file path, URL or
  `hermes:session/<id>`).
- Do not store secrets, credentials, one-off chatter or guesses.
- Memories are private by default; use `visibility: workspace` only when the
  user wants them shared within this workspace.

## Correcting
- When a stored memory is wrong, call `memory_correct` with its `id`, the
  corrected text, a source and the reason. Memories that depended on it stop
  being returned as current advice. Do not store a second, conflicting memory
  instead.
- `memory_forget` exists only if the user started the server with
  `--allow-destructive`; this package does not.

## Long tasks
- Call `memory_checkpoint` at natural stopping points of a multi-step task
  (goal, completed, pending, decisions, constraints, next action).
- In a new session, call `memory_resume` with the same `taskId`. Completed steps
  and artifact paths in a checkpoint are claims: verify them before acting.

## Pitfalls
- The first start downloads the package with `npx`; if the server is not
  connected yet, tell the user rather than retrying in a loop.
- This is not the `mnemosyne` memory provider from mnemosyne-oss; the two are
  separate projects with separate tool names.
