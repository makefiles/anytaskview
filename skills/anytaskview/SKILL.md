---
name: anytaskview
description: Detailed guide for drawing your work on the anytaskview live progress board (plan, draw, note, ids tools). Use when you start a multi-step task and want to plan or draw it well, when the user asks how to open or use the board, or when you are unsure what to draw.
---

# anytaskview board guide

The user follows your work on a local browser board. The MCP server instructions hold the rules; this guide adds patterns and examples. Write labels, titles and notes in the user's language.

## Sending

Board calls ride along with your work: put them first in the same message as your next Read, Bash, Edit or other tool calls. A message holding only board calls is a whole extra turn in which the full context is read again. After the last tool result, answer directly; a step still `doing` is closed by your next tool calls. The one exception is a `note` kind `wait` (approval) or `blocked` (stuck) right before you stop to ask the user, when no tool call is left to carry it. A step with a `wait` note stays waiting until the user answers; do not mark it `done` yourself.

## What goes where

- **plan**: the steps of *your* work (investigate, design, implement, verify). One call with all steps after you form a plan; later calls send only changed statuses. Set the old step `done` and the new one `doing` in the same call.
- **draw**: the structure of the *problem* (features, suspects, call paths, data flow, decisions). Not folder layouts, not every file you touch: hooks already post edits, commands and subagents.
- **note**: one timeline line for a reason (`why`), a decision (`decision`), being stuck (`blocked`) or waiting for approval (`wait`). `on` attaches it to a step or part.
- **ids**: only when you lost track of ids, for example after compaction.
- **project**: work spanning several conversations. A `[anytaskview 프로젝트]` line at session start lists candidates; join one with `{action:"join", id}` when the user's work matches. Create one (`{action:"create", name, purpose}`) only when the user starts work meant to span conversations. The user's own choice (drag on the board, their resume phrase) wins; a refusal is not an error to retry.

## Project board (big picture)

While the conversation belongs to a project, add `project:"<id>"` to plan/draw/note only at milestones: a work unit starts or ends, or a user decision is made or awaited. Units are plan steps (`u01` "01 첫 화판" done, `u08` "08 …" doing, and the next planned units as todo so the user sees what comes), open decisions are `note` kind `wait` on the unit. Keep one drawing there that shows the whole road: one box per unit in order with an edge to the next (done, the current one doing, planned ones todo; box ids must differ from step ids, e.g. box `b01` for step `u01`), extended when a unit starts, ends or is added; group finished phases if the road gets long, and the board folds them. Never `clear` it (other conversations share it); remove parts with `del`. Session detail stays on the session board (no `project`).

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

- Bug hunt: inside the task group, one `group` per area, one `box` per suspect with `ref` (path:line) and a `note` with the evidence; set the confirmed cause `done`, ruled-out ones `fail`. Add a `table` of what you reproduced (case, expected, actual).
- Change across files: boxes for the call path in order, `edge` between them; mark the box you are editing `doing`. A `diamond` box for the branch that decides the behaviour.
- Document or report: a `list` with one `item` per section; nested items for sub-sections; status per section.
- Decision with options: a `table` with one row per option and its trade-offs, `status` `wait` while the user decides, the recommended one in `note`; after the answer, `note` the decision.
- Flow the user must read as a whole (calls in order, a state machine, a schedule): one `mermaid` part next to the boxes.

Keep each group small: about 8 boxes, short tables and diagrams.

The user wants to see the whole work at a glance, not a new picture per task. Draw each task inside one `group` titled with the task; inside it you have three more levels (for example an area group, a list in it, the list's items). In a long conversation each new task (a new set of plan steps) in the same work adds its own `group` to the existing drawing, sent with that plan, and may link it to earlier parts with edges; routine steps such as commit and push need none. Give a finished task's parts their final status (the group folds once nothing in it is doing, blocked or wait) in the message with your last tool calls for that task, not in a board-only message. The board folds a finished group into one box (the user clicks it to unfold), so the drawing stays readable as it grows. Use `clear` only when the subject changes completely (another project or problem); `del` parts that turned out wrong. If the drawing is still from before the task's steps, the board marks it as an earlier task's drawing and the next plan result says so once.

## Example

One message: plan, draw and the first Read of the work.

```json
plan: {"steps":[{"id":"s1","title":"원인 찾기","status":"doing"},{"id":"s2","title":"고치기"},{"id":"s3","title":"검증"}]}
draw: {"ops":[{"id":"t1","kind":"group","label":"빈 줄 멈춤 고치기"},{"id":"g","kind":"group","in":"t1","label":"의심 지점"},
  {"id":"a","kind":"box","in":"g","label":"파서 경계값","ref":"src/parse.c:120","status":"doing","icon":"code"},
  {"id":"b","kind":"box","in":"g","label":"버퍼 길이","ref":"src/buf.c:40"},
  {"id":"t","kind":"table","in":"t1","label":"재현","cols":["입력","기대","실제"],"rows":[["빈 줄","무시","멈춤"],["한 줄","읽음","읽음"]]},
  {"id":"q","kind":"mermaid","in":"t1","label":"호출 순서","src":"sequenceDiagram\n  읽기->>파서: 줄\n  파서->>버퍼: 복사\n  버퍼-->>파서: 넘침"}]}
Read: {"file_path":"src/parse.c"}
```

A later message: the note and the step change ride with the first edit of the next step.

```json
note: {"text":"빈 줄에서만 재현됨","kind":"why","on":"a"}
plan: {"steps":[{"id":"s1","status":"done"},{"id":"s2","status":"doing"}]}
Edit: {"file_path":"src/parse.c", …}
```

## Opening the board

The board runs at `http://127.0.0.1:4871/` and starts automatically with the first session. When the user asks you to open the board, run `"<plugin folder>/scripts/atv" board --open` yourself: it starts the board server if it is down and opens this PC's default browser through a private redirect file, so the key never appears in the output. After that the user can open `http://127.0.0.1:4871/` in that browser. If it says there is no browser opener (a remote shell), tell the user to run `"<plugin folder>/scripts/atv" board --url` in their own terminal and open the printed address; never run `--url` yourself or print the address. After a plugin update, if a tool result says the board server is a different version, tell the user to run `<plugin folder>/scripts/atv board --stop`; the next tool call starts the new version.

The plugin folder is `${CLAUDE_PLUGIN_ROOT}` in Claude Code (two folders above this skill's base directory if the variable is not filled in). In Codex it is `~/.codex/plugins/cache/anytaskview/anytaskview/local/`, so run `"$HOME/.codex/plugins/cache/anytaskview/anytaskview/local/scripts/atv" board --open`.
