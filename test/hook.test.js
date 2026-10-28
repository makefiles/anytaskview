// 훅 시험: 사건을 사실로 줄이기, 비밀 가림, 실제 실행(화판 켜짐·꺼짐)
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { toFact } from "../hook/hook.js";
import { redact } from "../lib/redact.js";
import { boardFixture } from "./helpers.js";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hook", "hook.js");
const NUDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "nudge");

function runHook(ev, env, args = []) {
  return new Promise((ok) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [HOOK, ...args], { env: { ...process.env, ...env } });
    let out = "", err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    // exit 는 출력이 다 오기 전에 올 수 있다. 출력까지 닫힌 close 를 기다린다(바쁠 때 출력을 놓쳐 시험이 가끔 틀렸다)
    p.on("close", (code) => ok({ code, out, err, ms: Date.now() - t0 }));
    p.stdin.end(typeof ev === "string" ? ev : JSON.stringify(ev)); // 글을 주면 그대로 보낸다(깨진 JSON 시험)
  });
}

test("비밀 모양을 가리고, 다른 변수를 가리키는 값($VAR)은 그대로 둔다", () => {
  assert.equal(redact("curl -H 'Authorization: Bearer abcdefghijklmnopqrstu' https://x"), "curl -H 'Authorization: Bearer ***' https://x");
  assert.equal(redact("export API_TOKEN=s3cr3tvalue && run"), "export API_TOKEN=*** && run");
  assert.equal(redact('printf "%s" "$DB_PASS" | ssh host'), 'printf "%s" "$DB_PASS" | ssh host');
  // 띄어 쓴 옵션 값은 따옴표로 감싸도 가리고, 변수를 가리키는 값은 그대로 둔다
  assert.equal(redact('tool --password "s3cret" x'), "tool --password *** x");
  assert.equal(redact("tool --token 'abc123'"), "tool --token ***");
  assert.equal(redact('tool --password "$PW" x'), 'tool --password "$PW" x');
  assert.equal(redact("password: hunter2"), "password: ***");
  assert.equal(redact("git clone https://user:pa55word@example.com/r.git"), "git clone https://user:***@example.com/r.git");
  assert.equal(redact("key ghp_abcdefghijklmnopqrstuvwxyz0123 end"), "key *** end");
  assert.equal(redact("ls -la src/"), "ls -la src/");
  assert.equal(redact("deploy key=EXAMPLE_SECRET now"), "deploy key=*** now");
  assert.equal(redact('{"token":"EXAMPLE_SECRET","user":"a"}'), '{"token":***,"user":"a"}');
  assert.equal(redact("Basic auth 설정을 고쳐 줘"), "Basic auth 설정을 고쳐 줘");
  assert.equal(redact("mysql -u root -pS3cret db"), "mysql -u root -p*** db");
  assert.equal(redact("sshpass -p Hunter2x ssh h"), "sshpass -p *** ssh h");
  assert.equal(redact("curl -u me:Hunter2x https://x"), "curl -u me:*** https://x");
  assert.equal(redact("tool --password Hunter2x"), "tool --password ***");
  assert.equal(redact("find . -print && mkdir -p a && ssh -p 22 h"), "find . -print && mkdir -p a && ssh -p 22 h");
  assert.equal(redact("-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----"), "-----BEGIN PRIVATE KEY----- ***");
});

test("아주 긴 입력도 가림이 빨리 끝난다(먼저 자르고 가린다)", () => {
  const t0 = performance.now();
  const f = toFact({ hook_event_name: "UserPromptSubmit", prompt: "token".repeat(18000) });
  assert.ok(performance.now() - t0 < 100, `${(performance.now() - t0).toFixed(0)}ms`);
  assert.ok(f.text.length <= 4000);
  // 하이픈으로 이은 낱말이 길게 이어져도(가림 규칙의 되짚기) 빨리 끝난다
  for (const p of ["key-".repeat(1500), "monkey-".repeat(700), "pass-".repeat(1000)]) {
    const t1 = performance.now();
    toFact({ hook_event_name: "Stop", last_assistant_message: p });
    assert.ok(performance.now() - t1 < 100, `${p.slice(0, 7)}…: ${(performance.now() - t1).toFixed(0)}ms`);
  }
  assert.equal(toFact({ hook_event_name: "Stop", last_assistant_message: "export MY_SECRET_TOKEN=abc123 --api-key=zz" }).last, "export MY_SECRET_TOKEN=*** --api-key=***");
});

test("사용자 입력·차례 끝 답·하위 에이전트 끝 답은 4,000자까지 보내고 넘으면 … 로 자른다", () => {
  const long = "가".repeat(5000), mid = "나".repeat(3999);
  assert.equal(toFact({ hook_event_name: "Stop", last_assistant_message: mid }).last, mid);
  assert.equal(toFact({ hook_event_name: "Stop", last_assistant_message: long }).last, "가".repeat(3999) + "…");
  assert.equal(toFact({ hook_event_name: "SubagentStop", agent_id: "a", last_assistant_message: long }).last.length, 4000);
  assert.equal(toFact({ hook_event_name: "UserPromptSubmit", prompt: long }).text.length, 4000);
});

test("백그라운드 작업 알림은 sys 입력으로, 요약만 남긴다", () => {
  const f = toFact({ hook_event_name: "UserPromptSubmit", prompt: "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command \"빌드\" completed</summary>\n</task-notification>" });
  assert.deepEqual(f, { f: "prompt", sys: true, text: "Background command \"빌드\" completed" });
  assert.equal(toFact({ hook_event_name: "UserPromptSubmit", prompt: "보통 입력" }).sys, undefined);
});

test("사건 → 사실: 명령은 설명과 함께, 수정은 경로와 줄, 출력은 보내지 않는다", () => {
  const pre = toFact({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "npm test", description: "시험 실행" } });
  assert.deepEqual(pre, { f: "run-start", id: "t1", cmd: "npm test", desc: "시험 실행" });
  const post = toFact({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "npm test" }, tool_response: { stdout: "비밀이 든 출력" }, duration_ms: 1200 });
  assert.equal(post.f, "run-end");
  assert.equal(post.dur, 1200);
  assert.ok(!JSON.stringify(post).includes("비밀이 든 출력"));
  const edit = toFact({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "/w/a.js", old_string: "x", new_string: "y" }, tool_response: { structuredPatch: [{ newStart: 10, newLines: 3 }, { newStart: 40, newLines: 1 }] } });
  assert.deepEqual(edit, { f: "edit", tool: "Edit", path: "/w/a.js", lines: "10-12 외 1곳" });
  assert.equal(toFact({ hook_event_name: "PreToolUse", tool_name: "Read" }), null);
  const sub = toFact({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t2", agent_id: "ag", agent_type: "Explore", tool_input: { command: "ls" } });
  assert.equal(sub.agent, "ag");
  assert.equal(toFact({ hook_event_name: "PostToolUse", tool_name: "TaskCreate", tool_input: { subject: "로그인 고치기" } }).text, "로그인 고치기");
});

test("실제 실행: 화판에 사실이 오르고, 압축 직후에는 이름표를 stdout 으로 낸다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  const env = { ANYTASKVIEW_HOME: f.home, ANYTASKVIEW_PORT: String(f.port), CLAUDE_PID: String(process.pid) };
  const start = await runHook({ hook_event_name: "SessionStart", session_id: "H1", cwd: "/w", source: "startup" }, env);
  assert.equal(start.code, 0);
  assert.equal(f.board.pids.get(process.pid).sid, "H1");
  await f.mcp("plan", { steps: [{ id: "s1", title: "원인", status: "doing" }] }, { pid: process.pid });
  await runHook({ hook_event_name: "UserPromptSubmit", session_id: "H1", prompt: "token=abc123 고쳐 줘" }, env);
  const scene = (await f.read("/api/sessions/H1/snapshot")).json.scene;
  assert.equal(scene.timeline.at(-1).text, "token=*** 고쳐 줘");
  const compact = await runHook({ hook_event_name: "SessionStart", session_id: "H1", cwd: "/w", source: "compact" }, env);
  assert.match(compact.out, /plan: s1 "원인" doing/);
});

test("열쇠는 있는데 화판 포트가 닫혀 있어도 0 으로 빨리 끝난다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  const r = await runHook({ hook_event_name: "Stop", session_id: "H3" }, { ANYTASKVIEW_HOME: f.home, ANYTASKVIEW_PORT: "1" });
  assert.equal(r.code, 0);
  assert.ok(r.ms < 1500, `${r.ms}ms`);
});

test("화판이 꺼져 있어도 0 으로 빨리 끝난다", async () => {
  const r = await runHook({ hook_event_name: "Stop", session_id: "H2" }, { ANYTASKVIEW_PORT: "1", ANYTASKVIEW_HOME: "/nonexistent-atv" });
  assert.equal(r.code, 0);
  assert.ok(r.ms < 1500, `${r.ms}ms`);
  const broken = await runHook("이건 JSON 이 아님", { ANYTASKVIEW_PORT: "1" });
  assert.equal(broken.code, 0);
});

test("세션 이름: SessionStart·UserPromptSubmit 의 session_title 을 싣는다", () => {
  assert.equal(toFact({ hook_event_name: "SessionStart", source: "clear", session_title: "atv 02" }).title, "atv 02");
  assert.equal(toFact({ hook_event_name: "UserPromptSubmit", prompt: "x", session_title: "atv 02" }).title, "atv 02");
  assert.equal(toFact({ hook_event_name: "UserPromptSubmit", prompt: "x" }).title, undefined);
});

test("Stop --rewake: 화판 서버가 내려갔다 다시 떠도(새 판으로 갈아 끼우기) 기다림을 이어 가 메시지를 받는다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  const env = { ANYTASKVIEW_HOME: f.home, ANYTASKVIEW_PORT: String(f.port), CLAUDE_CODE_SESSION_ATTENDED: "1" };
  await f.hook("RW3", { f: "start", cwd: "/w" }, { pid: process.pid }); // 살아 있는 프로세스: 다시 뜬 서버가 끝난 세션으로 정리하지 않게
  const run = runHook({ hook_event_name: "Stop", session_id: "RW3", last_assistant_message: "끝" }, env, ["--rewake"]);
  const waiting = async () => { for (let i = 0; i < 400 && !f.board.waiters.has("RW3"); i++) await new Promise((ok) => setTimeout(ok, 25)); return f.board.waiters.has("RW3"); };
  assert.ok(await waiting(), "Stop 훅이 메시지를 기다린다");
  await f.restart({ samePort: true });
  assert.ok(await waiting(), "다시 뜬 서버에 다시 묻는다");
  const sent = await f.request("POST", "/api/board", { headers: boardHeaders(f), body: { op: "send", sid: "RW3", kind: "instruction", text: "다시 뜬 뒤의 지시" } });
  assert.equal(sent.status, 200, sent.text);
  const out = await run;
  assert.equal(out.code, 2);
  assert.match(out.err, /다시 뜬 뒤의 지시/);
});

test("Stop --rewake: 기다리던 화판 메시지를 받으면 stderr 로 내고 2 로 끝난다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  const env = { ANYTASKVIEW_HOME: f.home, ANYTASKVIEW_PORT: String(f.port), CLAUDE_CODE_SESSION_ATTENDED: "1" };
  await f.hook("RW", { f: "start", cwd: "/w" });
  const run = runHook({ hook_event_name: "Stop", session_id: "RW", last_assistant_message: "끝" }, env, ["--rewake"]);
  for (let i = 0; i < 100 && !f.board.waiters.has("RW"); i++) await new Promise((ok) => setTimeout(ok, 20));
  assert.ok(f.board.waiters.has("RW"), "Stop 훅이 메시지를 기다린다");
  const sent = await f.request("POST", "/api/board", { headers: boardHeaders(f), body: { op: "send", sid: "RW", kind: "instruction", text: "테스트 먼저 돌려 주세요" } });
  assert.equal(sent.status, 200, sent.text);
  const out = await run;
  assert.equal(out.code, 2);
  assert.match(out.err, /^\[anytaskview\] 사용자가 이 PC 의 화판에서 직접 쓴 글입니다\. 종류: 지시 · id: m[0-9a-f]{8}\n테스트 먼저 돌려 주세요/);
  // 다음 Stop 은 이미 보낸 메시지를 다시 받지 않는다
  const again = runHook({ hook_event_name: "Stop", session_id: "RW" }, env, ["--rewake"]);
  for (let i = 0; i < 100 && !f.board.waiters.has("RW"); i++) await new Promise((ok) => setTimeout(ok, 20));
  await f.hook("RW", { f: "end", reason: "other" }); // 세션이 끝나면 기다림도 「없음」으로 끝난다
  assert.equal((await again).code, 0);
});

test("Stop --rewake: 한 번 실행하는 세션(claude -p)은 기다리지 않고 바로 끝나고, --bg 처럼 지켜보지 않는 대화형 세션은 기다린다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  const env = (entry) => ({ ANYTASKVIEW_HOME: f.home, ANYTASKVIEW_PORT: String(f.port), CLAUDE_CODE_SESSION_ATTENDED: "0", CLAUDE_CODE_ENTRYPOINT: entry });
  await f.hook("RP", { f: "start", cwd: "/w" });
  const out = await runHook({ hook_event_name: "Stop", session_id: "RP", last_assistant_message: "OK" }, env("sdk-cli"), ["--rewake"]);
  assert.equal(out.code, 0);
  assert.ok(out.ms < 3000, `${out.ms}ms`);
  assert.ok(!f.board.waiters.has("RP"));
  assert.equal(f.board.sessions.get("RP").scene.timeline.at(-1).f, "stop", "차례 끝 사실은 그대로 올린다");
  await f.hook("BG", { f: "start", cwd: "/w" });
  const bg = runHook({ hook_event_name: "Stop", session_id: "BG" }, env("cli"), ["--rewake"]);
  for (let i = 0; i < 100 && !f.board.waiters.has("BG"); i++) await new Promise((ok) => setTimeout(ok, 20));
  assert.ok(f.board.waiters.has("BG"), "--bg 세션은 화판 글을 기다린다");
  await f.hook("BG", { f: "end", reason: "other" });
  assert.equal((await bg).code, 0);
});

function boardHeaders(f) {
  const host = `127.0.0.1:${f.port}`;
  return { "content-type": "application/json", origin: `http://${host}`, "x-atv-board": f.keys().board, cookie: `atv_r=${f.keys().read}` };
}

test("그리기 알림: 입력 뒤 도구를 8번 넘게 쓰면 대화마다 한 번, 입력이 오면 다시 세고, 그림·하위 에이전트·작업 알림은 세지 않는다", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "atv-nudge-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = (pid) => ({ ...process.env, ANYTASKVIEW_HOME: home, CLAUDE_PID: pid });
  const ev = (tool, extra = {}) => JSON.stringify({ session_id: "N1", hook_event_name: "PostToolUse", tool_name: tool, tool_input: { command: 'echo "tool_name":"mcp__anytaskview__draw"' }, tool_response: { stdout: "x".repeat(200_000) }, ...extra });
  const nudge = (arg, pid, input = ev("Read")) => spawnSync(NUDGE, [arg], { input, encoding: "utf8", env: env(pid) });
  const tools = (n, pid, input) => Array.from({ length: n }, () => nudge("tool", pid, input).stdout).join("");
  assert.equal(tools(8, "101"), "", "문자열 안의 draw 이름은 그림으로 치지 않는다");
  const out = JSON.parse(tools(1, "101"));
  assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(out.hookSpecificOutput.additionalContext, /no drawing yet/);
  nudge("prompt", "101", JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "다음" }));
  assert.equal(tools(20, "101"), "", "대화마다 한 번");
  assert.equal(tools(5, "102"), "");
  nudge("prompt", "102", JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "<task-notification><summary>끝</summary></task-notification>" }));
  assert.equal(tools(3, "102"), "", "작업 알림은 다시 세게 하지 않는다");
  assert.notEqual(tools(1, "102"), "");
  assert.equal(tools(3, "103"), "");
  const draw = (msg) => ev("mcp__plugin_anytaskview_anytaskview__draw", { tool_input: { ops: [{ id: "a", label: "적용 1" }] }, tool_response: [{ type: "text", text: msg }] });
  assert.equal(tools(1, "103", draw("적용 0 · 거부 1: a: kind 필요")), "", "모두 거부된 그리기는 도구로 센다");
  assert.equal(tools(1, "103", draw("비움 · 적용 3")), "", "그린 호출 자체는 알리지 않는다");
  assert.equal(tools(20, "103"), "", "그림이 있으면 알리지 않는다");
  assert.equal(tools(20, "104", ev("Read", { agent_id: "a1", agent_type: "Explore" })), "", "하위 에이전트의 도구는 세지 않는다");
  assert.equal(nudge("tool", "").stdout, "", "claude 번호가 없으면 아무것도 하지 않는다");
  // 나란히 돈 도구들의 훅이 함께 문턱을 넘어도 알림은 하나
  tools(8, "105");
  const runs = await Promise.all(Array.from({ length: 4 }, () => new Promise((ok) => {
    const p = spawn(NUDGE, ["tool"], { env: env("105") });
    let o = "";
    p.stdout.on("data", (c) => (o += c));
    p.on("close", () => ok(o)); // exit 는 출력보다 먼저 올 수 있다
    p.stdin.end(ev("Grep"));
  })));
  assert.equal(runs.filter(Boolean).length, 1);
  // 새 대화가 시작하면(SessionStart) hook.js 가 그 claude 의 파일을 지워 다시 센다. 화판이 꺼져 있어도 지운다
  const r = await runHook({ hook_event_name: "SessionStart", session_id: "N1", cwd: "/w", source: "clear" }, { ANYTASKVIEW_HOME: home, ANYTASKVIEW_PORT: "1", CLAUDE_PID: "101" });
  assert.equal(r.code, 0);
  assert.ok(!fs.existsSync(path.join(home, "nudge", "101.done")));
  assert.equal(tools(8, "101"), "");
  assert.notEqual(tools(1, "101"), "");
});

