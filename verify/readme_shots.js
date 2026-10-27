// README 화면 이미지(docs/images/<이름>-light.png · -dark.png)를 만든다. 화면 검사처럼 임시 상태 폴더의 시험 화판에
// 예시 세션만 넣고 화면 없는 Chrome 으로 찍으므로, 운영 화판·개인 경로·열쇠는 이미지에 들어가지 않는다.
// 쓰는 법: node verify/readme_shots.js [출력 폴더(기본 docs/images)]. Chrome 이 PATH 에 없으면 CHROME 에 경로를 넣는다.
// 타임라인 시각과 「지난 세션」 날짜는 돌린 날을 따르므로, 화면이 그대로여도 다시 찍으면 PNG 가 바뀐다. 화면이 바뀐 장면만 커밋한다
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startBoard } from "../lib/server.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.resolve(process.argv[2] || path.join(ROOT, "docs/images"));
const W = 1440, H = 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let temp, board, chrome, cdp;

// probe_ui.js 와 같은 방법으로 Chrome 을 찾는다
function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const pf = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean);
  const candidates = process.platform === "win32"
    ? pf.flatMap((dir) => [path.join(dir, "Google", "Chrome", "Application", "chrome.exe"), path.join(dir, "Microsoft", "Edge", "Application", "msedge.exe")])
    : process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].flatMap((name) => (process.env.PATH || "").split(path.delimiter).map((dir) => path.join(dir, name)));
  const hit = candidates.find((file) => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } });
  if (!hit) throw new Error("Chrome을 찾지 못했습니다. CHROME 환경 변수에 실행 파일 경로를 넣어 주세요.");
  return hit;
}

async function launchChrome(profile) {
  chrome = spawn(findChrome(), ["--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--hide-scrollbars", `--window-size=${W},${H}`, "--lang=ko-KR", "about:blank"],
  { stdio: "ignore", detached: process.platform !== "win32" }); // 하위 프로세스까지 한 묶음으로 끄려고 따로 세운다
  let gone = false, launchError;
  chrome.once("exit", () => { gone = true; });
  chrome.once("error", (e) => { gone = true; launchError = e; });
  for (const end = Date.now() + 12000; Date.now() < end && !gone; await sleep(50)) {
    try {
      const port = Number(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
      const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json()).find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* 디버깅 포트가 열릴 때까지 */ }
  }
  throw new Error(launchError ? `Chrome 실행 실패: ${launchError.message}` : "Chrome 디버깅 포트가 열리지 않았습니다.");
}

// 요청마다 시간 제한을 두고, 연결이 끊기면 기다리던 요청을 모두 실패로 끝낸다
async function connectCdp(url) {
  const ws = new WebSocket(url), pending = new Map();
  let nid = 0;
  const fail = () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("Chrome 연결이 끊겼습니다.")); } pending.clear(); };
  ws.addEventListener("close", fail);
  ws.addEventListener("error", fail);
  ws.addEventListener("message", ({ data }) => {
    const m = JSON.parse(data), p = m.id && pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Chrome 연결 시간이 초과됐습니다.")), 5000);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Chrome에 연결하지 못했습니다.")); }, { once: true });
  });
  return {
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nid, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 응답 시간 초과: ${method}`)); }, 15000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    }),
    close() { fail(); ws.close(); },
  };
}

// 쓰기 요청: 실패하거나 서버가 거부·무시한 필드를 알리면 멈춘다(틀린 예시로 찍지 않게)
async function post(port, keys, route, body) {
  const r = await fetch(`http://127.0.0.1:${port}${route}`, { method: "POST", headers: { "content-type": "application/json", "x-atv-key": keys.write, Host: `127.0.0.1:${port}` }, body: JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok || t.includes("거부") || t.includes("무시한 필드")) throw new Error(`${route}: ${r.status} ${t}`);
  return t;
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "atv-readme-"));
  const home = path.join(temp, "home"), profile = path.join(temp, "chrome");

  // 며칠 전에 끝난 세션(「지난 세션」)은 먼저 띄운 화판으로 만들고 기록의 시각을 앞으로 옮긴다
  board = await startBoard({ port: 0, home });
  {
    const k = JSON.parse(fs.readFileSync(path.join(home, "key.json"), "utf8"));
    for (const [sid, text] of [["past-1", "로그인 화면 문구 다듬기"], ["past-2", "CI 캐시 설정 정리"]]) {
      for (const fact of [{ f: "start", cwd: "/home/user/shop", source: "startup" }, { f: "prompt", text }, { f: "stop", last: "끝냈습니다" }, { f: "end", reason: "exit" }]) {
        await post(board.port, k, "/api/hook", { sid, fact });
      }
    }
    await board.close();
    board = null;
    const now = Date.now();
    for (const [sid, days] of [["past-1", 2], ["past-2", 5]]) {
      const f = path.join(home, "sessions", `${sid}.jsonl`);
      fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/\b1\d{12}\b/g, (m) => (Math.abs(Number(m) - now) < 3_600_000 ? String(Number(m) - days * 86_400_000) : m)));
    }
  }

  board = await startBoard({ port: 0, home });
  const keys = JSON.parse(fs.readFileSync(path.join(home, "key.json"), "utf8"));
  const host = `127.0.0.1:${board.port}`, base = `http://${host}`;
  const hook = (sid, fact, extra = {}) => post(board.port, keys, "/api/hook", { sid, fact, ...extra });
  const mcp = (sid, cwd, tool, input) => post(board.port, keys, "/api/mcp", { env: sid, cwd, tool, input });
  const boardOp = async (body) => {
    const r = await fetch(base + "/api/board", { method: "POST", headers: { "content-type": "application/json", origin: base, Host: host, cookie: `atv_r=${keys.read}`, "x-atv-board": keys.board }, body: JSON.stringify(body) });
    const j = JSON.parse(await r.text());
    if (!r.ok || !j.ok) throw new Error(`board ${body.op}: ${j.msg}`);
    return j;
  };

  // 예시 세션: 결제 버그(Claude, 프로젝트), 응답 시간 비교(Codex, 프로젝트), 문서 작업(Claude), 입력 기다림, 오늘 끝난 일
  const A = "demo-coupon", B = "demo-latency", C = "demo-docs", D = "demo-logs";
  const shop = "/home/user/shop", api = "/home/user/api";
  await hook(A, { f: "start", cwd: shop, source: "startup" });
  await hook(A, { f: "prompt", text: "결제 화면에서 쿠폰을 적용하면 합계가 두 번 깎이는 문제를 찾아 고쳐 줘" });
  await mcp(A, shop, "plan", { steps: [
    { id: "s1", title: "재현과 로그 확인", status: "done" },
    { id: "s2", title: "할인 계산 경로 추적", status: "done" },
    { id: "s3", title: "중복 적용 고치기", status: "doing" },
    { id: "s4", title: "회귀 시험 추가" },
    { id: "s5", title: "배포 전 확인" },
  ] });
  await mcp(A, shop, "draw", { ops: [
    { id: "g", kind: "group", label: "결제 흐름" },
    { id: "ui", kind: "box", in: "g", label: "결제 화면", icon: "monitor", shape: "round", status: "done", ref: "src/ui/Checkout.tsx:12" },
    { id: "dup", kind: "box", in: "g", label: "쿠폰이 이미 적용됐나?", shape: "diamond", status: "doing" },
    { id: "api", kind: "box", in: "g", label: "할인 API", icon: "server", status: "todo", ref: "api/discount.py:40" },
    { id: "db", kind: "box", in: "g", label: "쿠폰 사용 기록", icon: "db", shape: "cylinder" },
    { id: "e1", kind: "edge", from: "ui", to: "dup", label: "쿠폰 적용" },
    { id: "e2", kind: "edge", from: "dup", to: "api", label: "아니오" },
    { id: "e3", kind: "edge", from: "api", to: "db", label: "기록" },
    { id: "t", kind: "table", label: "재현 결과", status: "done", cols: ["경우", "기대", "실제"], rows: [["쿠폰 1장", "1,000원 할인", "2,000원 할인"], ["쿠폰 2장", "거절", "3,000원 할인"], ["쿠폰 없음", "0원", "0원"]], note: "화면이 다시 그려질 때마다 한 번 더 깎임" },
    { id: "rule", kind: "box", label: "결제 규칙 문서", icon: "file", shape: "doc", ref: "docs/payment.md" },
    { id: "prep", kind: "box", label: "시험 데이터 준비", icon: "test", shape: "hexagon", status: "wait" },
  ] });
  await mcp(A, shop, "note", { kind: "why", text: "합계가 바뀔 때마다 훅이 쿠폰을 다시 적용합니다", on: "dup" });
  await mcp(A, shop, "note", { kind: "decision", text: "할인은 서버 계산값만 쓰고 화면에서는 다시 계산하지 않기로 함" });
  let n = 0;
  for (const [cmd, ok] of [["npm test -- coupon", false], ["rg applyCoupon src", true], ["npm test -- coupon", true]]) {
    const id = `r${++n}`;
    await hook(A, { f: "run-start", id, cmd });
    await hook(A, { f: ok ? "run-end" : "run-fail", id, cmd, dur: 1500 + n * 400, ...(ok ? {} : { error: "2 failed" }) });
  }
  await hook(A, { f: "edit", tool: "Edit", path: `${shop}/src/ui/useTotal.js`, lines: "+3 -1" });
  await mcp(A, shop, "note", { kind: "blocked", text: "스테이징 쿠폰 데이터가 비어 있음", on: "api" });

  await hook(B, { f: "start", cwd: api, source: "startup", via: "codex", home: "/home/user/.codex" }, { via: "codex", home: "/home/user/.codex" });
  await hook(B, { f: "prompt", text: "주문 API 응답 시간을 줄일 방안을 비교해 줘" }, { via: "codex" });
  await mcp(B, api, "plan", { steps: [{ id: "s1", title: "느린 질의 찾기", status: "done" }, { id: "s2", title: "방안 비교", status: "wait" }] });
  await mcp(B, api, "draw", { ops: [
    { id: "opt", kind: "table", label: "방안 비교", status: "wait", cols: ["방안", "응답 시간", "위험", "작업량"], rows: [["색인 추가", "-70%", "쓰기 느려짐", "작음"], ["캐시", "-90%", "옛 값", "중간"], ["질의 다시 쓰기", "-50%", "회귀", "큼"]], note: "추천: 색인 추가" },
    { id: "pie", kind: "mermaid", label: "느린 요청 원인", src: "pie\n  \"주문 목록 질의\" : 62\n  \"직렬화\" : 23\n  \"인증\" : 15" },
    { id: "seq", kind: "mermaid", label: "주문 목록 호출 순서", src: "sequenceDiagram\n  화면->>API: 주문 목록\n  API->>DB: 질의(1.8초)\n  DB-->>API: 2,000줄\n  API-->>화면: 응답" },
    { id: "q", kind: "box", label: "주문 목록 질의", icon: "db", shape: "cylinder", status: "done", ref: "api/orders.py:88" },
    { id: "ix", kind: "box", label: "(user_id, created_at) 색인", icon: "key", status: "doing" },
    { id: "e", kind: "edge", from: "q", to: "ix", label: "느린 원인" },
  ] });
  await hook(B, { f: "stop", last: "방안 셋을 정리했습니다" }, { via: "codex" });

  await hook(C, { f: "start", cwd: "/home/user/handbook", source: "startup" });
  await hook(C, { f: "prompt", text: "운영 안내서에 장애 대응 절차 추가" });
  await mcp(C, "/home/user/handbook", "plan", { steps: [{ id: "s1", title: "목차 정하기", status: "doing" }] });
  // 입력을 기다리는 세션(권한 묻기): 목록에서 주황 띠·바탕으로 보인다
  const E = "demo-backup";
  await hook(E, { f: "start", cwd: "/home/user/infra", source: "startup" });
  await hook(E, { f: "prompt", text: "스테이징 DB 백업 스크립트 점검" });
  await hook(E, { f: "run-start", id: "x1", cmd: "rm -rf /tmp/restore-test" });
  await hook(E, { f: "notify", ntype: "permission_prompt", text: "Claude needs your permission to use Bash" });
  await hook(D, { f: "start", cwd: "/home/user/infra", source: "startup" });
  await hook(D, { f: "prompt", text: "오래된 로그 정리 스크립트 점검" });
  await hook(D, { f: "stop", last: "점검했습니다" });
  await hook(D, { f: "end", reason: "exit" });

  // 프로젝트: 큰 그림에 작업 단위와 결정 대기. 간트의 「오늘」 선은 끈다(찍은 날에 따라 그림이 달라지지 않게)
  const proj = await boardOp({ op: "proj-new", name: "쇼핑몰 결제 개편" });
  await boardOp({ op: "proj-set", sids: [A, B], pid: proj.pid });
  await mcp(A, shop, "plan", { project: proj.pid, steps: [
    { id: "u1", title: "결제 흐름 조사", status: "done" },
    { id: "u2", title: "쿠폰 중복 할인 고치기", status: "doing" },
    { id: "u3", title: "주문 API 응답 시간 개선", status: "todo" },
    { id: "u4", title: "배포·모니터링", status: "todo" },
  ] });
  await mcp(A, shop, "draw", { project: proj.pid, ops: [
    { id: "m", kind: "mermaid", label: "일정", src: "gantt\n  dateFormat YYYY-MM-DD\n  axisFormat %m-%d\n  todayMarker off\n  section 결제\n  흐름 조사 :done, a1, 2026-10-26, 2d\n  쿠폰 중복 고치기 :active, a2, after a1, 3d\n  section 주문 API\n  응답 시간 개선 :b1, 2026-11-02, 3d\n  section 배포\n  배포·모니터링 :c1, after b1, 2d" },
    { id: "risk", kind: "table", label: "남은 결정", cols: ["무엇", "누가", "언제"], rows: [["배포 시점", "사용자", "11-05 전"], ["캐시 쓸지", "사용자", "방안 비교 뒤"]] },
  ] });
  await mcp(A, shop, "note", { project: proj.pid, kind: "wait", text: "배포 시점 결정 기다림", on: "u4" });

  // 「보내기」 창이 받을 준비가 된 모습이 되게, 플러그인의 Stop 훅처럼 결제 세션의 메시지를 기다린다(서버 상한 4분, 찍는 데 십여 초)
  fetch(base + "/api/inbox", { method: "POST", headers: { "content-type": "application/json", "x-atv-key": keys.write, Host: host }, body: JSON.stringify({ sid: A, wait: 240_000 }) }).catch(() => {});

  cdp = await connectCdp(await launchChrome(profile));
  const ev = async (expression) => { const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  const until = async (expr, ms = 8000) => { for (const end = Date.now() + ms; ; await sleep(50)) { try { if (await ev(expr)) return; } catch { /* 문서가 바뀌는 중 */ } if (Date.now() > end) throw new Error("기다림 초과: " + expr); } };
  const settle = async () => { let prev = "", same = 0; for (let i = 0; i < 120 && same < 6; i++) { const s = await ev(`JSON.stringify([...document.querySelectorAll('#canvas .part')].map(p=>p.style.left+p.style.top))+document.getElementById('canvas').style.width`); same = s === prev ? same + 1 : 0; prev = s; await sleep(80); } };
  const viewport = (width, height) => cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await viewport(W, H);
  await cdp.send("Page.navigate", { url: `${base}/?t=${encodeURIComponent(keys.read)}#w=${keys.board}` });
  await until(`document.readyState === 'complete' && localStorage.getItem('atv.w') !== null`);
  await ev(`localStorage.setItem('atv.pastOpen', JSON.stringify([''])); localStorage.setItem('atv.follow', '0')`);
  let visit = 0;
  // fit: 그림 전체를 칸에 맞춘다(아니면 원래 크기 100%)
  const open = async (sid, theme, fit = true) => {
    const v = ++visit;
    await cdp.send("Page.navigate", { url: `${base}/?visit=${v}#s=${encodeURIComponent(sid)}` });
    await until(`location.search === '?visit=${v}' && document.readyState === 'complete' && window.__atv?.sid === ${JSON.stringify(sid)}`);
    await ev(`(() => { for (let i = 0; i < 3 && document.documentElement.dataset.theme !== ${JSON.stringify(theme)}; i++) document.getElementById('theme').click(); })()`);
    await ev(`document.fonts.ready`);
    await settle();
    await ev(`document.getElementById(${JSON.stringify(fit ? "zoom-fit" : "zoom-100")}).click()`);
    await sleep(300);
  };
  const shot = async (name, theme, clip) => {
    const r = await cdp.send("Page.captureScreenshot", { format: "png", ...(clip && { clip: { ...clip, scale: 1 } }) });
    const file = path.join(out, `${name}-${theme}.png`);
    fs.writeFileSync(file, Buffer.from(r.data, "base64"));
    console.log(`${path.relative(ROOT, file)} ${Math.round(fs.statSync(file).size / 1024)}KB`);
  };
  const rectOf = (sel, pad = 0) => ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.max(0, r.left - ${pad}), y: Math.max(0, r.top - ${pad}), width: r.width + ${pad} * 2, height: r.height + ${pad} * 2 }; })()`);

  for (const theme of ["light", "dark"]) {
    // 대표 화면: 세션 목록·그림·계획·타임라인
    await open(A, theme);
    await shot("hero", theme);
    // 그림 형식: 표·원 차트·시퀀스·모양 상자. 줄이면 글이 읽히지 않으므로 창을 넓혀 원래 크기로 찍고 그림 자리만 자른다
    await viewport(2200, 1400);
    await open(B, theme, false);
    await shot("forms", theme, await rectOf("#canvas", 12));
    await viewport(W, H);
    // 세션 목록: 프로젝트 묶음, Claude·Codex 로고, 펼친 지난 세션
    await open(A, theme);
    const list = await rectOf("#sessions");
    await shot("sessions", theme, { ...list, height: Math.min(list.height, 600) });
    // 대상 상자와 그 상자에 대해 연 보내기 창
    await ev(`document.querySelector('#canvas .part[data-id="api"]').dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))`);
    await until(`!document.getElementById('ask').hidden`);
    await ev(`document.getElementById('ask').click()`);
    await until(`!document.getElementById('composer').hidden`);
    await ev(`(() => { const t = document.getElementById('c-text'); t.value = '스테이징 쿠폰 데이터는 어제 백업에서 다시 넣어 두었어요. 다시 시험해 주세요'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(200);
    await shot("send", theme, await ev(`(() => { const c = document.getElementById('composer').getBoundingClientRect(), p = document.querySelector('#canvas .part[data-id="api"]').getBoundingClientRect();
      const x = Math.max(0, Math.min(c.left, p.left) - 24), y = Math.max(0, Math.min(c.top, p.top) - 12);
      return { x, y, width: Math.min(${W} - x, Math.max(c.right, p.right) + 24 - x), height: Math.min(${H} - y, Math.max(c.bottom, p.bottom) + 24 - y) }; })()`));
    await ev(`document.getElementById('composer-close').click()`);
    // 프로젝트 큰 그림: 작업 단위의 간트·남은 결정·대화 이력
    await open(proj.pid, theme);
    await shot("project", theme);
  }
}

try { await main(); }
catch (e) { console.error(`실패: ${e.message}`); process.exitCode = 1; }
finally {
  try { cdp?.close(); } catch { /* 이미 닫힘 */ }
  if (chrome) { try { process.kill(process.platform === "win32" ? chrome.pid : -chrome.pid, "SIGKILL"); } catch { /* 이미 끝남 */ } }
  try { await board?.close(); } catch { /* 이미 닫힘 */ }
  await sleep(300);
  if (temp) fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
