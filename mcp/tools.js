// MCP 도구 정의와 서버 안내문. 세션마다 LLM 맥락에 실리므로 짧은 영어로 쓴다(한국어보다 토큰이 덜 든다).
// 화판에 보이는 이름표·글은 사용자 언어로 쓰라고 안내한다.
import { STATUSES, NOTE_KINDS, DRAW_KINDS, SHAPES, ICONS } from "../lib/scene.js";

const str = { type: "string" };
const strOrNull = { type: ["string", "null"] };
const status = { type: ["string", "null"], enum: [...STATUSES, null] };

export const INSTRUCTIONS = `anytaskview: live progress board. Tools plan, draw, note, ids, project.
The user watches this board in a browser tab to follow your work. Hooks already post file edits, commands and subagents, so never draw those.
Board calls ride along: put them first in the same message as your other tool calls. A message holding only board calls costs a whole extra turn (the full context is read again), so do not send one, except the wait or blocked note below.
When to call (at these moments, not on every tool call):
- After you form a plan: plan once with all steps, in the same message as your first draw and the first tool calls of the work.
- When a step starts or ends: plan with only the changed statuses, in the message that starts the next work. The current step is the step most recently set to doing, so set the old one done and the new one doing in the same call.
- Closing: in the message with what you expect to be your last tool calls before you answer, mark done the steps whose work is finished; a step whose check is still running stays doing. If you will ask the user to approve something, add a note kind wait to that same message even before the check result is in (it marks the step as waiting until the user answers; do not mark that step done yourself). After the last tool result, answer directly: do not send board calls just to close steps (the board already shows the session as idle); your next tool calls close them. The one exception: if you stop to ask the user (approval, or help because you are stuck) and that note kind wait or blocked is not on the board yet, send it alone.
- Before launching subagents: plan or draw what they will do, in the same message as the launch.
- When stuck: note kind blocked.
- Draw the structure of the problem once early in every multi-step task, with your first plan call. Pick the form that fits the content and mix two or three forms in a view: boxes (shape, icon) and edges for the parts, suspects or options whose status you will update; a table for comparisons, options and results; mermaid for a flow the user reads as a whole (sequence, state, gantt, timeline, pie or xychart, mindmap, ER, class). Then update statuses as you go and redraw when that structure changes. Add ref (path:line) to parts tied to a file; the board marks them when the file is edited.
Rules: ids are yours and stable; resending an id updates only the fields you send; null clears a field. Send only changes, never the whole scene. Do not look at screenshots of the board.
Keep each view small (about 8 boxes, short tables and diagrams). Draw problem-solving units (features, suspects, call paths), not folder layouts. The anytaskview skill has examples of each form and the command that opens the board in the user's browser (use it when the user asks to open the board).
plan = the steps of your work. draw list + item = structure of a deliverable (document outline, checklist).
Write labels, titles and notes in the user's language (Korean for this user).
If a result says the board is off, skip drawing this time and continue your work.
Projects: work spanning several conversations can belong to a project with its own long-lived board (the big picture). If a [anytaskview 프로젝트] line lists candidates and the user's work matches one, call project {action:"join", id}. Create a project only when the user starts work meant to span conversations. While this conversation belongs to a project, also update its board by adding project:"<id>" to plan/draw/note, but only when a work unit starts or ends or a user decision is made or awaited: units as plan steps, open decisions as wait notes. Keep session detail on the session board (no project argument).`;
const project = { type: "string", description: "Project id: write to that project's long-lived board instead of this conversation's board" };

export const TOOLS = [
  {
    name: "plan",
    description: "Set or update steps in the plan panel. New step needs title. Status: todo doing done fail blocked wait. Example: {steps:[{id:\"s1\",status:\"done\"},{id:\"s2\",status:\"doing\"}]}",
    inputSchema: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: { id: str, title: str, status, parent: strOrNull, note: strOrNull, del: { type: "boolean" } },
            required: ["id"],
          },
        },
        project,
      },
      required: ["steps"],
    },
  },
  {
    name: "draw",
    description: "Add, update or delete parts of the center diagram (auto-laid out). Kinds: box (shape, icon), group (holds parts via in), edge (id, from, to; ends fixed at creation), list + item (item in list or item), table (cols: header cells, rows: arrays of cells; resend rows whole), progress (value, max), text, mermaid (src: any Mermaid diagram, no live status inside). del:true removes a part with its children and edges. clear:true empties the diagram first.",
    inputSchema: {
      type: "object",
      properties: {
        ops: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: str, kind: { type: "string", enum: DRAW_KINDS }, label: strOrNull, status, ref: strOrNull, note: strOrNull,
              in: strOrNull, from: str, to: str, value: { type: ["number", "null"] }, max: { type: ["number", "null"] },
              text: strOrNull, src: strOrNull, del: { type: "boolean" },
              shape: { type: ["string", "null"], enum: [...SHAPES, null] }, icon: { type: ["string", "null"], enum: [...ICONS, null] },
              cols: { type: ["array", "null"], items: str }, rows: { type: ["array", "null"], items: { type: "array", items: str } },
            },
            required: ["id"],
          },
        },
        clear: { type: "boolean" },
        dir: { type: "string", enum: ["RIGHT", "DOWN"] },
        project,
      },
    },
  },
  {
    name: "note",
    description: "Add one line to the timeline: a reason, decision, or that you are blocked or waiting for approval. on = step or part id to attach it to. blocked/wait also set that step (default: current step) to that status.",
    inputSchema: {
      type: "object",
      properties: { text: str, kind: { type: "string", enum: NOTE_KINDS }, on: str, ref: str, project },
      required: ["text"],
    },
  },
  {
    name: "ids",
    description: "List the ids already on the board with short labels. Use only when you lost track of them (for example after context compaction).",
    inputSchema: { type: "object", properties: { project } },
  },
  {
    name: "project",
    description: "Projects group conversations about one piece of work and keep its big-picture board. action list (default): this conversation's project and active ones; join {id}; create {name, purpose} (only when the user starts multi-conversation work) and join it; leave. The user's own choice is never overridden.",
    inputSchema: {
      type: "object",
      properties: { action: { type: "string", enum: ["list", "join", "create", "leave"] }, id: str, name: str, purpose: str },
    },
  },
];
