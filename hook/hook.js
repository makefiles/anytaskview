#!/usr/bin/env node
// Claude Code 훅: stdin 의 사건을 짧은 사실로 줄여 화판에 보낸다.
// 세션을 막지 않도록 언제나 0 으로 끝나고 800ms 를 넘기지 않는다. 화판이 꺼져 있으면 아무것도 하지 않는다.
// 도구 출력과 파일 내용은 보내지 않는다. 명령·경로·짧은 앞부분만 보내고, 비밀 모양은 가린다.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { clip } from "../lib/redact.js";
import { stateHome, readKeys, portOwner } from "../lib/store.js";

const HT = Date.now();
// Stop 훅을 asyncRewake 로 등록했을 때(인자 --rewake): 사실을 올린 뒤 화판 메시지를 기다린다.
// 받으면 stderr 로 내고 2 로 끝난다. Claude Code 가 그 글로 Claude 를 깨운다(쉬는 세션이면 새 차례를 연다)
const REWAKE = process.argv.includes("--rewake");
const INBOX_WAIT = 3590_000; // 전체로 기다리는 길이(훅 timeout 3600초 안)
const POLL_WAIT = 240_000;   // 한 번 묻는 길이. Node fetch 는 응답 머리를 5분 넘게 기다리지 않는다
const PORT = Number(process.env.ANYTASKVIEW_PORT || 4871);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const TODO_TOOLS = new Set(["TaskCreate", "TaskUpdate", "TodoWrite"]);

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

// claude 프로세스 번호: CLAUDE_PID(이 PC 에서 확인한 값, 문서에는 없음), 없으면 조상 프로세스에서 찾는다
function claudePid() {
  const env = Number(process.env.CLAUDE_PID);
  if (Number.isInteger(env) && env > 1) return env;
  let pid = process.ppid;
  for (let i = 0; i < 8 && pid > 1; i++) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      if (stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")")) === "claude") return pid;
      pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    } catch {
      return null;
    }
  }
  return null;
}

// Edit 응답의 structuredPatch 첫 덩어리에서 바뀐 줄 범위
function editLines(resp) {
  const hunks = resp && Array.isArray(resp.structuredPatch) ? resp.structuredPatch : [];
  if (!hunks.length) return undefined;
  const h = hunks[0];
  const range = h.newLines > 1 ? `${h.newStart}-${h.newStart + h.newLines - 1}` : `${h.newStart}`;
  return hunks.length > 1 ? `${range} 외 ${hunks.length - 1}곳` : range;
}

function todoText(tool, input) {
  if (tool === "TaskCreate") return clip(input.subject || "", 120);
  if (tool === "TaskUpdate") return clip(`${input.taskId || ""} ${input.status || ""} ${input.subject || ""}`.trim(), 120);
  const todos = Array.isArray(input.todos) ? input.todos : [];
  const now = todos.find((t) => t.status === "in_progress");
  return clip(`${todos.length}개${now ? " · 지금 " + (now.content || "") : ""}`, 120);
}

// Claude Code 의 세션 이름(/rename, claude -n). SessionStart·UserPromptSubmit 입력에 있다
const title = (ev) => (typeof ev.session_title === "string" && ev.session_title ? { title: clip(ev.session_title, 80) } : {});

// 훅 사건 → 화판 사실. 화판에 올리지 않는 사건이면 null
export function toFact(ev) {
  const tool = ev.tool_name, input = ev.tool_input || {}, resp = ev.tool_response;
  const who = ev.agent_id ? { agent: String(ev.agent_id), agentType: String(ev.agent_type || "") } : {};
  switch (ev.hook_event_name) {
    case "SessionStart":
      return { f: "start", source: ev.source || "startup", cwd: ev.cwd || "", model: ev.model || "", ...title(ev) };
    case "UserPromptSubmit": {
      const p = ev.prompt || "";
      // 백그라운드 작업이 끝났다는 알림도 이 훅으로 온다. 사용자 입력이 아니므로 표시해 둔다
      if (/^\s*<task-notification>/.test(p)) {
        const summary = (p.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1] || "";
        return { f: "prompt", sys: true, text: clip(summary || "백그라운드 작업 알림", 300) };
      }
      return { f: "prompt", text: clip(p, 300), ...title(ev) };
    }
    case "PreToolUse":
      if (tool !== "Bash") return null;
      return { f: "run-start", id: ev.tool_use_id, cmd: clip(input.command || "", 200), desc: clip(input.description || "", 120), ...who };
    case "PostToolUse":
      if (tool === "Bash") {
        const bg = !!(input.run_in_background || (resp && resp.backgroundTaskId));
        return { f: "run-end", id: ev.tool_use_id, cmd: clip(input.command || "", 200), desc: clip(input.description || "", 120), bg, ...(typeof ev.duration_ms === "number" && { dur: ev.duration_ms }), ...who };
      }
      if (EDIT_TOOLS.has(tool)) return { f: "edit", tool, path: input.file_path || input.notebook_path || "", lines: editLines(resp), ...who };
      if (TODO_TOOLS.has(tool)) return { f: "todo", tool, text: todoText(tool, input), ...who };
      return null;
    case "PostToolUseFailure":
      if (tool === "Bash") return { f: "run-fail", id: ev.tool_use_id, cmd: clip(input.command || "", 200), desc: clip(input.description || "", 120), error: clip(ev.error || "", 200), ...(typeof ev.duration_ms === "number" && { dur: ev.duration_ms }), ...who };
      if (EDIT_TOOLS.has(tool)) return { f: "edit-fail", tool, path: input.file_path || input.notebook_path || "", error: clip(ev.error || "", 200), ...who };
      return null;
    case "SubagentStart":
      return { f: "agent-start", agent: String(ev.agent_id || ""), agentType: String(ev.agent_type || "") };
    case "SubagentStop":
      return { f: "agent-stop", agent: String(ev.agent_id || ""), agentType: String(ev.agent_type || ""), last: clip(ev.last_assistant_message || "", 200) };
    case "Notification":
      return { f: "notify", ntype: ev.notification_type || "", text: clip(ev.message || "", 200) };
    case "Stop":
      return { f: "stop", last: clip(ev.last_assistant_message || "", 200) };
    case "SessionEnd":
      return { f: "end", reason: ev.reason || "" };
    default:
      return null;
  }
}

// 한 번 실행하고 끝나는 세션(`claude -p`·SDK). 이런 세션에서 Stop 훅이 화판 글을 기다리면 claude 가 답을 내고
// 끝나지 못한다(최대 한 시간). 지켜보지 않음(ATTENDED=0)만으로는 가리지 않는다: `claude --bg` 세션도 0 이지만
// 나중에 붙어 쓰는 대화형 세션이라 화판 글로 깨워야 한다. 그쪽 진입점은 cli, 한 번 실행은 sdk-cli·sdk-ts·sdk-py 다
const headless = () => process.env.CLAUDE_CODE_SESSION_ATTENDED === "0" && /^sdk-/.test(process.env.CLAUDE_CODE_ENTRYPOINT || "");

// 그리기 알림(scripts/nudge)이 claude 프로세스마다 쓰는 파일: 도구 수(.n)와 「이 대화는 끝」(.done).
// 대화가 시작하거나 끝나면 지운다. 시작한 대화의 화판에 이미 그림이 있으면(재개·압축) 「끝」으로 둔다
function nudgeReset(pid, drawn) {
  if (!pid) return;
  const dir = path.join(stateHome(), "nudge");
  try {
    if (drawn) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, `${pid}.done`), "", { mode: 0o600 });
      return;
    }
    for (const f of [`${pid}.n`, `${pid}.done`]) fs.rmSync(path.join(dir, f), { force: true });
  } catch { /* 알림이 한 번 더 가거나 빠질 뿐이다 */ }
}

async function main() {
  const raw = await readStdin();
  const ev = JSON.parse(raw);
  const fact = toFact(ev);
  if (!fact) return 0;
  const pid = claudePid();
  if (fact.f === "start" || fact.f === "end") nudgeReset(pid, false);
  const keys = readKeys(stateHome());
  if (!keys) return 0;
  // 화판이 꺼져 있거나 다른 사용자의 프로그램이 포트를 잡았으면 열쇠를 보내지 않는다
  const owner = portOwner(PORT);
  if (owner === "none" || owner === "other") return 0;
  const r = await fetch(`http://127.0.0.1:${PORT}/api/hook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-atv-key": keys.write },
    body: JSON.stringify({ pid, ht: HT, sid: ev.session_id, cwd: ev.cwd || "", fact }),
    signal: AbortSignal.timeout(700),
  });
  if (!r.ok) return 0;
  const body = await r.json();
  if (fact.f === "start" && body.drawn) nudgeReset(pid, true);
  // 압축 직후: 화판에 이미 있는 이름표를 맥락에 다시 넣는다(SessionStart 의 stdout 은 맥락에 들어간다)
  if (body.out) process.stdout.write(body.out + "\n");
  if (REWAKE && ev.hook_event_name === "Stop" && typeof ev.session_id === "string" && !headless()) return waitInbox(keys, ev.session_id);
  return 0;
}

// 이 세션에 온 화판 메시지를 기다린다. 202 면 아직 없으니 다시 묻고, 204 면(새 Stop 훅이 이어받음·세션 끝) 그만둔다
async function waitInbox(keys, sid) {
  const end = Date.now() + INBOX_WAIT;
  while (Date.now() < end) {
    let r;
    try {
      r = await fetch(`http://127.0.0.1:${PORT}/api/inbox`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-atv-key": keys.write },
        body: JSON.stringify({ sid, wait: Math.min(POLL_WAIT, end - Date.now()) }),
        signal: AbortSignal.timeout(POLL_WAIT + 10_000),
      });
    } catch {
      return 0;
    }
    if (r.status === 202) continue;
    if (r.status !== 200) return 0;
    const text = await r.text();
    if (!text) return 0;
    // 파이프에 큰 글을 쓰고 바로 끝내면 뒷부분이 잘릴 수 있어 다 쓴 뒤에 끝낸다
    await new Promise((ok) => process.stderr.write(text + "\n", ok));
    return 2;
  }
  return 0;
}

// 시험에서 toFact 만 가져다 쓸 때는 실행하지 않는다
// 끝내기 타이머도 실행할 때만 건다(시험이 이 파일을 불러오면 시험 프로세스가 800ms 뒤에 끝나 버린다)
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  setTimeout(() => process.exit(0), REWAKE ? INBOX_WAIT + 8000 : 800).unref();
  main().then((code) => process.exit(code || 0), () => process.exit(0));
}
