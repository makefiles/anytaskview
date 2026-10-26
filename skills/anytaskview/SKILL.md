---
name: anytaskview
description: Detailed guide for drawing your work on the anytaskview live progress board (plan, draw, note, ids tools). Use when you start a multi-step task and want to plan or draw it well, when the user asks how to open or use the board, or when you are unsure what to draw.
---

# anytaskview board guide

The user follows your work on a local browser board. The MCP server instructions hold the rules; this guide adds patterns and examples. Write labels, titles and notes in the user's language.

## What goes where

- **plan**: the steps of *your* work (investigate, design, implement, verify). One call with all steps after you form a plan; later calls send only changed statuses. Set the old step `done` and the new one `doing` in the same call.
- **draw**: the structure of the *problem* (features, suspects, call paths, data flow, decisions). Not folder layouts, not every file you touch: hooks already post edits, commands and subagents.
- **note**: one timeline line for a reason (`why`), a decision (`decision`), being stuck (`blocked`) or waiting for approval (`wait`). `on` attaches it to a step or part.
- **ids**: only when you lost track of ids, for example after compaction.
- **project**: work spanning several conversations. A `[anytaskview 프로젝트]` line at session start lists candidates; join one with `{action:"join", id}` when the user's work matches. Create one (`{action:"create", name, purpose}`) only when the user starts work meant to span conversations. The user's own choice (drag on the board, their resume phrase) wins; a refusal is not an error to retry.

## Project board (big picture)

While the conversation belongs to a project, add `project:"<id>"` to plan/draw/note only at milestones: a work unit starts or ends, or a user decision is made or awaited. Units are plan steps (`u01` "01 첫 화판" done, `u08` "08 …" doing), open decisions are `note` kind `wait` on the unit, and a few boxes may show the current unit's parts. Never `clear` it (other conversations share it); remove parts with `del`. Session detail stays on the session board (no `project`).

## Patterns

- Bug hunt: one `group` per area, one `box` per suspect with `ref` (path:line) and a `note` with the evidence; set the confirmed cause `done`, ruled-out ones `fail`.
- Change across files: boxes for the call path in order, `edge` between them; mark the box you are editing `doing`.
- Document or report: a `list` with one `item` per section; nested items for sub-sections; status per section.
- Decision with options: a `group` "options" with one box per option, the recommended one noted; after the user answers, mark the chosen one `done` and the others `fail`.
- A sequence or state machine the user must read as a whole: one `mermaid` part (keep it small; boxes update better than Mermaid).

Keep about 8 boxes visible. When a structure is finished, `del` it or `clear` before the next problem instead of growing one huge diagram.

## Example

```json
plan: {"steps":[{"id":"s1","title":"원인 찾기","status":"doing"},{"id":"s2","title":"고치기"},{"id":"s3","title":"검증"}]}
draw: {"ops":[{"id":"g","kind":"group","label":"의심 지점"},
  {"id":"a","kind":"box","in":"g","label":"파서 경계값","ref":"src/parse.c:120","status":"doing"},
  {"id":"b","kind":"box","in":"g","label":"버퍼 길이","ref":"src/buf.c:40"}]}
note: {"text":"빈 줄에서만 재현됨","kind":"why","on":"a"}
plan: {"steps":[{"id":"s1","status":"done"},{"id":"s2","status":"doing"}]}
```

## Opening the board

The board runs at `http://127.0.0.1:4871/` and starts automatically with the first session. A browser needs the read token once: tell the user to run `"${CLAUDE_PLUGIN_ROOT}/scripts/atv" board --url` in their own terminal and open the printed address. Never run it yourself or print the token. After a plugin update, if a tool result says the board server is a different version, tell the user to run `"${CLAUDE_PLUGIN_ROOT}/scripts/atv" board --stop`; the next tool call starts the new version.
