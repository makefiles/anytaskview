#!/usr/bin/env node
// Claude Code·Codex 훅: stdin 의 사건을 짧은 사실로 줄여 화판에 보낸다.
// 세션을 막지 않도록 언제나 0 으로 끝나고 800ms 를 넘기지 않는다. 화판이 꺼져 있으면 아무것도 하지 않는다.
// 도구 출력과 파일 내용은 보내지 않는다. 명령·경로·짧은 앞부분과 사용자 입력·답(4,000자까지)만 보내고, 비밀 모양은 가린다.
// 답에는 에이전트가 옮겨 적은 파일 내용·명령 출력이 들어갈 수 있다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { clip } from "../lib/redact.js";
import { stateHome, readKeys, portOwner, SID_RE } from "../lib/store.js";

const HT = Date.now();
// Codex 가 부른 훅(인자 --codex, hooks/codex.json). 세션 프로세스는 codex 조상에서 찾고 CLAUDE_* 는 보지 않는다
// (Claude 세션 안에서 codex 를 띄우면 그 값이 물려 와 Claude 세션의 것으로 잘못 간다)
const CODEX = process.argv.includes("--codex");
// Stop 훅을 asyncRewake 로 등록했을 때(인자 --rewake): 사실을 올린 뒤 화판 메시지를 기다린다.
// 받으면 stderr 로 내고 2 로 끝난다. Claude Code 가 그 글로 Claude 를 깨운다(쉬는 세션이면 새 차례를 연다).
// Codex 에는 쓰지 않는다: 화판 서버가 codex queue 로 보내고, Codex 의 Stop 에서 2 는 차례를 이어 가게 한다
const REWAKE = process.argv.includes("--rewake") && !CODEX;
const INBOX_WAIT = 3590_000; // 전체로 기다리는 길이(훅 timeout 3600초 안)
const POLL_WAIT = 240_000;   // 한 번 묻는 길이. Node fetch 는 응답 머리를 5분 넘게 기다리지 않는다
const PORT = Number(process.env.ANYTASKVIEW_PORT || 4871);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const TODO_TOOLS = new Set(["TaskCreate", "TaskUpdate", "TodoWrite"]);
const TEXT_MAX = 4_000; // 사용자 입력·차례 끝 답: 타임라인에서는 3줄로 접고, 누르면 이만큼 펼쳐 본다

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

// claude 프로세스 번호: CLAUDE_PID(이 PC 에서 확인한 값, 문서에는 없음), 없으면 조상 프로세스에서 찾는다
function claudePid() {
  const env = Number(process.env.CLAUDE_PID);
  if (Number.isInteger(env) && env > 1) return env;
  return ancestor("claude");
}

// 이름이 name 인 가장 가까운 조상 프로세스. Codex 는 훅 명령을 셸로 돌리므로 몇 단계 위에 있을 수 있다
function ancestor(name) {
  let pid = process.ppid;
  for (let i = 0; i < 8 && pid > 1; i++) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      if (stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")")) === name) return pid;
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

// 이 Codex 세션의 CODEX_HOME. 화판 서버가 다른 값을 물려받았을 수 있어 기본값(~/.codex)도 적어 보낸다
const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), ".codex");

// Claude Code 의 세션 이름(/rename, claude -n). SessionStart·UserPromptSubmit 입력에 있다
const title = (ev) => (typeof ev.session_title === "string" && ev.session_title ? { title: clip(ev.session_title, 80) } : {});

// Codex 의 apply_patch: 고친 파일마다 사실 하나. 결과 글의 「Success. Updated the following files:」 아래
// 「A|M|D 경로」 줄이 실제로 바뀐 파일이다. 그 줄이 없으면 실패로 보고 패치 머리(*** Add File: 따위)의 경로를 쓴다
const PATCH_MAX = 5;
function patchFacts(input, resp, who) {
  const out = typeof resp === "string" ? resp : JSON.stringify(resp ?? "");
  const done = out.split("Success. Updated the following files:")[1];
  if (done !== undefined) {
    const paths = [...done.matchAll(/^[AMD] (.+)$/gm)].map((m) => m[1].trim()).slice(0, PATCH_MAX);
    return paths.map((p) => ({ f: "edit", tool: "apply_patch", path: p, ...who }));
  }
  const heads = [...String(input.command || "").matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim()).slice(0, PATCH_MAX);
  return heads.map((p) => ({ f: "edit-fail", tool: "apply_patch", path: p, error: clip(out, 200), ...who }));
}

// 훅 사건 → 화판 사실. 화판에 올리지 않는 사건이면 null. Codex 의 apply_patch 는 파일마다 하나씩 배열로 낸다
export function toFact(ev, { codex = false } = {}) {
  const tool = ev.tool_name, input = ev.tool_input || {}, resp = ev.tool_response;
  const who = ev.agent_id ? { agent: String(ev.agent_id), agentType: String(ev.agent_type || "") } : {};
  switch (ev.hook_event_name) {
    case "SessionStart":
      // via: 어느 에이전트의 세션인지. Codex 는 큐로 보낼 때 그 세션의 CODEX_HOME 을 쓴다
      return { f: "start", source: ev.source || "startup", cwd: ev.cwd || "", model: ev.model || "", ...title(ev), ...(codex && { via: "codex", home: codexHome() }) };
    case "UserPromptSubmit": {
      const p = ev.prompt || "";
      // 백그라운드 작업이 끝났다는 알림도 이 훅으로 온다. 사용자 입력이 아니므로 표시해 둔다
      if (/^\s*<task-notification>/.test(p)) {
        const summary = (p.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1] || "";
        return { f: "prompt", sys: true, text: clip(summary || "백그라운드 작업 알림", 300) };
      }
      return { f: "prompt", text: clip(p, TEXT_MAX), ...title(ev) };
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
      if (tool === "apply_patch") return patchFacts(input, resp, who);
      return null;
    case "PermissionRequest":
      // Codex: 승인 창이 뜨기 직전이다. Claude 의 Notification(permission_prompt)처럼 「입력 필요」로 둔다
      return { f: "notify", ntype: "permission_prompt", text: clip(`${tool || ""} ${typeof input.description === "string" ? input.description : typeof input.command === "string" ? input.command : ""}`.trim(), 200) };
    case "PostToolUseFailure":
      if (tool === "Bash") return { f: "run-fail", id: ev.tool_use_id, cmd: clip(input.command || "", 200), desc: clip(input.description || "", 120), error: clip(ev.error || "", 200), ...(typeof ev.duration_ms === "number" && { dur: ev.duration_ms }), ...who };
      if (EDIT_TOOLS.has(tool)) return { f: "edit-fail", tool, path: input.file_path || input.notebook_path || "", error: clip(ev.error || "", 200), ...who };
      return null;
    case "SubagentStart":
      return { f: "agent-start", agent: String(ev.agent_id || ""), agentType: String(ev.agent_type || "") };
    case "SubagentStop":
      return { f: "agent-stop", agent: String(ev.agent_id || ""), agentType: String(ev.agent_type || ""), last: clip(ev.last_assistant_message || "", TEXT_MAX) };
    case "Notification":
      return { f: "notify", ntype: ev.notification_type || "", text: clip(ev.message || "", 200) };
    case "Stop":
      return { f: "stop", last: clip(ev.last_assistant_message || "", TEXT_MAX) };
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

// 그리기 알림(scripts/nudge)이 대화마다 쓰는 파일: 도구 수(.n)와 「이 대화는 끝」(.done). 이름은 Claude 면 claude 프로세스 번호,
// Codex 면 세션 id 다(데스크톱 앱·VS Code 는 한 프로세스에 세션이 여럿). 대화가 시작하거나 끝나면 지운다.
// 시작한 대화의 화판에 이미 그림이 있으면(재개·압축) 「끝」으로 둔다
function nudgeReset(key, drawn) {
  if (!key || !SID_RE.test(String(key))) return;
  const dir = path.join(stateHome(), "nudge");
  try {
    if (drawn) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, `${key}.done`), "", { mode: 0o600 });
      return;
    }
    for (const f of [`${key}.n`, `${key}.done`]) fs.rmSync(path.join(dir, f), { force: true });
  } catch { /* 알림이 한 번 더 가거나 빠질 뿐이다 */ }
}

const writeOut = (text) => new Promise((ok) => process.stdout.write(text, ok));

async function main() {
  const raw = await readStdin();
  const ev = JSON.parse(raw);
  // Codex 는 MCP 안내문을 모델에 넘기지 않는다. 그리기 규칙을 SessionStart 출력으로 넣는다(developer 메시지가 된다).
  // 화판이 꺼져 있거나 열쇠가 없어도 넣도록 화판과 통신하기 전에 쓴다
  if (CODEX && ev.hook_event_name === "SessionStart") await writeOut((await import("../mcp/tools.js")).INSTRUCTIONS + "\n");
  const got = toFact(ev, { codex: CODEX });
  const facts = Array.isArray(got) ? got : got ? [got] : [];
  if (!facts.length) return 0;
  const pid = CODEX ? ancestor("codex") : claudePid();
  const nudgeKey = CODEX ? ev.session_id : pid;
  if (facts[0].f === "start" || facts[0].f === "end") nudgeReset(nudgeKey, false);
  const keys = readKeys(stateHome());
  if (!keys) return 0;
  // 화판이 꺼져 있거나 다른 사용자의 프로그램이 포트를 잡았으면 열쇠를 보내지 않는다
  const owner = portOwner(PORT);
  if (owner === "none" || owner === "other") return 0;
  for (const fact of facts) {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/hook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-atv-key": keys.write },
      // Codex 는 모든 사실에 via·home 을 싣는다. SessionStart 를 화판이 받지 못했어도(아직 뜨지 않음) 서버가 Codex 세션으로 채운다
      body: JSON.stringify({ pid, ht: HT, sid: ev.session_id, cwd: ev.cwd || "", ...(CODEX && { via: "codex", home: codexHome() }), fact }),
      signal: AbortSignal.timeout(700),
    });
    if (!r.ok) return 0;
    const body = await r.json();
    if (fact.f === "start" && body.drawn) nudgeReset(nudgeKey, true);
    // 압축 직후: 화판에 이미 있는 이름표를 맥락에 다시 넣는다(SessionStart 의 stdout 은 맥락에 들어간다)
    if (body.out) await writeOut(body.out + "\n");
  }
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
