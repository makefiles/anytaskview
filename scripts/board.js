#!/usr/bin/env node
// 화판 서버를 띄운다. --url 은 처음 여는 브라우저에 쓸 주소를 찍는다(열쇠를 만들지 않고 읽기만 한다).
// --stop 은 떠 있는 서버를 멈춘다. 플러그인을 갱신한 뒤 옛 판 서버를 내릴 때 쓰고, 다음 도구 호출 때 MCP 가 새 판으로 다시 띄운다.
// --open 은 서버가 없으면 띄우고 이 PC 의 기본 브라우저로 화판을 연다(열쇠 든 주소는 화면·명령줄에 남기지 않는다).
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { startBoard } from "../lib/server.js";
import { stateHome, readKeys, portOwner, ensureDir } from "../lib/store.js";

const { values: o } = parseArgs({
  options: { port: { type: "string" }, url: { type: "boolean" }, open: { type: "boolean" }, stop: { type: "boolean" }, help: { type: "boolean", short: "h" } },
});
const port = Number(o.port || process.env.ANYTASKVIEW_PORT || 4871);
const home = stateHome();

if (o.help) {
  console.log(`쓰는 법: scripts/atv board [--port 4871]   화판 서버를 띄운다
       scripts/atv board --open          서버가 없으면 띄우고 기본 브라우저로 화판을 연다
       scripts/atv board --url           처음 여는 브라우저에 쓸 주소를 찍는다
       scripts/atv board --stop          떠 있는 화판 서버를 멈춘다
상태 폴더: ${home} (ANYTASKVIEW_HOME 으로 바꿀 수 있다)`);
  process.exit(0);
}

if (o.open) {
  // 이 포트에서 기록을 다 읽은 anytaskview 화판이 답하는가: 토큰 없이 부르면 잠긴 화면(401, 제목 AnyTaskView)을 준다.
  // 서버는 기록을 다 읽기 전에는 답하지 않으므로, 답이 오면 준비가 끝난 것이다(/proc 이 없는 macOS 에서도 쓴다)
  // 리다이렉트는 따라가지 않는다(다른 서버가 화판으로 넘겨도 화판으로 보지 않게)
  const ready = async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual", signal: AbortSignal.timeout(1000) });
      return r.status === 401 && (await r.text()).includes("<title>AnyTaskView</title>") ? "board" : "other";
    } catch { return "none"; }
  };
  if (portOwner(port) === "other") { console.error(`${port} 포트를 다른 사용자의 프로그램이 쓰고 있어 열지 않습니다.`); process.exit(1); }
  let state = await ready();
  if (state === "other") { console.error(`${port} 포트에서 다른 프로그램이 답해 열지 않습니다(화판 서버가 아님).`); process.exit(1); }
  if (state === "none") {
    // 서버가 없으면 MCP 처럼 따로 띄운다(이 세션의 CLAUDE_* 값은 물려주지 않는다). 로그는 상태 폴더의 board.log
    ensureDir(home);
    const fd = fs.openSync(path.join(home, "board.log"), "a", 0o600);
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE")));
    spawn(process.execPath, [fileURLToPath(import.meta.url), "--port", String(port)], { detached: true, stdio: ["ignore", fd, fd], env }).unref();
    fs.closeSync(fd);
    for (let i = 0; i < 50 && state !== "board"; i++) { await new Promise((ok) => setTimeout(ok, 100)); state = await ready(); }
    if (state !== "board") { console.error(`화판 서버를 띄우지 못했습니다. ${path.join(home, "board.log")} 를 보세요.`); process.exit(1); }
  }
  if (portOwner(port) === "other") { console.error(`${port} 포트를 다른 사용자의 프로그램이 쓰고 있어 열지 않습니다.`); process.exit(1); }
  const keys = readKeys(home);
  if (!keys) { console.error(`열쇠가 없습니다(${home}). 화판 서버를 다시 띄운 뒤 실행하세요.`); process.exit(1); }
  // 이 상태 폴더의 열쇠를 받는 화판인지 본다(다른 ANYTASKVIEW_HOME 의 화판이 포트를 잡고 있으면 그 화면은 잠겨 있다)
  const mine = await fetch(`http://127.0.0.1:${port}/api/sessions`, { redirect: "manual", headers: { cookie: `atv_r=${keys.read}` }, signal: AbortSignal.timeout(2000) }).then((r) => r.status === 200, () => false);
  if (!mine) { console.error(`${port} 포트의 화판이 이 상태 폴더(${home})의 열쇠를 받지 않습니다. 다른 상태 폴더의 화판이 떠 있는지 확인하세요.`); process.exit(1); }
  const url = `http://127.0.0.1:${port}/?t=${keys.read}${keys.board ? `#w=${keys.board}` : ""}`;
  // 열쇠 든 주소를 브라우저의 명령줄 인자로 넘기면 같은 PC 의 다른 사용자가 ps 로 볼 수 있다.
  // 이 사용자만 읽는 넘김 파일(상태 폴더)을 열어 그 안에서 화판 주소로 넘어가게 한다
  const page = path.join(home, "open.html");
  fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${url}"><title>AnyTaskView</title>`, { mode: 0o600 });
  fs.chmodSync(page, 0o600);
  const has = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;
  const opener = process.platform === "darwin" ? ["open", page]
    : process.platform === "win32" ? ["cmd", "/c", "start", "", page]
      : process.env.WSL_DISTRO_NAME && has("wslview") ? ["wslview", page]
        : has("xdg-open") ? ["xdg-open", page] : null;
  if (!opener) { console.error("브라우저를 여는 명령(xdg-open·wslview)이 없습니다. scripts/atv board --url 의 주소를 브라우저에 직접 넣으세요."); process.exit(1); }
  // 여는 명령이 곧바로 실패하면(화면 없는 Linux 따위) 알린다. 3초 안에 끝나지 않으면 브라우저를 띄운 채 기다리는 것으로 본다
  const child = spawn(opener[0], opener.slice(1), { detached: true, stdio: "ignore" });
  const code = await new Promise((ok) => {
    child.once("exit", (c, signal) => ok(signal ? `신호 ${signal}` : c));
    child.once("error", (e) => ok(e.code || "실행 실패"));
    setTimeout(() => ok("waiting"), 3000);
  });
  child.unref();
  if (code !== "waiting" && code !== 0) { console.error(`브라우저를 열지 못했습니다(${opener[0]} 끝남 ${code}). scripts/atv board --url 의 주소를 이 PC 의 브라우저에 직접 넣으세요.`); process.exit(1); }
  console.log("기본 브라우저로 화판을 열었습니다. 그 뒤로는 그 브라우저에서 http://127.0.0.1:" + port + "/ 만 열면 됩니다.");
  process.exit(0);
}

if (o.url || o.stop) {
  const keys = readKeys(home);
  if (!keys) {
    console.error(`열쇠가 아직 없습니다. 화판 서버를 먼저 띄우세요(${home}).`);
    process.exit(1);
  }
  if (o.url) {
    // 이 사용자의 화판 서버가 듣고 있을 때만 준다. 다른 사용자가 포트를 잡은 채 이 주소를 열면 그쪽 페이지가 열쇠를 읽는다
    const owner = portOwner(port);
    if (owner === "other" || owner === "none") {
      console.error(owner === "other" ? `${port} 포트를 다른 사용자의 프로그램이 쓰고 있어 주소를 주지 않습니다.` : `화판 서버가 떠 있지 않습니다. 먼저 띄운 뒤(scripts/atv board) 다시 실행하세요.`);
      process.exit(1);
    }
    // #w= 는 화판 쓰기 열쇠다. 주소 조각(#)은 서버로 가지 않고, 페이지가 이 포트의 localStorage 에 넣는다
    console.log(`http://127.0.0.1:${port}/?t=${keys.read}${keys.board ? `#w=${keys.board}` : ""}`);
    if (!keys.board) console.error("화판 쓰기 열쇠가 아직 없습니다. 화판 서버를 새 판으로 다시 띄운 뒤 --url 을 다시 실행하면 이름 바꾸기·보내기를 쓸 수 있습니다.");
    process.exit(0);
  }
  if (portOwner(port) === "other") {
    console.error(`${port} 포트를 다른 사용자의 프로그램이 쓰고 있어 열쇠를 보내지 않았습니다.`);
    process.exit(1);
  }
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-atv-key": keys.write },
      body: JSON.stringify({ tool: "stop" }),
      signal: AbortSignal.timeout(3000),
    });
    console.log(r.ok ? "화판 서버를 멈췄습니다. 다음 도구 호출 때 MCP 가 다시 띄웁니다." : `멈추지 못했습니다: HTTP ${r.status} ${await r.text()}`);
    process.exit(r.ok ? 0 : 1);
  } catch {
    console.log("떠 있는 화판 서버가 없습니다.");
    process.exit(0);
  }
}

let board;
const stop = () => board.close().then(() => process.exit(0));
try {
  board = await startBoard({ port, home, log: (m) => console.error(m), onStop: stop });
} catch (e) {
  console.error(e.code === "EADDRINUSE" ? `${port} 포트를 이미 다른 프로그램이 쓰고 있습니다.` : `화판을 띄우지 못했습니다: ${e.message}`);
  process.exit(1);
}
console.error(`anytaskview 화판: http://127.0.0.1:${board.port}/ (처음 여는 브라우저는 scripts/atv board --url 의 주소로 엽니다)`);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, stop);
