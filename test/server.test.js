// 화판 서버 시험: 보안 거절, 세션 짝짓기, 기록과 다시 시작, SSE
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import { boardFixture } from "./helpers.js";

test("보안: Host·열쇠·Origin·읽기 토큰·본문 형식", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  const k = f.keys();
  assert.equal((await f.request("GET", "/", { headers: { host: `evil.example:${f.port}` } })).status, 403);
  assert.equal((await f.request("POST", "/api/mcp", { headers: { "content-type": "application/json" }, body: {} })).status, 401);
  assert.equal((await f.write("/api/mcp", {}, { origin: "http://evil.example" })).status, 403);
  assert.equal((await f.write("/api/mcp", "x=1", { "content-type": "application/x-www-form-urlencoded" })).status, 415);
  assert.equal((await f.request("GET", "/api/sessions")).status, 401);
  const locked = await f.request("GET", "/");
  assert.equal(locked.status, 401);
  assert.match(locked.text, /--url/);
  assert.equal((await f.request("GET", "/?t=wrong")).status, 401);
  // 쿠키에는 읽기 토큰만, 쓰기 열쇠로는 읽을 수 없다
  assert.equal((await f.request("GET", "/api/sessions", { headers: { cookie: `atv_r=${k.write}` } })).status, 401);
  const ok = await f.request("GET", `/?t=${k.read}`);
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.location, "/");
  assert.match(ok.headers["set-cookie"][0], /HttpOnly; SameSite=Strict/);
  assert.match(ok.headers["content-security-policy"], /default-src 'none'; script-src 'self'/);
  assert.equal(ok.headers["referrer-policy"], "no-referrer");
  assert.equal((await f.read("/")).status, 200);
  assert.equal((await f.mcp("plan", { steps: [{ id: "s", title: "x" }] }, { env: "../etc" })).status, 400);
  assert.equal((await f.hook("bad/id", { f: "start" })).status, 400);
  const st = (p) => fs.statSync(p).mode & 0o777;
  assert.equal(st(f.home), 0o700);
  assert.equal(st(path.join(f.home, "key.json")), 0o600);
});

test("깨진 요청 줄에도 서버가 죽지 않는다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  const net = await import("node:net");
  const reply = await new Promise((ok) => {
    const sock = net.connect(f.port, "127.0.0.1", () => sock.end(`GET http://[ HTTP/1.1\r\nHost: 127.0.0.1:${f.port}\r\n\r\n`));
    let buf = "";
    sock.on("data", (c) => (buf += c));
    sock.on("close", () => ok(buf));
  });
  assert.match(reply, /^HTTP\/1\.1 400/);
  assert.equal((await f.read("/api/sessions")).status, 200);
});

test("기록 쓰기가 실패하면 장면을 바꾸지 않고, 되돌리지 못하면 그 세션의 기록을 멈춘다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  await f.mcp("plan", { steps: [{ id: "s1", title: "x" }] }, { env: "W" });
  const file = path.join(f.home, "sessions", "W.jsonl");
  fs.chmodSync(file, 0o400);
  assert.equal((await f.mcp("plan", { steps: [{ id: "s2", title: "y" }] }, { env: "W" })).status, 500);
  fs.chmodSync(file, 0o600);
  assert.equal((await f.mcp("plan", { steps: [{ id: "s3", title: "z" }] }, { env: "W" })).status, 500);
  const scene = (await f.read("/api/sessions/W/snapshot")).json.scene;
  assert.deepEqual(Object.keys(scene.items), ["s1"]);
});

test("다시 띄울 때: pid 를 다른 프로세스가 다시 썼으면 끝냄, /clear 뒤에는 나중 세션을 고른다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  const pid = process.pid;
  await f.hook("A", { f: "start", cwd: "/w" }, { pid });
  await f.hook("B", { f: "start", source: "clear", cwd: "/w" }, { pid });
  await f.hook("A", { f: "stop", last: "늦게 온 옛 사건" }, { pid });
  await f.hook("C", { f: "start", cwd: "/w" }, { pid: 1 << 22 }); // 없는 pid: 아래에서 다른 프로세스가 쓴 것처럼 꾸민다
  fs.appendFileSync(path.join(f.home, "sessions", "C.jsonl"), JSON.stringify({ v: 1, seq: 99, t: 1, res: [{ k: "meta", v: { pid, pstart: "1" } }] }) + "\n");
  await f.restart();
  assert.equal(f.board.pids.get(pid).sid, "B");
  await f.board.sessions.get("C").chain;
  assert.equal((await f.read("/api/sessions/C/snapshot")).json.scene.sess.status, "ended");
});

test("포트 경쟁에서 진 서버는 기록을 건드리지 않는다(포트를 먼저 잡고 기록을 읽는다)", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  await f.hook("G", { f: "start", cwd: "/w" }, { pid: 1 << 22 }); // 없는 pid: 다시 읽으면 「끝남」을 덧붙일 세션
  const file = path.join(f.home, "sessions", "G.jsonl");
  await f.board.sessions.get("G").chain;
  const before = fs.readFileSync(file, "utf8");
  const { startBoard } = await import("../lib/server.js");
  await assert.rejects(startBoard({ port: f.port, home: f.home }), { code: "EADDRINUSE" });
  await new Promise((ok) => setTimeout(ok, 50));
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("hello: 짝짓기 표에 없는 claude 만 넣고 약속 판을 돌려준다, stop 은 onStop 이 있을 때만", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  const { PROTOCOL } = await import("../lib/store.js");
  const r = await f.mcp("hello", null, { pid: process.pid, env: "H1" });
  assert.deepEqual(JSON.parse(r.text), { proto: PROTOCOL });
  assert.equal(f.board.pids.get(process.pid).sid, "H1");
  const h1 = (await f.read("/api/sessions/H1/snapshot")).json.scene;
  assert.equal(h1.meta.pid, process.pid);
  assert.ok(h1.meta.pstart, "다시 띄울 때 짝을 되찾을 시작 시각");
  assert.equal(h1.timeline.at(-1).source, "mcp");
  await f.hook("H2", { f: "start", source: "clear", cwd: "/w" }, { pid: process.pid });
  await f.mcp("hello", null, { pid: process.pid, env: "H1" }); // 옛 id 의 hello 는 SessionStart 가 정한 짝을 바꾸지 못한다
  assert.equal(f.board.pids.get(process.pid).sid, "H2");
  assert.equal((await f.write("/api/mcp", { tool: "stop" })).status, 404);
});

test("짝짓기: MCP 가 먼저 오면 환경 변수 세션, SessionStart 뒤로는 pid 표, 늦은 옛 훅은 표를 되돌리지 못한다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  assert.equal((await f.mcp("plan", { steps: [{ id: "s1", title: "먼저" }] }, { env: "A" })).text, "계획 1단계");
  await f.hook("B", { f: "start", source: "clear", cwd: "/w" });
  await f.mcp("plan", { steps: [{ id: "s1", title: "새 세션" }] }, { env: "A" }); // MCP 는 옛 id(A)를 들고 있다
  await f.hook("A", { f: "stop", last: "늦게 온 옛 사건" });
  await f.mcp("draw", { ops: [{ id: "x", kind: "box" }] }, { env: "A" });
  const a = (await f.read("/api/sessions/A/snapshot")).json.scene, b = (await f.read("/api/sessions/B/snapshot")).json.scene;
  assert.equal(a.items.s1.title, "먼저");
  assert.equal(b.items.s1.title, "새 세션");
  assert.ok(b.items.x, "늦은 옛 훅 뒤에도 그림은 새 세션으로 간다");
  assert.equal(a.items.x, undefined);
});

test("기록: 다시 시작해도 같은 장면, 끝이 잘린 줄은 잘라 내고 이어 쓴다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  // 살아 있는 프로세스 번호를 써야 다시 시작할 때 「끝남」으로 정리되지 않는다
  const pid = process.pid;
  await f.hook("S1", { f: "start", cwd: "/w" }, { pid });
  await f.mcp("plan", { steps: [{ id: "s1", title: "원인", status: "doing" }] }, { env: "S1", pid });
  await f.hook("S1", { f: "run-start", id: "r1", cmd: "npm test" }, { ht: Date.now(), pid });
  const before = (await f.read("/api/sessions/S1/snapshot")).json;
  const file = path.join(f.home, "sessions", "S1.jsonl");
  fs.appendFileSync(file, '{"v":1,"seq":99,"res":[{"k":"put"'); // 쓰다 만 줄
  await f.restart();
  const after = (await f.read("/api/sessions/S1/snapshot")).json;
  assert.deepEqual(after, before);
  assert.ok(fs.readFileSync(file, "utf8").endsWith("\n"));
  assert.equal((await f.mcp("note", { text: "이어서" }, { env: "S1", pid })).text, "기록");
  assert.equal((await f.read("/api/sessions/S1/snapshot")).json.seq, before.seq + 1);
});

test("SSE: 스냅샷 뒤에 그다음 순번의 변경이 온다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  await f.hook("S", { f: "start", cwd: "/w" });
  const events = [];
  const req = http.get({ host: "127.0.0.1", port: f.port, path: "/events?session=S", headers: { host: `127.0.0.1:${f.port}`, cookie: `atv_r=${f.keys().read}` } });
  const got = new Promise((ok) => {
    req.on("response", (res) => {
      let buf = "";
      res.on("data", (c) => {
        buf += c;
        for (let i; (i = buf.indexOf("\n\n")) >= 0; buf = buf.slice(i + 2)) {
          const m = /^event: (\w+)\ndata: (.*)$/s.exec(buf.slice(0, i));
          if (m) events.push({ ev: m[1], data: JSON.parse(m[2]) });
          if (events.some((e) => e.ev === "res")) ok();
        }
      });
    });
  });
  await new Promise((r) => setTimeout(r, 100));
  await f.mcp("plan", { steps: [{ id: "s1", title: "x" }] }, { env: "S" });
  await got;
  req.destroy();
  const snap = events.find((e) => e.ev === "snap"), res = events.find((e) => e.ev === "res");
  assert.ok(events.findIndex((e) => e.ev === "list") < events.indexOf(snap));
  assert.equal(res.data.seq, snap.data.seq + 1);
});

test("SessionStart 전에 시작한 세션도 다른 훅 사건의 cwd 로 작업 폴더를 채운다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  await f.write("/api/hook", { pid: 4242, sid: "P", cwd: "/w/proj", fact: { f: "run-start", id: "r1", cmd: "ls" } });
  await f.write("/api/hook", { pid: 4242, sid: "P", cwd: "/w/other", fact: { f: "run-end", id: "r1" } });
  const scene = (await f.read("/api/sessions/P/snapshot")).json.scene;
  assert.equal(scene.meta.cwd, "/w/proj");
  await f.mcp("plan", { steps: [{ id: "s1", title: "x" }] }, { env: "Q" }); // 이미 있는 세션의 cwd 는 MCP 가 정한다
  await f.write("/api/hook", { pid: 4242, sid: "Q", cwd: "/w/hook", fact: { f: "stop" } });
  assert.equal((await f.read("/api/sessions/Q/snapshot")).json.scene.meta.cwd, "/w");
});

test("압축 직후 SessionStart 에 이미 있는 이름표를 돌려준다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  await f.hook("S", { f: "start", cwd: "/w" });
  const empty = JSON.parse((await f.hook("S", { f: "start", source: "compact" })).text);
  assert.equal(empty.out, undefined);
  await f.mcp("plan", { steps: [{ id: "s1", title: "원인", status: "doing" }] }, { env: "S" });
  const r = JSON.parse((await f.hook("S", { f: "start", source: "compact" })).text);
  assert.match(r.out, /plan: s1 "원인" doing/);
});

test("살아 있음: claude 프로세스가 사라지면 세션을 끝냄으로 표시한다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 200)"]);
  await f.hook("S", { f: "start", cwd: "/w" }, { pid: child.pid });
  assert.ok(f.board.pids.get(child.pid).start, "시작 시각을 적어 둔다");
  await new Promise((r) => child.on("exit", r));
  f.board.checkLive();
  await f.board.sessions.get("S").chain;
  assert.equal((await f.read("/api/sessions/S/snapshot")).json.scene.sess.status, "ended");
  assert.equal(f.board.pids.has(child.pid), false);
});

test("claude 가 사라지면 /clear 로 남은 옛 세션까지 끝낸다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 200)"]);
  await f.hook("A", { f: "start", cwd: "/w" }, { pid: child.pid });
  await f.hook("B", { f: "start", source: "clear", cwd: "/w" }, { pid: child.pid });
  await new Promise((r) => child.on("exit", r));
  f.board.checkLive();
  await Promise.all([f.board.sessions.get("A").chain, f.board.sessions.get("B").chain]);
  for (const sid of ["A", "B"]) assert.equal((await f.read(`/api/sessions/${sid}/snapshot`)).json.scene.sess.status, "ended", sid);
});

test("쓰다 만 기록은 잘라 내고, 장면은 그대로 두고, 다음 기록은 이어서 쓴다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  await f.mcp("plan", { steps: [{ id: "s1", title: "x" }] }, { env: "T" });
  const file = path.join(f.home, "sessions", "T.jsonl");
  const real = fsp.appendFile;
  // 줄의 앞 10바이트만 쓰고 실패하는 디스크를 흉내 낸다
  t.mock.method(fsp, "appendFile", async (p, data, opts) => { await real(p, String(data).slice(0, 10), opts); throw new Error("디스크 가득 참"); }, { times: 1 });
  assert.equal((await f.mcp("plan", { steps: [{ id: "s2", title: "y" }] }, { env: "T" })).status, 500);
  assert.ok(fs.readFileSync(file, "utf8").endsWith("\n"), "쓰다 만 바이트를 잘라 냈다");
  assert.equal((await f.mcp("plan", { steps: [{ id: "s3", title: "z" }] }, { env: "T" })).text, "계획 2단계");
  await f.restart();
  assert.deepEqual(Object.keys((await f.read("/api/sessions/T/snapshot")).json.scene.items), ["s1", "s3"]);
});

test("재생 기록은 파일에서 읽고, 모르는 판의 줄은 결과를 비운다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  await f.mcp("plan", { steps: [{ id: "s1", title: "x" }] }, { env: "L" });
  fs.appendFileSync(path.join(f.home, "sessions", "L.jsonl"), JSON.stringify({ v: 2, seq: 3, t: 1, res: [{ k: "put", v: { id: "z" } }] }) + "\n");
  const log = (await f.read("/api/sessions/L/log")).json;
  assert.deepEqual(log.map((r) => r.seq), [1, 2, 3]);
  assert.deepEqual(log[2].res, []);
});

// ---- 브라우저 쓰기(02): 이름·묶음·메시지 ----
const boardHeaders = (f, extra = {}) => {
  const host = `127.0.0.1:${f.port}`;
  return { "content-type": "application/json", origin: `http://${host}`, "x-atv-board": f.keys().board, cookie: `atv_r=${f.keys().read}`, ...extra };
};
const board = (f, body, extra) => f.request("POST", "/api/board", { headers: boardHeaders(f, extra), body });

test("브라우저 쓰기 보안: 같은 화판 페이지(Origin·머리글·쿠키)에서 온 것만, 큰 본문은 거절", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  await f.hook("B1", { f: "start", cwd: "/w" });
  const op = { op: "rename", sid: "B1", name: "새 이름" };
  assert.equal((await board(f, op, { origin: "http://evil.example" })).status, 403);
  assert.equal((await board(f, op, { origin: "null" })).status, 403);
  assert.equal((await board(f, op, { origin: `http://localhost:${f.port}` })).status, 403, "Host 와 다른 이름의 Origin");
  assert.equal((await board(f, op, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await board(f, op, { "x-atv-board": "1" })).status, 403, "쿠키만으로는 못 쓴다(쿠키는 다른 포트로도 샌다)");
  assert.equal((await board(f, op, { "x-atv-board": f.keys().write })).status, 403, "훅 쓰기 열쇠로도 못 쓴다");
  assert.equal((await board(f, op, { cookie: "atv_r=wrong" })).status, 401);
  assert.equal((await board(f, op, { "content-type": "text/plain" })).status, 415);
  const noOrigin = boardHeaders(f);
  delete noOrigin.origin;
  assert.equal((await f.request("POST", "/api/board", { headers: noOrigin, body: op })).status, 403);
  assert.equal((await board(f, { ...op, name: "x".repeat(300_000) })).status, 413); // 256KB(모아 보내기 20개) 넘게
  // 쓰기 열쇠 길(/api/hook)은 여전히 Origin 이 있으면 거절한다
  assert.equal((await f.write("/api/hook", { sid: "B1", fact: { f: "stop" } }, { origin: `http://127.0.0.1:${f.port}` })).status, 403);
  assert.equal((await board(f, { ...op, sec: 1 }, { "sec-fetch-site": "same-origin" })).status, 200);
});

test("이름: 화판 이름 > Claude Code 이름 > 첫 프롬프트, 비우면 돌아가고, 같은 rid 는 한 번만", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  await f.hook("N1", { f: "start", cwd: "/w", title: "claude 이름" });
  await f.hook("N1", { f: "prompt", text: "첫 입력", title: "claude 이름" });
  const name = async () => (await f.read("/api/sessions")).json.find((s) => s.id === "N1").name;
  assert.equal(await name(), "claude 이름");
  assert.equal((await board(f, { op: "rename", sid: "N1", name: "화판 이름", rid: "r1" })).status, 200);
  assert.equal(await name(), "화판 이름");
  const seq = f.board.sessions.get("N1").seq;
  assert.equal((await board(f, { op: "rename", sid: "N1", name: "다른 이름", rid: "r1" })).status, 200);
  assert.equal(await name(), "화판 이름", "같은 rid 는 다시 처리하지 않는다");
  assert.equal(f.board.sessions.get("N1").seq, seq);
  await board(f, { op: "rename", sid: "N1", name: "  " });
  assert.equal(await name(), "claude 이름");
  assert.equal((await board(f, { op: "rename", sid: "없음", name: "x" })).status, 400);
});

test("프로젝트: 만들기·넣기·이름·끝·풀기, 파일에 남고, /clear 로 이어진 세션은 프로젝트를 물려받는다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  const pid = process.pid;
  await f.hook("C1", { f: "start", cwd: "/w" }, { pid });
  const made = JSON.parse((await board(f, { op: "proj-new", name: "anytaskview 02" })).text);
  assert.ok(/^g[0-9a-f]{8}$/.test(made.pid));
  assert.equal((await board(f, { op: "proj-set", sids: ["C1"], pid: made.pid })).status, 200);
  await f.hook("C1", { f: "end", reason: "clear" }, { pid });
  await f.hook("C2", { f: "start", source: "clear", cwd: "/w" }, { pid });
  assert.deepEqual(f.board.projects.members.C2, { pid: made.pid, why: "thread" });
  await f.hook("C3", { f: "start", cwd: "/w" }, { pid: 1 << 22 }); // 다른 claude: 물려받지 않는다
  assert.equal(f.board.projects.members.C3, undefined);
  assert.equal((await board(f, { op: "proj-set", sid: "C3", pid: made.pid })).status, 200);
  assert.equal((await board(f, { op: "proj-set", sid: "C3", pid: "g00000000" })).status, 400);
  assert.equal((await board(f, { op: "proj-set", sid: "C3" })).status, 400, "pid 를 빠뜨리면 빼기가 아니라 거절");
  assert.equal((await board(f, { op: "proj-rename", pid: made.pid, name: "02 단위" })).status, 200);
  assert.equal((await board(f, { op: "proj-done", pid: made.pid, done: true })).status, 200);
  const saved = JSON.parse(fs.readFileSync(path.join(f.home, "projects.json"), "utf8"));
  assert.equal(saved.projects[made.pid].name, "02 단위");
  assert.equal(saved.projects[made.pid].done, true);
  assert.deepEqual(Object.keys(saved.members).sort(), ["C1", "C2", "C3"]);
  await f.restart();
  assert.equal(f.board.projects.projects[made.pid].name, "02 단위", "다시 띄워도 남는다");
  assert.equal((await board(f, { op: "proj-drop", pid: made.pid })).status, 200);
  assert.deepEqual(f.board.projects, { projects: {}, members: {} });
});

test("메시지: 검사, 기다리는 훅에 한 번만, 새 기다림이 옛 것을 끝내고, 세션이 끝나면 만료, 다시 띄워도 대기열이 남는다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  // 다시 띄울 때 「끝남」으로 정리되지 않도록 살아 있는 프로세스 번호를 쓴다
  await f.hook("Q1", { f: "start", cwd: "/w" }, { pid: process.pid });
  await f.mcp("plan", { steps: [{ id: "s1", title: "고치기", status: "doing" }] }, { env: "Q1", pid: process.pid });
  const send = (b) => board(f, { op: "send", sid: "Q1", kind: "comment", text: "확인", ...b });
  assert.equal((await send({ kind: "order" })).status, 400);
  assert.equal((await send({ text: "  " })).status, 400);
  assert.equal((await send({ target: "nope" })).status, 400);
  assert.equal((await send({ text: "가".repeat(1400) })).status, 400, "UTF-8 4000바이트 넘음");
  const first = JSON.parse((await send({ target: "s1", kind: "instruction", text: "경계값부터" })).text);
  assert.equal(first.ok, true);
  // 기다리는 훅이 없으면 대기로 남는다. 다시 띄워도 기록에서 되살아난다
  await f.restart();
  assert.equal(f.board.sessions.get("Q1").scene.msgs[first.mid].state, "queued");
  const inbox = (wait = 5000) => f.write("/api/inbox", { sid: "Q1", wait });
  const got = await inbox();
  assert.equal(got.status, 200);
  assert.match(got.text, /종류: 지시 · 대상: 단계 s1 · id: m[0-9a-f]{8}\n경계값부터$/);
  assert.equal(f.board.sessions.get("Q1").scene.msgs[first.mid].state, "sent");
  // 기다리는 길이가 지나면 202(다시 물어라), 새 기다림이 오면 옛 기다림은 204(그만)
  assert.equal((await inbox(50)).status, 202);
  const old = inbox(10_000);
  for (let i = 0; i < 50 && !f.board.waiters.has("Q1"); i++) await new Promise((ok) => setTimeout(ok, 10));
  const newer = inbox(10_000);
  assert.equal((await old).status, 204);
  await send({ text: "둘째" });
  const n = await newer;
  assert.equal(n.status, 200);
  assert.ok(!n.text.includes("경계값부터"), "보낸 메시지는 다시 가지 않는다");
  // 세션이 끝나면 남은 대기 메시지는 만료된다(기다리던 훅이 「없음」으로 끝나는 것은 훅 시험에서 본다)
  const left = JSON.parse((await send({ text: "셋째" })).text);
  await f.hook("Q1", { f: "end", reason: "clear" }, { pid: process.pid });
  assert.equal(f.board.sessions.get("Q1").scene.msgs[left.mid].state, "expired");
  assert.equal((await inbox(1000)).status, 204, "끝난 세션은 기다리지 않는다");
  assert.equal((await send({ text: "끝난 뒤" })).status, 400);
});

test("모아 보내기: 여러 글을 기록 한 줄에 모두 넣거나, 하나라도 틀리면 하나도 넣지 않고 몇 번째인지 알린다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  await f.hook("M1", { f: "start", cwd: "/w" }, { pid: process.pid });
  await f.mcp("plan", { steps: [{ id: "s1", title: "고치기" }] }, { env: "M1", pid: process.pid });
  const many = (items) => board(f, { op: "send", sid: "M1", items });
  const msgs = () => Object.values(f.board.sessions.get("M1").scene.msgs || {});
  const seq = f.board.sessions.get("M1").seq;
  const bad = await many([{ kind: "comment", text: "하나" }, { kind: "comment", text: "둘", target: "없는것" }]);
  assert.equal(bad.status, 400);
  assert.match(JSON.parse(bad.text).msg, /^2번째 글: 대상 없는것 없음/);
  assert.equal(msgs().length, 0, "앞의 글도 넣지 않는다");
  assert.equal(f.board.sessions.get("M1").seq, seq, "기록하지 않는다");
  assert.equal((await many([])).status, 400);
  assert.equal((await many("글")).status, 400);
  assert.equal((await many([null])).status, 400);
  const ok = JSON.parse((await many([{ kind: "instruction", text: "단계에", target: "s1" }, { kind: "comment", text: "전체에" }])).text);
  assert.equal(ok.ok, true);
  assert.equal(ok.mids.length, 2);
  assert.equal(f.board.sessions.get("M1").seq, seq + 1, "기록 한 줄");
  assert.deepEqual(msgs().map((m) => [m.text, m.target?.id ?? null, m.state]), [["단계에", "s1", "queued"], ["전체에", null, "queued"]]);
  // 대기 한도(20)는 이미 대기 중인 글과 합쳐 센다
  const fill = Array.from({ length: 18 }, (_, i) => ({ kind: "comment", text: `채움 ${i}` }));
  assert.equal((await many(fill)).status, 200);
  const over = await many([{ kind: "comment", text: "넘침" }]);
  assert.equal(over.status, 400);
  assert.match(JSON.parse(over.text).msg, /대기 메시지가 20개를 넘음/);
  // 기다리는 훅은 모은 글을 한 번에 받는다
  const got = await f.write("/api/inbox", { sid: "M1", wait: 5000 });
  assert.equal(got.status, 200);
  assert.ok(got.text.includes("단계에") && got.text.includes("전체에"));
  await f.hook("M1", { f: "end", reason: "other" }, { pid: process.pid });
  assert.equal((await many([{ kind: "comment", text: "끝난 뒤" }])).status, 400);
});

test("같은 글 번호(cid): 다시 보내면 「이미 받음」 으로 성공하고 넣지 않으며, 내용이 다르면 거절, 다시 띄운 뒤에도 기억하고, 만료된 글은 받은 것으로 치지 않는다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  await f.hook("C1", { f: "start", cwd: "/w" }, { pid: process.pid });
  const one = (b) => board(f, { op: "send", sid: "C1", kind: "comment", text: "하나", ...b });
  const many = (items) => board(f, { op: "send", sid: "C1", items });
  const msgs = () => Object.values(f.board.sessions.get("C1").scene.msgs || {});
  const A = "aaaaaaaa-0000-4000-8000-000000000001", B = "bbbbbbbb-0000-4000-8000-000000000002", C = "cccccccc-0000-4000-8000-000000000003";
  assert.equal((await one({ cid: "짧음" })).status, 400);
  const first = JSON.parse((await one({ cid: A })).text);
  const seq = f.board.sessions.get("C1").seq;
  const again = JSON.parse((await one({ cid: A, text: "  하나\r\n" })).text); // 정리하면 같은 글
  assert.deepEqual([again.ok, again.mid], [true, first.mid]);
  assert.equal(f.board.sessions.get("C1").seq, seq, "다시 기록하지 않는다");
  const diff = await one({ cid: A, text: "고친 글" });
  assert.equal(diff.status, 400);
  assert.equal(JSON.parse(diff.text).conflict, A);
  // 묶음: 이미 받은 것은 건너뛰고 새 것만 넣으며, 응답의 cids 로 화면이 모은 글을 지운다
  const item = (cid, text) => ({ cid, kind: "comment", text });
  const b1 = JSON.parse((await many([item(A, "하나"), item(B, "둘")])).text);
  assert.deepEqual([b1.ok, b1.mids[0], b1.cids], [true, first.mid, [A, B]]);
  assert.match(b1.msg, /대기 1개 · 이미 받은 1개/);
  const b2 = JSON.parse((await many([item(A, "하나"), item(B, "둘")])).text);
  assert.equal(b2.ok, true, "모두 이미 받은 묶음도 성공");
  assert.equal(msgs().length, 2);
  assert.equal(JSON.parse((await many([item(C, "셋"), item(C, "셋")])).text).ok, false, "한 요청 안에 같은 번호");
  const bad = await many([item(C, "셋"), item(B, "다른 둘")]);
  assert.equal(JSON.parse(bad.text).conflict, B);
  assert.equal(msgs().length, 2, "새 글도 넣지 않는다");
  // 대기 한도는 새로 넣을 글만 센다
  await many(Array.from({ length: 18 }, (_, i) => item(`fill0000-0000-4000-8000-${String(i).padStart(12, "0")}`, `채움 ${i}`)));
  assert.equal(JSON.parse((await many([item(A, "하나"), item(B, "둘")])).text).ok, true, "이미 받은 글은 한도에 들지 않는다");
  assert.equal((await many([item(C, "셋")])).status, 400, "새 글은 한도에 걸린다");
  // 다시 띄운 뒤에도 기억한다. 세션이 끝나 만료된 글은 받은 것으로 치지 않는다(Claude 에 가지 않았다): 끝난 세션이라 거절
  await f.restart();
  const re = JSON.parse((await one({ cid: A })).text);
  assert.deepEqual([re.ok, re.mid], [true, first.mid]);
  await f.hook("C1", { f: "end", reason: "other" }, { pid: process.pid });
  assert.equal((await one({ cid: A })).status, 400, "만료된 글로 「이미 받음」 이라 하지 않는다");
  assert.equal((await one({ cid: C, text: "끝난 뒤 새 글" })).status, 400);
});

test("나눠 쓰는 연결: 구독한 세션만 받고, 새로 받는 세션과 fresh 는 같은 연결로 스냅샷부터, 화면 페이지에서 온 것만", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  const P1 = (1 << 22) + 1, P2 = (1 << 22) + 2;
  await f.hook("H1", { f: "start", cwd: "/w" }, { pid: P1 });
  await f.hook("H2", { f: "start", cwd: "/w" }, { pid: P2 });
  const chan = "c0ffee00-1111-2222-3333-444455556666";
  const s = sse(f, `/events?chan=${chan}`, t);
  await s.until((ev) => ev.some((e) => e.ev === "list"));
  // 구독은 읽기라 화판 쓰기 열쇠 없이 읽기 쿠키로 받는다(쓰기 열쇠가 없는 브라우저도 탭을 나눠 쓴다)
  const { "x-atv-board": _, ...pageHeaders } = boardHeaders(f);
  const sub = (body, extra) => f.request("POST", "/api/sub", { headers: { ...pageHeaders, ...extra }, body: { chan, ...body } });
  assert.equal((await sub({ sids: ["H1"] }, { origin: "http://evil.example" })).status, 403);
  assert.equal((await sub({ sids: ["H1"] }, { cookie: "atv_r=wrong" })).status, 401);
  assert.equal((await sub({ sids: ["H1"], chan: "없는-연결-이름-0000000000" })).status, 404);
  const r = await sub({ sids: ["H1", "모름"] });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.text).sids, ["H1"], "모르는 id 는 받지 않는다");
  await f.mcp("plan", { steps: [{ id: "a", title: "가" }] }, { env: "H1", pid: P1 });
  await f.mcp("plan", { steps: [{ id: "b", title: "나" }] }, { env: "H2", pid: P2 });
  let ev = await s.until((x) => x.some((e) => e.ev === "res" && e.data.id === "H1"));
  const ofSid = (id) => ev.filter((e) => (e.ev === "snap" || e.ev === "res") && e.data.id === id).map((e) => e.ev);
  assert.deepEqual(ofSid("H1"), ["snap", "res"]);
  assert.deepEqual(ofSid("H2"), [], "구독하지 않은 세션의 변경은 오지 않는다");
  // 하나를 더하면 그것만 스냅샷, fresh 를 주면 이미 받던 것도 스냅샷
  await sub({ sids: ["H1", "H2"] });
  await sub({ sids: ["H1", "H2"], fresh: ["H1"] });
  ev = await s.until((x) => x.filter((e) => e.ev === "snap").length >= 3);
  assert.deepEqual(ofSid("H1"), ["snap", "res", "snap"]);
  assert.deepEqual(ofSid("H2"), ["snap"]);
  assert.equal(ev.filter((e) => e.ev === "snap" && e.data.id === "H2")[0].data.seq, f.board.sessions.get("H2").seq);
  // 빼면 더 오지 않는다
  await sub({ sids: ["H2"] });
  await f.mcp("plan", { steps: [{ id: "a", status: "done" }] }, { env: "H1", pid: P1 });
  await f.mcp("plan", { steps: [{ id: "b", status: "done" }] }, { env: "H2", pid: P2 });
  ev = await s.until((x) => x.filter((e) => e.ev === "res" && e.data.id === "H2").length >= 1);
  assert.deepEqual(ofSid("H1"), ["snap", "res", "snap"]);
});

test("같은 rid 의 요청이 동시에 와도 한 번만 처리한다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  await f.hook("D1", { f: "start", cwd: "/w" });
  const body = { op: "send", sid: "D1", kind: "comment", text: "한 번만", rid: "same-rid" };
  const [a, b] = await Promise.all([board(f, body), board(f, body)]);
  assert.equal(a.text, b.text);
  assert.equal(Object.keys(f.board.sessions.get("D1").scene.msgs).length, 1);
});

test("프로젝트를 바꾸는 중에 /clear 가 와도 바뀐 뒤의 프로젝트를 물려받는다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  const pid = process.pid;
  await f.hook("E1", { f: "start", cwd: "/w" }, { pid });
  const a = JSON.parse((await board(f, { op: "proj-new", name: "옛 프로젝트" })).text);
  await board(f, { op: "proj-set", sids: ["E1"], pid: a.pid });
  const b = JSON.parse((await board(f, { op: "proj-new", name: "새 프로젝트" })).text);
  // 소속 바꾸기를 줄 세운 직후(아직 파일에 쓰기 전)에 /clear 가 온다
  const moving = board(f, { op: "proj-set", sids: ["E1"], pid: b.pid });
  await f.hook("E2", { f: "start", source: "clear", cwd: "/w" }, { pid });
  await moving;
  assert.equal(f.board.projects.members.E1.pid, b.pid);
  assert.equal(f.board.projects.members.E2.pid, b.pid);
});

test("만료 처리 전의 오래된 메시지만 있으면 기다림을 빼앗지 않고, 큰 대기열은 32KB 씩 나눠 넘긴다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  await f.hook("F1", { f: "start", cwd: "/w" }, { pid: process.pid });
  const file = path.join(f.home, "sessions", "F1.jsonl");
  await f.board.sessions.get("F1").chain;
  const seq = f.board.sessions.get("F1").seq;
  // 31분 전에 들어온 대기 메시지(아직 만료로 바뀌지 않음)를 기록에 넣고 다시 띄운다
  fs.appendFileSync(file, JSON.stringify({ v: 1, seq: seq + 1, t: 1, src: "board", type: "send", res: [{ k: "msg", v: { mid: "mold", kind: "comment", text: "오래됨", target: null, state: "queued", t: Date.now() - 31 * 60_000 } }] }) + "\n");
  await f.restart();
  const r = await f.write("/api/inbox", { sid: "F1", wait: 100 });
  assert.equal(r.status, 202, "오래된 것만 있으면 「없음」(204)으로 끊지 않고 다시 묻게 한다");
  for (let i = 0; i < 9; i++) assert.equal((await board(f, { op: "send", sid: "F1", kind: "comment", text: `${i}`.repeat(3900) })).status, 200);
  const first = await f.write("/api/inbox", { sid: "F1", wait: 1000 });
  assert.equal(first.status, 200);
  assert.ok(Buffer.byteLength(first.text) <= 34_000, `${Buffer.byteLength(first.text)}바이트`);
  const second = await f.write("/api/inbox", { sid: "F1", wait: 1000 });
  assert.equal(second.status, 200, "남은 것은 다음 기다림에");
  assert.ok(!second.text.includes("오래됨"));
});

test("SSE 화면과 기다리는 훅이 있어도 서버를 닫을 때 오류가 없다", async (t) => {
  const f = await boardFixture();
  await f.hook("G1", { f: "start", cwd: "/w" });
  const sse = await new Promise((ok) => {
    const req = http.request({ host: "127.0.0.1", port: f.port, path: "/events", headers: { host: `127.0.0.1:${f.port}`, cookie: `atv_r=${f.keys().read}` } }, ok);
    req.end();
  });
  sse.on("data", () => {});
  const waiting = f.write("/api/inbox", { sid: "G1", wait: 60_000 });
  for (let i = 0; i < 50 && !f.board.waiters.has("G1"); i++) await new Promise((ok) => setTimeout(ok, 10));
  const errors = [];
  process.on("uncaughtException", (e) => errors.push(e));
  await f.close();
  assert.equal((await waiting).status, 204);
  await new Promise((ok) => setTimeout(ok, 50));
  assert.deepEqual(errors.map((e) => e.code), []);
});

test("포트 주인: 이 사용자의 화판은 self, 아무도 안 들으면 none", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  const { portOwner } = await import("../lib/store.js");
  assert.equal(portOwner(f.port), "self");
  assert.equal(portOwner(1), "none");
  // IPv4 를 옮긴 IPv6 주소(::ffff:127.0.0.1)에 묶은 소켓도 그 포트의 주인으로 본다(다른 사용자면 열쇠를 보내지 않게)
  const s6 = http.createServer();
  await new Promise((ok, fail) => { s6.once("error", fail); s6.listen(0, "::ffff:127.0.0.1", ok); });
  t.after(() => s6.close());
  assert.equal(portOwner(s6.address().port), "self");
});

const tick = () => new Promise((ok) => setTimeout(ok, 5)); // 시작 시각·마지막 시각이 같은 ms 에 겹치지 않게
const sessMap = async (f) => Object.fromEntries((await f.read("/api/sessions")).json.map((s) => [s.id, s]));

test("이어진 대화: /clear 는 같은 claude 의 직전 세션, 이어받기 문구는 그 키를 가진 가장 최근 세션을 앞 대화로 남기고, 그 키의 프로젝트에 넣는다(처음 보는 키는 새 프로젝트)", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  const pid = process.pid, other = (n) => (1 << 22) + n;
  assert.equal(f.board.config.resume, null, "새 PC 는 이어받기 문구가 꺼져 있다");
  assert.equal((await board(f, { op: "config-set", resume: { phrase: "핸드온 <키>", doc: "/handoff/<키>.md" } })).status, 200);
  await f.hook("A1", { f: "start", cwd: "/w" }, { pid });
  const made = JSON.parse((await board(f, { op: "proj-new", name: "k1 작업" })).text);
  await board(f, { op: "proj-set", sids: ["A1"], pid: made.pid });
  await f.hook("A1", { f: "prompt", text: "인계 문서 쓰기" }, { pid });
  await f.hook("A1", { f: "edit", tool: "Write", path: "/m/pages/handoff/k1.md" }, { pid });
  await tick();
  await f.hook("A2", { f: "start", source: "clear", cwd: "/w" }, { pid });
  let s = await sessMap(f);
  assert.equal(s.A2.prev, "A1", "/clear");
  assert.equal(s.A1.prev, null);
  await tick();
  assert.deepEqual(f.board.projects.projects[made.pid].keys, ["k1"], "프로젝트에 든 대화가 인계 문서를 고치면 그 키가 프로젝트에 붙는다");
  // 다른 claude 에서 핸드온: 인계 문서를 고친 A1 에 잇고 그 키의 프로젝트에 들어간다
  await f.hook("B1", { f: "start", cwd: "/w" }, { pid: other(0) });
  await f.hook("B1", { f: "prompt", text: "핸드온 k1 — 이어서" }, { pid: other(0) });
  s = await sessMap(f);
  assert.equal(s.B1.prev, "A1");
  assert.deepEqual(f.board.projects.members.B1, { pid: made.pid, why: "phrase" });
  await tick();
  // 다음 핸드온 은 더 최근에 k1 을 가진 B1 에 잇는다. 첫 입력이 아니거나 모르는 키면 잇지 않는다
  await f.hook("C1", { f: "start", cwd: "/w" }, { pid: other(1) });
  await f.hook("C1", { f: "prompt", text: "핸드온 k1" }, { pid: other(1) });
  await f.hook("D1", { f: "start", cwd: "/w" }, { pid: other(2) });
  await f.hook("D1", { f: "prompt", text: "다른 일" }, { pid: other(2) });
  await f.hook("D1", { f: "prompt", text: "핸드온 k1" }, { pid: other(2) });
  await f.hook("E1", { f: "start", cwd: "/w" }, { pid: other(3) });
  await f.hook("E1", { f: "prompt", text: "핸드온 없는키" }, { pid: other(3) });
  s = await sessMap(f);
  assert.deepEqual([s.C1.prev, s.D1.prev, s.E1.prev], ["B1", null, null]);
  assert.equal(f.board.projects.members.D1, undefined, "첫 입력이 아니면 넣지 않는다");
  const fresh = f.board.projects.members.E1;
  assert.equal(fresh.why, "phrase");
  assert.deepEqual([f.board.projects.projects[fresh.pid].name, f.board.projects.projects[fresh.pid].keys], ["없는키", ["없는키"]], "처음 보는 키는 그 이름으로 새 프로젝트");
  await f.restart();
  s = await sessMap(f);
  assert.equal(s.C1.prev, "B1", "다시 띄워도 기록에서 되살아난다");
});

test("빈 세션: 모르는 세션의 끝으로는 세션을 만들지 않고, 입력도 그림도 없이 끝난 세션은 empty 로 알린다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  assert.equal((await f.hook("X0", { f: "end", reason: "other" })).status, 200);
  assert.ok(!fs.existsSync(path.join(f.home, "sessions", "X0.jsonl")));
  const p = (n) => (1 << 22) + n;
  await f.hook("X1", { f: "start", cwd: "/w" }, { pid: p(1) });
  await f.hook("X1", { f: "end", reason: "other" }, { pid: p(1) });
  await f.hook("X2", { f: "start", cwd: "/w" }, { pid: p(2) });
  await f.hook("X2", { f: "prompt", text: "일" }, { pid: p(2) });
  await f.hook("X2", { f: "end", reason: "other" }, { pid: p(2) });
  await f.hook("X3", { f: "start", cwd: "/w" }, { pid: p(3) });
  const s = await sessMap(f);
  assert.deepEqual([s.X0, s.X1.empty, s.X2.empty, s.X3.empty], [undefined, true, false, false]);
});

test("SessionStart 답에 그 대화의 화판에 그림이 있는지 싣는다(그리기 알림을 끈다)", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  const first = JSON.parse((await f.hook("Y1", { f: "start", cwd: "/w" })).text);
  assert.equal(first.drawn, false);
  await f.mcp("plan", { steps: [{ id: "s1", title: "계획만" }] });
  assert.equal(JSON.parse((await f.hook("Y1", { f: "start", source: "resume", cwd: "/w" })).text).drawn, false, "계획만으로는 그림이 아니다");
  await f.mcp("draw", { ops: [{ id: "a", kind: "box", label: "상자" }] });
  assert.equal(JSON.parse((await f.hook("Y1", { f: "start", source: "resume", cwd: "/w" })).text).drawn, true);
});

test("프로젝트 옮기기: sids 로 이어진 대화를 한 번에 옮기고, 모르는 세션이 하나라도 있거나 50개를 넘으면 아무것도 바꾸지 않으며, 「프로젝트 없음」 은 뺌으로 남는다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  for (const id of ["M1", "M2", "M3"]) await f.hook(id, { f: "start", cwd: "/w" }, { pid: (1 << 22) + id.charCodeAt(1) });
  const made = JSON.parse((await board(f, { op: "proj-new", name: "빈 프로젝트" })).text);
  assert.ok(made.ok);
  assert.deepEqual(f.board.projects.members, {}, "만들기만 하면 빈 프로젝트");
  assert.equal((await board(f, { op: "proj-set", sids: ["M1", "M2"], pid: made.pid })).status, 200);
  const hand = { pid: made.pid, why: "hand" };
  assert.deepEqual(f.board.projects.members, { M1: hand, M2: hand });
  assert.equal((await board(f, { op: "proj-set", sids: ["M3", "NOPE"], pid: made.pid })).status, 400);
  assert.equal((await board(f, { op: "proj-set", sids: Array(51).fill("M3"), pid: made.pid })).status, 400);
  assert.equal((await board(f, { op: "proj-set", sids: [], pid: made.pid })).status, 400);
  assert.equal(f.board.projects.members.M3, undefined);
  assert.equal((await board(f, { op: "proj-set", sids: ["M1", "M2"], pid: null })).status, 200);
  const out = { pid: null, why: "hand" };
  assert.deepEqual(f.board.projects.members, { M1: out, M2: out });
});

test("지우기: 끝난 대화만 휴지통으로 옮기고 프로젝트 소속을 지우며 SSE 로 알린다, 같은 id 로 다시 오면 새 기록, 30일 지난 휴지통은 비운다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  const p = (n) => (1 << 22) + n;
  await f.hook("D1", { f: "start", cwd: "/w" }, { pid: p(1) });
  await f.mcp("draw", { ops: [{ id: "a", kind: "box", label: "상자" }] }, { pid: p(1), env: "D1" });
  await f.hook("D1", { f: "end", reason: "other" }, { pid: p(1) });
  await f.hook("D2", { f: "start", cwd: "/w" }, { pid: p(2) });
  const made = JSON.parse((await board(f, { op: "proj-new", name: "프로젝트" })).text);
  await board(f, { op: "proj-set", sids: ["D1", "D2"], pid: made.pid });
  const events = [];
  const req = http.get({ host: "127.0.0.1", port: f.port, path: "/events", headers: { host: `127.0.0.1:${f.port}`, cookie: `atv_r=${f.keys().read}` } });
  const dropped = new Promise((ok) => {
    req.on("response", (res) => {
      let buf = "";
      res.on("data", (c) => {
        buf += c;
        for (let i; (i = buf.indexOf("\n\n")) >= 0; buf = buf.slice(i + 2)) {
          const m = /^event: (\w+)\ndata: (.*)$/s.exec(buf.slice(0, i));
          if (m) events.push({ ev: m[1], data: JSON.parse(m[2]) });
          if (events.some((e) => e.ev === "drop")) ok();
        }
      });
    });
  });
  t.after(() => req.destroy());
  await new Promise((r) => setTimeout(r, 100));

  assert.equal((await board(f, { op: "sess-delete", sids: ["D2"] })).status, 400, "진행 중인 대화는 지우지 않는다");
  assert.equal((await board(f, { op: "sess-delete", sids: ["D1", "NOPE"] })).status, 400, "모르는 세션이 섞이면 아무것도 지우지 않는다");
  const many = await board(f, { op: "sess-delete", sids: Array.from({ length: 51 }, (_, i) => `Z${i}`) });
  assert.equal(many.status, 400);
  assert.match(JSON.parse(many.text).msg, /50개까지/);
  const held = f.board.sessions.get("D1");
  assert.ok([...f.board.pids.values()].some((e) => e.sid === "D1"), "끝난 뒤에도 짝짓기 표에 남아 있다(시험 전제)");
  const out = JSON.parse((await board(f, { op: "sess-delete", sids: ["D1", "D2"] })).text);
  assert.ok(![...f.board.pids.values()].some((e) => e.sid === "D1"), "지운 세션을 짝짓기 표에서 뺀다");
  assert.equal(held.broken, true, "쥐고 있던 처리가 옛 파일 자리에 쓰지 않게 멈춘다");
  assert.deepEqual([out.ok, out.gone], [true, ["D1"]]);
  assert.match(out.msg, /1개는 진행 중이라 남김/);
  await dropped;
  assert.deepEqual(events.find((e) => e.ev === "drop").data, ["D1"]);
  const s = await sessMap(f);
  assert.deepEqual([s.D1, !!s.D2], [undefined, true]);
  assert.deepEqual(f.board.projects.members, { D2: { pid: made.pid, why: "hand" } });
  assert.ok(!fs.existsSync(path.join(f.home, "sessions", "D1.jsonl")));
  const trashed = fs.readdirSync(path.join(f.home, "trash"));
  assert.equal(trashed.length, 1);
  assert.match(trashed[0], /^D1\.\d+\.jsonl$/);
  assert.equal((await f.read("/api/sessions/D1/snapshot")).status, 404);

  // claude --continue 처럼 같은 id 로 다시 오면 빈 장면의 새 기록으로 시작한다
  await f.hook("D1", { f: "start", source: "resume", cwd: "/w" }, { pid: p(3) });
  const snap = (await f.read("/api/sessions/D1/snapshot")).json;
  assert.deepEqual(Object.keys(snap.scene.items), []);

  // 30일이 지난 휴지통 파일만 다시 띄울 때 비운다
  const old = `X.${Date.now() - 31 * 86_400_000}.jsonl`;
  fs.writeFileSync(path.join(f.home, "trash", old), "");
  await f.restart();
  assert.deepEqual(fs.readdirSync(path.join(f.home, "trash")), trashed);
  assert.ok((await sessMap(f)).D1, "다시 띄워도 새 기록은 남는다");
});

test("지우기: 줄 선 기록이 다 끝난 뒤에 보므로, 기다리는 사이 다시 시작한 대화는 남긴다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  await f.hook("R1", { f: "start", cwd: "/w" }, { pid: (1 << 22) + 9 });
  await f.hook("R1", { f: "end", reason: "other" }, { pid: (1 << 22) + 9 });
  // 기록 줄을 잠깐 막아 둔다: 지우기가 먼저 기다리기 시작하고, 그 뒤에 resume 이 줄을 선다
  const s = f.board.sessions.get("R1");
  let open;
  s.chain = s.chain.then(() => new Promise((ok) => { open = ok; }));
  const del = board(f, { op: "sess-delete", sids: ["R1"] });
  await new Promise((r) => setTimeout(r, 50));
  const again = f.hook("R1", { f: "start", source: "resume", cwd: "/w" }, { pid: (1 << 22) + 10 });
  await new Promise((r) => setTimeout(r, 50));
  open();
  await again;
  assert.equal((await del).status, 400);
  assert.equal((await sessMap(f)).R1.status, "idle");
  assert.deepEqual(fs.readdirSync(path.join(f.home, "trash")), []);
});

test("지우기: 뒤 세션을 기다리는 사이 같은 id 로 다시 생긴 세션은 지움 알림보다 뒤에 알리고, 휴지통의 같은 이름은 덮어쓰지 않는다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  for (const id of ["A", "B"]) {
    await f.hook(id, { f: "start", cwd: "/w" }, { pid: (1 << 22) + id.charCodeAt(0) });
    await f.hook(id, { f: "end", reason: "other" }, { pid: (1 << 22) + id.charCodeAt(0) });
  }
  const events = [];
  const req = http.get({ host: "127.0.0.1", port: f.port, path: "/events", headers: { host: `127.0.0.1:${f.port}`, cookie: `atv_r=${f.keys().read}` } });
  req.on("response", (res) => {
    let buf = "";
    res.on("data", (c) => {
      buf += c;
      for (let i; (i = buf.indexOf("\n\n")) >= 0; buf = buf.slice(i + 2)) {
        const m = /^event: (\w+)\ndata: (.*)$/s.exec(buf.slice(0, i));
        if (m) events.push({ ev: m[1], data: JSON.parse(m[2]) });
      }
    });
  });
  t.after(() => req.destroy());
  await new Promise((r) => setTimeout(r, 100));
  // 휴지통에 같은 이름이 이미 있다(같은 밀리초에 지운 앞선 기록)
  const realNow = Date.now;
  Date.now = () => 1234;
  t.after(() => { Date.now = realNow; });
  fs.writeFileSync(path.join(f.home, "trash", "A.1234.jsonl"), "앞선 기록\n");
  // B 의 기록 줄을 막아 두어, A 를 지운 뒤 B 를 기다리는 동안 A 가 다시 생기게 한다
  const b = f.board.sessions.get("B");
  let open;
  b.chain = b.chain.then(() => new Promise((ok) => { open = ok; }));
  const del = board(f, { op: "sess-delete", sids: ["A", "B"] });
  await new Promise((r) => setTimeout(r, 50));
  Date.now = realNow;
  await f.hook("A", { f: "start", source: "resume", cwd: "/w" }, { pid: (1 << 22) + 99 });
  await new Promise((r) => setTimeout(r, 50));
  open();
  const out = JSON.parse((await del).text);
  assert.deepEqual(out.gone, ["A", "B"]);
  await new Promise((r) => setTimeout(r, 50)); // 마지막 SSE 가 도착하도록
  // 화면이 사건을 차례대로 적용했을 때 다시 생긴 A 가 남는다
  const shown = new Set();
  for (const e of events) {
    if (e.ev === "list") for (const s of e.data) shown.add(s.id);
    if (e.ev === "sess") shown.add(e.data.id);
    if (e.ev === "drop") for (const id of e.data) shown.delete(id);
  }
  assert.ok(shown.has("A") && !shown.has("B"), JSON.stringify(events.map((e) => [e.ev, e.ev === "drop" ? e.data : e.data.id])));
  assert.equal(fs.readFileSync(path.join(f.home, "trash", "A.1234.jsonl"), "utf8"), "앞선 기록\n");
  assert.ok(fs.existsSync(path.join(f.home, "trash", "A.1235.jsonl")));
});

test("새 판이 처음 뜰 때: 옛 묶음을 프로젝트로 옮기고(한 묶음에서만 쓰인 인계 키는 그 프로젝트의 키), 옛 기록에 인계 키가 있으면 핸드온 규칙을 설정에 넣는다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  assert.equal(f.board.config.resume, null, "기록이 없으면 꺼 둔다");
  const rec = (sid, meta) => JSON.stringify({ v: 1, seq: 1, t: 1, src: "board", type: "session", op: null, res: [{ k: "meta", v: { id: sid, startedAt: 1, ...meta } }] }) + "\n";
  fs.writeFileSync(path.join(f.home, "sessions", "L1.jsonl"), rec("L1", { handoff: "k9" }));
  fs.writeFileSync(path.join(f.home, "sessions", "L2.jsonl"), rec("L2", { handoff: "k9" }));
  fs.writeFileSync(path.join(f.home, "sessions", "L3.jsonl"), rec("L3", { handoff: "kx" }));
  fs.writeFileSync(path.join(f.home, "sessions", "L4.jsonl"), rec("L4", {}));
  fs.writeFileSync(path.join(f.home, "groups.json"), JSON.stringify({ groups: { g0000000a: { name: "옛 묶음", t: 5 }, g0000000b: { name: "다른 묶음", t: 6 } }, members: { L1: "g0000000a", L2: "g0000000a", L4: "g0000000b" } }));
  fs.rmSync(path.join(f.home, "config.json"));
  await f.restart();
  const { projects, members } = f.board.projects;
  assert.deepEqual(projects.g0000000a, { name: "옛 묶음", purpose: "", keys: ["k9"], t: 5, done: false });
  assert.deepEqual(projects.g0000000b.keys, []);
  assert.deepEqual(members, { L1: { pid: "g0000000a", why: "hand" }, L2: { pid: "g0000000a", why: "hand" }, L4: { pid: "g0000000b", why: "hand" } });
  assert.deepEqual(f.board.config.resume, { phrase: "핸드온 <키>", doc: "/handoff/<키>.md" });
  assert.ok(fs.existsSync(path.join(f.home, "groups.json")), "옛 파일은 지우지 않는다");
  // 한 번 옮긴 뒤로는 옛 파일을 다시 읽지 않는다
  await board(f, { op: "proj-rename", pid: "g0000000a", name: "새 이름" });
  await f.restart();
  assert.equal(f.board.projects.projects.g0000000a.name, "새 이름");
  // 설정: 문구를 바꾸고 끌 수 있고, 틀린 값은 거절한다
  assert.equal((await board(f, { op: "config-set", resume: { phrase: "<키>" } })).status, 400);
  assert.equal((await board(f, { op: "config-set", resume: null })).status, 200);
  await f.restart();
  assert.equal(f.board.config.resume, null, "끈 설정은 다시 띄워도 그대로(옛 기록으로 다시 켜지 않는다)");
});

test("project 도구: list·join·create·leave, 손·이어받기 문구가 정한 소속은 Claude 가 바꾸지 못하고, 소속이 바뀌면 다음 도구 결과에 한 번 알린다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  const P1 = (1 << 22) + 1, P2 = (1 << 22) + 2;
  await f.hook("S1", { f: "start", cwd: "/w" }, { pid: P1 });
  const A = JSON.parse((await board(f, { op: "proj-new", name: "가" })).text).pid;
  const call = async (tool, input, pid = P1, env = "S1") => (await f.mcp(tool, input, { pid, env })).text;
  let r = await call("project", {});
  assert.match(r, /어느 프로젝트에도 속하지 않습니다/);
  assert.ok(r.includes(`${A} 「가」`), r);
  r = await call("project", { action: "join", id: A });
  assert.ok(r.includes(`「가」(${A}, Claude 가 고름)`) && r.includes(`project:"${A}"`), r);
  r = await call("project", { action: "create", name: "나", purpose: "두 번째 일" });
  const B = f.board.projects.members.S1.pid;
  assert.notEqual(B, A);
  assert.deepEqual([f.board.projects.projects[B].name, f.board.projects.projects[B].purpose], ["나", "두 번째 일"]);
  assert.match(await call("project", { action: "join", id: "g00000000" }), /^거부/);
  assert.match(await call("project", { action: "create" }), /^거부/);
  assert.match(await call("project", { action: "leave" }), /어느 프로젝트에도 속하지 않습니다/);
  assert.equal(f.board.projects.members.S1, undefined);
  // 사용자가 화판에서 넣으면 다음 도구 결과에 한 번만 알린다
  await board(f, { op: "proj-set", sids: ["S1"], pid: A });
  r = await call("plan", { steps: [{ id: "s1", title: "일" }] });
  assert.ok(r.startsWith("계획 1단계") && r.includes(`「가」(${A}, 사용자가 넣음)`), r);
  assert.equal(await call("plan", { steps: [{ id: "s1", status: "doing" }] }), "계획 1단계 · 지금 s1");
  assert.match(await call("project", { action: "join", id: B }), /^거부: 이 대화의 소속은 「사용자가 넣음」/);
  assert.match(await call("project", { action: "leave" }), /^거부/);
  assert.match(await call("project", { action: "create", name: "다" }), /^거부/);
  assert.equal(Object.keys(f.board.projects.projects).length, 2, "들어가지 못하면 만들지도 않는다");
  // 사용자가 뺀 대화(「프로젝트 없음」)에는 Claude 가 넣지 못한다
  await board(f, { op: "proj-set", sids: ["S1"], pid: null });
  assert.match(await call("project", { action: "join", id: A }), /^거부/);
  // 이어받기 문구로 들어간 대화도 Claude 가 바꾸지 못한다
  await board(f, { op: "config-set", resume: { phrase: "핸드온 <키>" } });
  await f.hook("S2", { f: "start", cwd: "/w" }, { pid: P2 });
  await f.hook("S2", { f: "prompt", text: "핸드온 kk" }, { pid: P2 });
  assert.equal(f.board.projects.members.S2.why, "phrase");
  assert.match(await call("project", { action: "join", id: A }, P2, "S2"), /^거부/);
  r = await call("note", { text: "메모" }, P2, "S2");
  assert.ok(r.includes("「kk」") && r.includes("이어받기 문구"), "문구로 들어간 것도 다음 도구 결과에 알린다");
});

test("프로젝트 화판: project 인자는 지금 소속과 같아야 하고 clear 는 받지 않으며, 부품마다 쓴 대화를 남기고, 스냅샷·재생·다시 띄우기·풀기(휴지통)가 프로젝트 id 로도 된다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  const P1 = (1 << 22) + 1;
  await f.hook("S1", { f: "start", cwd: "/w" }, { pid: P1 });
  const A = JSON.parse((await board(f, { op: "proj-new", name: "가" })).text).pid;
  const call = async (tool, input) => (await f.mcp(tool, input, { pid: P1, env: "S1" })).text;
  assert.match(await call("plan", { steps: [{ id: "u1", title: "단위 1" }], project: A }), /^거부: 이 대화는 프로젝트 .* 소속이 아님\(지금: 없음\)/);
  await board(f, { op: "proj-set", sids: ["S1"], pid: A });
  assert.ok((await call("plan", { steps: [{ id: "u1", title: "단위 1", status: "doing" }, { id: "u2", title: "단위 2" }], project: A })).startsWith("계획 2단계 · 지금 u1"));
  assert.equal(await call("draw", { ops: [{ id: "b", kind: "box", label: "큰 상자" }], project: A }), "적용 1");
  assert.match(await call("draw", { clear: true, project: A }), /^거부: 프로젝트 화판은/);
  assert.equal(await call("note", { text: "결정 대기", kind: "wait", on: "u2", project: A }), "기록 · u2 승인 대기");
  assert.match(await call("ids", { project: A }), /^plan: u1 "단위 1" doing, u2 "단위 2" wait \| draw: b "큰 상자" box$/);
  const pb = f.board.pboards.get(A).scene;
  assert.deepEqual([pb.items.u1.by, pb.items.b.by, pb.timeline.at(-1).by], ["S1", "S1", "S1"]);
  assert.equal(f.board.sessions.get("S1").scene.items.u1, undefined, "세션 화판에는 쓰지 않는다");
  const snap = (await f.read(`/api/sessions/${A}/snapshot`)).json;
  assert.equal(snap.scene.items.b.label, "큰 상자");
  assert.ok((await f.read(`/api/sessions/${A}/log`)).json.length >= 4);
  await f.restart();
  assert.equal(f.board.pboards.get(A).scene.items.u2.status, "wait", "다시 띄워도 기록에서 되살아난다");
  assert.equal((await board(f, { op: "proj-drop", pid: A })).status, 200);
  assert.ok(!fs.existsSync(path.join(f.home, "projects", `${A}.jsonl`)));
  assert.match(fs.readdirSync(path.join(f.home, "trash")).join(" "), new RegExp(`^${A}\\.\\d+\\.jsonl$`));
  assert.equal((await f.read(`/api/sessions/${A}/snapshot`)).status, 404);
  assert.match(await call("plan", { steps: [{ id: "u3", title: "단위 3" }], project: A }), /^거부/);
});

test("SessionStart 답: 소속이 있으면 프로젝트 상태, 없으면 후보(같은 저장소·브랜치에서 쓰인 것 먼저, 작업 트리는 원래 저장소로), 사용자가 뺀 대화에는 후보를 싣지 않는다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  // 저장소 둘(r1 main, r2 main)과 r1 의 작업 트리(feat)
  const git = (dir, head) => { fs.mkdirSync(path.join(dir, ".git"), { recursive: true }); fs.writeFileSync(path.join(dir, ".git", "HEAD"), `ref: refs/heads/${head}\n`); };
  const r1 = path.join(f.dir, "r1"), r2 = path.join(f.dir, "r2"), wt = path.join(f.dir, "wt");
  git(r1, "main");
  git(r2, "main");
  const wtGit = path.join(r1, ".git", "worktrees", "wt");
  fs.mkdirSync(wtGit, { recursive: true });
  fs.writeFileSync(path.join(wtGit, "HEAD"), "ref: refs/heads/feat\n");
  fs.writeFileSync(path.join(wtGit, "commondir"), "../..\n");
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${wtGit}\n`);
  fs.mkdirSync(path.join(r1, "sub"));
  const start = async (sid, cwd, n, source = "startup") => JSON.parse((await f.hook(sid, { f: "start", source, cwd }, { pid: (1 << 22) + n })).text).out || "";
  await start("SA", r1, 1);
  await start("SB", r2, 2);
  const A = JSON.parse((await board(f, { op: "proj-new", name: "가" })).text).pid;
  const B = JSON.parse((await board(f, { op: "proj-new", name: "나" })).text).pid;
  await board(f, { op: "proj-set", sids: ["SA"], pid: A });
  await board(f, { op: "proj-set", sids: ["SB"], pid: B });
  await tick();
  await f.hook("SB", { f: "prompt", text: "최근 일" }, { pid: (1 << 22) + 2 }); // B 가 더 최근
  const order = (out) => [out.indexOf(`${A} 「가」`), out.indexOf(`${B} 「나」`)];
  let out = await start("N1", path.join(r1, "sub"), 3);
  assert.match(out, /project \{action:"join", id\}/);
  let [a, b] = order(out);
  assert.ok(a >= 0 && b > a, `같은 저장소의 A 가 먼저: ${out}`);
  [a, b] = order(await start("N2", r2, 4));
  assert.ok(b >= 0 && a > b, "r2 에서는 B 가 먼저");
  [a, b] = order(await start("N3", wt, 5));
  assert.ok(a >= 0 && b > a, "작업 트리는 원래 저장소(r1)로 본다");
  [a, b] = order(await start("N4", "/nowhere", 6));
  assert.ok(b >= 0 && a > b, "저장소가 없으면 최근 순서");
  await board(f, { op: "proj-set", sids: ["N1"], pid: A });
  out = await start("N1", path.join(r1, "sub"), 3, "resume");
  assert.ok(out.includes(`「가」(${A}, 사용자가 넣음)`) && !out.includes("join"), out);
  await board(f, { op: "proj-set", sids: ["N2"], pid: null });
  assert.equal(await start("N2", r2, 4, "resume"), "", "뺀 대화에는 후보를 싣지 않는다");
  await board(f, { op: "proj-done", pid: B, done: true });
  assert.ok(!(await start("N5", r2, 7)).includes(`${B} 「나」`), "끝난 프로젝트는 후보가 아니다");
});

test("이어받기 키: 키가 있는 대화를 손으로 다른 프로젝트에 옮기면 키도 옮겨 가, 다음에 그 문구로 이어받는 대화는 옮긴 프로젝트로 간다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  await board(f, { op: "config-set", resume: { phrase: "핸드온 <키>" } });
  await f.hook("K1", { f: "start", cwd: "/w" }, { pid: (1 << 22) + 1 });
  await f.hook("K1", { f: "prompt", text: "핸드온 phase1" }, { pid: (1 << 22) + 1 });
  const auto = f.board.projects.members.K1.pid;
  const V = JSON.parse((await board(f, { op: "proj-new", name: "제품 V" })).text).pid;
  await board(f, { op: "proj-set", sids: ["K1"], pid: V });
  assert.deepEqual([f.board.projects.projects[V].keys, f.board.projects.projects[auto].keys], [["phase1"], []]);
  await f.hook("K2", { f: "start", cwd: "/w" }, { pid: (1 << 22) + 2 });
  await f.hook("K2", { f: "prompt", text: "핸드온 phase1 이어서" }, { pid: (1 << 22) + 2 });
  assert.deepEqual(f.board.projects.members.K2, { pid: V, why: "phrase" });
});

// SSE 를 열어 사건을 모은다. until(조건) 은 조건을 만족하는 사건 목록이 생길 때까지(2초) 기다린다
function sse(f, route, t) {
  const events = [];
  const req = http.get({ host: "127.0.0.1", port: f.port, path: route, headers: { host: `127.0.0.1:${f.port}`, cookie: `atv_r=${f.keys().read}` } });
  req.on("response", (res) => {
    let buf = "";
    res.on("data", (c) => {
      buf += c;
      for (let i; (i = buf.indexOf("\n\n")) >= 0; buf = buf.slice(i + 2)) {
        const m = /^event: (\w+)\ndata: (.*)$/s.exec(buf.slice(0, i));
        if (m) events.push({ ev: m[1], data: JSON.parse(m[2]) });
      }
    });
  });
  t.after(() => req.destroy());
  return {
    events,
    async until(pred) { for (let i = 0; i < 200 && !pred(events); i++) await new Promise((ok) => setTimeout(ok, 10)); return events; },
  };
}

test("아직 한 번도 쓰지 않은 프로젝트를 보는 화면도 그 뒤 큰 그림 변경을 받는다(빈 스냅샷 뒤 1번부터)", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  const P = (1 << 22) + 1;
  await f.hook("S1", { f: "start", cwd: "/w" }, { pid: P });
  const A = JSON.parse((await board(f, { op: "proj-new", name: "가" })).text).pid;
  await board(f, { op: "proj-set", sids: ["S1"], pid: A });
  const s = sse(f, `/events?session=${A}`, t);
  await s.until((ev) => ev.some((e) => e.ev === "list"));
  await f.mcp("plan", { steps: [{ id: "u1", title: "단위", status: "doing" }], project: A }, { pid: P, env: "S1" });
  const ev = await s.until((x) => x.filter((e) => e.ev === "res").length >= 2);
  assert.deepEqual(ev.filter((e) => e.ev === "res").map((e) => e.data.seq), [1, 2]);
  // 화면은 스냅샷을 받은 뒤의 변경만 쓰므로 화판이 없어도 빈 장면을 먼저 받는다
  const snaps = ev.filter((e) => e.ev === "snap");
  assert.deepEqual(snaps.map((e) => [e.data.id, e.data.seq, Object.keys(e.data.scene.items).length]), [[A, 0, 0]]);
  assert.ok(ev.indexOf(snaps[0]) < ev.findIndex((e) => e.ev === "res"));
});

test("큰 그림 덮어쓰기: 이 대화가 마지막으로 본 뒤 다른 대화가 바꾼 부품·단계를 고치거나 지우면 쓰고 알린다(본 것·자기 것·다시 띄우기 전 것은 알리지 않음)", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  const P1 = (1 << 22) + 1, P2 = (1 << 22) + 2;
  await f.hook("S1", { f: "start", cwd: "/w" }, { pid: P1 });
  await f.hook("S2", { f: "start", cwd: "/w" }, { pid: P2 });
  await f.hook("S1", { f: "prompt", text: "가" }, { pid: P1 });
  await f.hook("S2", { f: "prompt", text: "나" }, { pid: P2 });
  const A = JSON.parse((await board(f, { op: "proj-new", name: "가" })).text).pid;
  await board(f, { op: "proj-set", sids: ["S1", "S2"], pid: A });
  const as1 = (tool, input) => f.mcp(tool, { ...input, project: A }, { pid: P1, env: "S1" }).then((r) => r.text);
  const as2 = (tool, input) => f.mcp(tool, { ...input, project: A }, { pid: P2, env: "S2" }).then((r) => r.text);
  await f.mcp("project", {}, { pid: P1, env: "S1" });
  await f.mcp("project", {}, { pid: P2, env: "S2" });
  assert.doesNotMatch(await as1("plan", { steps: [{ id: "u1", title: "단위 1", status: "doing" }] }), /덮었습니다/);
  assert.doesNotMatch(await as1("draw", { ops: [{ id: "b1", kind: "box", label: "상자" }] }), /덮었습니다/);
  // S2 는 S1 이 쓰기 전에 봤다: 모르고 되돌리면 알린다
  const back = await as2("plan", { steps: [{ id: "u1", status: "todo" }] });
  assert.match(back, /^계획/);
  assert.match(back, /덮었습니다\(쓰기는 됨\): u1 상태 doing→todo\(「가」 대화가 바꾼 것\)/);
  assert.equal(f.board.pboards.get(A).scene.items.u1.status, "todo", "쓰기는 한다");
  assert.doesNotMatch(await as2("plan", { steps: [{ id: "u1", status: "doing" }] }), /덮었습니다/, "자기가 마지막으로 쓴 것");
  // S1 도 S2 의 변경을 보지 못했다. 지우기도 알린다
  assert.match(await as2("draw", { ops: [{ id: "b1", label: "S2 가 고친 상자" }] }), /b1 이름 상자→S2 가 고친 상자/);
  assert.match(await as1("draw", { ops: [{ id: "b1", del: true }] }), /b1 지움\(「나」 대화가 바꾼 것\)/);
  // ids 로 보면 그 뒤로는 알리지 않는다
  await as1("ids", {});
  assert.doesNotMatch(await as1("plan", { steps: [{ id: "u1", status: "done" }] }), /덮었습니다/);
  // project 도구의 안내(큰 그림 요약)를 받은 뒤의 쓰기도 알리지 않는다
  await as1("plan", { steps: [{ id: "u1", title: "단위 1 고침" }] });
  await f.mcp("project", {}, { pid: P2, env: "S2" });
  assert.doesNotMatch(await as2("plan", { steps: [{ id: "u1", status: "doing" }] }), /덮었습니다/);
  // 다시 띄우기 전의 변경은 따지지 않는다(본 번호는 메모리에만 있다)
  await as2("plan", { steps: [{ id: "u1", note: "S2 메모" }] });
  await f.restart();
  assert.doesNotMatch(await as1("plan", { steps: [{ id: "u1", note: "S1 메모" }] }), /덮었습니다/);
});

test("큰 그림 덮어쓰기: 내용이 그대로인 쓰기는 앞서 쓴 대화를 남기고, 지우고 다른 종류로 다시 만든 것도 알린다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  const P1 = (1 << 22) + 1, P2 = (1 << 22) + 2;
  await f.hook("S1", { f: "start", cwd: "/w" }, { pid: P1 });
  await f.hook("S2", { f: "start", cwd: "/w" }, { pid: P2 });
  const A = JSON.parse((await board(f, { op: "proj-new", name: "가" })).text).pid;
  await board(f, { op: "proj-set", sids: ["S1", "S2"], pid: A });
  const as1 = (tool, input) => f.mcp(tool, { ...input, project: A }, { pid: P1, env: "S1" }).then((r) => r.text);
  const as2 = (tool, input) => f.mcp(tool, { ...input, project: A }, { pid: P2, env: "S2" }).then((r) => r.text);
  await as1("plan", { steps: [{ id: "u1", title: "옛 제목", status: "doing" }] });
  await as1("draw", { ops: [{ id: "k1", kind: "box", label: "상자" }] });
  await f.mcp("project", {}, { pid: P2, env: "S2" });
  await as1("plan", { steps: [{ id: "u1", title: "새 제목" }] }); // S2 는 이것을 모른다
  await as2("plan", { steps: [{ id: "u1", status: "doing" }] }); // 그대로인 쓰기
  assert.equal(f.board.pboards.get(A).scene.items.u1.by, "S1", "그대로인 쓰기는 쓴 대화를 바꾸지 않는다");
  assert.match(await as2("plan", { steps: [{ id: "u1", title: "옛 제목" }] }), /u1 제목 새 제목→옛 제목/);
  await as1("draw", { ops: [{ id: "k1", label: "상자 고침" }] });
  assert.match(await as2("draw", { ops: [{ id: "k1", del: true }, { id: "k1", kind: "group", label: "상자 고침" }] }), /k1 종류 box→group/);
  // 안내의 요약이 잘렸으면(부품·단계 40개 넘게) 본 것으로 치지 않는다: 잘려 나간 부품을 고치면 알린다
  await as1("draw", { ops: Array.from({ length: 45 }, (_, i) => ({ id: `p${i}`, kind: "box", label: `부품 ${i}` })) });
  await as1("draw", { ops: [{ id: "p44", label: "끝 부품 고침" }] });
  await f.mcp("project", {}, { pid: P2, env: "S2" });
  assert.match(await as2("draw", { ops: [{ id: "p44", label: "S2 생각" }] }), /p44 이름 끝 부품 고침→S2 생각/);
});

test("이어받기 키: 그 키를 가진 프로젝트가 없으면 앞 대화에서 물려받은 프로젝트에 키를 붙이고, 인계 문서를 고친 대화는 다른 프로젝트가 가진 키를 옮기지 않는다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  await board(f, { op: "config-set", resume: { phrase: "핸드온 <키>", doc: "/handoff/<키>.md" } });
  const p = (n) => (1 << 22) + n;
  await f.hook("A1", { f: "start", cwd: "/w" }, { pid: p(1) });
  await f.hook("A1", { f: "prompt", text: "인계 문서 쓰기" }, { pid: p(1) });
  await f.hook("A1", { f: "edit", tool: "Write", path: "/m/handoff/kk.md" }, { pid: p(1) }); // 프로젝트가 없을 때 쓴 인계 문서
  const P = JSON.parse((await board(f, { op: "proj-new", name: "가" })).text).pid;
  await f.mcp("project", { action: "join", id: P }, { pid: p(1), env: "A1" });
  await tick();
  await f.hook("B1", { f: "start", cwd: "/w" }, { pid: p(2) });
  await f.hook("B1", { f: "prompt", text: "핸드온 kk" }, { pid: p(2) });
  assert.deepEqual(f.board.projects.members.B1, { pid: P, why: "phrase" }, "앞 대화의 프로젝트로 간다");
  assert.deepEqual([Object.keys(f.board.projects.projects).length, f.board.projects.projects[P].keys], [1, ["kk"]], "새 프로젝트를 만들지 않고 키를 붙인다");
  // 사용자가 키 kq 를 프로젝트 Q 로 옮긴 뒤, P 의 대화가 kq 의 인계 문서를 고쳐도 키는 Q 에 남는다
  const Q = JSON.parse((await board(f, { op: "proj-new", name: "나" })).text).pid;
  await f.hook("K1", { f: "start", cwd: "/w" }, { pid: p(3) });
  await f.hook("K1", { f: "prompt", text: "핸드온 kq" }, { pid: p(3) });
  await board(f, { op: "proj-set", sids: ["K1"], pid: Q });
  await f.hook("X1", { f: "start", cwd: "/w" }, { pid: p(4) });
  await board(f, { op: "proj-set", sids: ["X1"], pid: P });
  await f.hook("X1", { f: "edit", tool: "Edit", path: "/m/handoff/kq.md" }, { pid: p(4) });
  await f.hook("X1", { f: "edit", tool: "Write", path: "/m/handoff/k-new.md" }, { pid: p(4) });
  assert.deepEqual([f.board.projects.projects[Q].keys, f.board.projects.projects[P].keys], [["kq"], ["kk", "k-new"]], "아무도 갖지 않은 키만 붙인다");
});

test("끝난 프로젝트는 /clear 로 물려받지 않고, 다시 띄운 뒤에는 같은 소속 알림을 되풀이하지 않는다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  const pid = process.pid;
  await f.hook("A1", { f: "start", cwd: "/w" }, { pid });
  const P = JSON.parse((await board(f, { op: "proj-new", name: "가" })).text).pid;
  await board(f, { op: "proj-set", sids: ["A1"], pid: P });
  const call = async () => (await f.mcp("plan", { steps: [{ id: "s1", title: "일" }] }, { pid, env: "A1" })).text;
  assert.ok((await call()).includes("「가」"), "처음에는 알린다");
  assert.equal(await call(), "계획 1단계");
  await f.restart();
  assert.equal(await call(), "계획 1단계", "다시 띄워도 소속이 같으면 알리지 않는다");
  await board(f, { op: "proj-done", pid: P, done: true });
  await f.hook("A1", { f: "end", reason: "clear" }, { pid });
  const out = JSON.parse((await f.hook("A2", { f: "start", source: "clear", cwd: "/w" }, { pid })).text).out;
  assert.equal(f.board.projects.members.A2, undefined);
  assert.equal(out, undefined, "끝난 프로젝트는 후보로도 내지 않는다");
  assert.equal(f.board.projects.projects[P].done, true);
});

test("소속 확인은 쓸 차례에 다시 본다(기다리는 사이 옮기면 옛 프로젝트에 쓰지 않음), 사용자가 뺀 줄은 /clear 로 이어도 빠진 채, 이어받기 문구는 뺀 앞 대화에 이어도 들어감, 안내에 결정 대기 글을 싣는다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  const pid = process.pid, p = (n) => (1 << 22) + n;
  await f.hook("S1", { f: "start", cwd: "/w" }, { pid: p(1) });
  const A = JSON.parse((await board(f, { op: "proj-new", name: "가" })).text).pid;
  const B = JSON.parse((await board(f, { op: "proj-new", name: "나" })).text).pid;
  await board(f, { op: "proj-set", sids: ["S1"], pid: A });
  await f.mcp("plan", { steps: [{ id: "u1", title: "단위 1", status: "doing" }, { id: "u2", title: "단위 2" }], project: A }, { pid: p(1), env: "S1" });
  // A 의 쓰기 줄을 잠깐 막아 두고, 그사이 draw 를 줄 세운 뒤 사용자가 B 로 옮긴다
  const b = f.board.pboards.get(A);
  b.chain = b.chain.then(() => new Promise((ok) => setTimeout(ok, 200)));
  const draw = f.mcp("draw", { ops: [{ id: "late", kind: "box", label: "늦은 상자" }], project: A }, { pid: p(1), env: "S1" });
  await new Promise((ok) => setTimeout(ok, 50));
  await board(f, { op: "proj-set", sids: ["S1"], pid: B });
  assert.match((await draw).text, /^거부: 기다리는 사이/);
  assert.equal(f.board.pboards.get(A).scene.items.late, undefined);
  // 결정 대기 글은 이름표만으로 알 수 없으므로 안내에 싣는다(답을 받으면 빠진다)
  await board(f, { op: "proj-set", sids: ["S1"], pid: A });
  await f.mcp("note", { text: "API 2와 3 중 무엇으로 할지", kind: "wait", on: "u2", project: A }, { pid: p(1), env: "S1" });
  let r = (await f.mcp("project", {}, { pid: p(1), env: "S1" })).text;
  assert.ok(r.includes("결정 대기(u2): API 2와 3 중 무엇으로 할지"), r);
  await f.mcp("plan", { steps: [{ id: "u2", status: "doing" }], project: A }, { pid: p(1), env: "S1" });
  r = (await f.mcp("project", {}, { pid: p(1), env: "S1" })).text;
  assert.ok(!r.includes("결정 대기("), "답을 받아 상태가 바뀌면 싣지 않는다");
  // 사용자가 뺀 줄: /clear 로 이어진 대화도 빠진 채이고 후보를 받지 않는다
  await f.hook("C1", { f: "start", cwd: "/w" }, { pid });
  await board(f, { op: "proj-set", sids: ["C1"], pid: null });
  await f.hook("C1", { f: "end", reason: "clear" }, { pid });
  const out = JSON.parse((await f.hook("C2", { f: "start", source: "clear", cwd: "/w" }, { pid })).text).out;
  assert.deepEqual([f.board.projects.members.C2, out], [{ pid: null, why: "hand" }, undefined]);
  assert.match((await f.mcp("project", { action: "join", id: A }, { pid, env: "C2" })).text, /^거부/);
  // 이어받기 문구로 그 줄에 이어진 대화는 문구의 프로젝트로 들어간다
  await board(f, { op: "config-set", resume: { phrase: "핸드온 <키>", doc: "/handoff/<키>.md" } });
  await f.hook("C2", { f: "prompt", text: "인계 쓰기" }, { pid });
  await f.hook("C2", { f: "edit", tool: "Write", path: "/m/handoff/kz.md" }, { pid });
  await tick();
  await f.hook("D1", { f: "start", cwd: "/w" }, { pid: p(2) });
  await f.hook("D1", { f: "prompt", text: "핸드온 kz" }, { pid: p(2) });
  assert.equal((await sessMap(f)).D1.prev, "C2");
  assert.equal(f.board.projects.members.D1.why, "phrase");
});
