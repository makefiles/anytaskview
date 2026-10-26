// MCP 시험: SDK 클라이언트로 stdio 서버를 실제로 띄워 부른다. 도구 설명 크기도 잰다.
// 서버는 SDK 없이 JSON-RPC 를 직접 쓰므로, 줄 단위 처리와 오류 응답도 따로 확인한다
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { boardFixture } from "./helpers.js";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mcp", "server.js");

async function connect(env) {
  const client = new Client({ name: "atv-test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env, ...env }, stderr: "ignore" }));
  return client;
}
const text = (r) => r.content.map((c) => c.text).join("");

test("도구 5개, 안내문은 4,096자 안, 부르면 한 줄 결과", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  const client = await connect({ ANYTASKVIEW_HOME: f.home, ANYTASKVIEW_PORT: String(f.port), CLAUDE_CODE_SESSION_ID: "M1" });
  t.after(() => client.close());
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((x) => x.name), ["plan", "draw", "note", "ids", "project"]);
  const instructions = client.getInstructions();
  assert.ok(instructions.length <= 4096, `안내문 ${instructions.length}자`);
  const toolChars = JSON.stringify(tools).length;
  t.diagnostic(`도구 정의 ${toolChars}자, 안내문 ${instructions.length}자`);

  assert.equal(text(await client.callTool({ name: "plan", arguments: { steps: [{ id: "s1", title: "원인", status: "doing" }] } })), "계획 1단계 · 지금 s1");
  assert.equal(text(await client.callTool({ name: "draw", arguments: { ops: [{ id: "a", kind: "box", label: "parser.c" }] } })), "적용 1");
  assert.equal(text(await client.callTool({ name: "note", arguments: { text: "원인은 경계값", kind: "why", on: "a" } })), "기록");
  assert.equal(text(await client.callTool({ name: "ids", arguments: {} })), 'plan: s1 "원인" doing | draw: a "parser.c" box');
  const scene = (await f.read("/api/sessions/M1/snapshot")).json.scene;
  assert.equal(scene.meta.cwd, process.cwd());
});

test("화판이 꺼져 있고 자동 시작을 끄면 「화판 꺼짐」 한 줄(열쇠가 있어도)", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  const client = await connect({ ANYTASKVIEW_HOME: f.home, ANYTASKVIEW_PORT: "1", ANYTASKVIEW_AUTOSTART: "0", CLAUDE_CODE_SESSION_ID: "M2" });
  t.after(() => client.close());
  assert.match(text(await client.callTool({ name: "plan", arguments: { steps: [{ id: "s1", title: "x" }] } })), /^화판 꺼짐.*이번 호출은 건너뛰고/);
});

async function freePort() {
  const s = net.createServer();
  await new Promise((ok) => s.listen(0, "127.0.0.1", ok));
  const { port } = s.address();
  await new Promise((ok) => s.close(ok));
  return port;
}

test("화판이 꺼져 있으면 MCP 가 떼어 내 띄우고, 짝짓기 표에 자기 claude 를 알린다", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atv-auto-"));
  const home = path.join(dir, "home"), port = await freePort();
  t.after(async () => {
    // 떼어 낸 화판 서버를 멈춘다
    try {
      const keys = JSON.parse(fs.readFileSync(path.join(home, "key.json"), "utf8"));
      await fetch(`http://127.0.0.1:${port}/api/mcp`, { method: "POST", headers: { "content-type": "application/json", "x-atv-key": keys.write }, body: JSON.stringify({ tool: "stop" }) });
    } catch { /* 이미 없다 */ }
    await new Promise((ok) => setTimeout(ok, 200));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const client = await connect({ ANYTASKVIEW_HOME: home, ANYTASKVIEW_PORT: String(port), CLAUDE_CODE_SESSION_ID: "AUTO1" });
  t.after(() => client.close());
  assert.equal(text(await client.callTool({ name: "plan", arguments: { steps: [{ id: "s1", title: "자동 시작", status: "doing" }] } })), "계획 1단계 · 지금 s1");
  assert.ok(fs.existsSync(path.join(home, "board.log")), "화판 로그가 상태 폴더에 생긴다");
  // hello 가 돌았다: 짝짓기 표에 이 claude(여기서는 시험 프로세스)를 넣고 「세션 시작(mcp)」 사실을 남긴다
  const keys = JSON.parse(fs.readFileSync(path.join(home, "key.json"), "utf8"));
  const r = await fetch(`http://127.0.0.1:${port}/api/sessions/AUTO1/snapshot`, { headers: { cookie: `atv_r=${keys.read}` } });
  const scene = (await r.json()).scene;
  assert.equal(scene.items.s1.title, "자동 시작");
  assert.equal(scene.meta.pid, process.pid);
  assert.ok(scene.meta.pstart, "다시 띄울 때 짝을 되찾을 시작 시각");
  assert.ok(scene.timeline.some((e) => e.f === "start" && e.source === "mcp"));
});

test("JSON-RPC: 알림에는 답하지 않고, 깨진 줄·모르는 메서드는 오류, 나뉘어 온 줄도 읽는다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, ANYTASKVIEW_HOME: f.home, ANYTASKVIEW_PORT: String(f.port), CLAUDE_CODE_SESSION_ID: "R1" }, stdio: ["pipe", "pipe", "ignore"] });
  t.after(() => child.kill());
  const lines = [];
  let buf = "";
  child.stdout.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const waitFor = async (n) => { for (let i = 0; i < 100 && lines.length < n; i++) await new Promise((ok) => setTimeout(ok, 20)); };
  child.stdin.write('{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n');
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  child.stdin.write('{"jsonrpc":"2.0","id":1,"me');
  child.stdin.write('thod":"ping"}\n');
  child.stdin.write("{깨진 줄\n");
  child.stdin.write('{"jsonrpc":"2.0","id":"x","method":"resources/list"}\n');
  await waitFor(4);
  assert.equal(lines.length, 4);
  assert.equal(lines[0].id, 0);
  assert.equal(lines[0].result.protocolVersion, "2025-06-18");
  assert.deepEqual(lines[1], { jsonrpc: "2.0", id: 1, result: {} });
  assert.equal(lines[2].error.code, -32700);
  assert.deepEqual([lines[3].id, lines[3].error.code], ["x", -32601]);
});
