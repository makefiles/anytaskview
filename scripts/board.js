#!/usr/bin/env node
// 화판 서버를 띄운다. --url 은 처음 여는 브라우저에 쓸 주소를 찍는다(열쇠를 만들지 않고 읽기만 한다).
// --stop 은 떠 있는 서버를 멈춘다. 플러그인을 갱신한 뒤 옛 판 서버를 내릴 때 쓰고, 다음 도구 호출 때 MCP 가 새 판으로 다시 띄운다.
import { parseArgs } from "node:util";
import { startBoard } from "../lib/server.js";
import { stateHome, readKeys, portOwner } from "../lib/store.js";

const { values: o } = parseArgs({
  options: { port: { type: "string" }, url: { type: "boolean" }, stop: { type: "boolean" }, help: { type: "boolean", short: "h" } },
});
const port = Number(o.port || process.env.ANYTASKVIEW_PORT || 4871);
const home = stateHome();

if (o.help) {
  console.log(`쓰는 법: scripts/atv board [--port 4871]   화판 서버를 띄운다
       scripts/atv board --url           처음 여는 브라우저에 쓸 주소를 찍는다
       scripts/atv board --stop          떠 있는 화판 서버를 멈춘다
상태 폴더: ${home} (ANYTASKVIEW_HOME 으로 바꿀 수 있다)`);
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
