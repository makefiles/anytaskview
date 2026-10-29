#!/usr/bin/env node
// Claude Code·Codex 훅: stdin 의 사건을 짧은 사실로 줄여 화판에 보낸다.
// 세션을 막지 않도록 언제나 0 으로 끝나고 800ms 를 넘기지 않는다. 화판이 꺼져 있으면 아무것도 하지 않는다.
// 도구 출력은 보내지 않는다. 명령·경로·짧은 앞부분, 사용자 입력·답(4,000자까지), 파일 수정의 바뀐 줄(diff, 512KB 까지)만 보내고,
// 비밀 모양은 가린다. 답에는 에이전트가 옮겨 적은 파일 내용·명령 출력이 들어갈 수 있다.
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

// 수정의 바뀐 줄(diff). 화판 서버가 설정한 크기(기본 16KB)로 다시 잘라 남긴다
const DIFF_MAX = 512 * 1024; // 설정의 최대(lib/scene.js DIFF_KB_MAX)와 같다
const DIFF_LINE = 2_000; // 한 줄 상한(압축한 코드 따위)
const DIFF_MS = 200;     // 가리기에 쓰는 시간 상한. 「key-key-…」 처럼 생긴 긴 줄은 128KB 에도 수 초가 걸린다
const CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const KEY_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/, KEY_END = /-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/;
// 개인 키 파일은 바뀐 줄을 싣지 않는다(키 가운데만 고치면 diff 에 BEGIN·END 가 들어오지 않아 가릴 길이 없다)
const KEY_FILE = /(\.(?:pem|key|p12|pfx|jks|keystore|gpg|asc)|(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)[^/]*)$/i;
const masked = (s) => `${/^[+ -]/.test(s) ? s[0] : ""}***`;

// Edit·Write 응답의 diff 줄: structuredPatch 덩어리마다 「@@ -a,b +c,d @@」 머리와 줄. 새 파일(Write)은 덩어리 없이 내용이 온다
function patchLines(resp) {
  const hunks = resp && Array.isArray(resp.structuredPatch) ? resp.structuredPatch.filter((h) => Array.isArray(h?.lines)) : [];
  if (hunks.length) return hunks.flatMap((h) => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines.map(String)]);
  if (resp?.type !== "create" || typeof resp.content !== "string" || !resp.content) return [];
  const lines = resp.content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => "+" + l)];
}

// diff 줄 → 사실 필드: 전체 더하기·빼기 줄 수(add·del)와 가린 글(diff). 줄마다 가리고, 개인 키는 덩어리(@@) 안에서
// BEGIN~END 줄을 모두 가린다. 덩어리가 키 가운데서 시작해 END 만 보이면 그 덩어리의 앞줄을 거슬러 가린다.
// 512KB 나 시간 상한(until)에 닿으면 거기서 자르고 cut 을 붙인다
function diffFields(lines, until, file = "") {
  if (!lines.length) return {};
  let add = 0, del = 0;
  for (const l of lines) if (l[0] === "+") add++; else if (l[0] === "-") del++;
  if (KEY_FILE.test(file)) return { add, del };
  const out = [];
  let bytes = 0, cut = false, key = false, hunk = 0;
  for (const raw of lines) {
    if (performance.now() > until) { cut = true; break; }
    if (raw.startsWith("@@")) { key = false; hunk = out.length + 1; }
    const begin = KEY_BEGIN.test(raw), end = KEY_END.test(raw);
    if (begin) key = true;
    else if (end && !key) for (let i = hunk; i < out.length; i++) out[i] = masked(out[i]);
    // 제어 문자는 JSON 에서 6바이트(\u0000)로 늘어 본문 상한에 걸릴 수 있고 화면에도 쓸모없다. 탭·CR 은 둔다
    const line = key || end ? masked(raw) : clip(raw.replace(CTRL, "\ufffd"), DIFF_LINE);
    if (end) key = false;
    const n = Buffer.byteLength(line) + 1;
    if (bytes + n > DIFF_MAX) { cut = true; break; }
    out.push(line);
    bytes += n;
  }
  return { add, del, ...(out.length && { diff: out.join("\n") }), ...(cut && { cut: true }) };
}

// Codex 패치 글을 파일마다 나눈 몸통 줄(머리 「*** Add/Update/Delete File:」 아래부터 다음 머리 전까지)
function patchBodies(command) {
  const files = new Map();
  let cur = null;
  for (const l of String(command || "").split("\n")) {
    const m = l.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
    if (m) files.set(m[1].trim(), (cur = []));
    else if (/^\*\*\* (?:Begin Patch|End Patch|End of File)\s*$/.test(l)) continue;
    else if (cur) cur.push(l);
  }
  return files;
}
// 결과 글의 경로와 패치 머리의 경로는 한쪽만 절대 경로일 수 있다. 작업 폴더 기준으로 맞춰 보고, 그래도 없으면
// 뒤끝이 맞는 후보가 하나뿐일 때만 쓴다(이름이 같은 다른 폴더의 파일에 엉뚱한 diff 를 붙이지 않게)
function bodyOf(files, p, cwd) {
  const abs = (x) => path.resolve(cwd || "/", x);
  for (const [k, body] of files) if (k === p || abs(k) === abs(p)) return body;
  const tail = [...files].filter(([k]) => p.endsWith("/" + k) || k.endsWith("/" + p));
  return tail.length === 1 ? tail[0][1] : [];
}

function todoText(tool, input) {
  if (tool === "TaskCreate") return clip(input.subject || "", 120);
  if (tool === "TaskUpdate") return clip(`${input.taskId || ""} ${input.status || ""} ${input.subject || ""}`.trim(), 120);
  const todos = Array.isArray(input.todos) ? input.todos : [];
  const now = todos.find((t) => t.status === "in_progress");
  return clip(`${todos.length}개${now ? " · 지금 " + (now.content || "") : ""}`, 120);
}

// 하위 에이전트의 설명(이름표). Claude Code 가 세션 폴더에 남기는 `subagents/(workflows/<wf>/)agent-<id>.meta.json` 의
// description 이다(워크플로는 「review:bugs」 같은 이름표). 문서에 없는 내부 파일이라 없거나 모양이 다르면 설명 없이 둔다.
// 끝 사건은 에이전트 기록 파일(agent_transcript_path) 옆을, 시작 사건은 세션 기록(transcript_path) 옆 폴더를 찾는다
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const META_MAX = 64 * 1024;
// 파일 자체가 심볼릭 링크면 열지 않고(O_NOFOLLOW), 연 파일의 크기를 본다(보고 여는 사이에 바뀌어도 그 파일이다)
function readMeta(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > META_MAX) return undefined;
    const d = JSON.parse(fs.readFileSync(fd, "utf8")).description;
    return typeof d === "string" && d ? clip(d, 80) : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
// 링크가 아닌 진짜 폴더인가(폴더 링크를 따라 세션 밖의 파일을 읽지 않게)
const realDir = (p) => { try { return fs.lstatSync(p).isDirectory(); } catch { return false; } };
function agentDesc(ev) {
  const id = String(ev.agent_id || "");
  if (!AGENT_ID.test(id)) return undefined;
  const at = typeof ev.agent_transcript_path === "string" && ev.agent_transcript_path;
  if (at && path.basename(at) === `agent-${id}.jsonl`) return realDir(path.dirname(at)) ? readMeta(at.replace(/\.jsonl$/, ".meta.json")) : undefined;
  if (typeof ev.transcript_path !== "string" || !ev.transcript_path.endsWith(".jsonl")) return undefined;
  const sub = path.join(ev.transcript_path.slice(0, -".jsonl".length), "subagents"), name = `agent-${id}.meta.json`;
  if (!realDir(sub)) return undefined;
  const direct = readMeta(path.join(sub, name));
  if (direct !== undefined) return direct;
  const wf = path.join(sub, "workflows");
  let wfs = [];
  try { if (realDir(wf)) wfs = fs.readdirSync(wf, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { /* 워크플로를 쓴 적 없음 */ }
  for (const d of wfs) {
    const desc = readMeta(path.join(wf, d.name, name));
    if (desc !== undefined) return desc;
  }
  return undefined;
}
const withDesc = (ev) => { const desc = agentDesc(ev); return desc ? { desc } : {}; };

// 이 Codex 세션의 CODEX_HOME. 화판 서버가 다른 값을 물려받았을 수 있어 기본값(~/.codex)도 적어 보낸다
const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), ".codex");

// Claude Code 의 세션 이름(/rename, claude -n). SessionStart·UserPromptSubmit 입력에 있다
const title = (ev) => (typeof ev.session_title === "string" && ev.session_title ? { title: clip(ev.session_title, 80) } : {});

// Codex 의 apply_patch: 고친 파일마다 사실 하나. 결과 글의 「Success. Updated the following files:」 아래
// 「A|M|D 경로」 줄이 실제로 바뀐 파일이다. 그 줄이 없으면 실패로 보고 패치 머리(*** Add File: 따위)의 경로를 쓴다
const PATCH_MAX = 5;
function patchFacts(input, resp, who, until, cwd) {
  const out = typeof resp === "string" ? resp : JSON.stringify(resp ?? "");
  const done = out.split("Success. Updated the following files:")[1];
  if (done !== undefined) {
    const paths = [...done.matchAll(/^[AMD] (.+)$/gm)].map((m) => m[1].trim()).slice(0, PATCH_MAX);
    const files = patchBodies(input.command);
    return paths.map((p) => ({ f: "edit", tool: "apply_patch", path: p, ...diffFields(bodyOf(files, p, cwd), until, p), ...who }));
  }
  const heads = [...String(input.command || "").matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim()).slice(0, PATCH_MAX);
  return heads.map((p) => ({ f: "edit-fail", tool: "apply_patch", path: p, error: clip(out, 200), ...who }));
}

// 훅 사건 → 화판 사실. 화판에 올리지 않는 사건이면 null. Codex 의 apply_patch 는 파일마다 하나씩 배열로 낸다
export function toFact(ev, { codex = false } = {}) {
  const tool = ev.tool_name, input = ev.tool_input || {}, resp = ev.tool_response;
  const who = ev.agent_id ? { agent: String(ev.agent_id), agentType: String(ev.agent_type || "") } : {};
  const until = performance.now() + DIFF_MS;
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
      if (EDIT_TOOLS.has(tool)) return { f: "edit", tool, path: input.file_path || input.notebook_path || "", lines: editLines(resp), ...diffFields(patchLines(resp), until, input.file_path || input.notebook_path || ""), ...who };
      if (TODO_TOOLS.has(tool)) return { f: "todo", tool, text: todoText(tool, input), ...who };
      if (tool === "apply_patch") return patchFacts(input, resp, who, until, ev.cwd);
      // Agent 도구(옛 이름 Task): 설명과 하위 에이전트 id(문서에 있는 길). 백그라운드로 띄우면 곧바로 온다
      if ((tool === "Agent" || tool === "Task") && resp && typeof resp.agentId === "string" && resp.agentId) {
        return { f: "agent-call", agent: resp.agentId, desc: clip(input.description || "", 80), agentType: String(input.subagent_type || "") };
      }
      return null;
    case "PermissionRequest":
      // Codex: 승인 창이 뜨기 직전이다. Claude 의 Notification(permission_prompt)처럼 「입력 필요」로 둔다
      return { f: "notify", ntype: "permission_prompt", text: clip(`${tool || ""} ${typeof input.description === "string" ? input.description : typeof input.command === "string" ? input.command : ""}`.trim(), 200) };
    case "PostToolUseFailure":
      if (tool === "Bash") return { f: "run-fail", id: ev.tool_use_id, cmd: clip(input.command || "", 200), desc: clip(input.description || "", 120), error: clip(ev.error || "", 200), ...(typeof ev.duration_ms === "number" && { dur: ev.duration_ms }), ...who };
      if (EDIT_TOOLS.has(tool)) return { f: "edit-fail", tool, path: input.file_path || input.notebook_path || "", error: clip(ev.error || "", 200), ...who };
      return null;
    case "SubagentStart":
      return { f: "agent-start", agent: String(ev.agent_id || ""), agentType: String(ev.agent_type || ""), ...withDesc(ev) };
    case "SubagentStop":
      return { f: "agent-stop", agent: String(ev.agent_id || ""), agentType: String(ev.agent_type || ""), ...withDesc(ev), last: clip(ev.last_assistant_message || "", TEXT_MAX) };
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

// 그리기 알림(scripts/nudge)이 대화마다 쓰는 파일: 도구 수(.n), 「이 대화는 끝」(.done), 「그린 적 있음」(.drew, 결과 알림의 조건).
// 이름은 Claude 면 claude 프로세스 번호, Codex 면 세션 id 다(데스크톱 앱·VS Code 는 한 프로세스에 세션이 여럿). 대화가 시작하거나 끝나면 지운다.
// 시작한 대화의 화판에 이미 그림이 있으면(재개·압축) 「끝」·「그린 적 있음」으로 둔다
function nudgeReset(key, drawn) {
  if (!key || !SID_RE.test(String(key))) return;
  const dir = path.join(stateHome(), "nudge");
  try {
    if (drawn) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const f of [`${key}.done`, `${key}.drew`]) fs.writeFileSync(path.join(dir, f), "", { mode: 0o600 });
      return;
    }
    for (const f of [`${key}.n`, `${key}.done`, `${key}.drew`]) fs.rmSync(path.join(dir, f), { force: true });
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
  // 하위 에이전트의 meta 파일은 시작 훅보다 조금 늦게 써질 때가 있다. 시작 사실을 먼저 보낸 뒤 잠깐 다시 보고,
  // 찾으면 설명만 따로 보낸다(이 훅은 비동기라 Claude 를 기다리게 하지 않는다. 못 찾으면 끝 사건이 채운다)
  // 시간은 800ms 종료 타이머 안에서 나눈다: 다시 보기는 시작 뒤 600ms 까지, 보내기는 780ms 까지
  if (facts[0].f === "agent-start" && !facts[0].desc) {
    while (Date.now() < HT + 600) {
      await new Promise((ok) => setTimeout(ok, 50));
      const desc = agentDesc(ev);
      if (!desc) continue;
      await fetch(`http://127.0.0.1:${PORT}/api/hook`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-atv-key": keys.write },
        body: JSON.stringify({ pid, ht: HT, sid: ev.session_id, cwd: ev.cwd || "", fact: { f: "agent-call", agent: facts[0].agent, desc, agentType: facts[0].agentType } }),
        signal: AbortSignal.timeout(Math.max(1, HT + 780 - Date.now())),
      });
      break;
    }
  }
  if (REWAKE && ev.hook_event_name === "Stop" && typeof ev.session_id === "string" && !headless()) return waitInbox(keys, ev.session_id);
  return 0;
}

// 이 세션에 온 화판 메시지를 기다린다. 202 면 아직 없으니 다시 묻고, 204 면(새 Stop 훅이 이어받음·세션 끝) 그만둔다.
// 503 이나 연결 실패는 화판 서버가 내려가 다시 뜨는 중(새 판으로 갈아 끼우기)일 수 있어, 조금씩 늦추며 다시 묻는다
async function waitInbox(keys, sid) {
  const end = Date.now() + INBOX_WAIT;
  let backoff = 1000;
  const later = () => new Promise((ok) => setTimeout(ok, Math.min(backoff, Math.max(0, end - Date.now())))).then(() => { backoff = Math.min(backoff * 2, 30_000); });
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
      await later();
      continue;
    }
    if (r.status === 503) { await later(); continue; }
    backoff = 1000;
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
