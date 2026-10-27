// 화면 없는 Chrome으로 화판을 검사한다. Node 22 내장 기능만 쓴다.
// 쓰는 법: node verify/probe_ui.js [캡처 폴더]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { startBoard } from "../lib/server.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [], consoleErrors = [], exceptions = [], logErrors = [];
let temp, home, profile, board, chrome, chromeExit, cdp, keys;

function cleanText(value) {
  let text = String(value);
  for (const key of Object.values(keys || {})) text = text.replaceAll(key, "[열쇠 생략]");
  return text.replace(/\s+/g, " ").trim();
}

function record(ok, message) {
  results.push({ ok, message });
  console.log(`${ok ? "통과" : "실패"} · ${cleanText(message)}`);
}

async function check(message, run) {
  try {
    const detail = await run();
    record(true, message + (detail ? ` · ${detail}` : ""));
  } catch (error) {
    record(false, `${message} · ${error.message}`);
  }
}

function expect(value, message) {
  if (!value) throw new Error(message);
}

// CHROME을 우선하고, 없으면 운영체제별 실행 파일을 찾는다.
function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const pf = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean);
  const candidates = process.platform === "win32"
    ? pf.flatMap((dir) => [path.join(dir, "Google", "Chrome", "Application", "chrome.exe"), path.join(dir, "Microsoft", "Edge", "Application", "msedge.exe")])
    : process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].flatMap((name) =>
        (process.env.PATH || "").split(path.delimiter).map((dir) => path.join(dir, name)));
  const hit = candidates.find((file) => {
    try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); }
    catch { return false; }
  });
  if (!hit) throw new Error("Chrome을 찾지 못했습니다. CHROME 환경 변수에 실행 파일 경로를 넣어 주세요.");
  return hit;
}

// 포트 0은 운영체제가 빈 포트를 무작위로 고르게 한다.
async function launchChrome() {
  chrome = spawn(findChrome(), [
    "--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--hide-scrollbars", "--window-size=1800,1050", "about:blank",
  ], { stdio: "ignore", detached: process.platform !== "win32" }); // 하위 프로세스까지 한 묶음으로 끄려고 따로 세운다
  let gone = false, launchError;
  chromeExit = new Promise((resolve) => {
    chrome.once("exit", () => { gone = true; resolve(); });
    chrome.once("error", (error) => { gone = true; launchError = error; resolve(); });
  });
  const deadline = performance.now() + 12000;
  while (performance.now() < deadline && !gone) {
    try {
      const port = Number(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
      if (Number.isInteger(port) && port > 0) {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
        const page = (await response.json()).find((target) => target.type === "page");
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      }
    } catch { /* 디버깅 포트가 열릴 때까지 기다린다. */ }
    await sleep(50);
  }
  throw new Error(launchError ? `Chrome 실행 실패: ${launchError.message}` : "Chrome 디버깅 포트가 열리지 않았습니다.");
}

// 요청 번호로 응답을 짝짓고, 페이지 오류는 별도로 모은다.
async function connectCdp(url) {
  const ws = new WebSocket(url), pending = new Map();
  let nextId = 0;
  const rejectPending = () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Chrome 연결이 끊겼습니다."));
    }
    pending.clear();
  };
  ws.addEventListener("close", rejectPending);
  ws.addEventListener("error", rejectPending);
  ws.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
      return;
    }
    const p = message.params;
    if (message.method === "Runtime.exceptionThrown") {
      exceptions.push(p.exceptionDetails.exception?.description || p.exceptionDetails.text);
    }
    if (message.method === "Log.entryAdded" && p.entry.level === "error") logErrors.push(p.entry.text);
    if (message.method === "Runtime.consoleAPICalled" && p.type === "error") {
      consoleErrors.push(p.args.map((arg) => arg.value ?? arg.description ?? "").join(" "));
    }
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Chrome 연결 시간이 초과됐습니다.")), 5000);
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Chrome에 연결하지 못했습니다.")); }, { once: true });
    });
  } catch (error) { ws.close(); throw error; }
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 응답 시간 초과: ${method}`)); }, 10000);
        pending.set(id, { resolve, reject, timer });
        try { ws.send(JSON.stringify({ id, method, params })); }
        catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    },
    close() { rejectPending(); ws.close(); },
  };
}

async function evaluate(expression) {
  const reply = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
  return reply.result.value;
}

async function waitFor(expression, timeout = 6000, started = performance.now()) {
  do {
    const value = await evaluate(expression);
    const elapsed = performance.now() - started;
    if (value && elapsed <= timeout) return { value, elapsed };
    if (elapsed >= timeout) break;
    await sleep(15);
  } while (performance.now() - started < timeout);
  throw new Error(`${timeout}ms 안에 화면에 반영되지 않았습니다: ${expression.replace(/\s+/g, " ").slice(0, 160)}`);
}

// .part 전체의 화면 좌표를 잰다. 아직 배치 중인 4000px 화판은 제외한다.
async function positions() {
  return evaluate(`Object.fromEntries([...document.querySelectorAll('.part')].map((part) => {
    const rect = part.getBoundingClientRect();
    return [part.dataset.id, { left: rect.left, top: rect.top }];
  }))`);
}

async function settledPositions() {
  let previous = "", stableSince = performance.now();
  const deadline = performance.now() + 6000;
  while (performance.now() < deadline) {
    const ready = await evaluate(`(() => {
      const canvas = document.getElementById('canvas');
      return canvas.style.width && canvas.style.width !== '4000px' && document.querySelectorAll('.part').length > 0 &&
        [...document.querySelectorAll('.part.mermaid')].every((part) => part.querySelector('.msvg svg, .merr'));
    })()`);
    const current = await positions(), json = JSON.stringify(current);
    if (!ready || json !== previous) stableSince = performance.now();
    if (ready && json === previous && performance.now() - stableSince >= 200) return current;
    previous = json;
    await sleep(25);
  }
  throw new Error("화판 배치가 끝나지 않았습니다.");
}

function movements(before, after) {
  return Object.entries(before).map(([id, point]) => {
    const next = after[id];
    expect(next, `기존 부품 ${id}이 사라졌습니다.`);
    return { id, dx: next.left - point.left, dy: next.top - point.top };
  });
}

// 투명 배경은 조상 배경으로 채우고 WCAG 상대 휘도로 대비를 구한다.
function inspectContrast() {
  const rgb = (text) => {
    const values = text.match(/[\d.]+/g)?.map(Number);
    if (!values || values.length < 3) throw new Error(`RGB 색을 읽지 못했습니다: ${text}`);
    return [values[0], values[1], values[2], values[3] ?? 1];
  };
  const over = (fg, bg) => fg.slice(0, 3).map((value, i) => value * fg[3] + bg[i] * (1 - fg[3]));
  const background = (element) => {
    if (!element) return [255, 255, 255];
    const color = rgb(getComputedStyle(element).backgroundColor);
    if (color[3] === 1) return color.slice(0, 3);
    return over(color, background(element.parentElement));
  };
  const luminance = (color) => color.map((value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
  return [...document.querySelectorAll('button, input[type="range"]')].map((element, index) => {
    const style = getComputedStyle(element), bg = background(element), fg = over(rgb(style.color), bg);
    const a = luminance(fg), b = luminance(bg);
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    return {
      name: element.id || `${element.tagName.toLowerCase()}[${index}]`, ratio,
      ok: style.color !== style.backgroundColor && fg.some((value, i) => value !== bg[i]) && ratio >= 4.5,
    };
  });
}

async function main() {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "anytaskview-ui-"));
  home = path.join(temp, "home");
  profile = path.join(temp, "chrome");
  const out = path.resolve(process.argv[2] || path.join(temp, "out"));
  fs.mkdirSync(out, { recursive: true });
  board = await startBoard({ port: 0, home });
  keys = JSON.parse(fs.readFileSync(path.join(home, "key.json"), "utf8"));
  const host = `127.0.0.1:${board.port}`, base = `http://${host}`;
  const sid = `ui-probe-${process.pid}`, cwd = process.cwd();
  const post = async (route, body) => {
    const response = await fetch(base + route, {
      method: "POST", headers: { "content-type": "application/json", "x-atv-key": keys.write, Host: host },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    const receivedAt = performance.now();
    expect(response.ok, `POST ${route}: HTTP ${response.status}`);
    expect(!text.includes("거부") && !text.includes("무시한 필드"), `POST ${route}: ${text}`);
    return receivedAt;
  };
  const hook = (fact) => post("/api/hook", { sid, fact });
  const mcp = (tool, input) => post("/api/mcp", { env: sid, cwd, tool, input });

  // SessionStart 사실을 먼저 보내고 읽기 토큰의 302·쿠키 경로로 접속한다.
  await hook({ f: "start", cwd, source: "startup" });
  cdp = await connectCdp(await launchChrome());
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `
    if (location.search.includes('nohub')) delete window.SharedWorker; // SharedWorker 가 없는 브라우저 흉내
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__cspViolations.push({ directive: event.effectiveDirective, blocked: event.blockedURI });
    });
  ` });
  const navigation = await cdp.send("Page.navigate", { url: `${base}/?t=${encodeURIComponent(keys.read)}#w=${keys.board}` });
  expect(!navigation.errorText, navigation.errorText);
  await waitFor(`document.readyState === 'complete' && window.__atv?.sid === ${JSON.stringify(sid)} && document.querySelector('#sessions .sess.sel') !== null`);
  await check("읽기 토큰의 쿠키 접속", async () => {
    expect(await evaluate(`location.pathname === '/' && location.search === '' && !location.hash.includes('w=')`), "토큰 없는 주소로 이동하지 않았습니다.");
    expect(await evaluate(`localStorage.getItem('atv.w') === ${JSON.stringify(keys.board)}`), "화판 쓰기 열쇠를 이 포트의 localStorage 에 넣지 않았습니다.");
  });

  await check("띠가 없을 때 가운데 영역이 화면 높이를 채움", async () => {
    const box = await evaluate(`(() => {
      const main = document.querySelector('main').getBoundingClientRect(), bar = document.getElementById('replay').getBoundingClientRect();
      return { band: document.getElementById('band').hidden, main: main.height, bottom: bar.bottom, vh: innerHeight };
    })()`);
    expect(box.band, "띠가 보이는 상태입니다.");
    expect(box.main > box.vh * 0.6 && Math.abs(box.bottom - box.vh) <= 1, JSON.stringify(box));
    return `main ${Math.round(box.main)}px / 화면 ${box.vh}px`;
  });

  const stepTitles = ["화판 연결 확인", "결과 검토"];
  const planReady = `(() => {
    const titles = [...document.querySelectorAll('#plan-body .title')].map((part) => part.textContent);
    return ${JSON.stringify(stepTitles)}.every((title) => titles.includes(title));
  })()`;
  await check("계획이 응답 후 1000ms 안에 표시됨", async () => {
    const started = await mcp("plan", { steps: [
      { id: "s1", title: stepTitles[0], status: "doing" }, { id: "s2", title: stepTitles[1], status: "todo" },
    ] });
    const { elapsed } = await waitFor(planReady, 1000, started);
    return `${elapsed.toFixed(1)}ms`;
  });
  const parts = [
    { id: "group", kind: "group", label: "연결 묶음" },
    { id: "box-a", kind: "box", in: "group", label: "소스", ref: "src/a.js:3", status: "todo" },
    { id: "box-b", kind: "box", in: "group", label: "대상", status: "todo" },
    { id: "edge", kind: "edge", from: "box-a", to: "box-b", label: "전달" },
    { id: "list", kind: "list", label: "확인 목록" },
    { id: "item-a", kind: "item", in: "list", label: "첫 항목", status: "todo" },
    { id: "item-b", kind: "item", in: "list", label: "둘째 항목", status: "todo" },
    { id: "mermaid", kind: "mermaid", label: "정상 Mermaid", src: "graph LR; A-->B" },
  ];
  await check("모든 그림 부품이 응답 후 1000ms 안에 표시됨", async () => {
    const started = await mcp("draw", { ops: parts });
    const { elapsed } = await waitFor(`(() => {
      const ids = new Set([...document.querySelectorAll('#canvas [data-id]')].map((part) => part.dataset.id));
      return ${JSON.stringify(parts.map((part) => part.id))}.every((id) => ids.has(id)) &&
        document.querySelector('[data-id="mermaid"] .msvg svg') !== null &&
        [...document.querySelectorAll('#canvas .elabel')].some((label) => label.textContent === '전달');
    })()`, 1000, started);
    return `${elapsed.toFixed(1)}ms`;
  });
  await check("현재 단계 제목과 두 계획 단계 표시", async () => {
    await waitFor(`document.getElementById('headline').textContent.includes(${JSON.stringify(stepTitles[0])}) && (${planReady})`);
  });

  await check("상태만 바꾸면 모든 기존 부품의 좌표가 유지됨", async () => {
    const before = await settledPositions();
    expect(Object.keys(before).length === 5, "기준 부품이 모두 배치되지 않았습니다.");
    await mcp("draw", { ops: [{ id: "box-a", status: "doing" }] });
    await waitFor(`document.querySelector('[data-id="box-a"]').classList.contains('st-doing')`);
    const after = await settledPositions(), deltas = movements(before, after);
    expect(Object.keys(after).length === Object.keys(before).length, "부품 개수가 달라졌습니다.");
    const moved = deltas.filter(({ dx, dy }) => dx !== 0 || dy !== 0);
    expect(!moved.length, `좌표 변경: ${JSON.stringify(moved)}`);
    return "left/top 변화 0px";
  });
  await check("상자 추가 후 기존 부품의 최대 이동량 측정", async () => {
    const before = await settledPositions(), errorCount = exceptions.length;
    await mcp("draw", { ops: [{ id: "box-c", kind: "box", label: "추가 상자", in: "group" }] });
    await waitFor(`document.querySelector('.part[data-id="box-c"]') !== null`);
    const after = await settledPositions(), deltas = movements(before, after);
    const max = Math.max(0, ...deltas.map(({ dx, dy }) => Math.hypot(dx, dy)));
    console.log(` · 기존 부품 최대 이동량: ${max.toFixed(2)}px`);
    expect(exceptions.length === errorCount, "상자 추가 중 페이지 예외가 발생했습니다.");
  });

  await check("Edit 사실이 참조 상자에 수정됨 표지를 붙임", async () => {
    await hook({ f: "edit", tool: "Edit", path: path.join(cwd, "src", "a.js") });
    await waitFor(`document.querySelector('[data-id="box-a"] .badge.edited')?.textContent === '수정됨'`);
  });
  await check("UserPromptSubmit 사실이 수정됨 표지를 지움", async () => {
    await hook({ f: "prompt", text: "다음 확인을 진행하세요." });
    await waitFor(`document.querySelector('[data-id="box-a"]') !== null &&
      document.querySelector('[data-id="box-a"] .badge.edited') === null`);
  });
  await check("잘못된 Mermaid는 오류 문구를 표시하고 예외를 내보내지 않음", async () => {
    const errorCount = exceptions.length;
    await mcp("draw", { ops: [{ id: "mermaid-bad", kind: "mermaid", label: "오류 Mermaid", src: "graph LR; A[" }] });
    await waitFor(`!!document.querySelector('[data-id="mermaid-bad"] .merr')?.textContent.trim()`);
    await settledPositions();
    expect(exceptions.length === errorCount, "Mermaid 오류가 페이지 예외로 전달됐습니다.");
  });
  await check("현재 단계의 wait 메모가 띠와 입력 필요 탭 제목을 표시함", async () => {
    await mcp("note", { kind: "wait", on: "s1", text: "확인 후 알려 주세요." });
    await waitFor(`!document.getElementById('band').hidden &&
      document.getElementById('band').textContent.includes(${JSON.stringify(stepTitles[0])}) &&
      document.title.startsWith('● 입력 필요')`);
  });

  await check("빈 묶음도 긴 제목이 잘리지 않는 크기로 배치됨", async () => {
    await mcp("draw", { ops: [{ id: "group-empty", kind: "group", label: "제목이 아주 긴 빈 묶음 하나를 시험합니다" }] });
    const { value } = await waitFor(`(() => {
      const g = document.querySelector('[data-id="group-empty"]'), lbl = g?.querySelector('.lbl');
      if (!g || !lbl || !g.style.width) return null;
      return { width: g.getBoundingClientRect().width, need: lbl.scrollWidth, height: g.getBoundingClientRect().height };
    })()`);
    expect(value.width >= value.need && value.height >= 40, JSON.stringify(value));
    return `폭 ${Math.round(value.width)}px ≥ 제목 ${value.need}px`;
  });

  // 패널 크기·접기·배율·띠·거르기(02 단위)
  const mouse = async (type, x, y) => cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
  const rectOf = (selector) => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  await check("경계선을 끌면 세션 목록 폭이 바뀌고 다시 열어도 유지됨", async () => {
    const bar = await rectOf("#split-left"), before = (await rectOf("#sessions")).w;
    const x = bar.x + bar.w / 2, y = bar.y + 200;
    await mouse("mousePressed", x, y);
    await mouse("mouseMoved", x + 40, y);
    await mouse("mouseMoved", x + 80, y);
    await mouse("mouseReleased", x + 80, y);
    const after = (await rectOf("#sessions")).w;
    expect(Math.abs(after - (before + 80)) <= 2, `폭 ${before} → ${after}`);
    await evaluate("location.reload()");
    await waitFor(`document.readyState === 'complete' && window.__atv?.sid === ${JSON.stringify(sid)} && document.querySelector('#sessions .sess.sel') !== null`);
    const reloaded = (await rectOf("#sessions")).w;
    expect(Math.abs(reloaded - after) <= 2, `다시 연 뒤 폭 ${reloaded}`);
    await evaluate(`document.getElementById('split-left').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    return `${Math.round(before)} → ${Math.round(after)}px, 다시 열어도 ${Math.round(reloaded)}px`;
  });
  await check("세션 목록·계획·타임라인을 접고 펼 수 있음", async () => {
    await evaluate(`document.getElementById('fold-sessions').click()`);
    await waitFor(`document.getElementById('sessions').getBoundingClientRect().width <= 41`);
    // 접어도 그림 칸과 오른쪽 패널이 제 폭을 지킨다(숨긴 경계선이 칸을 밀어내지 않는다)
    const w = await evaluate(`[document.getElementById('canvas-wrap').getBoundingClientRect().width, document.getElementById('side').getBoundingClientRect().width]`);
    expect(w[0] > 600 && w[1] > 280, `그림 ${w[0]}px, 오른쪽 ${w[1]}px`);
    await evaluate(`document.getElementById('fold-sessions').click(); document.getElementById('fold-tl').click()`);
    await waitFor(`document.getElementById('sessions').getBoundingClientRect().width > 100 && document.getElementById('tl-body').offsetParent === null`);
    await waitFor(`document.getElementById('plan').getBoundingClientRect().height > 300`); // 타임라인을 접으면 계획 칸이 아래까지 늘어난다
    await evaluate(`document.getElementById('fold-tl').click(); document.getElementById('fold-plan').click()`);
    await waitFor(`document.getElementById('tl-body').offsetParent !== null && document.getElementById('timeline').getBoundingClientRect().height > 300 && document.getElementById('plan-body').offsetParent === null`);
    await evaluate(`document.getElementById('fold-plan').click()`);
    await waitFor(`document.getElementById('plan-body').offsetParent !== null`);
  });
  await check("900px 아래 좁은 화면에서도 계획과 타임라인이 보임", async () => {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 800, height: 1000, deviceScaleFactor: 1, mobile: false });
    try {
      await waitFor(`document.getElementById('timeline').getBoundingClientRect().height > 60 && document.getElementById('plan').getBoundingClientRect().height > 60`);
    } finally {
      await cdp.send("Emulation.clearDeviceMetricsOverride");
    }
  });
  await check("1440·1100px 화면: 맨 위 줄이 넘치지 않고(긴 제목·단계 줄은 줄어듦), 아이콘 단추에 이름이 있으며, 타임라인 시각이 시:분:초", async () => {
    const out = [];
    try {
      for (const width of [1440, 1100]) {
        await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await waitFor(`innerWidth === ${width}`);
        // 가장 넓은 경우를 만든다: 긴 이름·프로젝트·단계 줄(1초 뒤 화면이 다시 그려 되돌린다)
        const top = await evaluate(`(() => {
          const long = '아주 긴 세션 이름으로 맨 위 줄이 넘치는지 보는 시험 '.repeat(3);
          document.getElementById('sess-name').textContent = long;
          document.getElementById('headline').textContent = '지금 ' + long + ' · 1분 미만 · 파일 12 · 명령 34(실패 5)';
          const pl = document.getElementById('proj-link'), plHidden = pl.hidden;
          pl.hidden = false; pl.textContent = '프로젝트 ' + long;
          const t = document.getElementById('top'), last = document.getElementById('help-open').getBoundingClientRect();
          const compose = document.getElementById('compose').getBoundingClientRect();
          const r = { sw: t.scrollWidth, cw: t.clientWidth, right: Math.round(last.right), vw: innerWidth, bodyW: document.body.scrollWidth, composeH: Math.round(compose.height) };
          pl.hidden = plHidden;
          return r;
        })()`);
        expect(top.composeH <= 30, `${width}px 에서 보내기 단추 글자가 꺾임 ${JSON.stringify(top)}`);
        expect(top.bodyW <= top.vw, `${width}px 에서 화면 폭을 넘음 ${JSON.stringify(top)}`);
        expect(top.sw <= top.cw && top.right <= top.vw, `${width}px 에서 맨 위 줄 넘침 ${JSON.stringify(top)}`);
        out.push(`${width}: ${top.sw}/${top.cw}px`);
      }
      expect(await evaluate(`['theme', 'settings-open', 'help-open'].every((id) => document.getElementById(id).getAttribute('aria-label'))`), "아이콘 단추에 이름(aria-label)이 없음");
      expect(await evaluate(`/^\\d{2}:\\d{2}:\\d{2}$/.test(document.querySelector('#tl-body li .when')?.textContent || '')`), "타임라인 시각이 시:분:초 가 아님");
      return out.join(", ");
    } finally {
      await cdp.send("Emulation.clearDeviceMetricsOverride");
      await settledPositions(); // 화면 폭이 바뀌어 다시 고른 배치가 끝난 뒤 다음 검사로 간다
    }
  });
  await check("배율 단추가 그림만 키우고 부품 배치는 그대로 둠", async () => {
    const layoutOf = `JSON.stringify([...document.querySelectorAll('#canvas .part')].map((p) => [p.dataset.id, p.style.left, p.style.top]))`;
    const before = await evaluate(layoutOf);
    await evaluate(`document.getElementById('zoom-in').click()`);
    await waitFor(`document.getElementById('zoom-label').textContent === '125%' && document.getElementById('canvas').style.transform === 'scale(1.25)'`);
    expect(await evaluate(layoutOf) === before, "배율을 바꾸자 부품 배치가 달라졌습니다.");
    await evaluate(`document.getElementById('zoom-fit').click()`);
    const fit = await evaluate(`document.getElementById('zoom-label').textContent`);
    await evaluate(`document.getElementById('zoom-100').click()`);
    await waitFor(`document.getElementById('zoom-label').textContent === '100%'`);
    return `확대 125% → 맞춤 ${fit} → 100%`;
  });
  await check("띠의 보기 단추가 그 계획 단계로 데려감", async () => {
    await evaluate(`document.querySelector('#band button').click()`);
    await waitFor(`document.querySelector('#plan-body li[data-id="s1"]')?.classList.contains('flash')`);
  });
  await check("타임라인 거르기: 파일을 끄면 수정 줄이 사라지고 켜면 돌아옴", async () => {
    const editShown = `[...document.querySelectorAll('#tl-body li')].some((li) => li.textContent.includes('수정 a.js'))`;
    await waitFor(editShown);
    await evaluate(`[...document.querySelectorAll('#tl-filters button')].find((b) => b.textContent === '파일').click()`);
    await waitFor(`!(${editShown})`);
    await evaluate(`[...document.querySelectorAll('#tl-filters button')].find((b) => b.textContent === '파일').click()`);
    await waitFor(editShown);
  });

  // 브라우저 쓰기(이름·프로젝트·보내기·설정)
  await check("세션 이름을 바꾸면 맨 위와 세션 목록에 보임", async () => {
    await evaluate(`(() => {
      document.getElementById('sess-name').click();
      document.getElementById('name-input').value = '화판 이름 시험';
      document.getElementById('name-form').requestSubmit();
    })()`);
    await waitFor(`document.getElementById('sess-name').textContent === '화판 이름 시험' &&
      document.querySelector('#sessions .sess.sel .txt').textContent === '화판 이름 시험'`);
  });
  let visits = 0;
  const open = async (s) => {
    // 쿼리를 바꿔 매번 새 문서로 읽는다(주소 조각만 바뀌면 같은 문서로 남는다). 바뀌는 사이의 평가 오류는 넘긴다
    const v = ++visits;
    await cdp.send("Page.navigate", { url: `${base}/?visit=${v}#s=${encodeURIComponent(s)}` });
    const until = performance.now() + 6000;
    for (;;) {
      try {
        if (await evaluate(`location.search === '?visit=${v}' && document.readyState === 'complete' && window.__atv?.sid === ${JSON.stringify(s)}`)) return;
      } catch { /* 문서가 바뀌는 중 */ }
      if (performance.now() > until) throw new Error(`세션 ${s} 를 열지 못했습니다`);
      await sleep(30);
    }
  };
  const key = async (k, code, vk, text) => {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, ...(text && { text }) });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk });
  };
  // 프로젝트 머리 글(「이름 · 개수」)에 이름이, n 을 주면 「이름 · n」 이 있는가
  const groupCount = (name, n) => `[...document.querySelectorAll('#sessions .ghead .gfold')].some((b) => b.textContent.includes(${JSON.stringify(n === undefined ? name : `${name} · ${n}`)}))`;
  await check("「+ 프로젝트」 로 이름을 적으면 빈 프로젝트가 머리로 보이고, 「프로젝트 없음」 도 놓을 자리로 보임", async () => {
    await evaluate(`document.getElementById('group-add').click()`);
    await waitFor(`document.activeElement?.tagName === 'INPUT' && document.activeElement.closest('#sess-body') !== null`);
    await evaluate(`(() => { document.activeElement.value = '시험 프로젝트'; })()`);
    await key("Enter", "Enter", 13, "\r");
    await waitFor(`${groupCount("시험 프로젝트", 0)} && ${groupCount("프로젝트 없음")} && document.querySelector('#sessions .gempty') !== null`);
  });
  await check("세션 줄을 끌어 프로젝트에 놓으면 그 프로젝트로 옮겨 감", async () => {
    await evaluate(`(() => {
      const src = document.querySelector('#sessions .sess.sel');
      const target = [...document.querySelectorAll('#sessions .gsec')].find((s) => s.querySelector('.gfold').textContent.includes('시험 프로젝트'));
      const dt = new DataTransfer();
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    })()`);
    await waitFor(`${groupCount("시험 프로젝트", 1)} && [...document.querySelectorAll('#sessions .gsec')].find((s) => s.querySelector('.gfold').textContent.includes('시험 프로젝트'))?.querySelector('.sess.sel') != null`);
  });
  await check("줄의 ⋯ 메뉴를 키보드로 열어 「프로젝트 없음」 을 고르면 프로젝트에서 빠지고 초점이 ⋯ 로 돌아옴", async () => {
    await evaluate(`(() => { const m = document.querySelector('#sessions .sess.sel').parentElement.querySelector('.smenu'); m.focus(); })()`);
    await key("Enter", "Enter", 13, "\r");
    await waitFor(`!document.getElementById('group-menu').hidden && document.activeElement?.getAttribute('aria-checked') === 'true' && document.activeElement.textContent === '시험 프로젝트'`);
    await key("ArrowDown", "ArrowDown", 40);
    await waitFor(`document.activeElement?.textContent === '프로젝트 없음'`);
    await key("Enter", "Enter", 13, "\r");
    await waitFor(`document.getElementById('group-menu').hidden && ${groupCount("시험 프로젝트", 0)} && document.activeElement?.classList.contains('smenu')`);
  });
  await check("⋯ 메뉴: 열린 동안 목록이 다시 그려져도 Esc 로 닫으면 초점이 ⋯ 로, 「새 프로젝트…」 입력을 Esc 로 취소하면 그 항목으로 돌아옴", async () => {
    await evaluate(`document.querySelector('#sessions .sess.sel').parentElement.querySelector('.smenu').focus()`);
    await key("Enter", "Enter", 13, "\r");
    await waitFor(`!document.getElementById('group-menu').hidden`);
    await hook({ f: "prompt", text: "목록을 다시 그리게 하는 입력" }); // 세션 요약이 바뀌어 목록이 새로 그려진다
    await sleep(300);
    await evaluate(`[...document.querySelectorAll('#group-menu .gm-item')].find((b) => b.textContent === '새 프로젝트…').focus()`);
    await key("Enter", "Enter", 13, "\r");
    await waitFor(`document.activeElement?.tagName === 'INPUT' && document.getElementById('group-menu').contains(document.activeElement)`);
    await key("Escape", "Escape", 27);
    await waitFor(`document.activeElement?.textContent === '새 프로젝트…'`);
    await key("Escape", "Escape", 27);
    await waitFor(`document.getElementById('group-menu').hidden && document.activeElement?.classList.contains('smenu')`);
  });
  await check("프로젝트: 맨 위 「프로젝트 없음」 으로 넣을 곳을 고르고, 「프로젝트 …」 를 누르면 큰 그림(맨 위 「프로젝트」, 오른쪽 아래 「대화 이력」, 보내기·말풍선 꺼짐)이 열리며, 대화 이력에서 대화를 누르면 돌아옴", async () => {
    await waitFor(`document.getElementById('proj-link').textContent === '프로젝트 없음'`);
    await evaluate(`document.getElementById('proj-link').click()`);
    await waitFor(`!document.getElementById('group-menu').hidden && [...document.querySelectorAll('#group-menu .gm-item')].some((b) => b.textContent === '시험 프로젝트')`);
    await evaluate(`[...document.querySelectorAll('#group-menu .gm-item')].find((b) => b.textContent === '시험 프로젝트').click()`);
    await waitFor(`document.getElementById('proj-link').textContent.startsWith('프로젝트 시험 프로젝트') && document.activeElement?.id === 'proj-link'`);
    const pid = await evaluate(`document.getElementById('proj-link').dataset.pid`);
    await mcp("plan", { steps: [{ id: "u1", title: "08 프로젝트 화판", status: "doing" }], project: pid });
    await mcp("draw", { ops: [{ id: "big", kind: "box", label: "큰 그림 상자", status: "doing" }], project: pid });
    await waitFor(`document.getElementById('proj-link').textContent.includes('지금 08 프로젝트 화판')`);
    await evaluate(`document.getElementById('proj-link').click()`);
    await waitFor(`window.__atv.sid === ${JSON.stringify(pid)} && document.getElementById('sess-chip').textContent === '프로젝트' && document.getElementById('tl-title').textContent === '대화 이력'
      && document.querySelector('#canvas .part[data-id="big"]') !== null && document.getElementById('compose').disabled && document.getElementById('proj-link').hidden
      && document.querySelector('#sessions .gfold.sel')?.textContent.startsWith('시험 프로젝트') && document.getElementById('headline').textContent.startsWith('지금 08 프로젝트 화판')`);
    await evaluate(`document.querySelector('#canvas .part[data-id="big"]').focus()`);
    await sleep(200);
    expect(await evaluate(`document.getElementById('ask').hidden`), "프로젝트 화판에 말풍선이 뜸(받을 Claude 가 없다)");
    expect(await evaluate(`!document.querySelector('#canvas .part[aria-keyshortcuts], #plan-body li[aria-keyshortcuts]')`), "프로젝트 화판의 상자·단계가 Enter 보내기를 알림");
    // 다른 세션의 사건으로 대화 이력을 다시 그려도 그 단추의 초점이 남는다
    await waitFor(`document.querySelector('#tl-body .hist') !== null`);
    await evaluate(`document.querySelector('#tl-body .hist').focus()`);
    await hook({ f: "prompt", text: "대화 이력을 다시 그리게 하는 입력" });
    await sleep(300);
    expect(await evaluate(`document.activeElement?.classList.contains('hist')`), "대화 이력 단추에서 초점을 잃음");
    // ⋯ 「끝으로 표시」 뒤 초점은 접힌 「끝난 프로젝트」 머리로 간다. 다시 진행으로 돌려 둔다
    await evaluate(`document.querySelector('#sessions .pmenu[data-pid="${pid}"]').click()`);
    await waitFor(`!document.getElementById('group-menu').hidden`);
    await evaluate(`[...document.querySelectorAll('#group-menu .gm-item')].find((b) => b.textContent === '끝으로 표시').click()`);
    await waitFor(`document.activeElement?.classList.contains('dhead') && document.getElementById('sess-chip').textContent === '끝난 프로젝트'`);
    await evaluate(`document.querySelector('#sessions .dhead').click()`);
    await waitFor(`document.querySelector('#sessions .pmenu[data-pid="${pid}"]') !== null`);
    await evaluate(`document.querySelector('#sessions .pmenu[data-pid="${pid}"]').click()`);
    await waitFor(`!document.getElementById('group-menu').hidden`);
    await evaluate(`[...document.querySelectorAll('#group-menu .gm-item')].find((b) => b.textContent === '다시 진행으로 두기').click()`);
    await waitFor(`document.getElementById('sess-chip').textContent === '프로젝트' && document.getElementById('group-menu').hidden && document.querySelector('#sessions .dhead') === null`);
    await evaluate(`localStorage.removeItem('atv.doneOpen')`);
    await waitFor(`[...document.querySelectorAll('#tl-body .hist')].some((b) => b.textContent.includes('화판 이름 시험'))`);
    await evaluate(`[...document.querySelectorAll('#tl-body .hist')].find((b) => b.textContent.includes('화판 이름 시험')).click()`);
    await waitFor(`window.__atv.sid === ${JSON.stringify(sid)} && document.getElementById('tl-title').textContent === '타임라인' && !document.getElementById('compose').disabled && document.querySelectorAll('#canvas .part').length > 0`);
    // 다음 검사들이 처음 목록 모양을 쓰므로 다시 뺀다
    await evaluate(`document.querySelector('#sessions .sess.sel').parentElement.querySelector('.smenu').click()`);
    await waitFor(`!document.getElementById('group-menu').hidden`);
    await evaluate(`[...document.querySelectorAll('#group-menu .gm-item')].find((b) => b.textContent === '프로젝트 없음').click()`);
    await waitFor(`document.getElementById('proj-link').textContent === '프로젝트 없음'`);
  });
  await check("설정: 이어받기 문구를 저장하면 서버 설정이 바뀌고, 틀린 문구는 알림만 뜨고 창이 남으며, 비우면 끔", async () => {
    await evaluate(`document.getElementById('settings-open').click()`);
    await waitFor(`document.getElementById('settings').open && document.activeElement?.id === 'cfg-phrase'`);
    const logged = logErrors.length;
    await evaluate(`(() => { document.getElementById('cfg-phrase').value = '<키> 이어서'; document.getElementById('settings-form').requestSubmit(); })()`);
    await waitFor(`!document.getElementById('toast').hidden && document.getElementById('toast').textContent.includes('앞에 글') && document.getElementById('settings').open`);
    await sleep(100);
    // 일부러 틀린 문구를 보내 생긴 400 응답 한 건은 오류로 세지 않는다
    const extra = logErrors.splice(logged);
    const expected = extra.findIndex((t) => /status of 400/.test(t));
    if (expected >= 0) extra.splice(expected, 1);
    logErrors.push(...extra);
    await evaluate(`(() => { document.getElementById('cfg-phrase').value = 'continue <키>'; document.getElementById('settings-form').requestSubmit(); })()`);
    await waitFor(`!document.getElementById('settings').open && window.__atv.config.resume?.phrase === 'continue <키>'`);
    expect(board.config.resume?.phrase === "continue <키>", "서버 설정이 바뀌지 않음");
    await evaluate(`document.getElementById('settings-open').click()`);
    await waitFor(`document.getElementById('settings').open && document.getElementById('cfg-phrase').value === 'continue <키>'`);
    await evaluate(`(() => { document.getElementById('cfg-phrase').value = ''; document.getElementById('settings-form').requestSubmit(); })()`);
    await waitFor(`!document.getElementById('settings').open && window.__atv.config.resume === null`);
  });
  await check("세션 줄에 초점이 있어도 목록이 다시 그려질 때 스크롤 자리가 그대로임", async () => {
    await evaluate(`(() => {
      const box = document.getElementById('sessions');
      box.style.maxHeight = '120px';
      const filler = document.createElement('div'); filler.id = 'probe-filler'; filler.style.height = '600px';
      box.append(filler);
      document.querySelector('#sessions .sess.sel').focus();
      box.scrollTop = 500;
    })()`);
    const before = await evaluate(`document.getElementById('sessions').scrollTop`);
    await hook({ f: "prompt", text: "스크롤 자리 확인" });
    await sleep(400);
    const after = await evaluate(`(() => { const box = document.getElementById('sessions'), v = box.scrollTop; document.getElementById('probe-filler').remove(); box.style.maxHeight = ''; return v; })()`);
    expect(before > 0 && after === before, `스크롤 ${before} → ${after}`);
    return `스크롤 ${before} 그대로`;
  });
  const partBox = (id) => evaluate(`(() => { const r = document.querySelector('#canvas .part[data-id="${id}"]').getBoundingClientRect(); return { x: r.left, y: r.top, r: r.right, b: r.bottom }; })()`);
  await check("말풍선: 상자에 마우스를 올리면 「보내기」 가 뜨고, 누르면 상자 옆 창에서 그 상자에 보내며 Enter 로 보냄", async () => {
    await settledPositions();
    const box = await partBox("box-a");
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: (box.x + box.r) / 2, y: (box.y + box.b) / 2 });
    await waitFor(`!document.getElementById('ask').hidden`);
    // 실제 마우스로 말풍선까지 옮겨 누른다(묶음 안 상자라 사이에 묶음을 지나면 묶음의 말풍선으로 바뀐다)
    const ab = await evaluate(`(() => { const r = document.getElementById('ask').getBoundingClientRect(); return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2, h: r.height }; })()`);
    expect(ab.h >= 24, `말풍선 높이 ${ab.h}px(24px 이상이어야 누르기 쉽다)`);
    expect(await evaluate(`document.querySelector('#canvas .part[data-id="box-a"]').getAttribute('aria-keyshortcuts') === 'Enter'`), "보낼 수 있는 상자가 Enter 보내기를 알리지 않음");
    const from = { x: (box.x + box.r) / 2, y: (box.y + box.b) / 2 };
    for (let i = 1; i <= 20; i++) await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x + (ab.x - from.x) * i / 20, y: from.y + (ab.y - from.y) * i / 20 });
    for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x: ab.x, y: ab.y, button: "left", clickCount: 1 });
    await waitFor(`!document.getElementById('composer').hidden && document.activeElement?.id === 'c-text' &&
      document.getElementById('c-to').textContent.includes('소스') && document.querySelector('#canvas .part[data-id="box-a"]').classList.contains('target')`);
    const pop = await evaluate(`(() => { const r = document.getElementById('composer').getBoundingClientRect(); return { x: r.left, y: r.top, r: r.right, b: r.bottom, w: innerWidth, h: innerHeight }; })()`);
    expect(pop.x >= 0 && pop.r <= pop.w && pop.y >= 0 && pop.b <= pop.h, `창이 화면 밖: ${JSON.stringify(pop)}`);
    expect(Math.abs(pop.y - (box.b + 6)) < 2 || pop.b <= box.y, `창이 상자 옆이 아님: 상자 ${JSON.stringify(box)}, 창 ${JSON.stringify(pop)}`);
    // 한글을 조합하는 중의 Enter 는 보내지 않는다
    await evaluate(`(() => { const t = document.getElementById('c-text'); t.value = '경계값부터 봐 주세요';
      t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })); })()`);
    await sleep(200);
    expect(await evaluate(`!document.getElementById('composer').hidden && document.getElementById('c-text').value === '경계값부터 봐 주세요'`), "조합 중 Enter 에 보냄");
    await key("Enter", "Enter", 13, "\r");
    await waitFor(`document.getElementById('composer').hidden &&
      [...document.querySelectorAll('#tl-body li')].some((li) => li.textContent.includes('화판 → Claude (의견 · box-a): 경계값부터 봐 주세요'))`);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });
  });
  await check("키보드: 상자·계획 단계에 초점을 두고 Enter 로 열고, Esc 로 닫으면 그 자리로 초점이 돌아옴", async () => {
    await evaluate(`document.querySelector('#canvas .part[data-id="box-b"]').focus()`);
    await waitFor(`!document.getElementById('ask').hidden`);
    await key("Enter", "Enter", 13, "\r");
    await waitFor(`!document.getElementById('composer').hidden && document.getElementById('c-to').textContent.includes('대상')`);
    // 쓰다 닫은 글은 그 받는 곳에만 남는다(다른 대상의 창에는 비어 있다)
    await evaluate(`(() => { const t = document.getElementById('c-text'); t.value = '상자 b 에 쓰던 글'; t.dispatchEvent(new Event('input')); })()`);
    await key("Escape", "Escape", 27);
    await waitFor(`document.getElementById('composer').hidden && document.activeElement?.dataset.id === 'box-b'`);
    await evaluate(`document.getElementById('compose').click()`);
    await waitFor(`!document.getElementById('composer').hidden && document.getElementById('c-text').value === ''`);
    await key("Escape", "Escape", 27);
    await evaluate(`document.querySelector('#canvas .part[data-id="box-b"]').focus()`);
    await key("Enter", "Enter", 13, "\r");
    await waitFor(`!document.getElementById('composer').hidden && document.getElementById('c-text').value === '상자 b 에 쓰던 글'`);
    await key("Escape", "Escape", 27);
    await waitFor(`document.getElementById('composer').hidden`);
    // 창이 열린 채로 다른 대상을 열면 그 대상으로 바뀐다
    await evaluate(`document.querySelector('#canvas .part[data-id="box-b"]').focus()`);
    await key("Enter", "Enter", 13, "\r");
    await waitFor(`!document.getElementById('composer').hidden && document.getElementById('c-to').textContent.includes('대상')`);
    await evaluate(`document.querySelector('#plan-body li[data-id="s2"]').focus()`);
    await key("Enter", "Enter", 13, "\r");
    await waitFor(`!document.getElementById('composer').hidden && document.getElementById('c-to').textContent.includes('단계 · 결과 검토')`);
    await key("Escape", "Escape", 27);
    await waitFor(`document.getElementById('composer').hidden && document.activeElement?.dataset.id === 's2'`);
  });
  await check("맨 위 「Claude 에 보내기」 는 지금 세션 전체로 열림(고르기 칸 없음)", async () => {
    await evaluate(`document.getElementById('compose').click()`);
    await waitFor(`!document.getElementById('composer').hidden && document.getElementById('c-to').textContent.endsWith('세션 전체') && !document.querySelector('#composer select')`);
    await key("Escape", "Escape", 27);
    await waitFor(`document.getElementById('composer').hidden && document.activeElement?.id === 'compose'`);
  });
  await check("세션 줄 ⋯ 「메시지 보내기…」: 보던 화면은 그대로 두고 그 세션에 보냄", async () => {
    const other = `other-${process.pid}`;
    await post("/api/hook", { sid: other, pid: process.pid + 7, fact: { f: "start", cwd: "/tmp/다른-세션", source: "startup" } });
    await post("/api/hook", { sid: other, pid: process.pid + 7, fact: { f: "prompt", text: "다른 세션의 일" } });
    await waitFor(`document.querySelector('#sess-body .smenu[data-sid="${other}"]') !== null`);
    await evaluate(`document.querySelector('#sess-body .smenu[data-sid="${other}"]').focus()`);
    await key("Enter", "Enter", 13, "\r");
    await waitFor(`!document.getElementById('group-menu').hidden && document.querySelector('#group-menu .gm-item')?.textContent === '메시지 보내기…'`);
    await evaluate(`document.querySelector('#group-menu .gm-item').click()`);
    await waitFor(`!document.getElementById('composer').hidden && document.getElementById('c-to').textContent.includes('다른 세션의 일 · 세션 전체')`);
    await evaluate(`document.getElementById('c-text').value = '다른 세션에 보내는 글'`);
    await key("Enter", "Enter", 13, "\r");
    await waitFor(`document.getElementById('composer').hidden && document.activeElement?.classList.contains('smenu')`);
    expect(await evaluate(`window.__atv.sid`) === sid, "보던 세션이 바뀜");
    const snap = await evaluate(`fetch('/api/sessions/${other}/snapshot').then((r) => r.json())`);
    const got = Object.values(snap.scene.msgs || {}).find((m) => m.text === "다른 세션에 보내는 글");
    expect(got && got.target === null && got.state === "queued", `그 세션에 들어가지 않음: ${JSON.stringify(snap.scene.msgs)}`);
    // 창이 열린 채로 다른 세션 줄을 누르면 창이 닫히고 그 세션으로 옮겨 간다
    await evaluate(`document.getElementById('compose').click()`);
    await waitFor(`!document.getElementById('composer').hidden`);
    await evaluate(`document.querySelector('#sess-body .sess[data-sid="${other}"]').click()`);
    await waitFor(`window.__atv.sid === '${other}' && document.getElementById('composer').hidden`);
    await evaluate(`document.querySelector('#sess-body .sess[data-sid="${sid}"]').click()`);
    await waitFor(`window.__atv.sid === '${sid}' && document.querySelectorAll('#canvas .part').length > 0`);
    await post("/api/hook", { sid: other, pid: process.pid + 7, fact: { f: "end", reason: "other" } });
  });
  await check("Codex 세션: 목록 줄·메뉴·보내기 창의 로고와 제목·안내가 받는 쪽으로 바뀜", async () => {
    const cx = `codex-${process.pid}`;
    const logoOf = (sel) => `document.querySelector(${JSON.stringify(sel)})?.querySelector('use')?.getAttribute('href')`;
    await post("/api/hook", { sid: cx, pid: process.pid + 9, fact: { f: "start", cwd: "/tmp/코덱스", source: "startup", via: "codex" } });
    await post("/api/hook", { sid: cx, pid: process.pid + 9, fact: { f: "prompt", text: "코덱스 세션의 일" } });
    await post("/api/hook", { sid: cx, pid: process.pid + 9, fact: { f: "stop", last: "" } });
    await waitFor(`${logoOf(`#sess-body .sess[data-sid="${cx}"] .row2 svg.logo`)} === '#logo-codex' &&
      document.querySelector('#sess-body .sess[data-sid="${cx}"] .row2 svg.logo').getAttribute('aria-label') === 'Codex' &&
      ${logoOf(`#sess-body .sess[data-sid="${sid}"] .row2 svg.logo`)} === '#logo-claude'`);
    await evaluate(`document.querySelector('#sess-body .smenu[data-sid="${cx}"]').click()`);
    await waitFor(`!document.getElementById('group-menu').hidden && document.querySelector('#group-menu .gm-item')?.textContent === '메시지 보내기…' && ${logoOf("#group-menu .gm-item")} === '#logo-codex'`);
    await evaluate(`document.querySelector('#group-menu .gm-item').click()`);
    await waitFor(`!document.getElementById('composer').hidden && document.querySelector('#composer h2').textContent === 'Codex 에 보내기' && ${logoOf("#composer h2")} === '#logo-codex' && document.getElementById('c-hint').textContent.includes('바로 깨웁니다')`);
    await key("Escape", "Escape", 27);
    await waitFor(`document.getElementById('composer').hidden`);
    // Claude 세션의 보내기 창은 제목이 다시 Claude 로 돌아온다
    expect(await evaluate(`${logoOf("#compose")} === '#logo-claude' && document.getElementById('compose').textContent === 'Claude 에 보내기'`), "맨 위 보내기 단추가 Claude 가 아님");
    await evaluate(`document.getElementById('compose').click()`);
    await waitFor(`!document.getElementById('composer').hidden && document.querySelector('#composer h2').textContent === 'Claude 에 보내기' && ${logoOf("#composer h2")} === '#logo-claude'`);
    await key("Escape", "Escape", 27);
    await waitFor(`document.getElementById('composer').hidden`);
    await post("/api/hook", { sid: cx, pid: process.pid + 9, fact: { f: "end", reason: "other" } });
  });

  await check("모아 보내기: 보내기 창의 「모아 두기」 로 상자·단계 글을 모으고, 아래 띠에서 빼기·한꺼번에 보내기, 다른 세션 글은 섞지 않음", async () => {
    const collect = async (focusSel, text) => {
      await evaluate(`document.querySelector(${JSON.stringify(focusSel)}).focus()`);
      await key("Enter", "Enter", 13, "\r");
      await waitFor(`!document.getElementById('composer').hidden`);
      await evaluate(`(() => { document.getElementById('c-text').value = ${JSON.stringify(text)}; document.getElementById('c-collect').click(); })()`);
      await waitFor(`document.getElementById('composer').hidden`);
    };
    await collect('#canvas .part[data-id="box-b"]', "모은 글 하나");
    await collect('#plan-body li[data-id="s2"]', "모은 글 둘");
    await collect('#canvas .part[data-id="box-a"]', "뺄 글");
    await waitFor(`!document.getElementById('basket').hidden && document.getElementById('b-sum').textContent.startsWith('모은 글 3개')`);
    // 다른 세션 글은 섞지 않는다
    const other = `basket-${process.pid}`;
    await post("/api/hook", { sid: other, pid: process.pid + 9, fact: { f: "start", cwd: "/tmp/모으기", source: "startup" } });
    await post("/api/hook", { sid: other, pid: process.pid + 9, fact: { f: "prompt", text: "다른 세션" } });
    await waitFor(`document.querySelector('#sess-body .smenu[data-sid="${other}"]') !== null`);
    await evaluate(`document.querySelector('#sess-body .smenu[data-sid="${other}"]').click()`);
    await waitFor(`!document.getElementById('group-menu').hidden`);
    await evaluate(`document.querySelector('#group-menu .gm-item').click()`);
    await waitFor(`!document.getElementById('composer').hidden && document.getElementById('c-to').textContent.includes('다른 세션')`);
    await evaluate(`(() => { document.getElementById('c-text').value = '섞이면 안 됨'; document.getElementById('c-collect').click(); })()`);
    await waitFor(`document.getElementById('toast').textContent.includes('다른 세션에 보낼 글이 모여 있습니다')`);
    expect(await evaluate(`document.getElementById('b-sum').textContent.startsWith('모은 글 3개')`), "다른 세션 글이 섞임");
    await key("Escape", "Escape", 27);
    await post("/api/hook", { sid: other, pid: process.pid + 9, fact: { f: "end", reason: "other" } });
    // 보기 → 셋째 줄 빼기 → 초점은 남은 마지막 줄의 빼기로
    await evaluate(`document.getElementById('b-view').click()`);
    await waitFor(`!document.getElementById('b-list').hidden && document.querySelectorAll('#b-list li').length === 3`);
    await evaluate(`document.querySelectorAll('#b-list li button')[2].focus(); document.querySelectorAll('#b-list li button')[2].click()`);
    await waitFor(`document.querySelectorAll('#b-list li').length === 2 && document.getElementById('b-sum').textContent.startsWith('모은 글 2개') && document.activeElement === document.querySelectorAll('#b-list li button')[1]`);
    const before = await evaluate(`window.__atv.seq`);
    await evaluate(`document.getElementById('b-send').click()`);
    await waitFor(`document.getElementById('basket').hidden && document.activeElement?.id === 'compose'`);
    const msgs = await evaluate(`Object.values(window.__atv.scene.msgs).filter((m) => m.text.startsWith('모은 글')).map((m) => [m.text, m.target?.id, m.state])`);
    expect(JSON.stringify(msgs) === JSON.stringify([["모은 글 하나", "box-b", "queued"], ["모은 글 둘", "s2", "queued"]]), JSON.stringify(msgs));
    expect(await evaluate(`window.__atv.seq`) === before + 1, "기록 한 줄로 들어가지 않음");
    expect(!(await evaluate(`Object.values(window.__atv.scene.msgs).some((m) => m.text === '뺄 글')`)), "뺀 글이 감");
    // 비우기는 두 번 눌러야
    await collect('#canvas .part[data-id="box-b"]', "비울 글");
    await evaluate(`document.getElementById('b-clear').click()`);
    expect(await evaluate(`!document.getElementById('basket').hidden && document.getElementById('b-clear').textContent.includes('한 번 더')`), "한 번에 비움");
    await evaluate(`document.getElementById('b-clear').click()`);
    await waitFor(`document.getElementById('basket').hidden`);
  });
  await check("보낸 글 수: 상자·단계에 ✉N(대기면 대기 색)이 보이고, 누르면 그 대상의 보내기 창이 열림", async () => {
    await waitFor(`(() => { const m = document.querySelector('#canvas .part[data-id="box-b"] .badge.mail'); return m && /^✉\\d+$/.test(m.textContent) && m.classList.contains('queued'); })()`);
    await waitFor(`!!document.querySelector('#plan-body li[data-id="s2"] .mail.queued')`);
    const n = await evaluate(`Object.values(window.__atv.scene.msgs).filter((m) => m.target?.id === 'box-b').length`);
    expect(await evaluate(`document.querySelector('#canvas .part[data-id="box-b"] .badge.mail').textContent`) === `✉${n}`, "수가 틀림");
    await evaluate(`document.querySelector('#canvas .part[data-id="box-b"] .badge.mail').click()`);
    await waitFor(`!document.getElementById('composer').hidden && document.querySelector('#canvas .part[data-id="box-b"]').classList.contains('target')`);
    await key("Escape", "Escape", 27);
    await evaluate(`document.querySelector('#plan-body li[data-id="s2"] .mail').click()`);
    await waitFor(`!document.getElementById('composer').hidden && document.getElementById('c-to').textContent.includes('단계 · 결과 검토')`);
    await key("Escape", "Escape", 27);
    await waitFor(`document.getElementById('composer').hidden`);
    return `box-b ✉${n}`;
  });

  await check("모아 보내기 실패·보내는 중: 하나도 넣지 않고 알림은 띠 위에 보이며 초점은 「한꺼번에 보내기」 로, 보내는 중인 글은 모으지 않음", async () => {
    await mcp("draw", { ops: [{ id: "gone-box", kind: "box", label: "곧 지울 상자" }] });
    await waitFor(`!!document.querySelector('#canvas .part[data-id="gone-box"]')`);
    await settledPositions();
    await evaluate(`document.querySelector('#canvas .part[data-id="gone-box"]').focus()`);
    await key("Enter", "Enter", 13, "\r");
    await waitFor(`!document.getElementById('composer').hidden`);
    await evaluate(`(() => { document.getElementById('c-text').value = '지워질 상자에'; document.getElementById('c-collect').click(); })()`);
    await waitFor(`!document.getElementById('basket').hidden`);
    await mcp("draw", { ops: [{ id: "gone-box", del: true }] });
    await waitFor(`!document.querySelector('#canvas .part[data-id="gone-box"]')`);
    const count = await evaluate(`Object.keys(window.__atv.scene.msgs).length`), logged = logErrors.length;
    // 좁은 창에서는 아래 가운데의 띠와 오른쪽 아래의 알림이 겹친다
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 700, height: 900, deviceScaleFactor: 1, mobile: false });
    let top;
    try {
      await evaluate(`document.getElementById('b-send').focus(); document.getElementById('b-send').click()`);
      await waitFor(`document.getElementById('toast').textContent.includes('1번째 글: 대상 gone-box 없음') && document.activeElement?.id === 'b-send'`);
      top = await evaluate(`(() => { const r = document.getElementById('toast').getBoundingClientRect(); return document.elementFromPoint(r.left + 4, (r.top + r.bottom) / 2)?.closest('#toast') !== null; })()`);
    } finally { await cdp.send("Emulation.clearDeviceMetricsOverride"); }
    // 일부러 낸 400 응답 한 건은 오류로 세지 않는다
    await sleep(100);
    const extra = logErrors.splice(logged), expected = extra.findIndex((t) => /status of 400/.test(t));
    if (expected >= 0) extra.splice(expected, 1);
    logErrors.push(...extra);
    expect(top, "알림이 띠에 가려짐");
    expect(await evaluate(`Object.keys(window.__atv.scene.msgs).length`) === count, "실패했는데 글이 들어감");
    await evaluate(`document.querySelector('#b-list li button') || document.getElementById('b-view').click()`);
    await evaluate(`document.querySelector('#b-list li button').click()`);
    await waitFor(`document.getElementById('basket').hidden`);
    // 보내는 요청을 늦춰 두고 그사이 「모아 두기」 를 눌러도 모으지 않는다
    await evaluate(`(() => { const real = window.fetch; window.__realFetch = real;
      window.fetch = (u, o) => (u === '/api/board' ? new Promise((ok) => setTimeout(() => ok(real(u, o)), 600)) : real(u, o)); })()`);
    await evaluate(`document.getElementById('compose').click()`);
    await waitFor(`!document.getElementById('composer').hidden`);
    await evaluate(`(() => { document.getElementById('c-text').value = '한 번만 갈 글'; document.getElementById('composer').requestSubmit(); document.getElementById('c-collect').click(); })()`);
    await waitFor(`document.getElementById('composer').hidden`);
    await evaluate(`window.fetch = window.__realFetch`);
    expect(await evaluate(`document.getElementById('basket').hidden`), "보내는 중인 글을 모음");
    expect(await evaluate(`Object.values(window.__atv.scene.msgs).filter((m) => m.text === '한 번만 갈 글').length`) === 1, "한 번 가지 않음");
  });

  await check("모은 글·초안 보존: 새로 고쳐도 남고, 다른 탭과 같이 보며, 보내는 사이 탭이 닫혀 다시 보내도 한 번만 들어감", async () => {
    const opened = (sel) => evaluate(`document.querySelector(${JSON.stringify(sel)}).focus()`).then(() => key("Enter", "Enter", 13, "\r"))
      .then(() => waitFor(`!document.getElementById('composer').hidden && document.activeElement?.id === 'c-text'`));
    const typed = async (text) => { await cdp.send("Input.insertText", { text }); await sleep(450); }; // 0.3초 뒤 저장
    for (const [sel, text] of [['#canvas .part[data-id="box-b"]', "보존 하나"], ['#plan-body li[data-id="s2"]', "보존 둘"]]) {
      await opened(sel);
      await typed(text);
      await evaluate(`document.getElementById('c-collect').click()`);
      await waitFor(`document.getElementById('composer').hidden`);
    }
    // 보내지 않고 쓰다 둔 글(지시로 바꿈)
    await opened('#canvas .part[data-id="box-a"]');
    await evaluate(`document.querySelector('input[name="c-kind"][value="instruction"]').click()`);
    await typed("쓰다 둔 글");
    await open(sid);
    await waitFor(`!document.getElementById('basket').hidden && document.getElementById('b-sum').textContent.startsWith('모은 글 2개')`);
    await settledPositions();
    await opened('#canvas .part[data-id="box-a"]');
    expect(await evaluate(`document.getElementById('c-text').value === '쓰다 둔 글' && document.querySelector('input[name="c-kind"]:checked').value === 'instruction'`), "초안이 돌아오지 않음");
    await key("Escape", "Escape", 27);
    await evaluate(`document.querySelector('input[name="c-kind"][value="comment"]').checked = true`);
    // 다른 탭: 같은 목록을 보고, 거기서 빼면 이 탭에도 반영된다
    await cdp.send("Runtime.evaluate", { userGesture: true, expression: `window.__other = window.open('/?keep=1#s=${sid}', '_blank')` });
    await waitFor(`window.__other.document?.getElementById('b-sum')?.textContent.startsWith('모은 글 2개')`, 10000);
    await evaluate(`(() => { const d = window.__other.document; d.getElementById('b-view').click(); d.querySelector('#b-list li button').click(); })()`);
    await waitFor(`document.getElementById('b-sum').textContent.startsWith('모은 글 1개')`);
    await evaluate(`window.__other.close()`);
    await cdp.send("Page.bringToFront");
    // 보내는 요청은 서버에 닿지만 응답을 받기 전에 탭이 닫힌다 → 다시 열어 보내도 한 번만 들어간다
    await evaluate(`(() => { const real = window.fetch; window.fetch = (u, o) => (u === '/api/board' ? (real(u, o), new Promise(() => {})) : real(u, o)); })()`);
    await evaluate(`document.getElementById('b-send').click()`);
    const kept = () => Object.values(board.sessions.get(sid).scene.msgs).filter((m) => m.text === "보존 둘").length;
    for (let i = 0; i < 100 && kept() === 0; i++) await sleep(20);
    expect(kept() === 1, "서버에 닿지 않음");
    await open(sid);
    await waitFor(`!document.getElementById('basket').hidden && document.getElementById('b-sum').textContent.startsWith('모은 글 1개')`);
    await evaluate(`document.getElementById('b-send').click()`);
    await waitFor(`document.getElementById('basket').hidden`);
    expect(kept() === 1, `두 번 들어감: ${kept()}`);
    // 저장이 막히면 띠에 알린다
    await evaluate(`(() => { window.__setItem = Storage.prototype.setItem; Storage.prototype.setItem = function () { throw new Error('막힘'); }; })()`);
    await opened('#canvas .part[data-id="box-b"]');
    await typed("저장 안 되는 글");
    await evaluate(`document.getElementById('c-collect').click()`);
    await waitFor(`document.getElementById('b-sum').textContent.includes('저장되지 않음')`);
    await evaluate(`Storage.prototype.setItem = window.__setItem`);
    await evaluate(`document.getElementById('b-clear').click(); document.getElementById('b-clear').click()`);
    await waitFor(`document.getElementById('basket').hidden`);
    // 쓰다 둔 글은 지워 둔다(뒤 검사의 보내기 창이 비어 있게)
    await opened('#canvas .part[data-id="box-a"]');
    await evaluate(`(() => { const t = document.getElementById('c-text'); t.value = ''; t.dispatchEvent(new Event('input')); })()`);
    await key("Escape", "Escape", 27);
  });

  await check("저장 경합: 깨진 저장값은 덮지 않고, 저장이 막혀도 모은 글이 남았다가 풀리면 함께 쓰이며, 같은 번호의 고친 글은 따로 모이고, 번호 충돌은 거절된 쪽만 바꿈", async () => {
    const store = (v) => evaluate(`localStorage.setItem('atv.compose', ${JSON.stringify(JSON.stringify(v))})`);
    const stored = () => evaluate(`JSON.parse(localStorage.getItem('atv.compose'))`);
    const opened = (sel) => evaluate(`document.querySelector(${JSON.stringify(sel)}).focus()`).then(() => key("Enter", "Enter", 13, "\r"))
      .then(() => waitFor(`!document.getElementById('composer').hidden && document.activeElement?.id === 'c-text'`));
    const collectText = async (sel, text) => {
      await opened(sel);
      await evaluate(`(() => { const t = document.getElementById('c-text'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input')); document.getElementById('c-collect').click(); })()`);
      await waitFor(`document.getElementById('composer').hidden`);
    };
    // 받는 곳 없는 모은 글(깨진 값): 화면은 돌고, 그 값은 덮지 않는다
    const broken = { v: 1, basket: { items: [{ cid: "brok0000-0000", kind: "comment", text: "받는 곳 없음" }] } };
    await store(broken);
    await open(sid);
    await settledPositions();
    await collectText('#canvas .part[data-id="box-b"]', "깨진 값 위에서");
    await waitFor(`document.getElementById('b-sum').textContent.includes('저장되지 않음')`);
    expect(JSON.stringify(await stored()) === JSON.stringify(broken), "깨진 값을 덮어씀");
    await evaluate(`localStorage.removeItem('atv.compose')`);
    await open(sid);
    await settledPositions();
    // 저장이 막힌 동안 모은 두 글은 남았다가, 풀린 뒤의 셋째와 함께 쓰인다
    await evaluate(`(() => { window.__setItem = Storage.prototype.setItem; Storage.prototype.setItem = function () { throw new Error('막힘'); }; })()`);
    await collectText('#canvas .part[data-id="box-b"]', "막힘 하나");
    await collectText('#plan-body li[data-id="s2"]', "막힘 둘");
    await waitFor(`document.getElementById('b-sum').textContent.startsWith('모은 글 2개')`);
    await evaluate(`Storage.prototype.setItem = window.__setItem`);
    await collectText('#canvas .part[data-id="box-a"]', "풀린 뒤 셋");
    await waitFor(`!document.getElementById('b-sum').textContent.includes('저장되지 않음') && JSON.parse(localStorage.getItem('atv.compose')).basket.items.length === 3`);
    expect((await stored()).basket.items.map((x) => x.text).join("/") === "막힘 하나/막힘 둘/풀린 뒤 셋", JSON.stringify((await stored()).basket));
    // 같은 번호로 모은 글이 있는데 그 초안을 고쳐 모으면 새 번호로 따로 둔다
    const X = "same0000-0000-4000-8000-000000000001";
    await store({ v: 1, basket: { sid, items: [{ cid: X, kind: "comment", text: "처음 글", target: "box-b", name: "대상", t: 1 }] }, drafts: { [`${sid} box-b`]: { cid: X, kind: "comment", text: "고친 글", t: 2 } } });
    await open(sid);
    await settledPositions();
    await opened('#canvas .part[data-id="box-b"]');
    expect(await evaluate(`document.getElementById('c-text').value`) === "고친 글", "초안이 돌아오지 않음");
    await evaluate(`document.getElementById('c-collect').click()`);
    await waitFor(`document.getElementById('b-sum').textContent.startsWith('모은 글 2개')`);
    // 화면은 메모리를 먼저 고치고 저장은 잠금 안에서 뒤따르므로 저장값이 바뀔 때까지 기다린다
    await waitFor(`JSON.parse(localStorage.getItem('atv.compose')).basket.items.length === 2`);
    const two = (await stored()).basket.items;
    expect(two[0].cid === X && two[1].cid !== X && two[1].text === "고친 글", JSON.stringify(two));
    // 서버가 「처음 글」 을 X 로 받은 뒤(응답은 못 받음), 같은 X 의 다른 초안을 하나로 보내면 거절되고 그 초안만 번호가 바뀐다
    await evaluate(`fetch('/api/board', { method: 'POST', headers: { 'content-type': 'application/json', 'x-atv-board': localStorage.getItem('atv.w') }, body: JSON.stringify({ op: 'send', sid: ${JSON.stringify(sid)}, items: [{ cid: ${JSON.stringify(X)}, kind: 'comment', text: '처음 글', target: 'box-b' }] }) }).then((r) => r.status)`);
    const logged = logErrors.length;
    await evaluate(`(() => { const d = JSON.parse(localStorage.getItem('atv.compose')); d.drafts[${JSON.stringify(sid + " box-a")}] = { cid: ${JSON.stringify(X)}, kind: 'comment', text: '세 번째 글', t: 3 }; localStorage.setItem('atv.compose', JSON.stringify(d)); })()`);
    await opened('#canvas .part[data-id="box-a"]');
    await key("Enter", "Enter", 13, "\r");
    await waitFor(`document.getElementById('toast').textContent.includes('새 글로 바꿨습니다')`);
    await sleep(200);
    const extra = logErrors.splice(logged), expected = extra.findIndex((t) => /status of 400/.test(t));
    if (expected >= 0) extra.splice(expected, 1);
    logErrors.push(...extra);
    await waitFor(`(JSON.parse(localStorage.getItem('atv.compose')).drafts[${JSON.stringify(sid + " box-a")}]?.cid || ${JSON.stringify(X)}) !== ${JSON.stringify(X)}`);
    const after = await stored();
    expect(after.basket.items[0].cid === X, "이미 보낸 쪽(모은 글)의 번호까지 바뀜");
    expect(after.drafts[`${sid} box-a`]?.cid && after.drafts[`${sid} box-a`].cid !== X, "거절된 초안의 번호가 그대로");
    await key("Escape", "Escape", 27);
    // 모은 글을 보내면 「처음 글」 은 이미 받은 것이라 한 번만 들어간다
    await evaluate(`document.getElementById('b-send').click()`);
    await waitFor(`document.getElementById('basket').hidden`);
    const count = (text) => Object.values(board.sessions.get(sid).scene.msgs).filter((m) => m.text === text).length;
    expect(count("처음 글") === 1 && count("고친 글") === 1, `처음 ${count("처음 글")} · 고친 ${count("고친 글")}`);
    // 세 번째 글은 새 번호로 보내진다
    await opened('#canvas .part[data-id="box-a"]');
    await key("Enter", "Enter", 13, "\r");
    await waitFor(`document.getElementById('composer').hidden`);
    expect(count("세 번째 글") === 1, "세 번째 글이 가지 않음");
  });

  await check("도움말: 단추와 ? 키로 열리고 Esc 로 닫힘", async () => {
    await evaluate(`document.getElementById('help-open').click()`);
    await waitFor(`document.getElementById('help').open`);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await waitFor(`!document.getElementById('help').open`);
    await evaluate(`document.body.focus()`);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "?", code: "Slash", text: "?", modifiers: 8 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "?", code: "Slash", modifiers: 8 });
    await waitFor(`document.getElementById('help').open`);
    await evaluate(`document.getElementById('help-close').click()`);
    await waitFor(`!document.getElementById('help').open`);
  });

  // 아래 세 가지는 새 세션을 쓰므로 끝나면 처음 세션으로 돌아간다
  const hookAs = (s, fact, pid) => post("/api/hook", { sid: s, pid, fact });


  await check("묶음과 사슬이 있는 그림을 칸 모양에 가깝게 놓고(가로 띠도 세로 줄도 아님), 묶음을 넘는 선까지 모두 그리며, 상자의 ref 는 파일 이름:줄만 보임", async () => {
    // 실제 세션이 그린 모양(이름만 바꿈): 묶음 둘 안팎으로 상자 6개가 한 줄로 이어진다(dir RIGHT)
    const chain = `chain-${process.pid}`;
    await post("/api/mcp", { env: chain, cwd, tool: "draw", input: { dir: "RIGHT", ops: [
      { id: "key", kind: "box", label: "물리 버튼 입력", note: "BTN_A·B·C·D 누름/뗌" },
      { id: "bsp", kind: "group", label: "플랫폼 (바꾸지 않음)" },
      { id: "pwm", kind: "box", in: "bsp", label: "InputDispatcher 큐 넣기 전", note: "intercept 다음 키 코드로 분기", ref: "/home/u/src/platform/frameworks/base/services/core/java/com/example/input/InputDispatcher.java:5045" },
      { id: "hsk", kind: "box", in: "bsp", label: "Legacy.handleButton → 옛 경로", note: "키 코드가 BTN_* 일 때만" },
      { id: "svc", kind: "group", label: "device service (s1)" },
      { id: "hij", kind: "box", in: "svc", label: "KeyRouter.routeKey", note: "키 재정의 → [새 버튼 훅] → 여러 키" },
      { id: "hook", kind: "box", in: "svc", label: "새 훅 (D4)", note: "기능 켜짐 + 재정의 없는 버튼 → 제어 큐로 넘김" },
      { id: "mgr", kind: "box", in: "svc", label: "ActionManager", note: "키 시작·멈춤과 모드별 누름·뗌을 더할 곳" },
      { id: "cam", kind: "box", in: "svc", label: "PreviewControl", note: "뗌 동작의 '결과 없이 미리 보기만' 기능이 없음" },
      { id: "app", kind: "box", label: "앞 화면 앱", note: "전달 단계는 캐시로 BTN_A 그대로 받음" },
      { id: "e1", kind: "edge", from: "key", to: "pwm" }, { id: "e2", kind: "edge", from: "pwm", to: "hij", label: "1. 먼저 호출" },
      { id: "e3", kind: "edge", from: "hij", to: "hook" }, { id: "e4", kind: "edge", from: "hook", to: "mgr", label: "시작·멈춤" },
      { id: "e5", kind: "edge", from: "mgr", to: "cam" }, { id: "e6", kind: "edge", from: "pwm", to: "hsk", label: "2. 키 코드가 그대로면" },
      { id: "e7", kind: "edge", from: "pwm", to: "app", label: "전달" },
    ] } });
    await open(chain);
    await waitFor(`document.querySelector('.part[data-id="cam"]') !== null && document.getElementById('canvas').offsetWidth > 0`);
    await sleep(300);
    const m = await evaluate(`(() => {
      const c = document.getElementById('canvas'), s = document.getElementById('canvas-scroll');
      return { w: c.offsetWidth, h: c.offsetHeight, vw: s.clientWidth - 32, vh: s.clientHeight - 32, ref: document.querySelector('.part[data-id="pwm"] .ref').textContent, tip: document.querySelector('.part[data-id="pwm"]').title,
        edges: [...document.querySelectorAll('#canvas svg path[data-id]')].map((p) => p.dataset.id).sort() };
    })()`);
    const ratio = m.w / m.h, rel = ratio / (m.vw / m.vh);
    expect(rel > 0.6 && rel < 2.5, `그림 가로:세로 ${ratio.toFixed(2)}, 칸 ${(m.vw / m.vh).toFixed(2)}(칸 ${m.vw}×${m.vh}, 그림 ${m.w}×${m.h})`);
    expect(JSON.stringify(m.edges) === JSON.stringify(["e1", "e2", "e3", "e4", "e5", "e6", "e7"]), `그린 선: ${m.edges.join(",")}`);
    expect(m.ref === "InputDispatcher.java:5045", `ref 표시: ${m.ref}`);
    expect(m.tip.includes("/frameworks/base/"), "툴팁에 전체 경로가 없습니다");
    // 배율을 줄여 둔 화면에서도 띠로 돌아가지 않는다(구조가 바뀌어 다시 배치할 때)
    for (let i = 0; i < 5; i++) await evaluate(`document.getElementById('zoom-out').click()`); // 가장 작은 40% 까지
    await post("/api/mcp", { env: chain, cwd, tool: "draw", input: { ops: [{ id: "extra", kind: "box", in: "svc", label: "추가 상자" }] } });
    await waitFor(`document.querySelector('.part[data-id="extra"]') !== null`);
    await sleep(300);
    const z = await evaluate(`({ w: document.getElementById('canvas').offsetWidth, h: document.getElementById('canvas').offsetHeight, zoom: document.getElementById('zoom-label').textContent })`);
    await evaluate(`document.getElementById('zoom-100').click()`);
    const zrel = (z.w / z.h) / (m.vw / m.vh);
    expect(zrel > 0.6 && zrel < 2.5, `배율 ${z.zoom} 에서 가로:세로 ${(z.w / z.h).toFixed(2)}`);
    return `그림 ${m.w}×${m.h}(가로:세로 ${ratio.toFixed(2)}), 칸 ${m.vw}×${m.vh}, 배율 ${z.zoom} 에서 ${(z.w / z.h).toFixed(2)}, 선 7개`;
  });

  await check("선이 없는 그림(묶음 둘에 상자 열둘)을 한 줄로 늘어놓지 않고 칸에 채워 넣음", async () => {
    const loose = `loose-${process.pid}`, ops = [{ id: "ga", kind: "group", label: "바로 할 일" }, { id: "gb", kind: "group", label: "결정 필요" }];
    for (let i = 0; i < 12; i++) ops.push({ id: `b${i}`, kind: "box", in: i < 7 ? "ga" : "gb", label: `상자 ${i}`, note: "짧은 설명 한 줄" });
    await post("/api/mcp", { env: loose, cwd, tool: "draw", input: { dir: "DOWN", ops } });
    await open(loose);
    await waitFor(`document.querySelectorAll('#canvas .part.box').length === 12`);
    await sleep(300);
    const m = await evaluate(`(() => { const c = document.getElementById('canvas'), s = document.getElementById('canvas-scroll'); return { w: c.offsetWidth, h: c.offsetHeight, vw: s.clientWidth - 32, vh: s.clientHeight - 32 }; })()`);
    const rel = (m.w / m.h) / (m.vw / m.vh);
    expect(rel > 0.5 && rel < 2, `그림 ${m.w}×${m.h}, 칸 ${m.vw}×${m.vh}`);
    expect(m.w <= m.vw && m.h <= m.vh, `칸에 다 들어가지 않음: 그림 ${m.w}×${m.h}, 칸 ${m.vw}×${m.vh}`);
    return `그림 ${m.w}×${m.h}(가로:세로 ${(m.w / m.h).toFixed(2)}), 칸 ${m.vw}×${m.vh}`;
  });

  await check("묶음을 넘는 선의 긴 이름표도 그림 안에 다 보임(왼쪽·위로 잘리지 않음)", async () => {
    const lab = `label-${process.pid}`, text = "아주 긴 이름표: 묶음 안의 상자에서 바깥 상자로 가는 선이 화면 왼쪽으로 잘리지 않는지 봅니다";
    await post("/api/mcp", { env: lab, cwd, tool: "draw", input: { ops: [
      { id: "g", kind: "group", label: "안" }, { id: "a", kind: "box", in: "g", label: "A" }, { id: "a2", kind: "box", in: "g", label: "A2" },
      { id: "b", kind: "box", label: "B" }, { id: "ab", kind: "edge", from: "a", to: "b", label: text }, { id: "aa", kind: "edge", from: "a", to: "a2" },
    ] } });
    await open(lab);
    await waitFor(`[...document.querySelectorAll('#canvas .elabel')].some((l) => l.textContent.startsWith('아주 긴'))`);
    await sleep(300);
    const m = await evaluate(`(() => { const c = document.getElementById('canvas'), l = [...document.querySelectorAll('#canvas .elabel')].find((x) => x.textContent.startsWith('아주 긴'));
      return { left: l.offsetLeft, top: l.offsetTop, right: l.offsetLeft + l.offsetWidth, bottom: l.offsetTop + l.offsetHeight, w: c.offsetWidth, h: c.offsetHeight }; })()`);
    expect(m.left >= 0 && m.top >= 0 && m.right <= m.w + 1 && m.bottom <= m.h + 1, JSON.stringify(m));
    return `이름표 ${m.left}~${m.right}, 그림 폭 ${m.w}`;
  });

  await check("모두 같은 크기로 들어가면 직접 그린 직선이 다른 상자를 지나지 않는 배치를 고름", async () => {
    // 02 세션이 그린 모양: 묶음 셋을 잇는 선 가운데 둘이 같은 묶음의 두 상자에서 나온다(섞기에서 한 선이 옆 상자를 지났다)
    const id = `cross-${process.pid}`;
    await post("/api/mcp", { env: id, cwd, tool: "draw", input: { ops: [
      { id: "cc", kind: "group", label: "Claude Code 쪽" },
      { id: "mcp", kind: "box", label: "MCP 서버(plan·draw·note·ids)", in: "cc", ref: "/w/mcp/server.js" },
      { id: "hook", kind: "box", label: "훅(사실 자동 수집)", in: "cc", ref: "/w/hook/hook.js" },
      { id: "bd", kind: "group", label: "화판 서버 127.0.0.1:4871" },
      { id: "srv", kind: "box", label: "서버·기록·짝짓기", in: "bd", ref: "/w/lib/server.js" },
      { id: "scene", kind: "box", label: "장면 모델(검사·결과)", in: "bd", ref: "/w/lib/scene.js" },
      { id: "web", kind: "group", label: "브라우저" },
      { id: "app", kind: "box", label: "화면(계획·타임라인)", in: "web", ref: "/w/web/app.js" },
      { id: "canvas", kind: "box", label: "그림(ELK 배치)", in: "web", ref: "/w/web/canvas.js" },
      { id: "e1", kind: "edge", from: "mcp", to: "srv", label: "명령" }, { id: "e2", kind: "edge", from: "hook", to: "srv", label: "사실" },
      { id: "e3", kind: "edge", from: "srv", to: "scene" }, { id: "e4", kind: "edge", from: "srv", to: "app", label: "SSE" },
      { id: "e5", kind: "edge", from: "app", to: "canvas" },
      { id: "chk", kind: "list", label: "사용자 확인 항목(언제든)" },
      ...["/clear 뒤 새 화판에 그려지는가", "압축 뒤 이름표가 맥락에 들어가는가", "/context 의 MCP 도구 토큰", "--continue 뒤 같은 화판"].map((label, i) => ({ id: `c${i}`, kind: "item", in: "chk", label })),
      { id: "rv", kind: "group", label: "최종 검토(Fable 5.1)" },
      { id: "rvA", kind: "box", label: "검토자 A: 정확성(순서·재생·배치)", in: "rv" }, { id: "rvB", kind: "box", label: "검토자 B: 보안·훅 견고성", in: "rv" },
      { id: "rvJ", kind: "box", label: "판정(주 세션)" }, { id: "e6", kind: "edge", from: "rvA", to: "rvJ" }, { id: "e7", kind: "edge", from: "rvB", to: "rvJ" },
    ] } });
    await open(id);
    await settledPositions();
    const crossed = await evaluate(`(() => {
      const boxes = [...document.querySelectorAll('#canvas .part:not(.group)')].map((e) => ({ id: e.dataset.id, x: e.offsetLeft + 3, y: e.offsetTop + 3, X: e.offsetLeft + e.offsetWidth - 3, Y: e.offsetTop + e.offsetHeight - 3 }));
      const items = window.__atv.scene.items, out = [];
      for (const path of document.querySelectorAll('#canvas svg.edges path[data-id]')) {
        const pts = path.getAttribute('d').match(/-?[\\d.]+,-?[\\d.]+/g).map((t) => t.split(',').map(Number));
        const ed = items[path.dataset.id];
        for (let i = 1; i < pts.length; i++) {
          const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
          for (const b of boxes) {
            if (b.id === ed.from || b.id === ed.to) continue;
            let t0 = 0, t1 = 1, ok = true;
            for (const [o, d, lo, hi] of [[ax, bx - ax, b.x, b.X], [ay, by - ay, b.y, b.Y]]) {
              if (!d) { if (o <= lo || o >= hi) ok = false; continue; }
              let u = (lo - o) / d, v = (hi - o) / d;
              if (u > v) [u, v] = [v, u];
              t0 = Math.max(t0, u); t1 = Math.min(t1, v);
            }
            if (ok && t0 < t1) out.push(path.dataset.id + '→' + b.id);
          }
        }
      }
      return out;
    })()`);
    expect(!crossed.length, `상자를 지나는 선: ${crossed.join(", ")}`);
  });
  await check("배치를 재는 사이 구조가 되돌아가거나 상태가 바뀌어도 마지막 장면대로 그림", async () => {
    await open(sid);
    await settledPositions();
    const tag = `rv${process.pid}`;
    // 구조를 바꿨다가(상자 + 선) 배치가 끝나기 전에 되돌린다. 재던 배치가 끝나도 되돌린 장면이어야 한다
    await mcp("draw", { ops: [{ id: `${tag}p`, kind: "box", label: "잠깐 생긴 상자" }, { id: `${tag}e`, kind: "edge", from: "box-a", to: `${tag}p` }] });
    await sleep(30);
    await mcp("draw", { ops: [{ id: `${tag}p`, del: true }] });
    await settledPositions();
    await sleep(300);
    const left = await evaluate(`[!!document.querySelector('#canvas .part[data-id="${tag}p"]'), !!document.querySelector('#canvas svg.edges path[data-id="${tag}e"]')]`);
    expect(!left[0] && !left[1], `되돌린 부품이 남음: 상자 ${left[0]}, 선 ${left[1]}`);
    // 새 Mermaid(그리는 동안 기다림)와 함께 구조를 바꾸고, 그사이 상자 상태를 바꾼다. 늦게 끝난 꾸미기가 옛 상태로 덮지 않아야 한다
    await mcp("draw", { ops: [{ id: `${tag}m`, kind: "mermaid", src: `graph LR; ${tag}a-->${tag}b` }, { id: `${tag}s`, kind: "box", label: "상태 시험", status: "todo" }] });
    await sleep(20);
    await mcp("draw", { ops: [{ id: `${tag}s`, status: "done" }] });
    await settledPositions();
    await sleep(300);
    const cls = await evaluate(`document.querySelector('#canvas .part[data-id="${tag}s"]')?.className || ''`);
    expect(/st-done/.test(cls), `상태가 옛것: ${cls}`);
    return "되돌림·상태 모두 마지막 장면";
  });
  await check("같은 탭에서 여러 번 새로 열어도 화판이 뜸(옛 문서의 SSE 가 브라우저 연결 6개를 차지하지 않음)", async () => {
    for (let i = 0; i < 7; i++) await open(sid);
    return "7번";
  });
  await check("탭·새 창 여덟 개가 연결 하나를 나눠 쓰며 각자 보는 세션의 변경을 모두 받음(SharedWorker 가 없으면 탭마다 연결)", async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `tab${i}-${process.pid}`);
    for (const [i, id] of ids.entries()) await post("/api/hook", { sid: id, pid: process.pid + 20 + i, fact: { f: "start", cwd: "/tmp/탭", source: "startup" } });
    // 사용자 동작 한 번에 새 창은 하나만 열린다
    await evaluate(`window.__wins = []`);
    for (const id of ids) {
      const opened = await cdp.send("Runtime.evaluate", { userGesture: true, returnByValue: true, expression: `!!window.__wins[window.__wins.push(window.open('/?tab=${id}#s=${id}', '_blank')) - 1]` });
      expect(opened.result.value, `새 창을 열지 못함: ${id}`);
    }
    await waitFor(`window.__wins.every((w, i) => w.__atv?.sid === ${JSON.stringify(ids)}[i] && w.__atv.snapped)`, 10000);
    for (const [i, id] of ids.entries()) await post("/api/mcp", { env: id, cwd, tool: "plan", input: { steps: [{ id: "t", title: `탭 ${i}` }] } });
    await waitFor(`window.__wins.every((w, i) => w.__atv.scene.items.t?.title === '탭 ' + i)`, 10000);
    // 이 탭과 새 창 여덟 개가 연결 하나(그사이 닫힌 옛 연결이 잠깐 남을 수 있어 둘까지 본다)
    const conns = board.listeners;
    expect(conns <= 2, `서버 연결 ${conns}개`);
    // 다른 창이 열린 채로(worker 가 살아 있는 채로) 이 탭을 새로 열어도 목록과 그림을 받는다. 새 창이 앞에 있으면 이 탭은
    // 숨은 탭이라 그리기(requestAnimationFrame)가 멈추므로 앞으로 가져온다
    await cdp.send("Page.bringToFront");
    await open(sid);
    await settledPositions().catch(async (e) => { throw new Error(`다른 창이 열린 채 새로 연 탭: ${e.message} · ${await evaluate(`JSON.stringify({ vis: document.visibilityState, sid: window.__atv.sid, snapped: window.__atv.snapped, seq: window.__atv.seq, sessions: window.__atv.sessions.size, parts: document.querySelectorAll('#canvas .part').length })`)}`); });
    expect(await evaluate(`document.querySelectorAll('#sess-body .sess').length > 0`), "목록이 비었음");
    // 새 문서라 창 손잡이가 사라졌으므로 DevTools 로 닫는다
    for (const t of (await cdp.send("Target.getTargets")).targetInfos) if (t.type === "page" && t.url.includes("?tab=")) await cdp.send("Target.closeTarget", { targetId: t.targetId });
    // SharedWorker 가 없는 브라우저(이 탭에서 흉내, 새 문서 스크립트가 지운다)는 탭마다 연결해도 같게 돈다
    const v = ++visits;
    await cdp.send("Page.navigate", { url: `${base}/?nohub=${v}#s=${ids[0]}` });
    await waitFor(`location.search === '?nohub=${v}' && typeof SharedWorker === 'undefined' && window.__atv?.sid === '${ids[0]}' && window.__atv.snapped`, 10000);
    await post("/api/mcp", { env: ids[0], cwd, tool: "plan", input: { steps: [{ id: "t", status: "done" }] } });
    await waitFor(`window.__atv.scene.items.t?.status === 'done'`);
    for (const [i, id] of ids.entries()) await post("/api/hook", { sid: id, pid: process.pid + 20 + i, fact: { f: "end", reason: "other" } });
    await open(sid);
    return `여덟 창 + 이 탭의 서버 연결 ${conns}개, SharedWorker 없이도 갱신됨`;
  });
  await check("구조가 같은 사건이 잦아도 재고 있는 배치를 새로 시작하지 않음(ELK 후보 한 벌)", async () => {
    await open(sid);
    await settledPositions();
    await evaluate(`(() => {
      window.__lay = { calls: 0 };
      if (window.__layWrapped) return;
      const orig = window.ELK.prototype.layout;
      window.ELK.prototype.layout = function (...a) { window.__lay.calls++; return orig.apply(this, a); };
      window.__layWrapped = true;
    })()`);
    await mcp("draw", { ops: [{ id: `burst-${process.pid}`, kind: "box", label: "잦은 사건 시험" }] });
    for (let i = 0; i < 20; i++) { await hook({ f: "run-start", id: `burst-${i}`, cmd: "true" }); await sleep(20); }
    for (let i = 0; i < 20; i++) await hook({ f: "run-end", id: `burst-${i}`, cmd: "true" });
    await settledPositions();
    const calls = await evaluate(`window.__lay.calls`);
    expect(calls > 0 && calls <= 6, `ELK 호출 ${calls}번(후보 6개 한 벌이어야 함)`);
    return `ELK 호출 ${calls}번`;
  });
  await check("이어진 대화: /clear 로 이어진 세션은 목록에 한 줄이고 ◀ ▶ 로 오가며, 입력도 그림도 없이 끝난 세션은 숨김", async () => {
    const pid = process.pid, t1 = `thread-a-${pid}`, t2 = `thread-b-${pid}`, gone = `cli-${pid}`;
    await hookAs(t1, { f: "start", cwd, source: "startup" }, pid);
    await hookAs(t1, { f: "prompt", text: "첫 대화" }, pid);
    await sleep(5);
    await hookAs(t2, { f: "start", cwd, source: "clear" }, pid);
    await hookAs(t2, { f: "prompt", text: "둘째 대화" }, pid);
    await hookAs(gone, { f: "start", cwd: `/tmp/cli-${pid}`, source: "startup" }, pid + 1); // 목록에 보이면 폴더 이름으로 드러난다
    await hookAs(gone, { f: "end", reason: "other" }, pid + 1);
    await open(t2);
    await waitFor(`!document.getElementById('thread-nav').hidden && document.getElementById('thread-pos').textContent === '대화 2/2'`);
    const rows = await evaluate(`[...document.querySelectorAll('#sess-body .sess')].map((b) => b.textContent)`);
    expect(rows.filter((r) => r.includes("둘째 대화") || r.includes("첫 대화")).length === 1, `이어진 대화가 한 줄이 아님: ${JSON.stringify(rows)}`);
    expect(rows.some((r) => r.includes("대화 2")), "줄에 대화 수가 없습니다");
    const ids = await evaluate(`[...window.__atv.sessions.keys()]`);
    expect(ids.includes(gone), "빈 세션 요약이 오지 않았습니다");
    expect(!rows.some((r) => r.includes(`cli-${pid}`)), "빈 세션이 목록에 보입니다");
    await evaluate(`document.getElementById('thread-prev').click()`);
    await waitFor(`window.__atv.sid === ${JSON.stringify(t1)} && document.getElementById('thread-pos').textContent === '대화 1/2' && document.getElementById('thread-prev').disabled`);
    return `줄 ${rows.length}개`;
  });
  await check("지우기: 진행 중인 줄은 꺼져 있고, 끝난 줄은 ⋯ 메뉴에서 두 번 눌러야 지워지며 보던 대화가 지워지면 다른 대화로 옮겨 감", async () => {
    const pid = process.pid, t1 = `thread-a-${pid}`, t2 = `thread-b-${pid}`;
    const menuOf = (id) => `document.querySelector('#sess-body .smenu[data-sid="${id}"]')`;
    await evaluate(`${menuOf(sid)}.focus()`);
    await key("Enter", "Enter", 13, "\r");
    await waitFor(`!document.getElementById('group-menu').hidden && document.querySelector('#group-menu .gm-del')?.getAttribute('aria-disabled') === 'true'`);
    await evaluate(`document.querySelector('#group-menu .gm-del').focus()`);
    await key("ArrowUp", "ArrowUp", 38);
    await waitFor(`document.activeElement?.textContent === '새 프로젝트…'`); // 꺼진 항목에서도 방향키가 막히지 않는다
    await key("Escape", "Escape", 27);
    await hookAs(t1, { f: "end", reason: "clear" }, pid);
    await hookAs(t2, { f: "end", reason: "other" }, pid);
    // 두 대화의 「끝」 이 화면에 온 뒤에 메뉴를 연다(그 전에 열면 「지우기」 가 꺼진 채로 만들어진다). 줄의 대표는 나중 대화
    await waitFor(`window.__atv.sid === ${JSON.stringify(t1)} && ${menuOf(t2)} != null && [${JSON.stringify(t1)}, ${JSON.stringify(t2)}].every((id) => window.__atv.sessions.get(id)?.status === 'ended')`);
    await evaluate(`${menuOf(t2)}.focus()`);
    await key("Enter", "Enter", 13, "\r");
    await waitFor(`!document.getElementById('group-menu').hidden && document.querySelector('#group-menu .gm-del')?.textContent === '지우기' && !document.querySelector('#group-menu .gm-del').hasAttribute('aria-disabled')`);
    expect(await evaluate(`document.querySelector('#group-menu .gm-item').getAttribute('aria-disabled') === 'true'`), "끝난 줄의 「메시지 보내기…」 가 켜져 있음");
    await evaluate(`document.querySelector('#group-menu .gm-del').focus()`);
    await key("Enter", "Enter", 13, "\r");
    await waitFor(`document.querySelector('#group-menu .gm-del')?.textContent === '한 번 더 누르면 지웁니다(대화 2개)' && window.__atv.sessions.has(${JSON.stringify(t1)})`);
    await key("Enter", "Enter", 13, "\r");
    // 보던 대화가 지워지면 새 연결의 목록을 받아 다시 그린다. 그 뒤에는 지운 줄이 없고 초점은 세션 줄에 있다
    await waitFor(`!window.__atv.sessions.has(${JSON.stringify(t1)}) && !window.__atv.sessions.has(${JSON.stringify(t2)}) && window.__atv.sid !== ${JSON.stringify(t1)}
      && ![...document.querySelectorAll('#sess-body .sess')].some((b) => b.textContent.includes('둘째 대화')) && document.activeElement?.classList.contains('sess')`);
    const rows = await evaluate(`[...document.querySelectorAll('#sess-body .sess')].map((b) => b.textContent)`);
    expect(fs.readdirSync(path.join(home, "trash")).length === 2, "휴지통에 기록이 없습니다");
    return `남은 줄 ${rows.length}개`;
  });
  await open(sid);

  // 13: 표·상자 모양·아이콘·Mermaid 크기, 세션 정렬·지난 세션·끝난 세션 숨기기·자동 휴지통 날수
  await check("표·상자 모양·아이콘: 표 칸은 글로만, 짧은 줄은 빈칸으로 채우고, 모양 윤곽은 상태 색, 아이콘은 그 심벌, Mermaid 는 칠과 크기 상한을 지킴", async () => {
    const rich = `rich-${process.pid}`;
    await post("/api/hook", { sid: rich, pid: process.pid + 40, fact: { f: "start", cwd: "/tmp/표", source: "startup" } });
    await post("/api/mcp", { env: rich, cwd, tool: "draw", input: { ops: [
      { id: "tb", kind: "table", label: "비교", cols: ["방안", "위험"], rows: [["<img src=x onerror=alert(1)>", "낮음"], ["캐시"]] },
      { id: "dm", kind: "box", label: "판단", shape: "diamond", status: "doing", icon: "db" },
      { id: "rd", kind: "box", label: "둥근 상자", shape: "round", status: "done" },
      { id: "pi", kind: "mermaid", label: "비율", src: "pie\n  \"A\" : 60\n  \"B\" : 40" },
      { id: "e1", kind: "edge", from: "dm", to: "rd" },
    ] } });
    await open(rich);
    await waitFor(`document.querySelector('[data-id="pi"] .msvg svg') !== null && document.querySelector('#canvas svg.edges path') !== null`);
    await settledPositions();
    const r = await evaluate(`(() => {
      const color = (v) => { const i = document.createElement('i'); i.style.color = v; document.body.append(i); const c = getComputedStyle(i).color; i.remove(); return c; };
      const tb = document.querySelector('[data-id="tb"] table');
      const dm = document.querySelector('[data-id="dm"]'), shp = getComputedStyle(dm.querySelector('svg.shp path'));
      const rd = getComputedStyle(document.querySelector('[data-id="rd"]'));
      const pie = document.querySelector('[data-id="pi"] .msvg svg');
      return {
        cells: [...tb.querySelectorAll('th, td')].map((c) => c.textContent), img: !!tb.querySelector('img'),
        widths: [...tb.querySelectorAll('tr')].map((tr) => tr.children.length),
        stroke: shp.stroke, fill: shp.fill, doing: color('var(--s-doing)'), done: color('var(--s-done)'), rdBorder: rd.borderTopColor, rdLeft: rd.borderLeftWidth,
        icon: dm.querySelector('.lbl > svg.pic use')?.getAttribute('href'), sym: !!document.getElementById('ic-db'),
        fills: [...new Set([...pie.querySelectorAll('path')].map((p) => getComputedStyle(p).fill))], pieW: Number(pie.getAttribute('width')), pieH: Number(pie.getAttribute('height')),
        edge: getComputedStyle(document.querySelector('#canvas svg.edges > g path')).fill,
      };
    })()`);
    expect(!r.img && r.cells.includes("<img src=x onerror=alert(1)>"), "표 칸이 글로 들어가지 않았습니다");
    expect(r.widths.every((w) => w === 2), `짧은 줄을 빈칸으로 채우지 않음: ${r.widths}`);
    expect(r.stroke === r.doing && r.fill !== "none", `마름모 윤곽 ${r.stroke}/${r.fill}, 진행 색 ${r.doing}`);
    expect(r.rdBorder === r.done && r.rdLeft !== "4px", `둥근 상자 테두리 ${r.rdBorder} ${r.rdLeft}`);
    expect(r.icon === "#ic-db" && r.sym, `아이콘 ${r.icon}`);
    expect(r.fills.filter((f) => f !== "none").length >= 2, `원 차트 칠이 빠짐: ${r.fills}`);
    expect(r.pieW > 0 && r.pieW <= 640 && r.pieH > 0, `Mermaid 크기 ${r.pieW}×${r.pieH}`);
    expect(r.edge === "none", `선 칠 ${r.edge}`);
    return `원 ${r.pieW}×${r.pieH}`;
  });

  const sortSid = (n) => `sort-${n}-${process.pid}`;
  // 그 세션 줄이 든 묶음(프로젝트, 없으면 목록 전체)의 줄 순서
  const rowsOf = (member = sortSid("a")) => evaluate(`(() => {
    const row = document.querySelector('#sess-body .sess[data-sid="${member}"]');
    const sec = row?.closest('.gsec') || document.getElementById('sess-body');
    return [...sec.querySelectorAll('.sess')].map((b) => b.dataset.sid);
  })()`);
  const pickSort = async (label) => {
    await evaluate(`document.getElementById('sess-sort').click()`);
    await waitFor(`!document.getElementById('group-menu').hidden && document.getElementById('group-menu').getAttribute('aria-label') === '정렬'`);
    await evaluate(`[...document.querySelectorAll('#group-menu .gm-item')].find((b) => b.textContent === ${JSON.stringify(label)}).click()`);
    await waitFor(`document.getElementById('group-menu').hidden`);
  };
  await check("세션 정렬: 기본 시작순은 활동해도 자리를 지키고, 활동순·이름순으로 바꾸면 순서가 바뀌며 브라우저에 기억함", async () => {
    for (const [i, n] of ["a", "b"].entries()) {
      await post("/api/hook", { sid: sortSid(n), pid: process.pid + 50 + i, fact: { f: "start", cwd: "/tmp/정렬", source: "startup" } });
      await post("/api/hook", { sid: sortSid(n), pid: process.pid + 50 + i, fact: { f: "prompt", text: n === "a" ? "가 정렬 시험" : "나 정렬 시험" } });
      await sleep(20); // 시작 시각이 갈리게
    }
    await open(sortSid("a"));
    expect(await evaluate(`document.getElementById('sess-sort').textContent.startsWith('시작순')`), "기본 정렬이 시작순이 아닙니다");
    const before = await rowsOf();
    expect(before.indexOf(sortSid("b")) < before.indexOf(sortSid("a")), `시작순에서 늦게 시작한 줄이 위가 아님: ${before}`);
    await post("/api/hook", { sid: sortSid("a"), pid: process.pid + 50, fact: { f: "prompt", text: "가 정렬 시험 다시" } });
    await sleep(300);
    const still = await rowsOf();
    expect(still.indexOf(sortSid("b")) < still.indexOf(sortSid("a")), `시작순에서 활동한 줄이 움직임: ${still}`);
    await pickSort("활동순");
    await waitFor(`(() => { const r = [...document.querySelectorAll('#sess-body .sess')].map((b) => b.dataset.sid); return r.indexOf(${JSON.stringify(sortSid("a"))}) < r.indexOf(${JSON.stringify(sortSid("b"))}); })()`);
    await pickSort("이름순");
    const named = await evaluate(`[...document.querySelectorAll('#sess-body .sess')].filter((b) => b.dataset.sid.startsWith('sort-')).map((b) => b.querySelector('.row1 .txt').textContent)`);
    expect(named[0].startsWith("가") && named[1].startsWith("나"), `이름순: ${named}`);
    await open(sortSid("a"));
    expect(await evaluate(`localStorage.getItem('atv.sessSort') === 'name' && document.getElementById('sess-sort').textContent.startsWith('이름순')`), "고른 정렬을 기억하지 못함");
    await pickSort("시작순");
  });
  await check("지난 세션: 끝난 지 하루 지난 줄은 접힌 「지난 세션」 으로 가고, 끝난 세션 숨기기는 끝난 줄을 숨기고 그 수를 알림", async () => {
    const old = sortSid("old");
    await post("/api/hook", { sid: old, pid: process.pid + 60, fact: { f: "start", cwd: "/tmp/정렬", source: "startup" } });
    await post("/api/hook", { sid: old, pid: process.pid + 60, fact: { f: "prompt", text: "다 지난 일" } });
    await post("/api/hook", { sid: old, pid: process.pid + 60, fact: { f: "end", reason: "other" } });
    board.sessions.get(old).scene.sess.lastT = Date.now() - 2 * 86_400_000;
    await open(sortSid("a")); // 새 연결의 요약에서 옛 시각을 받는다
    await waitFor(`[...document.querySelectorAll('#sess-body .pastfold')].some((b) => b.dataset.past === '' && b.getAttribute('aria-expanded') === 'false')`);
    expect(!(await rowsOf()).includes(old), "접힌 지난 세션 줄이 보입니다");
    await evaluate(`document.querySelector('#sess-body .pastfold[data-past=""]').click()`);
    await waitFor(`document.querySelector('#sess-body .sess[data-sid="${old}"]') !== null && document.querySelector('#sess-body .pastfold[data-past=""]').getAttribute('aria-expanded') === 'true'`);
    expect(await evaluate(`JSON.parse(localStorage.getItem('atv.pastOpen')).includes('')`), "펼침을 기억하지 못함");
    await pickSort("끝난 세션 숨기기");
    await waitFor(`document.querySelector('#sess-body .sess[data-sid="${old}"]') === null && [...document.querySelectorAll('#sess-body .gempty')].some((p) => /끝난 세션 \\d+개를 숨겼습니다/.test(p.textContent))`);
    const ended = await evaluate(`[...document.querySelectorAll('#sess-body .sess')].filter((b) => b.classList.contains('ended') && !b.classList.contains('sel')).length`);
    expect(ended === 0, `숨기기 뒤에도 끝난 줄 ${ended}개`);
    await pickSort("끝난 세션 숨기기");
    await waitFor(`document.querySelector('#sess-body .sess[data-sid="${old}"]') !== null`);
    // 접어 두어도 지금 보는 지난 줄은 단추 아래에 보인다
    await evaluate(`document.querySelector('#sess-body .pastfold[data-past=""]').click()`);
    await waitFor(`document.querySelector('#sess-body .pastfold[data-past=""]').getAttribute('aria-expanded') === 'false' && document.querySelector('#sess-body .sess[data-sid="${old}"]') === null`);
    await open(old);
    await waitFor(`document.querySelector('#sess-body .sess.sel[data-sid="${old}"]') !== null && document.querySelector('#sess-body .pastfold[data-past=""]').getAttribute('aria-expanded') === 'false'`);
    expect(await evaluate(`document.getElementById('sess-sort').getAttribute('aria-label') === '정렬: 시작순'`), "정렬 단추의 이름이 없습니다");
  });
  await check("설정: 지난 세션을 휴지통으로 옮기는 날수는 기본 30, 바꾸면 서버에 저장되고 비우면 끔", async () => {
    await evaluate(`document.getElementById('settings-open').click()`);
    await waitFor(`document.getElementById('settings').open && document.getElementById('cfg-trash').value === '30'`);
    await evaluate(`(() => { document.getElementById('cfg-trash').value = '7'; document.getElementById('settings-form').requestSubmit(); })()`);
    await waitFor(`!document.getElementById('settings').open`);
    expect(board.config.trashDays === 7, `저장된 날수 ${board.config.trashDays}`);
    expect(board.sessions.has(sortSid("old")), "7일보다 덜 된 대화를 옮김");
    await evaluate(`document.getElementById('settings-open').click()`);
    await waitFor(`document.getElementById('settings').open && document.getElementById('cfg-trash').value === '7'`);
    await evaluate(`(() => { document.getElementById('cfg-trash').value = ''; document.getElementById('settings-form').requestSubmit(); })()`);
    await waitFor(`!document.getElementById('settings').open`);
    expect(board.config.trashDays === null, `비웠는데 ${board.config.trashDays}`);
  });
  await open(sid);

  for (const theme of ["light", "dark"]) {
    await check(`${theme} 테마의 모든 버튼·범위 입력 대비가 4.5 이상임`, async () => {
      await evaluate(`(() => {
        for (let i = 0; i < 3 && document.documentElement.dataset.theme !== ${JSON.stringify(theme)}; i++) {
          document.getElementById('theme').click();
        }
      })()`);
      await waitFor(`document.documentElement.dataset.theme === ${JSON.stringify(theme)}`);
      await settledPositions();
      const controls = await evaluate(`(${inspectContrast.toString()})()`);
      expect(controls.length > 0 && controls.some((control) => control.name === "slider"), "입력 요소를 찾지 못했습니다.");
      const failed = controls.filter((control) => !control.ok);
      expect(!failed.length, failed.map((control) => `${control.name}: ${control.ratio.toFixed(2)}:1`).join(", "));
      return `${controls.length}개, 최소 ${Math.min(...controls.map((control) => control.ratio)).toFixed(2)}:1`;
    });
    await check(`${theme} 스크린샷 저장`, async () => {
      expect(await evaluate(`document.documentElement.dataset.theme === ${JSON.stringify(theme)}`), "캡처 테마가 다릅니다.");
      const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const file = path.join(out, `probe-${theme}.png`);
      fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
      console.log(` · 스크린샷: ${file}`);
    });
  }

  // 마지막 렌더와 오류 이벤트가 도착한 뒤에 전체 오류를 판정한다.
  await settledPositions();
  await sleep(100);
  record(consoleErrors.length === 0, `콘솔 오류 ${consoleErrors.length}건${consoleErrors.length ? ": " + consoleErrors.join(" | ") : ""}`);
  record(logErrors.length === 0, `브라우저 로그 오류 ${logErrors.length}건${logErrors.length ? ": " + logErrors.join(" | ") : ""}`);
  record(exceptions.length === 0, `처리되지 않은 예외 ${exceptions.length}건${exceptions.length ? ": " + exceptions.join(" | ") : ""}`);
  await check("CSP 위반이 없음", async () => {
    const violations = await evaluate("window.__cspViolations");
    expect(Array.isArray(violations), "CSP 감시기가 설치되지 않았습니다.");
    expect(violations.length === 0, JSON.stringify(violations));
  });
}

// 캡처는 남기고 Chrome 프로필과 임시 열쇠는 지운다.
// Chrome 이 띄운 하위 프로세스가 남아 프로필에 쓰면 폴더를 지우지 못한다. 프로세스 묶음째 끈다
function killChrome(signal) {
  try { process.kill(process.platform === "win32" ? chrome.pid : -chrome.pid, signal); }
  catch { chrome.kill(signal); }
}

async function cleanup() {
  const errors = [];
  let stopped = !chrome;
  try {
    cdp?.close();
    if (chrome) {
      killChrome("SIGTERM");
      await Promise.race([chromeExit.then(() => { stopped = true; }), sleep(3000)]);
      if (!stopped) {
        killChrome("SIGKILL");
        await Promise.race([chromeExit.then(() => { stopped = true; }), sleep(3000)]);
        expect(stopped, "Chrome을 종료하지 못했습니다.");
      }
    }
  } catch (error) { errors.push(error.message); }
  try { if (board) await board.close(); }
  catch (error) { errors.push(error.message); }
  for (const dir of [stopped && profile, home].filter(Boolean)) {
    // Chrome 이 끝난 뒤에도 잠깐 프로필에 쓰므로 넉넉히 다시 시도한다
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
    catch (error) { errors.push(error.message); }
  }
  expect(!errors.length, errors.join("; "));
}

try { await main(); }
catch (error) { record(false, `검사 실행 실패 · ${error.message}`); }
finally {
  try { await cleanup(); }
  catch (error) { record(false, `정리 실패 · ${error.message}`); }
  const passed = results.filter((result) => result.ok).length;
  console.log(`통과 ${passed} / 전체 ${results.length}`);
  process.exitCode = passed === results.length ? 0 : 1;
}
