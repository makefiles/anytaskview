#!/usr/bin/env node
// stdio MCP 서버: LLM 의 plan·draw·note·ids 호출을 화판 서버에 넘기고 한 줄 결과를 돌려준다.
// 어느 세션의 것인지는 부모 프로세스(claude) 번호와 CLAUDE_CODE_SESSION_ID 로 화판 서버가 가린다.
// Codex 는 호출마다 _meta 에 세션 id 를 싣는다. 데스크톱 앱·VS Code 는 한 프로세스에 세션이 여럿이라 그 id 를 앞세운다.
// 설치할 때 npm 이 필요 없도록 MCP SDK 없이 줄 단위 JSON-RPC 를 직접 읽고 쓴다(시험은 SDK 클라이언트로 한다).
// 화판 서버가 꺼져 있으면 떼어 내 띄운다. 여러 세션이 동시에 띄우면 늦은 쪽은 포트를 못 잡고 끝난다.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TOOLS, INSTRUCTIONS } from "./tools.js";
import { stateHome, readKeys, ensureDir, portOwner, orphaned, codeVersion, versionCmp, PROTOCOL } from "../lib/store.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = codeVersion(ROOT);
const PORT = Number(process.env.ANYTASKVIEW_PORT || 4871);
const HOME = stateHome();
const PID = process.ppid;
// Claude Code 가 아닌 에이전트는 ANYTASKVIEW_SESSION, 그것도 없으면 이 프로세스만의 id 를 쓴다.
// Codex 에서는 이 프로세스만의 id 로 짝짓지 않는다(hello): MCP 가 첫 입력보다 먼저 떠서 빈 세션이 따로 생기고,
// 호출마다 _meta 에 세션 id 가 온다. 그래서 hello 는 initialize 로 Codex 인지 안 뒤에 보낸다
const KNOWN_SESSION = process.env.CLAUDE_CODE_SESSION_ID || process.env.ANYTASKVIEW_SESSION || "";
const ENV_SESSION = KNOWN_SESSION || "mcp-" + crypto.randomBytes(8).toString("hex");
// Codex 는 플러그인 폴더에서 이 서버를 띄운다(.codex-mcp.json 의 cwd "."). 그때는 작업 폴더를 모르므로 비워 두고 훅의 값을 쓴다.
// Codex 인지는 initialize 의 clientInfo 로 안다
let codexClient = false;
const cwdNow = () => process.env.CLAUDE_PROJECT_DIR || (codexClient && process.cwd() === ROOT ? "" : process.cwd());
const AUTOSTART = process.env.ANYTASKVIEW_AUTOSTART !== "0";
const OFF = `화판 꺼짐(127.0.0.1:${PORT}). 이번 호출은 건너뛰고 하던 일을 계속하세요.`;
const FOREIGN = `화판 포트(127.0.0.1:${PORT})를 다른 사용자의 프로그램이 쓰고 있어 열쇠를 보내지 않았습니다. 이번 호출은 건너뛰고, 사용자께 알리세요.`;
const LOG_MAX = 1024 * 1024;

let keys = readKeys(HOME);
let stale = ""; // 화판 서버가 다른 약속 판이면 도구 결과 뒤에 붙일 알림
let ready = Promise.resolve(); // 처음 인사(hello)가 끝나면 풀린다

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

// 화판 서버를 띄울 코드 폴더: root 가 갱신으로 밀려난 판 폴더(다시 읽지 않은 세션)면 옆의 새 판 폴더.
// 옛 판 서버를 띄우면 새 판 세션이 곧바로 다시 갈아 끼우게 되므로
function liveRoot(root) {
  if (!orphaned(root)) return root;
  const up = path.dirname(root);
  try {
    const live = fs.readdirSync(up).map((n) => path.join(up, n)).find((d) => !orphaned(d) && fs.existsSync(path.join(d, "scripts", "board.js")));
    if (live) return live;
  } catch { /* 폴더를 못 읽으면 이 판으로 */ }
  return root;
}

let lastSpawn = 0, starting = null;
// 띄우는 중이면 그 결과를 같이 기다린다(hello 가 띄우는 사이에 온 첫 도구 호출이 「꺼짐」으로 끝나지 않게)
function ensureBoard(root = liveRoot(ROOT)) {
  if (!starting) starting = startBoardIfDown(root).finally(() => { starting = null; });
  return starting;
}
async function startBoardIfDown(root) {
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
    const child = spawn(process.execPath, [path.join(root, "scripts", "board.js"), "--port", String(PORT)], { detached: true, stdio: ["ignore", fd, fd], env });
    child.unref();
    fs.closeSync(fd);
  } catch {
    return false;
  }
  for (let i = 0; i < 30; i++) {
    await new Promise((ok) => setTimeout(ok, 100));
    if (await boardUp()) { stale = ""; return true; } // 이 판(또는 새 판 폴더)에서 띄웠으니 옛 판 알림은 지운다
  }
  return false;
}

async function post(tool, input, timeoutMs = 3000, sid = null) {
  if (!keys) keys = readKeys(HOME);
  // 다른 사용자의 프로그램에 열쇠를 보내지 않는다. 듣는 소켓이 없으면 먼저 띄워 본다
  const owner = portOwner(PORT);
  if (owner === "other") return { ok: false, text: FOREIGN };
  // 알릴(내릴) 서버가 없다. 그 포트를 누가 잡았는지 모르는 채 열쇠를 보내지 않고, 내리려고 띄우지도 않는다
  if (owner === "none" && (tool === "bye" || tool === "stop")) return { ok: true, text: "" };
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
        body: JSON.stringify({ pid: PID, env: tool === "hello" && codexClient ? KNOWN_SESSION : ENV_SESSION, ...(sid && { sid }), cwd: cwdNow(), tool, input, proto: PROTOCOL }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // 연결이 거절됐을 때만(서버가 없을 때만) 띄워 보고 다시 보낸다. 시간 초과는 서버가 이미 기록했을 수 있어 다시 보내지 않는다
      if (attempt === 0 && tool !== "bye" && tool !== "stop" && e?.cause?.code === "ECONNREFUSED" && (await ensureBoard())) { keys = readKeys(HOME); continue; }
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
    const info = JSON.parse(r.text);
    const root = swapRoot(info);
    if (root && (await replaceBoard(info.code, root))) return;
    if (info.proto !== PROTOCOL) stale = `\n(화판 서버가 다른 판입니다: 서버 ${info.proto}, 플러그인 ${PROTOCOL}. 사용자께 「scripts/atv board --stop」 으로 화판 서버를 내려 달라고 알리세요.)`;
    else if (root) stale = "\n(화판 서버가 갱신 전 판입니다. 사용자께 「scripts/atv board --stop」 으로 화판 서버를 내려 달라고 알리세요. 다음 호출 때 새 판이 뜹니다.)";
  } catch { /* 옛 서버는 hello 를 모른다 */ }
}
// 서버를 갈아 끼울지와, 그렇다면 어느 코드 폴더에서 다시 띄울지. 갈아 끼우지 않으면 null.
// - 이 MCP 가 갱신으로 밀려난 판(다시 읽지 않은 세션)이면 건드리지 않는다
// - 서버 판 번호(package.json)가 이 판보다 낮거나 판 정보를 모르면(28 전 판) 이 판 폴더로
// - 판 번호가 같고 서버가 밀려났으면, 같은 설치(같은 폴더나 그 옆 판 폴더)일 때만 그 설치의 새 코드로.
//   다른 설치(Claude·Codex 를 함께 씀)는 판 번호가 같으면 어느 쪽이 새것인지 몰라 건드리지 않는다
function swapRoot(info) {
  if (orphaned(ROOT)) return null;
  if (!Object.hasOwn(info, "version")) return liveRoot(ROOT);
  const cmp = versionCmp(info.version, VERSION);
  if (cmp < 0) return liveRoot(ROOT);
  if (cmp > 0 || !info.superseded) return null;
  const same = typeof info.root === "string" && (info.root === ROOT || path.dirname(info.root) === path.dirname(ROOT));
  return same ? liveRoot(info.root) : null;
}
// 떠 있는 서버를 내리고 새로 띄워 다시 인사한다. 내릴 서버의 표지(code)를 실어, 다른 세션이 먼저 갈아 끼운 새 서버는 내리지 않는다(409).
// 내려가는 서버는 보내던 Codex 글을 마무리하느라 포트를 20초 남짓 쥘 수 있어 그만큼 기다리고, 새로 붙은 서버가 새 판인지 확인한다
async function replaceBoard(code, root) {
  const r = await post("stop", { code });
  if (!r.ok && !r.text.startsWith("화판 오류 409")) return false;
  if (r.ok) for (let i = 0; i < 250 && (await boardUp()); i++) await new Promise((ok) => setTimeout(ok, 100));
  lastSpawn = 0;
  if (!(await ensureBoard(root))) return false;
  keys = readKeys(HOME);
  const h = await post("hello", null);
  try {
    const info = h.ok ? JSON.parse(h.text) : null;
    return !!info && info.superseded === false && versionCmp(info.version, VERSION) >= 0;
  } catch { return false; }
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
      codexClient = m.params?.clientInfo?.name === "codex-mcp-client";
      ready = hello().catch(() => {});
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
      // Codex: _meta["x-codex-turn-metadata"].session_id(호출한 세션). 동시에 오는 호출이 섞이지 않게 호출마다 넘긴다
      const meta = m.params?._meta?.["x-codex-turn-metadata"];
      const sid = typeof meta?.session_id === "string" ? meta.session_id : null;
      await ready; // 옛 판 서버를 갈아 끼우는 중이면 끝난 뒤 새 서버로 보낸다
      const r = await post(name, args, 3000, sid);
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

