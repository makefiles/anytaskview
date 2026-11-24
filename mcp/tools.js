// MCP 도구 정의와 서버 안내문. 세션마다 LLM 맥락에 실리므로 짧은 영어로 쓴다(한국어보다 토큰이 덜 든다).
// 화판에 보이는 이름표·글은 사용자 언어로 쓰라고 안내한다.
import { STATUSES, NOTE_KINDS, DRAW_KINDS, SHAPES, ICONS, EXPLAIN_ICONS, EXPLAIN_LAYOUTS } from "../lib/scene.js";

const str = { type: "string" };
const strOrNull = { type: ["string", "null"] };
const status = { type: ["string", "null"], enum: [...STATUSES, null] };
const bool = { type: "boolean" };
const mark = { type: "string", enum: ["underline", "circle", "highlight", "box"] };
// 판서의 줄 한 개: 글, 또는 강조를 붙인 {t, …}
const talkLine = (more = {}) => ({ anyOf: [str, { type: "object", properties: { t: str, em: bool, mark, ...more }, required: ["t"] }] });

export const INSTRUCTIONS = `anytaskview: live progress board. Tools plan, draw, note, explain, ids, project.
The user watches this board in a browser tab to follow your work. Hooks already post file edits, commands and subagents, so never draw those.
Board calls ride along: put them first in the same message as your other tool calls. A message holding only board calls costs a whole extra turn (the full context is read again), so do not send one, except the wait or blocked note below or a task's explain when nothing else is left to call.
When to call (at these moments, not on every tool call):
- After you form a plan: plan once with all steps, in the same message as your first draw and the first tool calls of the work.
- When a step starts or ends: plan with only the changed statuses, in the message that starts the next work. The current step is the step most recently set to doing, so set the old one done and the new one doing in the same call.
- Closing: in the message with what you expect to be your last tool calls before you answer, mark done the steps whose work is finished, and give the drawing's parts for that work (and their group) their final status; a step whose check is still running stays doing. If you will ask the user to approve something, add a note kind wait to that same message even before the check result is in (it marks the step as waiting until the user answers; do not mark that step done yourself). After the last tool result, answer directly: do not send board calls just to close steps (the board already shows the session as idle); your next tool calls close them. The one exception: if you stop to ask the user (approval, or help because you are stuck) and that note kind wait or blocked is not on the board yet, send it alone.
- Before launching subagents: plan or draw what they will do, in the same message as the launch.
- When stuck: note kind blocked, saying what you are waiting for.
- Draw the structure of the problem once early in every multi-step task, with your first plan call, inside one group for that task. A later task in the same work adds its own group to that drawing, so the user sees the whole work (the board folds finished groups); clear:true only when the subject changes completely. Pick the form that fits the content and mix two or three forms in a view: boxes (shape, icon) and edges for the parts, suspects or options whose status you will update; a table for comparisons, options and results; mermaid for a flow the user reads as a whole. Then update statuses as you go and redraw when that structure changes. Add ref (path:line) to parts tied to a file; the board marks them when the file is edited.
Rules: ids are yours and stable; resending an id updates only the fields you send; null clears a field. Send only changes, never the whole scene. Do not look at screenshots of the board.
Keep each group small (about 8 boxes, short tables and diagrams). Draw problem-solving units (features, suspects, call paths), not folder layouts. The anytaskview skill has examples of each form and the command that opens the board in the user's browser (use it when the user asks to open the board).
plan = tasks and their steps: make each request or work unit a top-level step (the task) and put its work in sub-steps with parent set to it; add tasks you already know will follow as todo top-level steps. draw list + item = structure of a deliverable (document outline, checklist).
Write labels, titles and notes in the user's language (Korean for this user).
If a result or note says the board is off or no board tab is open, skip board calls as it says.
Projects: work spanning several conversations can belong to a project; the board shows its conversations side by side from their plans and wait or blocked notes. If a [anytaskview 프로젝트] line lists candidates and the user's work matches one, call project {action:"join", id}. Create a project only when the user starts work meant to span conversations.`;

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
      },
    },
  },
  {
    name: "note",
    description: "Add one line to the timeline: a reason, decision, or that you are blocked or waiting for approval. on = step or part id to attach it to. blocked/wait also set that step (default: current step) to that status.",
    inputSchema: {
      type: "object",
      properties: { text: str, kind: { type: "string", enum: NOTE_KINDS }, on: str, ref: str },
      required: ["text"],
    },
  },
  {
    name: "explain",
    description: "Draw the gist of a task as one whiteboard page (판서) the user can switch to from the diagram. Send words only; the board lays it out in hand-drawn marker style, so no coordinates or colors. Call it once when a task reaches a conclusion (findings, the option chosen, work finished), with that task's last tool calls, and when the user asks for 판서. One page per task (a top-level plan step with sub-steps; with no plan or a flat plan the conversation has one page): calling again for the same task replaces it. The page goes to the plan's current task; if a plan call already moved on, set task to the finished task's id. Pick the layout that fits the conclusion instead of always 3-4 parts and a summary: row (default) for a cause or sequence across parts, with arrows between neighbouring parts; compare for options weighed (parts = options, rows = criteria, each part's lines give its value for each row in order, a word or short phrase each, mark:\"pick\" on the chosen one); before-after for what changed (two parts; one arrow from before to after whose label says what was changed); hub for one idea and its aspects (the first part is the core, drawn as an ellipse with its head and one or two short lines only; 2-3 more around it; one arrow at most between the core and each aspect). Keep only the core: 2-4 parts, each a short head and a few short lines. Use what fits: steps for ordered actions (row only; by = the acting part's id); flow:true draws a part's lines as linked boxes for a chain (shape box, diamond or bubble; via labels the arrow into a line); memo for a why; like for an analogy to an unfamiliar idea (not with steps); summary for the one-line takeaway (with at most 4 steps). In lines, em makes red text and mark adds underline, circle, highlight or box. Avoid special symbols: the hand font may lack them.",
    inputSchema: {
      type: "object",
      properties: {
        title: str,
        sub: str,
        layout: { type: "string", enum: EXPLAIN_LAYOUTS },
        rows: { type: "array", items: str },
        parts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: str, head: str, icon: { type: "string", enum: EXPLAIN_ICONS }, flow: bool, mark: { type: "string", enum: ["pick"] }, note: str,
              lines: { type: "array", items: talkLine({ shape: { type: "string", enum: ["box", "diamond", "bubble"] }, via: str }) },
            },
            required: ["head"],
          },
        },
        arrows: { type: "array", items: { type: "object", properties: { from: str, to: str, label: str, dash: bool }, required: ["from", "to"] } },
        steps: { type: "array", items: talkLine({ by: str }) },
        memo: { type: "object", properties: { head: str, lines: { type: "array", items: str } } },
        like: { type: "object", properties: { lines: { type: "array", items: str } } },
        summary: str,
        task: str,
      },
      required: ["title", "parts"],
    },
  },
  {
    name: "ids",
    description: "List the ids already on the board with short labels. Use only when you lost track of them (for example after context compaction).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "project",
    description: "Projects group conversations about one piece of work; the board shows them side by side. action list (default): this conversation's project and active ones; join {id}; create {name, purpose} (only when the user starts multi-conversation work) and join it; leave. The user's own choice is never overridden.",
    inputSchema: {
      type: "object",
      properties: { action: { type: "string", enum: ["list", "join", "create", "leave"] }, id: str, name: str, purpose: str },
    },
  },
];
