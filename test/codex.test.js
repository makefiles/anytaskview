// Codex 시험: 훅 사건 → 사실, --codex 실행(규칙 출력·CLAUDE_* 무시), 그리기 알림, 세션 id 로 짝짓기, codex queue 로 보내기.
// 진짜 Codex 큐에 닿지 않도록 보내기 시험은 PATH 를 가짜 codex 가 있는 폴더로만 둔다
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { toFact } from "../hook/hook.js";
import { INSTRUCTIONS } from "../mcp/tools.js";
import { boardFixture } from "./helpers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, "..", "hook", "hook.js");
const NUDGE = path.join(HERE, "..", "scripts", "nudge");
const MCP = path.join(HERE, "..", "mcp", "server.js");
const until = async (cond, ms = 3000) => { for (const end = Date.now() + ms; !cond() && Date.now() < end;) await new Promise((ok) => setTimeout(ok, 20)); return cond(); };

function runHook(ev, env, args = []) {
  return new Promise((ok) => {
    const p = spawn(process.execPath, [HOOK, ...args], { env: { ...process.env, ...env } });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.on("close", (code) => ok({ code, out })); // exit 는 출력보다 먼저 올 수 있다
    p.stdin.end(JSON.stringify(ev));
  });
}

// 브라우저 쓰기(보내기): 화판 페이지와 같은 Origin·읽기 토큰·화판 쓰기 열쇠
const board = (f, body) => f.request("POST", "/api/board", {
  headers: { "content-type": "application/json", origin: `http://127.0.0.1:${f.port}`, cookie: `atv_r=${f.keys().read}`, "x-atv-board": f.keys().board },
  body,
});
const summaryOf = async (f, sid) => (await f.read("/api/sessions")).json.find((s) => s.id === sid);

test("Codex 사건 → 사실: apply_patch 는 고친 파일마다, 실패는 패치 머리의 경로로, 승인 요청은 「입력 필요」", () => {
  const ok = toFact({
    hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_input: { command: "*** Begin Patch\n*** Add File: /w/a.txt\n+x\n*** Update File: /w/b.js\n@@\n-y\n+z\n*** End Patch" },
    tool_response: "Exit code: 0\nWall time: 0.4 seconds\nOutput:\nSuccess. Updated the following files:\nA /w/a.txt\nM /w/b.js\n",
  }, { codex: true });
  assert.deepEqual(ok, [{ f: "edit", tool: "apply_patch", path: "/w/a.txt" }, { f: "edit", tool: "apply_patch", path: "/w/b.js" }]);
  const bad = toFact({ hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_input: { command: "*** Begin Patch\n*** Update File: /w/c.js\n@@\n*** End Patch" }, tool_response: "Exit code: 1\nOutput:\nverification failed: context not found" });
  assert.equal(bad.length, 1);
  assert.equal(bad[0].f, "edit-fail");
  assert.equal(bad[0].path, "/w/c.js");
  assert.match(bad[0].error, /context not found/);
  assert.deepEqual(toFact({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "rm -rf build", description: null } }), { f: "notify", ntype: "permission_prompt", text: "Bash rm -rf build" });
  // Codex 의 Bash 는 설명이 없고, 결과 글에 종료 코드가 없어 성공·실패를 가리지 않는다(화판에는 「끝」)
  assert.deepEqual(toFact({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "c1", tool_input: { command: "ls /nope" }, tool_response: "ls: 없음\n" }), { f: "run-end", id: "c1", cmd: "ls /nope", desc: "", bg: false });
  assert.deepEqual(toFact({ hook_event_name: "SessionStart", source: "startup", cwd: "/w", model: "m" }, { codex: true }), { f: "start", source: "startup", cwd: "/w", model: "m", via: "codex", home: process.env.CODEX_HOME || path.join(os.homedir(), ".codex") });
});

test("--codex 실행: SessionStart 는 화판이 꺼져 있어도 그리기 규칙을 내고, 물려받은 CLAUDE_PID 를 쓰지 않는다", async (t) => {
  const off = await runHook({ hook_event_name: "SessionStart", session_id: "X0", cwd: "/w", source: "startup" }, { ANYTASKVIEW_PORT: "1", CLAUDE_PID: String(process.pid) }, ["--codex"]);
  assert.equal(off.code, 0);
  assert.ok(off.out.startsWith(INSTRUCTIONS), "규칙이 맨 앞에 온다");
  const f = await boardFixture();
  t.after(() => f.close());
  const on = await runHook({ hook_event_name: "SessionStart", session_id: "X0", cwd: "/w", source: "startup" }, { ANYTASKVIEW_HOME: f.home, ANYTASKVIEW_PORT: String(f.port), CLAUDE_PID: String(process.pid), CODEX_HOME: "/tmp/ch" }, ["--codex"]);
  assert.equal(on.code, 0);
  assert.ok(on.out.startsWith(INSTRUCTIONS));
  const meta = f.board.sessions.get("X0").scene.meta;
  assert.equal(meta.via, "codex");
  assert.equal(meta.home, "/tmp/ch");
  assert.equal(meta.pid, undefined, "codex 조상이 없으면 pid 를 모른다(CLAUDE_PID 는 Claude 세션의 것)");
  // Stop 에 --rewake 를 붙여도 Codex 에서는 기다리지 않고 0 으로 끝난다
  const t0 = Date.now();
  const stop = await runHook({ hook_event_name: "Stop", session_id: "X0", last_assistant_message: "끝" }, { ANYTASKVIEW_HOME: f.home, ANYTASKVIEW_PORT: String(f.port) }, ["--codex", "--rewake"]);
  assert.equal(stop.code, 0);
  assert.ok(Date.now() - t0 < 3000);
});

test("그리기 알림(Codex): 세션 id 로 세고, 물려받은 CLAUDE_PID 는 보지 않는다", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "atv-nudge-codex-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const ev = (sid, tool = "Bash", extra = {}) => JSON.stringify({ session_id: sid, turn_id: "t", hook_event_name: "PostToolUse", tool_name: tool, tool_input: { command: "ls" }, tool_response: "x", ...extra });
  const nudge = (arg, input) => spawnSync(NUDGE, [arg, "codex"], { input, encoding: "utf8", env: { ...process.env, ANYTASKVIEW_HOME: home, CLAUDE_PID: "777" } });
  const tools = (n, input) => Array.from({ length: n }, () => nudge("tool", input).stdout).join("");
  assert.equal(tools(8, ev("S-1")), "");
  assert.match(JSON.parse(tools(1, ev("S-1"))).hookSpecificOutput.additionalContext, /no drawing yet/);
  assert.ok(fs.existsSync(path.join(home, "nudge", "S-1.done")));
  assert.ok(!fs.existsSync(path.join(home, "nudge", "777.n")), "CLAUDE_PID 로 세지 않는다");
  // 한 app-server 의 다른 세션은 따로 센다. Codex MCP 결과({content:[…]})의 「적용 N」 도 그림으로 친다
  assert.equal(tools(1, ev("S-2", "mcp__anytaskview__draw", { tool_response: { content: [{ type: "text", text: "적용 2" }] } })), "");
  assert.equal(tools(20, ev("S-2")), "");
  assert.equal(nudge("tool", ev("bad id")).stdout, "", "세션 id 모양이 아니면 아무것도 하지 않는다");
});

test("MCP 호출의 세션 id(Codex _meta)가 같은 pid 의 짝짓기보다 앞선다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  await f.hook("A1", { f: "start", cwd: "/w", via: "codex" }, { pid: process.pid });
  const r = await f.write("/api/mcp", { pid: process.pid, env: "", sid: "B1", cwd: "", tool: "plan", input: { steps: [{ id: "s1", title: "다른 세션" }] } });
  assert.equal(r.status, 200);
  assert.ok(f.board.sessions.get("B1").scene.items.s1);
  assert.ok(!f.board.sessions.get("A1").scene.items.s1);
  // 알지 못하는 id(빈 env)로 hello 가 오면 짝짓지 않는다
  await f.write("/api/mcp", { pid: 999_999, env: "", cwd: "", tool: "hello" });
  assert.ok(!f.board.pids.has(999_999));
});

test("Codex 보내기: codex queue 로 넣고 성공한 글만 「보냄」, 실패는 대기로 두고 차례 끝에 다시, 답이 없으면 만료, /clear 앞 세션은 받지 않음", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atv-codex-bin-"));
  const log = path.join(dir, "calls.jsonl"), mode = path.join(dir, "mode");
  // 가짜 codex: 받은 인자를 적고, mode 파일에 따라 성공(ok)·실패(fail)·멈춤(hang)
  fs.writeFileSync(path.join(dir, "codex"), `#!/bin/sh
m=$(/bin/cat "${mode}")
printf '%s\\n' "$CODEX_HOME|$1|$2|$3|$4" >> "${log}"
case "$m" in
  fail) echo "error: thread not found" >&2; exit 3 ;;
  hang) exec /bin/sleep 5 ;;
esac
echo "Queued message x for thread $3."
`, { mode: 0o755 });
  fs.writeFileSync(mode, "ok");
  const saved = { PATH: process.env.PATH, T: process.env.ANYTASKVIEW_QUEUE_TIMEOUT };
  process.env.PATH = dir;
  process.env.ANYTASKVIEW_QUEUE_TIMEOUT = "800";
  const f = await boardFixture();
  t.after(async () => {
    process.env.PATH = saved.PATH;
    if (saved.T === undefined) delete process.env.ANYTASKVIEW_QUEUE_TIMEOUT; else process.env.ANYTASKVIEW_QUEUE_TIMEOUT = saved.T;
    await f.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []);
  const send = async (sid, text) => {
    const r = JSON.parse((await board(f, { op: "send", sid, kind: "instruction", text })).text);
    assert.equal(r.ok, true, r.msg);
    await f.board.sessions.get(sid).qjob;
    return r.mid;
  };
  const state = (sid, mid) => f.board.sessions.get(sid).scene.msgs[mid];

  await f.hook("C1", { f: "start", cwd: "/w", via: "codex", home: "/tmp/ch" }, { pid: process.pid });
  assert.equal((await summaryOf(f, "C1")).agent, "codex");
  assert.equal((await summaryOf(f, "C1")).inbox, true);
  const m1 = await send("C1", "경계값부터");
  assert.equal(state("C1", m1).state, "sent");
  const [home, sub, flag, sid, msgFlag] = calls()[0].split("|");
  assert.deepEqual([home, sub, flag, sid, msgFlag], ["/tmp/ch", "queue", "--thread", "C1", "--message"]);

  fs.writeFileSync(mode, "fail");
  const m2 = await send("C1", "둘째");
  assert.equal(state("C1", m2).state, "queued");
  assert.match((await summaryOf(f, "C1")).qerr, /thread not found/);
  fs.writeFileSync(mode, "ok");
  await f.hook("C1", { f: "stop", last: "" }, { pid: process.pid });
  await f.board.sessions.get("C1").qjob;
  assert.equal(state("C1", m2).state, "sent", "차례가 끝나면 남은 글을 다시 보낸다");
  assert.equal((await summaryOf(f, "C1")).qerr, "");

  fs.writeFileSync(mode, "hang");
  const m3 = await send("C1", "셋째");
  assert.equal(state("C1", m3).state, "expired");
  assert.match(state("C1", m3).why, /전달 확인 못 함/);

  // 같은 codex 에서 /clear: 새 세션이 앞 대화를 잇고, 앞 세션에는 더 보내지 않는다
  fs.writeFileSync(mode, "ok");
  await f.hook("C2", { f: "start", cwd: "/w", via: "codex", source: "clear" }, { pid: process.pid });
  assert.equal(f.board.sessions.get("C2").scene.meta.prev, "C1");
  assert.equal((await summaryOf(f, "C1")).inbox, false);
  assert.equal((await summaryOf(f, "C2")).inbox, true);
  const before = calls().length;
  const m4 = await send("C1", "옛 대화에");
  assert.equal(state("C1", m4).state, "queued");
  assert.equal(calls().length, before, "받을 수 없는 세션에는 codex queue 를 부르지 않는다");
});

test("Codex app-server(데스크톱 앱·VS Code): 한 프로세스의 세션들은 서로 앞 대화로 잇지 않고 모두 받을 수 있다", async (t) => {
  // 명령줄에 app-server 가 든 프로세스를 띄워 그 pid 로 세션 둘을 연다
  const host = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", "app-server"], { stdio: "ignore" });
  const f = await boardFixture();
  t.after(async () => { host.kill(); await f.close(); });
  await f.hook("D1", { f: "start", cwd: "/w", via: "codex" }, { pid: host.pid });
  await f.hook("D2", { f: "start", cwd: "/w", via: "codex", source: "fork" }, { pid: host.pid });
  assert.equal(f.board.sessions.get("D2").scene.meta.shared, true);
  assert.equal(f.board.sessions.get("D2").scene.meta.prev, undefined, "같은 app-server 의 다른 세션은 앞 대화가 아니다");
  assert.equal((await summaryOf(f, "D1")).inbox, true);
  assert.equal((await summaryOf(f, "D2")).inbox, true);
  // app-server 가 끝나면 그 세션들이 모두 끝난다
  host.kill();
  await new Promise((ok) => host.on("exit", ok));
  f.board.checkLive();
  await f.board.sessions.get("D1").chain;
  await f.board.sessions.get("D2").chain;
  assert.equal(f.board.sessions.get("D1").scene.sess.status, "ended");
  assert.equal(f.board.sessions.get("D2").scene.sess.status, "ended");
});

test("hello: Codex 클라이언트는 임의 id 로 짝짓지 않고, 훅 없는 다른 MCP 클라이언트는 예전처럼 짝짓는다", async (t) => {
  for (const [name, paired] of [["codex-mcp-client", false], ["other-agent", true]]) {
    const f = await boardFixture();
    t.after(() => f.close());
    const client = new Client({ name, version: "0" });
    const env = { ...process.env, ANYTASKVIEW_HOME: f.home, ANYTASKVIEW_PORT: String(f.port) };
    delete env.CLAUDE_CODE_SESSION_ID;
    delete env.ANYTASKVIEW_SESSION;
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [MCP], env, stderr: "ignore" }));
    t.after(() => client.close());
    await client.listTools(); // initialize 뒤 hello 가 돌 시간
    await until(() => f.board.pids.has(process.pid), paired ? 3000 : 500);
    assert.equal(f.board.pids.has(process.pid), paired, name);
  }
});

test("SessionStart 를 놓친 Codex 세션: 다른 훅 사실의 via·home 으로 Codex 세션이 되고 받을 수 있다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  await f.write("/api/hook", { pid: process.pid, sid: "L1", cwd: "/w", via: "codex", home: "/h", fact: { f: "prompt", text: "시작을 놓침" } });
  const meta = f.board.sessions.get("L1").scene.meta;
  assert.equal(meta.via, "codex");
  assert.equal(meta.home, "/h");
  assert.equal(meta.pid, process.pid);
  assert.ok(meta.pstart);
  const s = await summaryOf(f, "L1");
  assert.equal(s.agent, "codex");
  assert.equal(s.inbox, true);
  // 같은 codex 에서 `/clear` 로 연 L2 의 시작도 놓쳤다: L2 의 사실이 오면 L2 가 지금 세션이 되고 L1 은 더 받지 않는다
  await f.write("/api/hook", { pid: process.pid, sid: "L2", cwd: "/w", via: "codex", home: "/h", fact: { f: "prompt", text: "clear 뒤" } });
  assert.equal((await summaryOf(f, "L2")).inbox, true);
  assert.equal((await summaryOf(f, "L1")).inbox, false);
  // 앞 세션 L1 의 늦은 사실은 짝짓기를 되돌리지 않는다(L1 은 이미 Codex 세션이라 보충하지 않는다)
  await f.write("/api/hook", { pid: process.pid, sid: "L1", cwd: "/w", via: "codex", home: "/h", fact: { f: "stop", last: "" } });
  assert.equal((await summaryOf(f, "L2")).inbox, true);
});

test("이어 연 세션: 데스크톱 앱(app-server)에서 시작한 세션을 터미널에서 이어 열면 shared·home 을 새 값으로 덮는다", async (t) => {
  const host = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", "app-server"], { stdio: "ignore" });
  const f = await boardFixture();
  t.after(async () => { host.kill(); await f.close(); });
  await f.hook("R1", { f: "start", cwd: "/w", via: "codex", home: "/old" }, { pid: host.pid });
  assert.equal(f.board.sessions.get("R1").scene.meta.shared, true);
  await f.hook("R1", { f: "start", cwd: "/w", via: "codex", source: "resume" }, { pid: process.pid });
  const meta = f.board.sessions.get("R1").scene.meta;
  assert.equal(meta.shared, false);
  assert.equal(meta.home, null);
});

test("codex queue 가 멈추면(손자가 stderr 를 쥔 채) 기다리지 않고 만료하고, 같은 글 번호로 다시 보내면 「이미 받음」", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atv-codex-hang-"));
  // npm 래퍼처럼 진짜 codex 를 손자로 띄운다. 손자는 따로 된 세션(setsid)이라 묶음째 죽여도 남아 stderr 를 쥔다
  fs.writeFileSync(path.join(dir, "codex"), "#!/bin/sh\n/usr/bin/setsid /bin/sleep 4 &\nexec /bin/sleep 4\n", { mode: 0o755 });
  const saved = { PATH: process.env.PATH, T: process.env.ANYTASKVIEW_QUEUE_TIMEOUT };
  process.env.PATH = dir;
  process.env.ANYTASKVIEW_QUEUE_TIMEOUT = "500";
  const f = await boardFixture();
  t.after(async () => {
    process.env.PATH = saved.PATH;
    if (saved.T === undefined) delete process.env.ANYTASKVIEW_QUEUE_TIMEOUT; else process.env.ANYTASKVIEW_QUEUE_TIMEOUT = saved.T;
    await f.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await f.hook("H1", { f: "start", cwd: "/w", via: "codex" }, { pid: process.pid });
  const body = { op: "send", sid: "H1", kind: "comment", text: "한 번만", cid: "c-hang-1" };
  const t0 = Date.now();
  assert.equal(JSON.parse((await board(f, body)).text).ok, true);
  await f.board.sessions.get("H1").qjob;
  assert.ok(Date.now() - t0 < 2500, `${Date.now() - t0}ms`);
  const m = Object.values(f.board.sessions.get("H1").scene.msgs)[0];
  assert.equal(m.state, "expired");
  assert.equal(m.unsure, true);
  const again = JSON.parse((await board(f, body)).text);
  assert.equal(again.ok, true);
  assert.match(again.msg, /이미 받음/);
  assert.equal(Object.keys(f.board.sessions.get("H1").scene.msgs).length, 1);
});
