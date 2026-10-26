#!/usr/bin/env node
// stdio MCP 서버: LLM 의 plan·draw·note·ids 호출을 화판 서버에 넘기고 한 줄 결과를 돌려준다.
// 어느 세션의 것인지는 부모 프로세스(claude) 번호와 CLAUDE_CODE_SESSION_ID 로 화판 서버가 가린다.
// 설치할 때 npm 이 필요 없도록 MCP SDK 없이 줄 단위 JSON-RPC 를 직접 읽고 쓴다(시험은 SDK 클라이언트로 한다).
// 화판 서버가 꺼져 있으면 떼어 내 띄운다. 여러 세션이 동시에 띄우면 늦은 쪽은 포트를 못 잡고 끝난다.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TOOLS, INSTRUCTIONS } from "./tools.js";
import { stateHome, readKeys, ensureDir, portOwner, PROTOCOL } from "../lib/store.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.ANYTASKVIEW_PORT || 4871);
const HOME = stateHome();
const PID = process.ppid;
// Claude Code 가 아닌 에이전트는 ANYTASKVIEW_SESSION, 그것도 없으면 이 프로세스만의 id 를 쓴다
const ENV_SESSION = process.env.CLAUDE_CODE_SESSION_ID || process.env.ANYTASKVIEW_SESSION || "mcp-" + crypto.randomBytes(8).toString("hex");
const CWD = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const AUTOSTART = process.env.ANYTASKVIEW_AUTOSTART !== "0";
const OFF = `화판 꺼짐(127.0.0.1:${PORT}). 이번 호출은 건너뛰고 하던 일을 계속하세요.`;
const FOREIGN = `화판 포트(127.0.0.1:${PORT})를 다른 사용자의 프로그램이 쓰고 있어 열쇠를 보내지 않았습니다. 이번 호출은 건너뛰고, 사용자께 알리세요.`;
const LOG_MAX = 1024 * 1024;

let keys = readKeys(HOME);
let stale = ""; // 화판 서버가 다른 약속 판이면 도구 결과 뒤에 붙일 알림

// ---- 화판 서버 띄우기 ----
async function boardUp() {
  const owner = portOwner(PORT);
  if (owner !== "unknown") return owner === "self";
  try {
    await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(500) });
    return true; // 응답이 무엇이든(401 잠금 화면이어도) 떠 있다
  } catch {
    return false;
  }
}

let lastSpawn = 0, starting = null;
// 띄우는 중이면 그 결과를 같이 기다린다(hello 가 띄우는 사이에 온 첫 도구 호출이 「꺼짐」으로 끝나지 않게)
function ensureBoard() {
  if (!starting) starting = startBoardIfDown().finally(() => { starting = null; });
  return starting;
}
async function startBoardIfDown() {
  if (await boardUp()) return true;
  if (!AUTOSTART || Date.now() - lastSpawn < 30_000) return false;
  lastSpawn = Date.now();
  try {
    ensureDir(HOME);
    const logFile = path.join(HOME, "board.log");
    try { if (fs.statSync(logFile).size > LOG_MAX) fs.truncateSync(logFile, 0); } catch { /* 처음이면 없다 */ }
    const fd = fs.openSync(logFile, "a", 0o600);
    // 화판 서버는 여러 세션이 함께 쓰므로 이 세션의 CLAUDE_* 값을 물려주지 않는다
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE")));
    const child = spawn(process.execPath, [path.join(ROOT, "scripts", "board.js"), "--port", String(PORT)], { detached: true, stdio: ["ignore", fd, fd], env });
    child.unref();
    fs.closeSync(fd);
  } catch {
    return false;
  }
  for (let i = 0; i < 30; i++) {
    await new Promise((ok) => setTimeout(ok, 100));
    if (await boardUp()) return true;
  }
  return false;
}

async function post(tool, input, timeoutMs = 3000) {
  if (!keys) keys = readKeys(HOME);
  // 다른 사용자의 프로그램에 열쇠를 보내지 않는다. 듣는 소켓이 없으면 먼저 띄워 본다
  const owner = portOwner(PORT);
  if (owner === "other") return { ok: false, text: FOREIGN };
  if (owner === "none" && tool === "bye") return { ok: true, text: "" }; // 알릴 서버가 없다(그 포트를 누가 잡았는지 모르는 채 열쇠를 보내지 않는다)
  if (owner === "none") {
    if (!(await ensureBoard())) return { ok: false, text: portOwner(PORT) === "other" ? FOREIGN : OFF };
    keys = readKeys(HOME);
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    let r;
    try {
      r = await fetch(`http://127.0.0.1:${PORT}/api/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-atv-key": keys ? keys.write : "" },
        body: JSON.stringify({ pid: PID, env: ENV_SESSION, cwd: CWD, tool, input, proto: PROTOCOL }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // 연결이 거절됐을 때만(서버가 없을 때만) 띄워 보고 다시 보낸다. 시간 초과는 서버가 이미 기록했을 수 있어 다시 보내지 않는다
      if (attempt === 0 && tool !== "bye" && e?.cause?.code === "ECONNREFUSED" && (await ensureBoard())) { keys = readKeys(HOME); continue; }
      return { ok: false, text: OFF };
    }
    // 열쇠가 바뀌었으면(서버 상태 폴더를 새로 만든 경우) 한 번 다시 읽고 다시 보낸다
    if (r.status === 401 && attempt === 0) { keys = readKeys(HOME); if (keys) continue; }
    const body = await r.text();
    return { ok: r.ok, text: r.ok ? body : `화판 오류 ${r.status}: ${body}` };
  }
  return { ok: false, text: OFF };
}

// MCP 가 뜰 때: 화판을 띄우고, 짝짓기 표에 이 claude 를 알리고, 약속 판을 맞춰 본다
async function hello() {
  if (!(await ensureBoard())) return;
  keys = readKeys(HOME);
  const r = await post("hello", null);
  if (!r.ok) {
    // 01 판 서버는 hello 를 모른다(「도구 'hello' 모름」)
    if (/hello/.test(r.text)) stale = "\n(화판 서버가 이 플러그인보다 오래된 판입니다. 사용자께 떠 있는 화판 서버를 그 서버를 띄운 방법(예: 사용자 서비스)으로 멈춰 달라고 알리세요. 멈추면 다음 호출 때 새 판이 뜹니다.)";
    return;
  }
  try {
    const { proto } = JSON.parse(r.text);
    if (proto !== PROTOCOL) stale = `\n(화판 서버가 다른 판입니다: 서버 ${proto}, 플러그인 ${PROTOCOL}. 사용자께 「scripts/atv board --stop」 으로 화판 서버를 내려 달라고 알리세요.)`;
  } catch { /* 옛 서버는 hello 를 모른다 */ }
}

// ---- stdio JSON-RPC ----
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const reply = (id, result) => send({ id, result });
const fail = (id, code, message) => send({ id, error: { code, message } });

async function onRequest(m) {
  if (!m || typeof m !== "object" || Array.isArray(m)) return fail(null, -32600, "잘못된 요청");
  const isRequest = m.id !== undefined && m.id !== null;
  switch (m.method) {
    case "initialize":
      // 클라이언트가 고른 약속 판을 그대로 쓴다(이 서버는 도구만 쓴다)
      return reply(m.id, {
        protocolVersion: String(m.params?.protocolVersion || "2025-06-18"),
        capabilities: { tools: {} },
        serverInfo: { name: "anytaskview", version: "0.2.0" },
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return isRequest && reply(m.id, {});
    case "tools/list":
      return reply(m.id, { tools: TOOLS });
    case "tools/call": {
      const name = m.params?.name, args = m.params?.arguments || {};
      if (!TOOLS.some((t) => t.name === name)) return reply(m.id, { content: [{ type: "text", text: `도구 '${name}' 없음` }], isError: true });
      const r = await post(name, args);
      return reply(m.id, { content: [{ type: "text", text: r.text + stale }] });
    }
    default:
      // 알림(notifications/*)에는 답하지 않는다
      if (isRequest) fail(m.id, -32601, `모르는 메서드: ${m.method}`);
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { fail(null, -32700, "JSON 이 깨졌습니다"); continue; }
    for (const m of Array.isArray(msg) ? msg : [msg]) onRequest(m).catch((e) => m && m.id != null && fail(m.id, -32603, String(e.message || e)));
  }
});
// claude 가 끝나면 stdin 이 닫힌다. 화판에 알리고 끝낸다
process.stdin.on("end", () => { post("bye", null, 500).finally(() => process.exit(0)); });

hello().catch(() => {});
