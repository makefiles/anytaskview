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

## Choosing the form

Pick the form that fits each part of the problem and mix two or three in a view. Keep parts whose status you will update as boxes: Mermaid has no live status per element (the part itself takes a `status`).

| Content | Form |
|---|---|
| Parts, suspects, options you will mark done or fail | `box` + `edge` (`shape`, `icon`) |
| Comparison, options with trade-offs, test results, numbers | `table` (`cols`, `rows`) |
| Who calls whom, in order | `mermaid` sequenceDiagram |
| States and transitions | `mermaid` stateDiagram-v2 |
| Schedule | `mermaid` gantt |
| History, releases | `mermaid` timeline |
| Share of a whole | `mermaid` pie |
| Values across items or over time | `mermaid` xychart-beta (bar, line) |
| Brainstorm, outline of ideas | `mermaid` mindmap |
| Data model, classes | `mermaid` erDiagram, classDiagram |
| Document outline, checklist | `list` + `item` |

- `shape`: `rect` (default), `round` (screen, step), `circle` (start, end, event), `diamond` (decision), `hexagon` (preparation), `cylinder` (database, store), `doc` (document, file).
- `icon`: server, db, file, folder, user, users, cloud, code, terminal, bug, test, lock, key, gear, phone, monitor, chart, mail, clock, search, warn, net, pkg, branch, link. Use one only when it tells the kind of thing at a glance.
- `table`: up to 8 columns and 40 rows, 120 characters a cell. Resending `rows` replaces them all, so keep tables short and update them at milestones, not every step.
- `mermaid`: one diagram per part, small (about 12 nodes or messages). Diagrams render offline in strict mode; links are removed. A syntax error shows on the board instead of the diagram.

## Patterns

- Bug hunt: one `group` per area, one `box` per suspect with `ref` (path:line) and a `note` with the evidence; set the confirmed cause `done`, ruled-out ones `fail`. Add a `table` of what you reproduced (case, expected, actual).
- Change across files: boxes for the call path in order, `edge` between them; mark the box you are editing `doing`. A `diamond` box for the branch that decides the behaviour.
- Document or report: a `list` with one `item` per section; nested items for sub-sections; status per section.
- Decision with options: a `table` with one row per option and its trade-offs, `status` `wait` while the user decides, the recommended one in `note`; after the answer, `note` the decision.
- Flow the user must read as a whole (calls in order, a state machine, a schedule): one `mermaid` part next to the boxes.

Keep each view small: about 8 boxes, short tables and diagrams. When a structure is finished, `del` it or `clear` before the next problem instead of growing one huge diagram.

## Example

```json
plan: {"steps":[{"id":"s1","title":"원인 찾기","status":"doing"},{"id":"s2","title":"고치기"},{"id":"s3","title":"검증"}]}
draw: {"ops":[{"id":"g","kind":"group","label":"의심 지점"},
  {"id":"a","kind":"box","in":"g","label":"파서 경계값","ref":"src/parse.c:120","status":"doing","icon":"code"},
  {"id":"b","kind":"box","in":"g","label":"버퍼 길이","ref":"src/buf.c:40"},
  {"id":"t","kind":"table","label":"재현","cols":["입력","기대","실제"],"rows":[["빈 줄","무시","멈춤"],["한 줄","읽음","읽음"]]},
  {"id":"q","kind":"mermaid","label":"호출 순서","src":"sequenceDiagram\n  읽기->>파서: 줄\n  파서->>버퍼: 복사\n  버퍼-->>파서: 넘침"}]}
note: {"text":"빈 줄에서만 재현됨","kind":"why","on":"a"}
plan: {"steps":[{"id":"s1","status":"done"},{"id":"s2","status":"doing"}]}
```

## Opening the board

The board runs at `http://127.0.0.1:4871/` and starts automatically with the first session. When the user asks you to open the board, run `"<plugin folder>/scripts/atv" board --open` yourself: it starts the board server if it is down and opens this PC's default browser through a private redirect file, so the key never appears in the output. After that the user can open `http://127.0.0.1:4871/` in that browser. If it says there is no browser opener (a remote shell), tell the user to run `"<plugin folder>/scripts/atv" board --url` in their own terminal and open the printed address; never run `--url` yourself or print the address. After a plugin update, if a tool result says the board server is a different version, tell the user to run `<plugin folder>/scripts/atv board --stop`; the next tool call starts the new version.

The plugin folder is `${CLAUDE_PLUGIN_ROOT}` in Claude Code (two folders above this skill's base directory if the variable is not filled in). In Codex it is `~/.codex/plugins/cache/anytaskview/anytaskview/local/`, so run `"$HOME/.codex/plugins/cache/anytaskview/anytaskview/local/scripts/atv" board --open`.
