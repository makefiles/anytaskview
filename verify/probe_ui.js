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
  await check("Mermaid 를 그리는 동안 임시 요소가 body 에 붙지 않아 화면이 밀리지 않음", async () => {
    // body 는 행을 못박은 grid 라 body 에 붙은 흐름 요소는 띠 자리(2행)에 들어가 화면 전체를 민다
    await evaluate(`(() => { window.__added = []; window.__mo = new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) window.__added.push(n.id || n.tagName); }); window.__mo.observe(document.body, { childList: true }); return 1; })()`);
    await mcp("draw", { ops: [{ id: "mermaid-seq", kind: "mermaid", label: "순서 Mermaid", src: "sequenceDiagram\n  A->>B: 요청\n  B-->>A: 응답" }] });
    await waitFor(`!!document.querySelector('[data-id="mermaid-seq"] .msvg svg')`);
    const added = await evaluate(`(() => { window.__mo.disconnect(); return window.__added; })()`);
    expect(!added.some((id) => /^d?atv-m/.test(id)), `body 에 붙은 Mermaid 임시 요소: ${added.join(", ")}`);
    return added.length ? `body 에 붙은 것: ${added.join(", ")}` : "";
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
    const editShown = `[...document.querySelectorAll('#tl-body li')].some((li) => li.querySelector('.tl-k')?.textContent === '수정' && li.querySelector('.tl-t')?.textContent.startsWith('a.js'))`;
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
  // 줄 목록을 서버에서 새로 받으며 연다. 서버 메모리를 직접 고친 값(옛 시각 따위)은 알림 없이 바뀌어 새 연결이라야 보인다.
  // 탭들이 나눠 쓰는 SharedWorker(hub.js)가 목록을 들고 있는데, Chrome 156 은 페이지를 다시 열어도 그 worker 를 이어 쓴다(151 은 새로 띄웠다)
  const reopen = async (s) => {
    await cdp.send("Page.navigate", { url: "about:blank" });
    for (const t of (await cdp.send("Target.getTargets")).targetInfos) if (t.type === "shared_worker") await cdp.send("Target.closeTarget", { targetId: t.targetId });
    await open(s);
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

  await check("끝난 묶음 접기: 처음부터 상자 하나로 접히고(선은 접힌 상자로, 안의 실패는 띠에 없음), 누르면 펼치고 접으며, 다 끝나면 마지막 묶음은 펼쳐 두고, 찾기로 고르면 펼쳐 보임", async () => {
    const fd = `fold-${process.pid}`, sel = (id) => `document.querySelector('#canvas .part[data-id="${id}"]')`;
    const draw = (ops) => post("/api/mcp", { env: fd, cwd, tool: "draw", input: { ops } });
    await draw([
      { id: "t1", kind: "group", label: "첫 작업" }, { id: "a", kind: "box", in: "t1", label: "접힌속상자A", status: "done" }, { id: "b", kind: "box", in: "t1", label: "B", status: "done" },
      { id: "memo", kind: "text", in: "t1", text: "상태 없는 설명은 따지지 않음" }, { id: "x", kind: "box", in: "t1", label: "아니라고 지운 후보", status: "fail" },
      { id: "t2", kind: "group", label: "둘째 작업" }, { id: "c", kind: "box", in: "t2", label: "C", status: "doing" },
      { id: "ab", kind: "edge", from: "a", to: "b" }, { id: "bc", kind: "edge", from: "b", to: "c" }, { id: "ac", kind: "edge", from: "a", to: "c" },
    ]);
    await open(fd);
    await waitFor(`${sel("t1")}?.classList.contains('folded') && !${sel("a")} && ${sel("c")} && !${sel("t2")}.classList.contains('folded')`);
    await sleep(200);
    // 안끼리의 선(ab)은 숨고, 밖으로 가는 두 선(bc·ac)은 접힌 상자에서 나가는 선 하나가 된다
    const m = await evaluate(`(() => ({ edges: [...document.querySelectorAll('#canvas svg.edges path[data-id]')].map((p) => p.dataset.id).sort().join(','),
      sum: ${sel("t1")}.querySelector('.fsum')?.textContent, done: ${sel("t1")}.classList.contains('st-done'), btn: ${sel("t1")}.querySelector('button.fold')?.getAttribute('aria-expanded') }))()`);
    expect(m.edges === "bc", `선 ${m.edges}`);
    // 아니라고 지운 후보(실패)가 섞여도 묶음은 끝이고, 끝난 묶음 안의 실패는 주의 띠에 올리지 않는다
    expect(m.sum === "끝 · 부품 4개 · 실패 1" && m.done && m.btn === "false", JSON.stringify(m));
    expect(!(await evaluate(`document.getElementById('band').textContent.includes('아니라고 지운 후보')`)), "끝난 묶음 안의 실패가 주의 띠에 남음");
    // 접힌 상자를 누르면 펼치고, 단추로 다시 접는다
    await evaluate(`${sel("t1")}.click()`);
    await waitFor(`!${sel("t1")}.classList.contains('folded') && ${sel("a")} && ${sel("t1")}.querySelector('button.fold').getAttribute('aria-expanded') === 'true' && document.querySelectorAll('#canvas svg.edges path[data-id]').length === 3`);
    await evaluate(`${sel("t1")}.querySelector('button.fold').click()`);
    await waitFor(`${sel("t1")}.classList.contains('folded') && !${sel("a")}`);
    // 키보드: 단추에서 Enter 로 펴도 다시 그린 뒤 초점이 새 단추에 남는다(다음 Enter 로 다시 접힘)
    await evaluate(`${sel("t1")}.querySelector('button.fold').focus()`);
    await key("Enter", "Enter", 13, "\r");
    await waitFor(`!${sel("t1")}.classList.contains('folded') && document.activeElement === ${sel("t1")}.querySelector('button.fold')`);
    await key("Enter", "Enter", 13, "\r");
    await waitFor(`${sel("t1")}.classList.contains('folded') && document.activeElement === ${sel("t1")}.querySelector('button.fold')`);
    // 묶음만 끝으로 두고 안에 승인 대기를 남기면 접지 않고, 그 대기는 주의 띠에 남는다
    await draw([{ id: "t9", kind: "group", label: "배포", status: "done" }, { id: "w9", kind: "box", in: "t9", label: "배포 승인 받기", status: "wait" }]);
    await waitFor(`${sel("w9")} && !${sel("t9")}.classList.contains('folded') && document.getElementById('band').textContent.includes('배포 승인 받기')`);
    await draw([{ id: "t9", del: true }]);
    // 둘째 작업도 끝나면 맨 바깥 묶음이 모두 끝났으니 가장 나중 묶음(t2)은 펼쳐 둔다. 새 작업 묶음이 생기면 접힌다
    await draw([{ id: "c", status: "done" }]);
    await waitFor(`${sel("t2")} && ${sel("c")} && !${sel("t2")}.classList.contains('folded')`);
    await draw([{ id: "t3", kind: "group", label: "셋째 작업" }, { id: "d", kind: "box", in: "t3", label: "D", status: "doing" }]);
    await waitFor(`${sel("t2")}?.classList.contains('folded') && !${sel("c")} && ${sel("d")}`);
    // 찾기로 접힌 묶음 안의 상자를 고르면 그 묶음을 펼쳐 보인다
    await evaluate(`document.getElementById('search-open').click()`);
    await evaluate(`(() => { const i = document.getElementById('search-q'); i.value = '접힌속상자A'; i.dispatchEvent(new Event('input')); return 1; })()`);
    await waitFor(`document.querySelector('#search .s-opt[aria-selected="true"]')?.textContent.includes('접힌속상자A')`);
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await waitFor(`document.getElementById('search').hidden && ${sel("a")} && !${sel("t1")}.classList.contains('folded') && document.activeElement === ${sel("a")}`);
    return `요약 「${m.sum}」, 선 ${m.edges}`;
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
  await check("지우기: 쉬는 Codex 앱(app-server) 대화는 끝나지 않았어도 ⋯ 의 「지우기」 가 켜지고, 지우면 목록에서 빠짐", async () => {
    // 명령줄에 app-server 가 든 프로세스를 VS Code·데스크톱 앱의 codex 로 흉내 낸다
    const host = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)", "app-server"], { stdio: "ignore" });
    try {
      const cx = `codex-app-${process.pid}`, menu = `document.querySelector('#sess-body .smenu[data-sid="${cx}"]')`;
      await post("/api/hook", { sid: cx, pid: host.pid, via: "codex", home: "/tmp/codex-home", fact: { f: "start", cwd: "/tmp/앱", source: "startup", via: "codex", home: "/tmp/codex-home" } });
      await post("/api/hook", { sid: cx, pid: host.pid, via: "codex", home: "/tmp/codex-home", fact: { f: "prompt", text: "앱에서 연 대화" } });
      await post("/api/hook", { sid: cx, pid: host.pid, via: "codex", home: "/tmp/codex-home", fact: { f: "stop", last: "끝" } });
      await waitFor(`window.__atv.sessions.get(${JSON.stringify(cx)})?.status === 'idle' && ${menu} != null`);
      await evaluate(`${menu}.focus()`);
      await key("Enter", "Enter", 13, "\r");
      await waitFor(`!document.getElementById('group-menu').hidden && document.querySelector('#group-menu .gm-del')?.textContent === '지우기' && !document.querySelector('#group-menu .gm-del').hasAttribute('aria-disabled')`);
      expect((await evaluate(`document.querySelector('#group-menu .gm-del').title`)).includes("Codex 앱"), "쉬는 앱 대화를 지운다는 설명이 없음");
      await evaluate(`document.querySelector('#group-menu .gm-del').click()`);
      await evaluate(`document.querySelector('#group-menu .gm-del').click()`);
      await waitFor(`!window.__atv.sessions.has(${JSON.stringify(cx)})`);
      expect(board.pids.has(host.pid), "같은 프로세스의 다른 대화를 위한 짝짓기가 사라짐");
    } finally { host.kill(); }
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
    // 이어 쓰는 SharedWorker(Chrome 156)는 들고 있던 목록을 먼저 주고, 방금 만든 세션 줄은 뒤이어 온 변경으로 붙는다
    await waitFor(`${JSON.stringify([sortSid("a"), sortSid("b")])}.every((id) => document.querySelector('#sess-body .sess[data-sid="' + id + '"]'))`);
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
    await reopen(sortSid("a")); // 새 연결의 요약에서 옛 시각을 받는다
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

  // 14: 글꼴·탭 아이콘·역할별 색, 주의 띠 접기·닫기, 승인 대기, 설정 창, 그림 끌어 옮기기
  await check("글꼴·탭: Pretendard 를 이 서버에서 받아 쓰고, 탭 아이콘과 「· AnyTaskView」 제목이 있음", async () => {
    const r = await evaluate(`(async () => {
      const faces = await document.fonts.load('14px "Pretendard Variable"', '가A1');
      const icon = document.querySelector('link[rel="icon"]')?.getAttribute('href');
      const res = await fetch(icon);
      return { faces: faces.length, family: getComputedStyle(document.body).fontFamily, icon, status: res.status, type: res.headers.get('content-type'), title: document.title };
    })()`);
    expect(r.faces > 0 && r.family.startsWith('"Pretendard Variable"'), `글꼴 ${r.faces} ${r.family}`);
    expect(r.icon === "/icon.svg" && r.status === 200 && r.type.startsWith("image/svg+xml"), `아이콘 ${r.icon} ${r.status} ${r.type}`);
    expect(r.title.endsWith(" · AnyTaskView"), `제목 ${r.title}`);
    return r.title;
  });
  await check("역할별 색: 패널 제목·보조 단추·지금 세션 이름이 각자의 색을 씀", async () => {
    const r = await evaluate(`(() => {
      const color = (v, prop = 'color') => { const i = document.createElement('i'); i.style[prop] = v; document.body.append(i); const c = getComputedStyle(i)[prop]; i.remove(); return c; };
      const h2 = getComputedStyle(document.querySelector('#plan .ptab[aria-selected="true"]')), btn = getComputedStyle(document.getElementById('zoom-fit'));
      return { h2: h2.color, title: color('var(--title)'), head: getComputedStyle(document.querySelector('#plan > .phead')).backgroundColor, titleBg: color('var(--title-bg)', 'backgroundColor'),
        btnBg: btn.backgroundColor, wantBg: color('var(--btn-bg)', 'backgroundColor'), btnFg: btn.color, wantFg: color('var(--btn-fg)'),
        name: getComputedStyle(document.getElementById('sess-name')).color, key: color('var(--key)') };
    })()`);
    expect(r.h2 === r.title && r.head === r.titleBg, `제목 ${r.h2}/${r.title} 머리띠 ${r.head}/${r.titleBg}`);
    expect(r.btnBg === r.wantBg && r.btnFg === r.wantFg, `보조 단추 ${r.btnBg}/${r.wantBg} ${r.btnFg}/${r.wantFg}`);
    expect(r.name === r.key, `세션 이름 ${r.name}/${r.key}`);
  });
  await check("주의 띠: 둘 이상이면 한 줄로 접히고 「외 N개」 로 펴며, 닫으면 숨고 새 항목이 오면 다시 보임. 끝난 세션은 승인 대기를 띄우지 않음", async () => {
    const bs = `band-${process.pid}`;
    await post("/api/hook", { sid: bs, pid: process.pid + 70, fact: { f: "start", cwd: "/tmp/띠", source: "startup" } });
    await post("/api/mcp", { env: bs, cwd, tool: "plan", input: { steps: [{ id: "q1", title: "첫 승인", status: "wait" }] } });
    await post("/api/mcp", { env: bs, cwd, tool: "draw", input: { ops: [{ id: "p1", kind: "box", label: "둘째", status: "wait" }, { id: "p2", kind: "box", label: "셋째", status: "blocked" }] } });
    await open(bs);
    await waitFor(`!document.getElementById('band').hidden && document.querySelectorAll('#band .bi').length === 1 && document.querySelector('#band .btoggle')?.textContent === '외 2개 ▾'`);
    await evaluate(`document.querySelector('#band .btoggle').click()`);
    await waitFor(`document.querySelectorAll('#band .bi').length === 3 && document.activeElement?.classList.contains('btoggle') && document.activeElement.getAttribute('aria-expanded') === 'true'`);
    await evaluate(`[...document.querySelectorAll('#band button')].find((b) => b.textContent === '닫기 ×').click()`);
    await waitFor(`document.getElementById('band').hidden && document.activeElement?.closest('#top') !== null && document.activeElement.tagName === 'BUTTON'`);
    await post("/api/mcp", { env: bs, cwd, tool: "draw", input: { ops: [{ id: "p3", kind: "box", label: "넷째", status: "fail" }] } });
    await waitFor(`!document.getElementById('band').hidden && document.querySelectorAll('#band .bi').length === 4`);
    // 다시 닫은 뒤 사용자 입력으로 승인 대기가 풀리면 띠는 숨은 채, 같은 단계에 승인 대기를 다시 걸면 새 알림으로 보인다
    await evaluate(`[...document.querySelectorAll('#band button')].find((b) => b.textContent === '닫기 ×').click()`);
    await waitFor(`document.getElementById('band').hidden`);
    await post("/api/hook", { sid: bs, pid: process.pid + 70, fact: { f: "prompt", text: "좋아요" } });
    await sleep(300);
    expect(await evaluate(`document.getElementById('band').hidden`), "풀린 뒤 띠가 다시 보임");
    await post("/api/mcp", { env: bs, cwd, tool: "plan", input: { steps: [{ id: "q1", status: "wait" }] } });
    await waitFor(`!document.getElementById('band').hidden && [...document.querySelectorAll('#band .bi .txt')].some((t) => t.textContent === '승인 대기: 첫 승인')`);
    await post("/api/hook", { sid: bs, pid: process.pid + 70, fact: { f: "prompt", text: "다시 좋아요" } });
    await waitFor(`![...document.querySelectorAll('#band .bi .txt')].some((t) => t.textContent.startsWith('승인 대기'))`);
    await post("/api/hook", { sid: bs, pid: process.pid + 70, fact: { f: "end", reason: "other" } });
    await waitFor(`![...document.querySelectorAll('#band .bi .txt')].some((t) => /^(승인 대기|막힘)/.test(t.textContent)) && [...document.querySelectorAll('#band .bi .txt')].some((t) => t.textContent.startsWith('실패'))`);
  });
  await check("설정 창: 도움말처럼 소개·항목 두 칸·「자세히」 접기", async () => {
    await evaluate(`document.getElementById('settings-open').click()`);
    await waitFor(`document.getElementById('settings').open`);
    const r = await evaluate(`({ lead: !!document.querySelector('#settings .lead'), fields: document.querySelectorAll('#settings dl.fields dt').length, details: document.querySelectorAll('#settings details').length, w: document.getElementById('settings').getBoundingClientRect().width })`);
    await evaluate(`document.getElementById('settings-close').click()`);
    expect(r.lead && r.fields === 4 && r.details === 3 && r.w > 600, JSON.stringify(r)); // 이어받기 문구 2 · 휴지통 날수 · diff 보관 크기
  });
  await check("그림 끌어 옮기기: 칸보다 크면 손 모양이 되고, 끌면 스크롤이 옮겨지며 끌기 뒤 클릭은 경로를 복사하지 않음", async () => {
    await open(`rich-${process.pid}`);
    await settledPositions();
    for (let i = 0; i < 4; i++) await evaluate(`document.getElementById('zoom-in').click()`);
    await waitFor(`document.getElementById('canvas-scroll').classList.contains('pannable')`);
    const box = await evaluate(`(() => { const s = document.getElementById('canvas-scroll'); s.scrollLeft = 0; s.scrollTop = 0; const r = s.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await evaluate(`window.__copied = 0; navigator.clipboard.writeText = async () => { window.__copied++; };`);
    const mouse = (type, x, y) => cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
    await mouse("mousePressed", box.x, box.y);
    for (let k = 1; k <= 6; k++) await mouse("mouseMoved", box.x - k * 25, box.y - k * 15);
    await mouse("mouseReleased", box.x - 150, box.y - 90);
    const after = await evaluate(`({ left: document.getElementById('canvas-scroll').scrollLeft, top: document.getElementById('canvas-scroll').scrollTop, panning: document.getElementById('canvas-scroll').classList.contains('panning'), copied: window.__copied })`);
    expect(after.left >= 140 && after.top >= 80 && !after.panning && after.copied === 0, JSON.stringify(after));
    await evaluate(`document.getElementById('zoom-100').click()`);
    return `스크롤 ${after.left}·${after.top}`;
  });
  await check("타임라인: 시각·표지·글 세 칸이라 글 머리가 줄마다 같은 자리이고, 넘어간 줄도 글 머리 아래에서 잇고, 긴 사용자 입력은 3줄로 접힘", async () => {
    await open(sid);
    await mcp("note", { kind: "decision", text: "아주 긴 결정 메모입니다. ".repeat(12) });
    await post("/api/hook", { sid, fact: { f: "prompt", text: "아주 긴 사용자 입력입니다. ".repeat(40) } });
    // 하위 에이전트: 시작·끝이 짝인 것은 보이고(들여 쓰지 않음), 시작 없이 끝만 온 보조 에이전트는 숨긴다
    await post("/api/hook", { sid, fact: { f: "agent-start", agent: "real1", agentType: "Explore" } });
    await post("/api/hook", { sid, fact: { f: "agent-stop", agent: "real1", agentType: "Explore", last: "찾은 곳 셋" } });
    await post("/api/hook", { sid, fact: { f: "agent-stop", agent: "helper1", last: "보조 에이전트가 낸 글" } });
    await waitFor(`document.body.textContent.includes('아주 긴 결정 메모') && document.body.textContent.includes('아주 긴 사용자 입력') && document.body.textContent.includes('찾은 곳 셋')`);
    expect(!(await evaluate(`document.getElementById('tl-body').textContent.includes('보조 에이전트가 낸 글')`)), "시작 없는 보조 에이전트 끝 줄이 보입니다");
    const r = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('#tl-body li:not(.new-mark)')].slice(0, 14); // 하위 에이전트 줄(.sub)도 같은 글 머리
      const lefts = rows.map((li) => Math.round(li.querySelector('.tl-t').getBoundingClientRect().left));
      // 줄마다의 자리는 글 칸 안의 글자 범위(Range)로 잰다(격자 칸의 getClientRects 는 칸 하나만 준다)
      const lines = (cell) => { const g = document.createRange(); g.selectNodeContents(cell); return [...g.getClientRects()].filter((x) => x.width > 0); };
      const note = rows.find((li) => li.textContent.includes('아주 긴 결정 메모')).querySelector('.tl-t');
      const prompt = rows.find((li) => li.textContent.includes('아주 긴 사용자 입력')).querySelector('.tl-t');
      const nl = lines(note), cs = getComputedStyle(prompt);
      return { lefts: [...new Set(lefts)], noteLines: new Set(nl.map((x) => Math.round(x.top))).size, wrapLeft: Math.round(Math.min(...nl.map((x) => x.left))), textLeft: Math.round(note.getBoundingClientRect().left),
        clamp: cs.webkitLineClamp, promptH: prompt.getBoundingClientRect().height, lineH: parseFloat(cs.lineHeight) };
    })()`);
    expect(r.lefts.length === 1, `글 머리가 줄마다 다름: ${r.lefts}`);
    expect(r.noteLines >= 2 && r.wrapLeft === r.textLeft, `넘어간 줄 ${r.noteLines}줄, ${r.wrapLeft} ≠ 글 머리 ${r.textLeft}`);
    expect(r.clamp === "3" && r.promptH <= r.lineH * 3 + 1, `사용자 입력이 3줄로 접히지 않음: ${r.clamp} ${r.promptH}px`);
    return `글 머리 ${r.lefts[0]}px, 메모 ${r.noteLines}줄`;
  });
  await check("하위 에이전트 이름표: 도는 에이전트 칸·타임라인 줄 앞·세션 줄에 같은 이름과 색, 이름표를 누르면 그 에이전트 줄만, 끝나면 칸이 사라짐", async () => {
    await open(sid);
    await hook({ f: "agent-start", agent: "probe-ag1", agentType: "general-purpose" });
    await hook({ f: "agent-call", agent: "probe-ag1", desc: "로그 원인 찾기", agentType: "general-purpose" });
    await hook({ f: "agent-start", agent: "probe-wf1", agentType: "workflow-subagent", desc: "review:bugs" });
    await hook({ f: "run-start", id: "probe-ag-run", cmd: "grep -r err logs", desc: "오류 줄 찾기", agent: "probe-ag1", agentType: "general-purpose" });
    await hook({ f: "run-start", id: "probe-main-run", cmd: "ls", desc: "주 에이전트 명령" });
    const chips = `[...document.querySelectorAll('#plan-agents button.atag')]`;
    await waitFor(`!document.getElementById('plan-agents').hidden && ${chips}.length === 2 && document.querySelector('#sessions .sess.sel').textContent.includes('에이전트 2')`);
    const r = await evaluate(`(() => {
      const chips = ${chips}.map((b) => ({ text: b.textContent, color: getComputedStyle(b.querySelector('.adot')).backgroundColor }));
      const row = [...document.querySelectorAll('#tl-body li')].find((li) => li.textContent.includes('오류 줄 찾기'));
      const tag = row?.querySelector('.tl-t button.atag');
      return { chips, tag: tag?.textContent, tagColor: tag && getComputedStyle(tag.querySelector('.adot')).backgroundColor, sub: row?.classList.contains('sub') };
    })()`);
    expect(r.chips.some((c) => c.text.includes('로그 원인 찾기')) && r.chips.some((c) => c.text.includes('review:bugs')), JSON.stringify(r.chips));
    const mine = r.chips.find((c) => c.text.includes('로그 원인 찾기'));
    expect(r.sub && r.tag?.includes('로그 원인 찾기') && r.tagColor === mine.color, `줄 앞 이름표: ${JSON.stringify(r)}`);
    // 칸의 이름표를 누르면 그 에이전트 줄만 보이고, 거르기 줄의 ✕ 로 풀린다
    const rows = `[...document.querySelectorAll('#tl-body li[data-key]')]`;
    const onlyAg = `${rows}.length > 0 && ${rows}.every((li) => li.querySelector('.atag')?.textContent.includes('로그 원인 찾기'))`;
    await evaluate(`${chips}.find((b) => b.textContent.includes('로그 원인 찾기')).click()`);
    await waitFor(`${onlyAg} && document.querySelector('#tl-filters button.atag')?.textContent.includes('로그 원인 찾기')`);
    await evaluate(`document.querySelector('#tl-filters button.atag').click()`);
    await waitFor(`!document.querySelector('#tl-filters button.atag') && document.getElementById('tl-body').textContent.includes('주 에이전트 명령')`);
    // 줄 앞 이름표를 눌러도 걸리고, 다시 누르면 풀린다. 이름표를 눌러도 줄의 창은 열리지 않는다
    const rowTag = `[...document.querySelectorAll('#tl-body li')].find((li) => li.textContent.includes('오류 줄 찾기')).querySelector('button.atag')`;
    await evaluate(`${rowTag}.click()`);
    await waitFor(onlyAg);
    expect(!(await evaluate(`document.getElementById('tl-full').open`)), "이름표를 누르니 줄의 창이 열렸습니다");
    await evaluate(`${rowTag}.click()`);
    await waitFor(`document.getElementById('tl-body').textContent.includes('주 에이전트 명령')`);
    // 도는 명령 줄은 매초 새로 만들어도 그 줄 이름표의 키보드 초점이 남는다
    await evaluate(`${rowTag}.focus()`);
    await new Promise((ok) => setTimeout(ok, 2200));
    expect(await evaluate(`document.activeElement?.matches('#tl-body button.atag') && document.activeElement.closest('li').textContent.includes('오류 줄 찾기')`), "도는 명령 줄의 이름표 초점이 사라졌습니다");
    await hook({ f: "run-end", id: "probe-ag-run", cmd: "grep -r err logs", agent: "probe-ag1", agentType: "general-purpose" });
    await hook({ f: "run-end", id: "probe-main-run", cmd: "ls" });
    await hook({ f: "agent-stop", agent: "probe-ag1", agentType: "general-purpose", last: "원인 하나" });
    await hook({ f: "agent-stop", agent: "probe-wf1", agentType: "workflow-subagent", last: "지적 없음" });
    await waitFor(`document.getElementById('plan-agents').hidden && !document.querySelector('#sessions .sess.sel').textContent.includes('에이전트')`);
    // 누르면 창이 열리는 줄(끝 줄, 마지막 글)의 이름표를 눌러도 창은 열리지 않고 거르기만 걸린다
    const stopTag = `[...document.querySelectorAll('#tl-body li.full')].find((li) => li.textContent.includes('원인 하나')).querySelector('button.atag')`;
    await waitFor(`${stopTag} != null`);
    await evaluate(`${stopTag}.click()`);
    await waitFor(onlyAg);
    expect(!(await evaluate(`document.getElementById('tl-full').open`)), "끝 줄의 이름표를 누르니 창이 열렸습니다");
    await evaluate(`${stopTag}.click()`);
    await waitFor(`document.getElementById('tl-body').textContent.includes('주 에이전트 명령')`);
    // 줄의 다른 곳을 누르면 전체 보기 창: 글에는 이름표 이름이 섞이지 않고 제목에 붙는다
    await evaluate(`${stopTag}.closest('li').querySelector('.when').click()`);
    await waitFor(`document.getElementById('tl-full').open`);
    const full = await evaluate(`({ body: document.getElementById('tl-full-body').textContent, title: document.getElementById('tl-full-title').textContent })`);
    await evaluate(`document.getElementById('tl-full').close()`);
    expect(full.body.startsWith('끝') && full.body.includes('원인 하나') && !full.body.includes('로그 원인 찾기') && full.title.includes('로그 원인 찾기'), JSON.stringify(full));
    // 줄이 400개를 넘는 세션: 먼저 시작한 에이전트를 골라도 그 시작 줄까지 보인다
    const many = `ui-agents-${process.pid}`, mpid = process.pid + 80;
    await post("/api/hook", { sid: many, pid: mpid, fact: { f: "start", cwd: "/tmp/에이전트", source: "startup" } });
    await post("/api/hook", { sid: many, pid: mpid, fact: { f: "agent-start", agent: "probe-old1", agentType: "Explore", desc: "먼저 시작한 일" } });
    for (let i = 0; i < 410; i++) await post("/api/hook", { sid: many, pid: mpid, fact: { f: "todo", tool: "TodoWrite", text: `주 에이전트 할 일 ${i}` } });
    await open(many);
    const oldChip = `[...document.querySelectorAll('#plan-agents button.atag')].find((b) => b.textContent.includes('먼저 시작한 일'))`;
    await waitFor(`${oldChip} != null`);
    await evaluate(`${oldChip}.click()`);
    await waitFor(`[...document.querySelectorAll('#tl-body li')].some((li) => li.textContent.includes('먼저 시작한 일') && li.querySelector('.tl-k')?.textContent === '에이전트')`);
    await post("/api/hook", { sid: many, pid: mpid, fact: { f: "end", reason: "other" } });
    await open(sid);
    return `칸 ${r.chips.length}개, 색 ${mine.color}`;
  });
  await check("문서 보기: [계획 | 문서] 탭의 목록·점, 눌러서 그림 자리에 md(목차·mermaid·그림·링크·뒤로)·html(격리 틀), 수정 줄은 바뀐 문단, 고치면 갱신, Esc·초점, 고정", async () => {
    const dir = path.join(temp, "docs-probe");
    fs.mkdirSync(dir, { recursive: true });
    const plan = path.join(dir, "plan.md"), other = path.join(dir, "other.md"), page = path.join(dir, "page.html");
    const planText = (last) => ["# 작업 계획서", "", "## 1. 목적", "", "문서 보기 점검.", "", "## 2. 흐름", "", "```mermaid", "flowchart LR", "  A --> B", "```", "", "## 3. 화면", "", last, "", "![그림](pic.png)", "", "[다른 문서](other.md)", "", "```bash", "echo hi", "```", ""].join("\n");
    fs.writeFileSync(plan, planText("처음 문단."));
    fs.writeFileSync(other, "# 다른 문서\n\n링크로 옮겨 온 문서.\n");
    fs.writeFileSync(page, "<!doctype html><title>격리 페이지</title><p>html</p><script>document.body.dataset.ran = '1'</script>");
    fs.writeFileSync(path.join(dir, "pic.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64"));
    await open(sid);
    const lines = planText("처음 문단.").split("\n");
    await hook({ f: "edit", tool: "Write", path: plan, create: true, add: lines.length, del: 0, diff: [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => "+" + l)].join("\n") });
    await hook({ f: "edit", tool: "Edit", path: page, add: 1, del: 0, diff: "@@ -1,0 +1,1 @@\n+<p>html</p>" });
    await mcp("draw", { ops: [{ id: "doc-box", kind: "box", label: "다른 문서", ref: `${other}:1` }] });
    // 탭: 중요 문서(제목에 「계획」, 그림에 걸림)만 보이고 수와 아직 열어 보지 않은 변경의 점, 나머지는 「모든 문서」 뒤
    await evaluate(`document.getElementById('tab-docs').click()`);
    const rows = `[...document.querySelectorAll('#docs-body .drow')]`;
    await waitFor(`${rows}.length === 2 && !document.getElementById('docs-body').hidden && document.getElementById('plan-body').hidden`);
    const tab = await evaluate(`(() => ({ sel: document.getElementById('tab-docs').getAttribute('aria-selected'), text: document.getElementById('tab-docs').textContent, dot: !document.getElementById('docs-dot').hidden,
      order: ${rows}.map((r) => r.querySelector('.dtitle').textContent), more: document.querySelector('#docs-body .dmore')?.textContent }))()`);
    expect(tab.sel === "true" && tab.text.startsWith("문서 2") && tab.dot && tab.more === "모든 문서 3개 ›", `탭: ${JSON.stringify(tab)}`);
    expect(JSON.stringify(tab.order) === JSON.stringify(["작업 계획서", "다른 문서"]), `중요 문서: ${JSON.stringify(tab)}`);
    await evaluate(`document.querySelector('#docs-body .dmore').click()`);
    await waitFor(`${rows}.length === 3`);
    const all = await evaluate(`(() => ({ order: ${rows}.map((r) => r.querySelector('.dtitle').textContent), kinds: ${rows}.map((r) => r.querySelector('.dkind').textContent) }))()`);
    expect(JSON.stringify(all.order) === JSON.stringify(["작업 계획서", "다른 문서", "격리 페이지"]) && all.kinds.join() === "MD,MD,HTML", `모든 문서: ${JSON.stringify(all)}`);
    // 목록에서 열기: 그림 자리에 문서, 목차·mermaid·그림, 그 줄의 점이 사라짐
    await evaluate(`${rows}[0].querySelector('.dopen').focus(); ${rows}[0].querySelector('.dopen').click()`);
    await waitFor(`!document.getElementById('doc-view').hidden && document.querySelector('#dv-article h1')?.textContent === '작업 계획서' && document.querySelector('#dv-article .mmd svg')`, 15000);
    const md = await evaluate(`(() => ({ title: document.getElementById('dv-title').textContent, toc: document.querySelectorAll('#dv-tocbox button.toc').length, tocShown: !document.getElementById('dv-tocbox').hidden,
      img: document.querySelector('#dv-article img')?.getAttribute('src'), imgOk: document.querySelector('#dv-article img')?.naturalWidth, zoom: getComputedStyle(document.getElementById('zoombar')).visibility,
      rowDot: !!document.querySelector('#docs-body .drow.open .udot'), focus: document.activeElement?.id, inert: document.getElementById('canvas-scroll').inert }))()`);
    expect(md.title === "작업 계획서" && md.toc >= 3 && md.tocShown && /^\/doc\/[0-9a-f]{32}\/(.+\/)?pic\.png$/.test(md.img || "") && !md.rowDot && md.zoom === "hidden", `md: ${JSON.stringify(md)}`);
    await waitFor(`document.querySelector('#dv-article img')?.naturalWidth === 1`);
    expect(md.focus === "dv-canvas" && md.inert, `연 뒤 초점·덮인 그림: ${md.focus} ${md.inert}`);
    fs.writeFileSync(path.join(out, "probe-doc.png"), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
    // 링크로 옮겨 가고 ◀ 뒤로 돌아온다
    await evaluate(`[...document.querySelectorAll('#dv-article a')].find((a) => a.textContent === '다른 문서').click()`);
    await waitFor(`document.querySelector('#dv-article h1')?.textContent === '다른 문서' && !document.getElementById('dv-back').hidden`);
    await evaluate(`document.getElementById('dv-back').click()`);
    await waitFor(`document.querySelector('#dv-article h1')?.textContent === '작업 계획서' && document.getElementById('dv-back').hidden`);
    // 그림이 바뀌면 「← 그림으로」 에 점, Esc 로 닫으면 연 줄로 초점이 돌아온다
    await mcp("draw", { ops: [{ id: "doc-box2", kind: "box", label: "새 상자" }] });
    await waitFor(`!document.getElementById('dv-canvas-dot').hidden`);
    await evaluate(`document.getElementById('dv-scroll').focus(); document.getElementById('dv-scroll').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await waitFor(`document.getElementById('doc-view').hidden && document.activeElement?.matches('#docs-body .dopen')`);
    // 수정 줄을 누르면 문서가 열리고 그 수정이 바꾼 문단에 색 띠
    fs.writeFileSync(plan, planText("고친 문단."));
    await hook({ f: "edit", tool: "Edit", path: plan, add: 1, del: 1, diff: "@@ -16,1 +16,1 @@\n-처음 문단.\n+고친 문단." });
    const docLine = `[...document.querySelectorAll('#tl-body li.doc')].filter((li) => li.textContent.includes('plan.md')).sort((a, b) => b.dataset.dseq - a.dataset.dseq)[0]`;
    await waitFor(`${docLine}?.textContent.includes('+1')`);
    await evaluate(`${docLine}.click()`);
    const chg = `[...document.querySelectorAll('#dv-article > .chg')].map((b) => b.textContent).join('|')`;
    try { await waitFor(`!document.getElementById('doc-view').hidden && ${chg} === '고친 문단.'`, 15000); }
    catch (e) { throw new Error(`바뀐 문단: ${await evaluate(chg)} · 알림: ${await evaluate(`document.getElementById('dv-note').textContent`)} · ${e.message}`); }
    // 연 채로 파일이 고쳐지면 다시 그린다
    fs.writeFileSync(plan, planText("또 고친 문단."));
    await hook({ f: "edit", tool: "Edit", path: plan, add: 2, del: 2, diff: "@@ -16,1 +16,1 @@\n-고친 문단.\n+또 고친 문단.\n@@ -23,1 +23,1 @@\n-echo hi\n+echo hi" });
    // 코드 덩어리 안의 줄도 그 덩어리에 띠가 붙는다
    await waitFor(`[...document.querySelectorAll('#dv-article > .chg')].some((b) => b.textContent === '또 고친 문단.') && document.querySelector('#dv-article > pre.chg') && !document.getElementById('dv-diff').hidden`, 15000);
    // 그림 상자의 문서 표: 누르면 그 문서
    await evaluate(`document.getElementById('dv-close').click()`);
    await waitFor(`document.getElementById('doc-view').hidden && document.querySelector('#canvas .part[data-id="doc-box"] .badge.doc')`);
    // 「문서」 표는 단추라 키보드로도 연다
    await evaluate(`document.querySelector('#canvas .part[data-id="doc-box"] button.badge.doc').click()`);
    await waitFor(`!document.getElementById('doc-view').hidden && document.querySelector('#dv-article h1')?.textContent === '다른 문서'`);
    // html: 화판과 출처가 다른 격리 틀(allow-same-origin 없음)에 연다
    await evaluate(`[...document.querySelectorAll('#docs-body .drow')].find((r) => r.textContent.includes('격리 페이지')).querySelector('.dopen').click()`);
    await waitFor(`!document.getElementById('dv-frame').hidden && document.getElementById('dv-frame').getAttribute('src')?.startsWith('/doc/') && document.getElementById('dv-article').hidden`);
    const sandbox = await evaluate(`document.getElementById('dv-frame').getAttribute('sandbox')`);
    expect(!sandbox.includes("allow-same-origin") && sandbox.includes("allow-scripts"), `sandbox: ${sandbox}`);
    await evaluate(`document.getElementById('dv-close').click()`);
    // 고정: 맨 위로, 📌
    await evaluate(`[...document.querySelectorAll('#docs-body .drow')].find((r) => r.textContent.includes('격리 페이지')).querySelector('.dpin').click()`);
    await waitFor(`document.querySelector('#docs-body .drow .dtitle')?.textContent === '📌 격리 페이지'`);
    const csp = await evaluate(`JSON.stringify(window.__cspViolations.filter((v) => v.directive.startsWith('frame') || v.blocked.includes('/doc/')))`);
    expect(csp === "[]", `CSP 위반: ${csp}`);
    await evaluate(`document.getElementById('tab-plan').click()`);
    await waitFor(`!document.getElementById('plan-body').hidden && document.getElementById('docs-body').hidden`);
    return `중요 ${tab.order.join(" · ")} · 모두 ${all.order.length}`;
  });
  await check("한국어 줄바꿈: 넘어간 줄은 낱말 중간이 아니라 띄어쓰기 자리에서 바뀜", async () => {
    const r = await evaluate(`(() => {
      const note = [...document.querySelectorAll('#tl-body li')].find((li) => li.textContent.includes('아주 긴 결정 메모')).querySelector('.tl-t');
      note.scrollIntoView({ block: 'center' }); // 앞 점검이 줄을 더해 화면 밖에 있으면 그 자리의 글자를 잡지 못한다
      const g = document.createRange(); g.selectNodeContents(note);
      const tops = [...new Map([...g.getClientRects()].filter((x) => x.width > 0).map((x) => [Math.round(x.top), x])).values()];
      // 둘째 줄부터 줄 첫 글자 바로 앞이 띄어쓰기인지 본다
      const bad = tops.slice(1).map((x) => document.caretRangeFromPoint(x.left + 1, x.top + x.height / 2)).filter((c) => c && c.startOffset > 0 && !/\\s/.test(c.startContainer.data[c.startOffset - 1]));
      return { lines: tops.length, bad: bad.length, wb: getComputedStyle(note).wordBreak };
    })()`);
    expect(r.lines >= 2 && r.bad === 0 && r.wb === "keep-all", JSON.stringify(r));
    return `${r.lines}줄`;
  });
  await check("타임라인 전체 보기: 긴 차례 끝 답은 3줄로 접히고, 누르거나 Enter 로 전체가 창에 열리며 Esc·바깥 누르기로 닫힘", async () => {
    const answer = "끝까지 보여야 하는 답입니다. ".repeat(150) + "마지막 문장";
    await post("/api/hook", { sid, fact: { f: "stop", last: answer } });
    const row = `[...document.querySelectorAll('#tl-body li.full')].find((li) => li.textContent.includes('마지막 문장'))`;
    await waitFor(`${row} !== undefined`);
    const folded = await evaluate(`(() => { const t = ${row}.querySelector('.tl-t'), cs = getComputedStyle(t); return { h: t.getBoundingClientRect().height, line: parseFloat(cs.lineHeight), title: ${row}.title }; })()`);
    expect(folded.h <= folded.line * 3 + 1 && folded.title === "누르면 전체를 봅니다", JSON.stringify(folded));
    const shown = `document.getElementById('tl-full').open && document.getElementById('tl-full-body').textContent === ${JSON.stringify(answer)} && document.getElementById('tl-full-title').textContent.startsWith('차례 끝')`;
    await evaluate(`${row}.click()`);
    await waitFor(shown);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await waitFor(`!document.getElementById('tl-full').open`);
    await evaluate(`${row}.focus()`);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await waitFor(shown);
    for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x: 3, y: 3, button: "left", clickCount: 1 });
    await waitFor(`!document.getElementById('tl-full').open`);
    expect(await evaluate(`[...document.querySelectorAll('#tl-body li.prompt')].every((li) => li.classList.contains('full') && li.title.length < 20)`), "사용자 입력 줄이 전체 보기가 아니거나 긴 말풍선을 붙임");
    return `${answer.length}자`;
  });
  await check("바뀐 줄(diff) 보기: 수정 줄에 +·− 줄 수가 붙고, 누르거나 Enter 로 창에 색칠한 diff 가 열리며, 잇달아 고친 것은 옛것부터, 경로 복사는 창의 단추로, 그림의 파일 표시를 누르면 같은 창(바뀐 줄이 없으면 경로 복사), 보관 크기는 설정 슬라이더로", async () => {
    await post("/api/hook", { sid, fact: { f: "edit", tool: "Edit", path: "/tmp/작업/diff.js", lines: "3", add: 1, del: 1, diff: "@@ -3,1 +3,1 @@\n-const a = 1;\n+const a = 2;" } });
    await post("/api/hook", { sid, fact: { f: "edit", tool: "Edit", path: "/tmp/작업/diff.js", lines: "9-10", add: 2, del: 0, cut: true, diff: "@@ -9,0 +9,2 @@\n+둘째 수정\n+<img src=x onerror=alert(1)>" } });
    const row = `document.querySelector('#tl-body li.diff')`;
    await waitFor(`${row}?.textContent.includes('×2') && ${row}.querySelector('.dadd').textContent === '+3' && ${row}.querySelector('.ddel').textContent === '−1' && !${row}.dataset.ref`);
    const shown = `document.getElementById('tl-full').open && document.querySelectorAll('#tl-full pre.diff').length === 2`;
    const key = async (k, code) => { for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", { type, key: k, code: k, windowsVirtualKeyCode: code }); };
    await evaluate(`${row}.click()`);
    await waitFor(shown);
    const r = await evaluate(`(() => {
      const pres = [...document.querySelectorAll('#tl-full pre.diff')];
      const bg = (s) => getComputedStyle(document.querySelector('#tl-full .dl.' + s)).backgroundColor;
      return { title: document.getElementById('tl-full-title').textContent, first: pres[0].textContent, kinds: [...pres[0].children].map((c) => c.className),
        img: !!document.querySelector('#tl-full img'), copy: !document.getElementById('tl-full-copy').hidden, cut: document.getElementById('tl-full-body').textContent.includes('앞부분만 남겼습니다'), add: bg('add'), del: bg('del') };
    })()`);
    expect(r.title === "수정 · diff.js" && r.first.includes("const a = 1;") && r.first.includes("const a = 2;"), JSON.stringify(r)); // 옛것부터
    expect(r.kinds.join(" ") === "dl hunk dl del dl add", `줄 종류 ${r.kinds}`);
    expect(!r.img && r.copy && r.cut && r.add !== r.del, JSON.stringify(r));
    await key("Escape", 27);
    await waitFor(`!document.getElementById('tl-full').open`);
    await evaluate(`${row}.focus()`);
    await key("Enter", 13);
    await waitFor(shown);
    await key("Escape", 27);
    await waitFor(`!document.getElementById('tl-full').open`);
    // 다른 긴 글을 열면 경로 복사 단추가 숨는다
    await evaluate(`document.querySelector('#tl-body li.full').click()`);
    await waitFor(`document.getElementById('tl-full').open && document.getElementById('tl-full-copy').hidden && !document.querySelector('#tl-full pre.diff')`);
    await key("Escape", 27);
    await waitFor(`!document.getElementById('tl-full').open`);
    // 그림의 파일 표시: 고친 파일을 가리키는 상자는 같은 창(옛것부터), 고쳤어도 바뀐 줄이 남지 않은 파일(보관 끔 따위)의 상자는 경로 복사
    await mcp("draw", { ops: [{ id: "dref", kind: "box", label: "고친 파일", ref: "/tmp/작업/diff.js:3" }, { id: "nref", kind: "box", label: "바뀐 줄 없는 파일", ref: "/tmp/작업/none.js:1" }] });
    await waitFor(`document.querySelector('[data-id="dref"]')?.dataset.ref && document.querySelector('[data-id="nref"]')?.dataset.ref`);
    await post("/api/hook", { sid, fact: { f: "edit", tool: "Edit", path: "/tmp/작업/diff.js", lines: "5", add: 1, del: 0, diff: "@@ -5,0 +5,1 @@\n+셋째 수정" } });
    await post("/api/hook", { sid, fact: { f: "edit", tool: "Edit", path: "/tmp/작업/none.js", lines: "1", add: 1, del: 0 } });
    await waitFor(`document.querySelector('[data-id="dref"] .badge.edited')?.title.includes('바뀐 줄') && document.querySelector('[data-id="nref"] .badge.edited')`);
    await evaluate(`window.__copied = []; navigator.clipboard.writeText = async (t) => { window.__copied.push(t); };`);
    await evaluate(`document.querySelector('[data-id="dref"]').click()`);
    await waitFor(`document.getElementById('tl-full').open && document.querySelectorAll('#tl-full pre.diff').length === 3`);
    const box = await evaluate(`({ title: document.getElementById('tl-full-title').textContent, first: document.querySelector('#tl-full pre.diff').textContent, last: [...document.querySelectorAll('#tl-full pre.diff')].pop().textContent, copied: window.__copied.length })`);
    expect(box.title === "수정 · diff.js" && box.first.includes("const a = 1;") && box.last.includes("셋째 수정") && box.copied === 0, JSON.stringify(box));
    await key("Escape", 27);
    await waitFor(`!document.getElementById('tl-full').open`);
    await evaluate(`document.querySelector('[data-id="nref"]').click()`);
    await waitFor(`window.__copied.length === 1`);
    expect(await evaluate(`window.__copied[0] === '/tmp/작업/none.js:1' && !document.getElementById('tl-full').open`), `안 고친 파일 상자: ${await evaluate(`JSON.stringify(window.__copied)`)}`);
    await mcp("draw", { ops: [{ id: "dref", del: true }, { id: "nref", del: true }] });
    // 설정: 기본 16KB, 0(끔)~512KB 를 16KB 단위로 고르고, 서버에 저장되어 다시 열면 그대로. 구역마다 입력 칸이 같은 곳에서 시작한다
    const setDiff = (v) => evaluate(`(() => { const s = document.getElementById('cfg-diff'); s.value = '${v}'; s.dispatchEvent(new Event('input')); document.getElementById('settings-form').requestSubmit(); })()`);
    await evaluate(`document.getElementById('settings-open').click()`);
    await waitFor(`document.getElementById('settings').open && document.getElementById('cfg-diff').value === '16' && document.getElementById('cfg-diff-val').textContent === '16KB(기본)'`);
    const form = await evaluate(`(() => { const s = document.getElementById('cfg-diff'), left = (id) => Math.round(document.getElementById(id).getBoundingClientRect().left); return { min: s.min, max: s.max, step: s.step, lefts: ['cfg-phrase', 'cfg-doc', 'cfg-trash', 'cfg-diff'].map(left) }; })()`);
    expect(form.min === "0" && form.max === "512" && form.step === "16", `슬라이더 ${JSON.stringify(form)}`);
    expect(Math.max(...form.lefts) - Math.min(...form.lefts) <= 1, `입력 칸 시작 위치 ${form.lefts}`);
    // 좁은 화면(400px)에서도 설정 창이 가로로 넘치지 않고 시작 위치가 같으며, 재생 막대도 넘치지 않는다
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 900, deviceScaleFactor: 1, mobile: false });
    try {
      await waitFor(`innerWidth === 400`);
      const narrow = await evaluate(`(() => { const d = document.getElementById('settings'), b = document.getElementById('replay'), left = (id) => Math.round(document.getElementById(id).getBoundingClientRect().left); return { over: d.scrollWidth - d.clientWidth, bar: b.scrollWidth - b.clientWidth, lefts: ['cfg-phrase', 'cfg-doc', 'cfg-trash', 'cfg-diff'].map(left) }; })()`);
      expect(narrow.over <= 0 && narrow.bar <= 0 && Math.max(...narrow.lefts) - Math.min(...narrow.lefts) <= 1, `400px ${JSON.stringify(narrow)}`);
    } finally {
      await cdp.send("Emulation.clearDeviceMetricsOverride");
    }
    await setDiff(208);
    await waitFor(`!document.getElementById('settings').open`);
    expect(board.config.diffKB === 208, `저장된 크기 ${board.config.diffKB}`);
    await evaluate(`document.getElementById('settings-open').click()`);
    await waitFor(`document.getElementById('settings').open && document.getElementById('cfg-diff').value === '208' && document.getElementById('cfg-diff-val').textContent === '208KB'`);
    await setDiff(0);
    await waitFor(`!document.getElementById('settings').open`);
    expect(board.config.diffKB === 0, `저장된 크기 ${board.config.diffKB}`);
    await evaluate(`document.getElementById('settings-open').click()`);
    await waitFor(`document.getElementById('settings').open && document.getElementById('cfg-diff').value === '0' && document.getElementById('cfg-diff-val').textContent === '끔'`);
    // 512KB 로 두고 큰 수정 셋(각 40만 자)을 잇달아 하면, 창은 최근 것부터 100만 자까지만(둘) 그리고 알린다
    await evaluate(`document.getElementById('settings-open').click()`);
    await waitFor(`document.getElementById('settings').open`);
    await setDiff(512);
    await waitFor(`!document.getElementById('settings').open`);
    expect(board.config.diffKB === 512, `저장된 크기 ${board.config.diffKB}`);
    const huge = (tag) => `@@ -0,0 +1,4000 @@\n` + Array.from({ length: 4000 }, (_, i) => `+${tag} ${i} ${"y".repeat(90)}`).join("\n");
    for (const tag of ["첫째", "둘째", "셋째"]) await post("/api/hook", { sid, fact: { f: "edit", tool: "Write", path: "/tmp/작업/huge.js", lines: "1-4000", add: 4000, del: 0, diff: huge(tag) } });
    const hrow = `[...document.querySelectorAll('#tl-body li.diff')].find((li) => li.dataset.path === '/tmp/작업/huge.js')`;
    await waitFor(`${hrow}?.textContent.includes('×3')`);
    await evaluate(`${hrow}.click()`);
    await waitFor(`document.getElementById('tl-full').open && document.querySelectorAll('#tl-full pre.diff').length === 2`, 15000);
    const capped = await evaluate(`({ note: document.querySelector('#tl-full .dnote')?.textContent, first: document.querySelector('#tl-full pre.diff').textContent.slice(0, 40) })`);
    expect(capped.note === "고친 3번 가운데 최근 2번만 보입니다." && capped.first.includes("둘째"), JSON.stringify(capped));
    await key("Escape", 27);
    await waitFor(`!document.getElementById('tl-full').open`);
    await evaluate(`document.getElementById('settings-open').click()`);
    await waitFor(`document.getElementById('settings').open`);
    await setDiff(16);
    await waitFor(`!document.getElementById('settings').open`);
    expect(board.config.diffKB === 16, `되돌린 크기 ${board.config.diffKB}`);
    return r.kinds.length + "줄";
  });

  await check("재생 단추: 실시간에서 누르면 처음부터 흘러 누른 때의 끝에서 멈추고(뒤에 온 기록은 ▶ 로 이어 보며 끝에서 ↻, 이어 쌓은 장면은 실시간과 같음), 다시 누르면 처음부터, 슬라이더를 움직이면 멈추며, 빠르기는 1×·4×·16× 를 돌고 기억됨", async () => {
    const btn = `document.getElementById('play')`, rp = `window.__atv.replay`, speed = `document.getElementById('speed')`;
    expect(await evaluate(`${btn}?.getAttribute('aria-label') === '처음부터 재생' && ${speed}?.getAttribute('aria-label') === '재생 빠르기 1×'`), "재생·빠르기 단추가 없음");
    await evaluate(`${speed}.click(); ${speed}.click()`);
    expect(await evaluate(`${speed}.textContent === '16×' && ${speed}.getAttribute('aria-label') === '재생 빠르기 16×' && localStorage.getItem('atv.replaySpeed') === '16'`), "빠르기 순환·기억");
    // 누른 바로 뒤에 온 기록(기록을 받는 사이일 수도 있다)은 이번 재생의 끝에 넣지 않는다
    const seq0 = await evaluate(`window.__atv.seq`);
    await evaluate(`${btn}.click()`);
    await hook({ f: "todo", tool: "TodoWrite", text: "재생 뒤에 온 기록" });
    await waitFor(`window.__atv.seq > ${seq0}`);
    await waitFor(`${rp} && window.__atv.play && ${btn}.getAttribute('aria-label') === '멈춤'`);
    await waitFor(`!window.__atv.play && ${btn}.getAttribute('aria-label') !== '멈춤'`, 60000); // 단추는 다음 그리기에서 바뀐다
    const first = await evaluate(`({ idx: ${rp}.idx, seq: ${rp}.records[${rp}.idx].seq, last: ${rp}.records.length - 1, name: ${btn}.getAttribute('aria-label') })`);
    expect(first.seq === seq0 && first.idx === first.last - 1 && first.name === "재생", `누른 때의 끝: ${JSON.stringify(first)} (누를 때 사건 ${seq0})`);
    await evaluate(`${btn}.click()`);
    await waitFor(`${btn}.getAttribute('aria-label') === '처음부터 다시 재생'`, 60000);
    const end = await evaluate(`(() => {
      const r = window.__atv.replay, live = window.__atv.scene, norm = (s) => JSON.stringify({ items: Object.keys(s.items).sort().map((k) => s.items[k]), runs: Object.keys(s.runs).sort().map((k) => s.runs[k]), tl: s.timeline.length });
      return { idx: r.idx, last: r.records.length - 1, same: norm(r.scene) === norm(live), slider: document.getElementById('slider').value };
    })()`);
    expect(end.idx === end.last && end.same && end.slider === String(end.last), JSON.stringify(end));
    // 끝에서 다시 누르면 처음부터, 슬라이더를 직접 움직이면 멈춘다
    await evaluate(`${btn}.click()`);
    await waitFor(`${btn}.getAttribute('aria-label') === '멈춤' && ${rp}.idx < ${end.last}`);
    await evaluate(`(() => { const s = document.getElementById('slider'); s.value = '3'; s.dispatchEvent(new Event('input')); })()`);
    await waitFor(`${btn}.getAttribute('aria-label') === '재생' && ${rp}.idx === 3`);
    await new Promise((r) => setTimeout(r, 300));
    expect(await evaluate(`${rp}.idx === 3`), "슬라이더를 움직인 뒤에도 흘러감");
    await evaluate(`document.getElementById('speed').click(); document.getElementById('live').click()`);
    await waitFor(`!${rp} && ${btn}.getAttribute('aria-label') === '처음부터 재생' && document.getElementById('speed').textContent === '1×'`);
    return `기록 ${end.last + 1}개`;
  });
  await check("그림 글자 복사: 칸보다 큰 그림에서 글자 위를 끌면 화면을 옮기지 않고 글자를 고르며, 그 끝의 클릭은 경로를 복사하지 않음", async () => {
    const pick = `pick-${process.pid}`;
    await post("/api/hook", { sid: pick, pid: process.pid + 41, fact: { f: "start", cwd: "/tmp/고르기", source: "startup" } });
    // 확대하면 칸보다 커지도록 상자를 옆으로 길게 잇는다
    const chain = Array.from({ length: 8 }, (_, i) => ({ id: `g${i}`, kind: "box", label: i ? `다음 상자 ${i}` : "복사할 수 있는 상자 이름", ...(i ? {} : { ref: "src/pick.js:7" }) }));
    await post("/api/mcp", { env: pick, cwd, tool: "draw", input: { dir: "RIGHT", ops: [...chain, ...chain.slice(1).map((b, i) => ({ id: `ge${i}`, kind: "edge", from: `g${i}`, to: b.id }))] } });
    await open(pick);
    await settledPositions();
    for (let i = 0; i < 4; i++) await evaluate(`document.getElementById('zoom-in').click()`);
    await waitFor(`document.getElementById('canvas-scroll').classList.contains('pannable')`);
    const at = await evaluate(`(() => {
      const l = document.querySelector('[data-id="g0"] .lbl');
      l.scrollIntoView({ block: 'center', inline: 'center' });
      const g = document.createRange(); g.selectNodeContents(l); const r = g.getBoundingClientRect(), s = document.getElementById('canvas-scroll');
      return { x0: r.left + 2, x1: r.right - 2, y: r.top + r.height / 2, left: s.scrollLeft, top: s.scrollTop, cursor: getComputedStyle(l).cursor };
    })()`);
    await evaluate(`getSelection().removeAllRanges(); window.__copied = 0; navigator.clipboard.writeText = async () => { window.__copied++; };`);
    const mouse = (type, x, y) => cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
    await mouse("mousePressed", at.x0, at.y);
    for (let k = 1; k <= 6; k++) await mouse("mouseMoved", at.x0 + (at.x1 - at.x0) * k / 6, at.y);
    await mouse("mouseReleased", at.x1, at.y);
    await sleep(100);
    const after = await evaluate(`({ sel: getSelection().toString(), left: document.getElementById('canvas-scroll').scrollLeft, top: document.getElementById('canvas-scroll').scrollTop, copied: window.__copied })`);
    // 골라 둔 글자를 한 번 누르면 그 클릭은 경로를 복사한다(Chrome 은 선택을 클릭 뒤에야 푼다)
    for (const type of ["mousePressed", "mouseReleased"]) await mouse(type, (at.x0 + at.x1) / 2, at.y);
    await sleep(100);
    const again = await evaluate(`window.__copied`);
    await evaluate(`document.getElementById('zoom-100').click(); getSelection().removeAllRanges()`);
    expect(at.cursor === "text", `글자 위 커서: ${at.cursor}`);
    expect(after.sel.includes("상자 이름") && after.left === at.left && after.top === at.top && after.copied === 0, JSON.stringify({ at, after }));
    expect(again === 1, `골라 둔 글자를 누른 첫 클릭의 경로 복사: ${again}`);
    return `「${after.sel}」`;
  });
  await check("도움말 찾기: 쓰면 낱말이 모두 든 항목만 남기고 칠하며, 「자세히」 의 맞는 줄은 펼치고, 없으면 알리고, 비우거나 닫으면 처음대로", async () => {
    await evaluate(`document.getElementById('help-open').click()`);
    await waitFor(`document.getElementById('help').open`);
    expect(await evaluate(`document.activeElement.id === 'help-q'`), "도움말을 열어도 찾기 칸에 초점이 없음");
    // 빈 찾기 칸에 초점이 있어도 ? 로 닫히고, 다시 ? 로 열린다
    const question = async () => {
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "?", code: "Slash", text: "?", modifiers: 8 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "?", code: "Slash", modifiers: 8 });
    };
    await question();
    await waitFor(`!document.getElementById('help').open && document.getElementById('help-q').value === ''`);
    await evaluate(`document.body.focus()`);
    await question();
    await waitFor(`document.getElementById('help').open && document.activeElement.id === 'help-q'`);
    const type = (q) => evaluate(`(() => { const i = document.getElementById('help-q'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input')); })()`);
    const state = `(() => {
      const h = document.getElementById('help'), vis = (e) => e.getClientRects().length > 0;
      const items = [...h.querySelectorAll('dl > dt')].filter(vis).map((dt) => dt.textContent + ' ' + dt.nextElementSibling.textContent)
        .concat([...h.querySelectorAll('details li')].filter(vis).map((li) => li.closest('details').querySelector('summary').textContent + ' ' + li.textContent));
      return { items, open: [...h.querySelectorAll('details')].filter((d) => d.open).length, h3: [...h.querySelectorAll('h3')].filter(vis).length, lead: vis(h.querySelector('.lead')),
        none: vis(document.getElementById('help-none')), marks: CSS.highlights.get('help-hit')?.size || 0 };
    })()`;
    const all = await evaluate(state);
    await type("휴지통 지우");
    const hit = await evaluate(state);
    expect(hit.items.length > 0 && hit.items.length < all.items.length && hit.items.every((t) => t.includes("휴지통") && t.includes("지우")), JSON.stringify(hit.items));
    expect(hit.open > 0 && hit.h3 < all.h3 && !hit.lead && !hit.none && hit.marks >= 2, JSON.stringify({ ...hit, items: hit.items.length }));
    await type("없는낱말xyz");
    const none = await evaluate(state);
    expect(none.items.length === 0 && none.none && none.h3 === 0, JSON.stringify(none));
    await type("");
    const back = await evaluate(state);
    expect(back.items.length === all.items.length && back.open === all.open && back.lead && !back.none && back.marks === 0, JSON.stringify({ ...back, items: back.items.length }));
    await type("휴지통");
    await evaluate(`document.getElementById('help-close').click()`);
    await evaluate(`document.getElementById('help-open').click()`);
    await waitFor(`document.getElementById('help').open`);
    const again = await evaluate(state);
    await evaluate(`document.getElementById('help-close').click()`);
    expect(again.items.length === all.items.length && await evaluate(`document.getElementById('help-q').value === ''`), "닫았다 열어도 찾기가 남음");
    return `「휴지통 지우」 ${hit.items.length} / ${all.items.length}개`;
  });
  await check("프로젝트 지우기: 「프로젝트 없음」 머리는 흐린 색, ⋯ 의 「지우기」 는 대화를 남기고 「끝난 대화까지 지우기」 는 끝난 대화도 휴지통으로", async () => {
    const live = `pj-live-${process.pid}`, done = `pj-done-${process.pid}`;
    for (const [i, id] of [live, done].entries()) {
      await post("/api/hook", { sid: id, pid: process.pid + 90 + i, fact: { f: "start", cwd: "/tmp/지우기", source: "startup" } });
      await post("/api/hook", { sid: id, pid: process.pid + 90 + i, fact: { f: "prompt", text: `지우기 시험 ${i}` } });
    }
    await post("/api/hook", { sid: done, pid: process.pid + 91, fact: { f: "end", reason: "other" } });
    const r0 = await fetch(`http://127.0.0.1:${board.port}/api/board`, { method: "POST", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${board.port}`, Host: `127.0.0.1:${board.port}`, cookie: `atv_r=${keys.read}`, "x-atv-board": keys.board }, body: JSON.stringify({ op: "proj-new", name: "지울 프로젝트" }) });
    const made = await r0.json();
    await fetch(`http://127.0.0.1:${board.port}/api/board`, { method: "POST", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${board.port}`, Host: `127.0.0.1:${board.port}`, cookie: `atv_r=${keys.read}`, "x-atv-board": keys.board }, body: JSON.stringify({ op: "proj-set", sids: [live, done], pid: made.pid }) });
    await open(sid);
    await waitFor(`document.querySelector('#sess-body .pmenu[data-pid="${made.pid}"]') !== null`);
    const muted = await evaluate(`(() => { const i = document.createElement('i'); i.style.color = 'var(--muted)'; document.body.append(i); const c = getComputedStyle(i).color; i.remove(); const n = document.querySelector('#sess-body .gfold.none'); return n && getComputedStyle(n).color === c; })()`);
    expect(muted, "「프로젝트 없음」 머리가 흐린 색이 아님");
    await evaluate(`document.querySelector('#sess-body .pmenu[data-pid="${made.pid}"]').click()`);
    await waitFor(`!document.getElementById('group-menu').hidden`);
    const items = await evaluate(`[...document.querySelectorAll('#group-menu .gm-item')].map((b) => b.textContent)`);
    expect(items.includes("지우기") && items.includes("끝난 대화까지 지우기(1개)") && !items.includes("풀기"), JSON.stringify(items));
    for (let k = 0; k < 2; k++) await evaluate(`[...document.querySelectorAll('#group-menu .gm-item')].find((b) => b.textContent.startsWith(${k ? "'한 번 더'" : "'끝난 대화까지'"})).click()`);
    await waitFor(`!window.__atv.sessions.has(${JSON.stringify(done)}) && document.querySelector('#sess-body .pmenu[data-pid="${made.pid}"]') === null`);
    expect(board.sessions.has(live) && !board.sessions.has(done) && !board.projects.projects[made.pid], "지운 결과가 다름");
    expect(!board.projects.members[live] || board.projects.members[live].pid !== made.pid, "진행 중인 대화가 지운 프로젝트에 남음");
  });
  await check("판 갈아 끼우기: 다시 붙은 화판 서버의 코드 표지가 다르면 페이지를 새로 읽고, 같으면 그대로", async () => {
    await open(sid);
    const code = await evaluate(`window.__atv.code`);
    expect(typeof code === "string" && code.length === 12, `코드 표지: ${code}`);
    // 다시 붙은 서버가 보낸 config 처럼 사건을 흉내 낸다. 새로 읽으면 표시(__mark)가 사라진다
    const fire = (c) => evaluate(`(() => { window.__mark = 1; window.__atv.es.dispatchEvent(new MessageEvent('config', { data: JSON.stringify({ ...window.__atv.config, code: ${JSON.stringify(c)} }) })); return 1; })()`);
    await fire(code);
    await sleep(300);
    expect(await evaluate(`window.__mark === 1`), "같은 표지인데 새로 읽음");
    await fire("다른판000000");
    await waitFor(`window.__mark === undefined && window.__atv?.code === ${JSON.stringify(code)}`, 10000);
  });
  await check("프로젝트 순서: 이름을 끌어 다른 프로젝트 아래에 놓으면 순서가 바뀌어 서버에 남고, ⋯ 의 「위로 옮기기」 로 되돌아감", async () => {
    const op = async (body) => (await fetch(`http://127.0.0.1:${board.port}/api/board`, { method: "POST", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${board.port}`, Host: `127.0.0.1:${board.port}`, cookie: `atv_r=${keys.read}`, "x-atv-board": keys.board }, body: JSON.stringify(body) })).json();
    const a = (await op({ op: "proj-new", name: "순서 가" })).pid, b = (await op({ op: "proj-new", name: "순서 나" })).pid;
    await open(sid);
    const order = `[...document.querySelectorAll('#sess-body .gsec[data-pid]')].map((s) => s.dataset.pid).filter((p) => p === ${JSON.stringify(a)} || p === ${JSON.stringify(b)})`;
    await waitFor(`${order}.length === 2`);
    const before = await evaluate(order);
    const [top, low] = before;
    // 위 프로젝트의 이름을 끌어 아래 프로젝트 머리의 아래쪽 절반에 놓는다
    await evaluate(`(() => {
      const src = document.querySelector('#sess-body .gsec[data-pid=' + JSON.stringify(${JSON.stringify(top)}) + '] .gfold');
      const target = document.querySelector('#sess-body .gsec[data-pid=' + JSON.stringify(${JSON.stringify(low)}) + ']');
      const r = target.getBoundingClientRect(), y = r.top + target.querySelector('.ghead').offsetHeight - 1;
      const dt = new DataTransfer();
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
      src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    })()`);
    await waitFor(`JSON.stringify(${order}) === ${JSON.stringify(JSON.stringify([low, top]))}`);
    expect(board.projects.projects[low].pos < board.projects.projects[top].pos, "서버에 순서가 남지 않음");
    await evaluate(`document.querySelector('#sess-body .pmenu[data-pid=' + JSON.stringify(${JSON.stringify(top)}) + ']').click()`);
    await waitFor(`!document.getElementById('group-menu').hidden`);
    await evaluate(`[...document.querySelectorAll('#group-menu .gm-item')].find((x) => x.textContent === '위로 옮기기').click()`);
    await waitFor(`JSON.stringify(${order}) === ${JSON.stringify(JSON.stringify(before))}`);
    for (const pid of [a, b]) await op({ op: "proj-drop", pid });
    return `${before.join(",")} → 바꾸고 되돌림`;
  });
  await check("지난 세션 모두 지우기: 지난 세션 머리의 ⋯ 에서 두 번 누르면 그 묶음의 지난 세션이 모두 지워지고 다른 줄은 남음", async () => {
    const olds = [`past-a-${process.pid}`, `past-b-${process.pid}`];
    for (const [i, id] of olds.entries()) {
      await post("/api/hook", { sid: id, pid: process.pid + 95 + i, fact: { f: "start", cwd: "/tmp/지난", source: "startup" } });
      await post("/api/hook", { sid: id, pid: process.pid + 95 + i, fact: { f: "prompt", text: `지난 일 ${i}` } });
      await post("/api/hook", { sid: id, pid: process.pid + 95 + i, fact: { f: "end", reason: "other" } });
      board.sessions.get(id).scene.sess.lastT = Date.now() - 3 * 86_400_000;
    }
    await reopen(sid);
    await waitFor(`document.querySelector('#sess-body .pmenu[data-past=""]') !== null`);
    const before = await evaluate(`window.__atv.sessions.size`);
    await evaluate(`document.querySelector('#sess-body .pmenu[data-past=""]').click()`);
    await waitFor(`!document.getElementById('group-menu').hidden && document.querySelector('#group-menu .gm-del')?.textContent.startsWith('지난 세션 모두 지우기')`);
    for (let k = 0; k < 2; k++) await evaluate(`document.querySelector('#group-menu .gm-del').click()`);
    await waitFor(`${JSON.stringify(olds)}.every((id) => !window.__atv.sessions.has(id))`);
    expect(board.sessions.has(sid), "지금 세션이 지워짐");
    // 목록은 다음 프레임에 다시 그린다(상태가 바뀐 바로 그때 읽으면 옛 목록이 보일 수 있다)
    await waitFor(`!document.querySelector('#sess-body .pmenu[data-past=""]')`, 2000).catch(() => { throw new Error("지난 세션 머리가 남음"); });
    return `세션 ${before} → ${await evaluate(`window.__atv.sessions.size`)}`;
  });
  await check("작업 중 표시: 작업 중·입력 필요 줄은 왼쪽 띠와 바탕, 상태 글자와 계획 「지금」 줄에 빛이 지나가고(움직임 줄이기면 멈춤), 맨 위 표지는 움직이지 않음", async () => {
    const wait = `wait-${process.pid}`;
    await post("/api/hook", { sid: wait, pid: process.pid + 80, fact: { f: "start", cwd: "/tmp/입력", source: "startup" } });
    await post("/api/hook", { sid: wait, pid: process.pid + 80, fact: { f: "prompt", text: "권한 묻는 세션" } });
    await post("/api/hook", { sid: wait, pid: process.pid + 80, fact: { f: "notify", ntype: "permission_prompt", text: "needs permission" } });
    await post("/api/hook", { sid, fact: { f: "prompt", text: "다시 일하기" } });
    await mcp("plan", { steps: [{ id: "s1", status: "doing" }] });
    await open(sid);
    await waitFor(`document.querySelector('#sess-body .sess.working .stw.working') !== null && document.querySelector('#sess-body .sess.input .stw.input') !== null && document.getElementById('plan-now').classList.contains('live')`);
    const look = () => evaluate(`(() => {
      const color = (v) => { const i = document.createElement('i'); i.style.color = v; document.body.append(i); const c = getComputedStyle(i).color; i.remove(); return c; };
      const work = document.querySelector('#sess-body .sess.working'), inp = document.querySelector('#sess-body .sess.input');
      // 빛은 겹친 글자(.shine > span)와 띠 가림막(.shine)이 transform 으로 움직여 만든다. 바탕 글자는 원래 색 그대로다
      const win = (host) => { const s = host.querySelector(':scope > .shine'); return s && getComputedStyle(s).display !== 'none' ? getComputedStyle(s).animationName + '+' + getComputedStyle(s.firstChild).animationName : 'none'; };
      const stw = work.querySelector('.stw');
      return { w: win(stw), i: win(inp.querySelector('.stw')), now: win(document.querySelector('#plan-now > span')), fill: getComputedStyle(stw).color, peak: getComputedStyle(stw.querySelector('.shine > span')).color, shine: color('var(--shine)'),
        hidden: stw.querySelector('.shine').getAttribute('aria-hidden'), chip: getComputedStyle(document.getElementById('sess-chip')).animationName,
        workLeft: getComputedStyle(work).borderLeftColor, inLeft: getComputedStyle(inp).borderLeftColor, doing: color('var(--s-doing)'), wait: color('var(--s-wait)'),
        workBg: getComputedStyle(work).backgroundColor, inBg: getComputedStyle(inp).backgroundColor };
    })()`);
    const r = await look();
    const both = "shine-win+shine-copy";
    expect(r.w === both && r.i === both && r.now === both && r.fill === r.doing && r.peak === r.shine && r.hidden === "true", `반짝임 ${JSON.stringify(r)}`);
    // 글자 폭의 세 배인 가림막이 계획 칸에 가로 스크롤을 만들지 않는다
    const wide = await evaluate(`(() => { const p = document.getElementById('plan'); return p.scrollWidth - p.clientWidth; })()`);
    expect(wide <= 0, `계획 칸이 가로로 ${wide}px 넘침`);
    // 1초마다 「지금」 줄을 고치고 목록을 다시 그려도 빛은 처음부터 다시 시작하지 않는다(위상이 문서 시계를 따른다)
    const phase = `(() => [document.querySelector('#plan-now > span > .shine'), document.querySelector('#sess-body .sess.working .shine')].map((e) => Math.round((e.getAnimations()[0].effect.getComputedTiming().progress * 2400 - document.timeline.currentTime % 2400 + 4800) % 2400)))()`;
    const p1 = await evaluate(phase);
    const nodes = `[document.querySelector('#plan-now > span'), document.querySelector('#sess-body .sess.working .stw')]`;
    await evaluate(`window.__shineOld = ${nodes}`);
    // 「지금」 줄은 단계 이름이 바뀌면, 목록은 마지막 활동 시각만 바뀐 요약을 모아 2초 뒤에 다시 만든다
    await mcp("plan", { steps: [{ id: "s1", title: stepTitles[0] + " (반짝임 확인)" }] });
    await post("/api/hook", { sid, fact: { f: "run-start", id: "shine-1", cmd: "sleep 1", desc: "목록 다시 그리기" } });
    await waitFor(`(() => { const n = ${nodes}; return n[0] !== window.__shineOld[0] && n[1] !== window.__shineOld[1]; })()`, 4000);
    await sleep(300);
    const p2 = await evaluate(phase);
    await mcp("plan", { steps: [{ id: "s1", title: stepTitles[0] }] });
    expect([...p1, ...p2].every((d) => d < 60 || d > 2340), `반짝임 위상이 문서 시계와 어긋남(다시 시작함): ${p1} → ${p2}`);
    expect(r.chip === "none", `맨 위 표지가 움직임: ${r.chip}`);
    expect(r.workLeft === r.doing && r.inLeft === r.wait && r.workBg !== "rgba(0, 0, 0, 0)" && r.inBg !== "rgba(0, 0, 0, 0)", JSON.stringify(r));
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    const still = await look();
    await cdp.send("Emulation.setEmulatedMedia", { features: [] });
    expect(still.w === "none" && still.i === "none" && still.now === "none" && still.fill === still.doing, `움직임 줄이기 ${JSON.stringify(still)}`);
    await post("/api/hook", { sid, fact: { f: "run-end", id: "shine-1", cmd: "sleep 1", desc: "목록 다시 그리기" } });
    // 세션이 쉬면 계획 「지금」 줄은 멈춘다(단계는 여전히 진행 중)
    await post("/api/hook", { sid, fact: { f: "stop", last: "쉼" } });
    await waitFor(`!document.getElementById('plan-now').classList.contains('live')`);
  });
  await open(sid);

  await check("타임라인은 있던 줄을 다시 만들지 않고 새 줄만 넣으며, 보지 않는 세션의 사건은 보는 화면을 다시 그리지 않음", async () => {
    await waitFor(`document.querySelectorAll('#tl-body li').length > 3`);
    await evaluate(`window.__tl = [...document.querySelectorAll('#tl-body li')]; window.__plan = document.querySelector('#plan-body > ul')`);
    await mcp("note", { text: "줄 재사용 확인" });
    await waitFor(`document.querySelector('#tl-body li')?.textContent.includes('줄 재사용 확인')`);
    const kept = await evaluate(`window.__tl.filter((li) => li.isConnected).length + '/' + window.__tl.length`);
    const [k, n] = kept.split("/").map(Number);
    expect(k >= n - 1, `있던 줄을 다시 만듦: ${kept}`); // 400줄을 넘으면 맨 끝 한 줄은 빠질 수 있다
    await evaluate(`window.__tl = [...document.querySelectorAll('#tl-body li')]`);
    const other = `other-${process.pid}`;
    await post("/api/hook", { sid: other, fact: { f: "start", cwd: "/tmp/다른", source: "startup" } });
    await post("/api/hook", { sid: other, fact: { f: "prompt", text: "다른 세션" } });
    await waitFor(`[...document.querySelectorAll('#sess-body .sess')].some((b) => b.textContent.includes('다른 세션'))`);
    const same = await evaluate(`window.__tl.every((li, i) => document.querySelectorAll('#tl-body li')[i] === li) && document.querySelector('#plan-body > ul') === window.__plan`);
    expect(same, "다른 세션의 사건에 타임라인·계획이 다시 만들어짐");
    // 옛 기록을 보는 중에 위에 줄이 붙어도 보던 줄은 화면에서 제자리에 있다(코드 보정과 브라우저 스크롤 고정이 겹치지 않음)
    for (let i = 0; i < 30; i++) await mcp("note", { text: `스크롤 채우기 ${i}` });
    await waitFor(`document.getElementById('timeline').scrollHeight > document.getElementById('timeline').clientHeight + 300`);
    await evaluate(`(() => { const box = document.getElementById('timeline'); box.scrollTop = 200; window.__row = [...document.querySelectorAll('#tl-body li')].find((li) => li.getBoundingClientRect().top >= box.getBoundingClientRect().top + 40); window.__rowTop = window.__row.getBoundingClientRect().top; window.__dbg0 = { st: box.scrollTop, band: document.getElementById('band').offsetHeight, top: document.getElementById('top').offsetHeight, boxTop: Math.round(box.getBoundingClientRect().top), n: document.querySelectorAll('#tl-body li').length, sy: Math.round(scrollY), side: Math.round(document.getElementById('side').getBoundingClientRect().top), hplan: document.getElementById('side').style.getPropertyValue('--h-plan'), vh: innerHeight }; return 1; })()`);
    await sleep(100);
    await mcp("note", { text: "위에 붙는 줄" });
    await waitFor(`!document.getElementById('tl-new').hidden`);
    const moved = await evaluate(`Math.round(window.__row.getBoundingClientRect().top - window.__rowTop)`);
    const dbg = await evaluate(`JSON.stringify({ before: window.__dbg0, after: { st: document.getElementById('timeline').scrollTop, band: document.getElementById('band').offsetHeight, top: document.getElementById('top').offsetHeight, boxTop: Math.round(document.getElementById('timeline').getBoundingClientRect().top), n: document.querySelectorAll('#tl-body li').length, conn: window.__row.isConnected, txt: window.__row.textContent.slice(0, 30), sy: Math.round(scrollY), side: Math.round(document.getElementById('side').getBoundingClientRect().top), hplan: document.getElementById('side').style.getPropertyValue('--h-plan'), vh: innerHeight,
      extra: [...document.body.children].filter((e) => !['top', 'band', 'replay'].includes(e.id) && e.tagName !== 'MAIN' && getComputedStyle(e).position === 'static' && getComputedStyle(e).display !== 'none').map((e) => e.tagName + '#' + e.id + ':' + e.offsetHeight) } })`);
    expect(moved === 0, `보던 줄이 ${moved}px 밀림 ${dbg}`);
    await evaluate(`document.getElementById('timeline').scrollTop = 0`);
    return `있던 줄 ${kept} 그대로`;
  });

  // ---- 19: 도형 옮기기(Ctrl + 왼쪽 끌기) ----
  const mv = `move-${process.pid}`;
  const mvHook = (fact) => post("/api/hook", { sid: mv, pid: process.pid + 140, fact });
  const mvDraw = (input) => post("/api/mcp", { env: mv, cwd, tool: "draw", input });
  await mvHook({ f: "start", cwd: "/tmp/옮기기", source: "startup" });
  await mvHook({ f: "prompt", text: "도형 옮기기 시험" });
  await mvDraw({ ops: [
    { id: "g", kind: "group", label: "묶음" }, { id: "a", kind: "box", label: "가 상자", in: "g" }, { id: "b", kind: "box", label: "나 상자", in: "g" },
    { id: "c", kind: "box", label: "다 상자", ref: "/tmp/옮기기/c.js:3" }, { id: "ac", kind: "edge", from: "a", to: "c" }, { id: "bc", kind: "edge", from: "b", to: "c" },
  ] });
  await open(mv);
  await settledPositions();
  const rect = (id) => evaluate(`(() => { const r = document.querySelector('#canvas .part[data-id="${id}"]').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const pathD = (id) => evaluate(`document.querySelector('#canvas path[data-id="${id}"]')?.getAttribute('d') || ''`);
  const ctrlDrag = async (id, dx, dy, top = false) => {
    const r = await rect(id), x = r.x + Math.min(20, r.w / 2), y = top ? r.y + 10 : r.y + r.h / 2; // top: 묶음 제목 자리
    const ev = (type, px, py, buttons) => cdp.send("Input.dispatchMouseEvent", { type, x: px, y: py, button: "left", buttons, modifiers: 2, clickCount: 1 });
    await ev("mousePressed", x, y, 1);
    for (let i = 1; i <= 8; i++) await ev("mouseMoved", x + (dx * i) / 8, y + (dy * i) / 8, 1);
    await ev("mouseReleased", x + dx, y + dy, 0);
  };
  const posOf = (id) => board.sessions.get(mv).scene.items[id].pos;
  await check("도형 옮기기: Ctrl + 왼쪽 끌기로 옮기고 기록에 남으며, 닿는 선만 다시 긋고 「자동 배치로」 가 보임(화면 끌기·경로 복사·글자 고르기는 하지 않음)", async () => {
    await evaluate(`window.__ctx = 0; document.addEventListener('contextmenu', (e) => { if (!e.defaultPrevented) window.__ctx++; }, { capture: false }); 1`);
    const before = await rect("c"), dAc = await pathD("ac"), zoom = await evaluate("window.__atv && Number(localStorage.getItem('atv.zoom') || 1)");
    expect(await evaluate(`document.getElementById('auto-place').hidden`), "옮기기 전에 「자동 배치로」 가 보임");
    const scroll0 = await evaluate(`[document.getElementById('canvas-scroll').scrollLeft, document.getElementById('canvas-scroll').scrollTop].join()`);
    await evaluate(`document.getElementById('toast').hidden = true; 1`);
    await ctrlDrag("c", 90, 60);
    await waitFor(`!!${JSON.stringify(mv)} && document.getElementById('auto-place').hidden === false`);
    const p = posOf("c");
    expect(p && Number.isInteger(p.x) && Number.isInteger(p.y), `기록된 자리 없음 ${JSON.stringify(p)}`);
    await sleep(200);
    const after = await rect("c");
    expect(Math.abs(after.x - before.x - 90) <= 2 && Math.abs(after.y - before.y - 60) <= 2, `옮긴 거리 ${after.x - before.x},${after.y - before.y}(배율 ${zoom})`);
    expect((await pathD("ac")) !== dAc, "닿는 선을 다시 긋지 않음");
    expect((await evaluate("window.__ctx")) === 0, "Ctrl + 클릭에 브라우저 메뉴가 뜸");
    expect(await evaluate(`document.getElementById('toast').hidden`), `끈 뒤 경로를 복사함: ${await evaluate(`document.getElementById('toast').textContent`)}`);
    expect((await evaluate(`[document.getElementById('canvas-scroll').scrollLeft, document.getElementById('canvas-scroll').scrollTop].join()`)) === scroll0, "Ctrl + 끌기에 그림 화면도 움직임");
    expect((await evaluate(`String(getSelection())`)) === "", "끄는 동안 글자가 골라짐");
    return `c → ${JSON.stringify(p)}`;
  });
  await check("도형 옮기기: 묶음 안 도형은 묶음 밖으로 나가지 않고, 묶음을 옮기면 안의 도형이 함께 가며, 다시 열어도 그 자리", async () => {
    const g0 = await rect("g");
    await ctrlDrag("a", -400, -400);
    await waitFor(`true`);
    for (let i = 0; i < 40 && !posOf("a"); i++) await sleep(50);
    const a = await rect("a"), g = await rect("g");
    expect(a.x >= g.x && a.y >= g.y && a.x + a.w <= g.x + g.w + 1 && a.y + a.h <= g.y + g.h + 1, `묶음 밖으로 나감 ${JSON.stringify({ a, g })}`);
    const b0 = await rect("b");
    await ctrlDrag("g", 40, 120, true);
    for (let i = 0; i < 40 && !posOf("g"); i++) await sleep(50);
    await sleep(200);
    const g1 = await rect("g"), b1 = await rect("b");
    expect(Math.round(g1.x - g0.x) === 40 && Math.round(b1.x - b0.x) === 40 && Math.round(b1.y - b0.y) === Math.round(g1.y - g0.y), `묶음과 안 도형이 함께 가지 않음 ${JSON.stringify({ g0, g1, b0, b1 })}`);
    // Claude 가 새 도형을 그려 다시 배치해도 놓은 자리 그대로
    const c0 = await rect("c");
    await mvDraw({ ops: [{ id: "d", kind: "box", label: "새 상자" }, { id: "cd", kind: "edge", from: "c", to: "d" }] });
    await waitFor(`!!document.querySelector('#canvas .part[data-id="d"]')`);
    await settledPositions();
    const c1 = await rect("c");
    expect(Math.abs(c1.x - c0.x) <= 1 && Math.abs(c1.y - c0.y) <= 1, `다시 배치 뒤 옮긴 자리가 바뀜 ${JSON.stringify({ c0, c1 })}`);
    await open(mv);
    await settledPositions();
    const c2 = await rect("c");
    expect(Math.abs(c2.x - c1.x) <= 1 && Math.abs(c2.y - c1.y) <= 1, "다시 열면 자리가 바뀜");
  });
  await check("도형 옮기기: Shift + 화살표는 10px, Ctrl + 오른쪽 클릭은 그 도형만 처음 자리로, 「자동 배치로」 는 모두", async () => {
    const p0 = posOf("c");
    await evaluate(`document.querySelector('#canvas .part[data-id="c"]').focus()`);
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, modifiers: 8 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, modifiers: 8 });
    for (let i = 0; i < 40 && posOf("c").x === p0.x; i++) await sleep(50);
    expect(posOf("c").x === p0.x + 10 && posOf("c").y === p0.y, `Shift + → ${JSON.stringify(posOf("c"))}`);
    await ctrlDrag("c", 0, 0);
    for (let i = 0; i < 40 && posOf("c"); i++) await sleep(50);
    expect(!posOf("c") && posOf("g"), "Ctrl + 클릭이 그 도형만 되돌리지 않음");
    expect(await evaluate(`document.getElementById('toast').hidden || !document.getElementById('toast').textContent.includes('c.js')`), "Ctrl + 클릭이 경로를 복사함");
    await evaluate(`document.getElementById('auto-place').click()`);
    for (let i = 0; i < 40 && Object.values(board.sessions.get(mv).scene.items).some((x) => x.pos); i++) await sleep(50);
    expect(!Object.values(board.sessions.get(mv).scene.items).some((x) => x.pos), "「자동 배치로」 뒤에도 옮긴 자리가 남음");
    await waitFor(`document.getElementById('auto-place').hidden`);
  });

  // ---- 19: 찾기 ----
  const other = `find-${process.pid}`;
  await post("/api/hook", { sid: other, pid: process.pid + 141, fact: { f: "start", cwd: "/tmp/다른곳", source: "startup" } });
  await post("/api/hook", { sid: other, pid: process.pid + 141, fact: { f: "prompt", text: "무지개다리 고치기" } });
  await post("/api/hook", { sid: other, pid: process.pid + 141, fact: { f: "run-end", id: "rainbow", cmd: "make rainbowbridge", desc: "무지개다리 빌드" } });
  await mvHook({ f: "run-end", id: "old-1", cmd: "echo 옛날찾기", desc: "옛 기록 시험" });
  for (let i = 0; i < 420; i++) await mvHook({ f: "run-end", id: `fill-${i}`, cmd: `true ${i}`, desc: "채우기" });
  await open(mv);
  await check("찾기: / 로 열고 이 화판·타임라인(400줄 밖)·세션·다른 세션 기록을 묶어 보이며, ↑ ↓ · Enter 로 그 자리로 감", async () => {
    await evaluate(`document.activeElement?.blur(); 1`);
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "/", code: "Slash", windowsVirtualKeyCode: 191 });
    await waitFor(`!document.getElementById('search').hidden && document.activeElement === document.getElementById('search-q')`);
    const type = (q) => evaluate(`(() => { const i = document.getElementById('search-q'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input')); return 1; })()`);
    await type("상자");
    const heads = await evaluate(`[...document.querySelectorAll('#search .s-head')].map((h) => h.textContent)`);
    expect(heads[0].startsWith("이 화판") && (await evaluate(`document.querySelectorAll('#search mark').length`)) > 0, `묶음 ${heads}`);
    // 400줄 밖 옛 줄로 간다. 타임라인 칸을 접어 두었어도 펴고 간다
    await evaluate(`document.getElementById('search-q').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.getElementById('fold-tl').click(); 1`);
    await waitFor(`document.getElementById('side').classList.contains('fold-tl')`);
    await evaluate(`document.getElementById('search-open').click()`);
    await type("옛날찾기");
    await waitFor(`[...document.querySelectorAll('#search .s-head')].some((h) => h.textContent.startsWith('이 세션 타임라인'))`);
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await waitFor(`document.getElementById('search').hidden && !document.getElementById('side').classList.contains('fold-tl') && [...document.querySelectorAll('#tl-body li')].some((li) => li.textContent.includes('옛 기록 시험') && li.classList.contains('flash') && li.getBoundingClientRect().height > 0)`);
    // 다른 세션 기록(서버)에서 고르면 그 세션으로 간다
    await evaluate(`document.getElementById('search-open').click()`);
    await type("rainbowbridge");
    await waitFor(`[...document.querySelectorAll('#search .s-head')].some((h) => h.textContent.startsWith('다른 세션 기록')) && document.querySelectorAll('#search .s-opt').length > 0`, 4000);
    const first = await evaluate(`document.querySelector('#search .s-opt[aria-selected="true"]')?.textContent || ''`);
    expect(first.includes("rainbowbridge"), `고른 줄 ${first}`);
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await waitFor(`window.__atv.sid === ${JSON.stringify(other)} && [...document.querySelectorAll('#tl-body li.flash')].some((li) => li.textContent.includes('무지개다리 빌드'))`, 6000);
    // 서버 찾기를 받기 전에 닫았다가 같은 말로 다시 열어도 결과가 온다
    await evaluate(`document.getElementById('search-open').click()`);
    await type("rainbowbridge");
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await evaluate(`document.getElementById('search-open').click()`);
    await waitFor(`[...document.querySelectorAll('#search .s-opt')].some((o) => o.textContent.includes('rainbowbridge'))`, 4000);
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    // 끝난 상위 단계 아래의 끝난 단계로 가면 그 단계까지 펼쳐 보이고 초점을 준다(다음 그리기에도 남음)
    await post("/api/mcp", { env: other, cwd, tool: "plan", input: { steps: [{ id: "p1", title: "위 단계", status: "done" }, { id: "p2", title: "숨은단계찾기", status: "done", parent: "p1" }, { id: "p3", title: "지금", status: "doing" }] } });
    await waitFor(`!!document.querySelector('#plan-body li[data-id="p3"]') && !document.querySelector('#plan-body li[data-id="p2"]')`);
    await evaluate(`document.getElementById('search-open').click()`);
    await type("숨은단계찾기");
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await waitFor(`document.activeElement === document.querySelector('#plan-body li[data-id="p2"]')`);
    await sleep(1300); // 1초 타이머가 계획을 다시 그려도 남는다
    expect(await evaluate(`!!document.querySelector('#plan-body li[data-id="p2"]')`), "다음 그리기에서 단계가 다시 숨음");
    // Ctrl + K 로 열고 Esc 로 닫으면 초점이 돌아간다
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "k", code: "KeyK", windowsVirtualKeyCode: 75, modifiers: 2 });
    await waitFor(`!document.getElementById('search').hidden`);
    await type("없을것같은낱말zzz");
    await waitFor(`document.getElementById('search-status').textContent.includes('찾은 것이 없습니다') && document.getElementById('search-status').getAttribute('role') === 'status'`, 4000);
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await waitFor(`document.getElementById('search').hidden`);
    return `묶음 ${heads.join(" / ")}`;
  });

  // ---- 21: 옛 그림 표시 ----
  await check("옛 그림: 새 작업을 올린 뒤 그림이 그대로면 10초 뒤 그림 위에 「지난 작업 때 그린 그림」 이 보이고, 그 작업의 다음 plan 결과에 한 번 알리며, 그리면 사라짐", async () => {
    const mvMcp = async (tool, input) => (await fetch(base + "/api/mcp", {
      method: "POST", headers: { "content-type": "application/json", "x-atv-key": keys.write, Host: host },
      body: JSON.stringify({ env: mv, cwd, tool, input }), signal: AbortSignal.timeout(5000),
    })).text();
    await open(mv);
    await waitFor(`!!document.querySelector('#canvas .part[data-id="c"]')`);
    expect(await evaluate(`document.getElementById('stale').hidden`), "새 작업 전에 옛 그림 표시가 보임");
    // 마지막 그림이 10초(DRAW_SLACK) 안이면 같은 작업의 그림으로 친다. 그보다 오래된 그림으로 시험한다
    const drawT = board.sessions.get(mv).scene.view.drawT;
    expect(drawT > 0, `그림 시각이 없음 ${JSON.stringify(board.sessions.get(mv).scene.view)}`);
    await sleep(Math.max(0, drawT + 10_500 - Date.now()));
    await mvMcp("plan", { steps: [{ id: "n1", title: "새 작업", status: "doing" }, { id: "n2", title: "검증" }] });
    await sleep(1000);
    expect(await evaluate(`document.getElementById('stale').hidden`), "같은 메시지의 draw 를 기다리지 않고 바로 보임");
    // 기다리는 사이 다른 세션으로 바꾸면 그 세션에는 보이지 않는다(걸어 둔 타이머가 남아도)
    await open(sid);
    await sleep(Math.max(0, board.sessions.get(mv).scene.view.taskT + 10_500 - Date.now()));
    expect(await evaluate(`document.getElementById('stale').hidden`), "다른 세션 화면에 옛 그림 표시가 보임");
    await open(mv);
    await waitFor(`!document.getElementById('stale').hidden && document.getElementById('stale').textContent.startsWith('지난 작업 때 그린 그림 · ')`, 3000);
    // 표시가 그림 칸을 넓히지 않는다(넓은 창·창 반쪽 폭·좁은 화면)
    for (const width of [1440, 950, 700]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      try {
        await sleep(150);
        const box = await evaluate(`(() => { const r = (id) => document.getElementById(id).getBoundingClientRect(); const z = document.getElementById('zoombar');
          return { wrap: r('canvas-wrap').right, bar: r('zoombar').right, scroll: r('canvas-scroll').right, over: z.scrollWidth - z.clientWidth, page: document.documentElement.scrollWidth - innerWidth, chip: r('stale').width }; })()`);
        expect(box.bar <= box.wrap + 1 && box.scroll <= box.wrap + 1 && box.over <= 1 && box.page <= 0 && box.chip > 20, `${width}px 에서 넘침 ${JSON.stringify(box)}`);
      } finally { await cdp.send("Emulation.clearDeviceMetricsOverride"); }
    }
    const text = await mvMcp("plan", { steps: [{ id: "n1", status: "done" }, { id: "n2", status: "doing" }] });
    expect(text.includes("from before this task's steps"), `plan 결과에 알림 없음: ${text}`);
    expect(!(await mvMcp("plan", { steps: [{ id: "n2", status: "done" }] })).includes("from before"), "같은 작업에서 두 번 알림");
    await mvDraw({ ops: [{ id: "c", status: "done" }] });
    await waitFor(`document.getElementById('stale').hidden`);
    return await evaluate(`document.getElementById('stale').textContent`);
  });
  await open(sid);

  // ---- 26: 끝난 단계의 id 를 새 제목으로 다시 쓰기 ----
  await check("끝난 단계의 id 를 새 제목으로 다시 쓰면 할 일로 보이고, 진행하면 옛 파일 수 없이 새로 셈", async () => {
    const mvPlan = (steps) => post("/api/mcp", { env: mv, cwd, tool: "plan", input: { steps } });
    const li = `document.querySelector('#plan-body li[data-id="r1"]')`;
    await open(mv);
    await mvPlan([{ id: "r1", title: "옛 단계", status: "doing" }]);
    await mvHook({ f: "edit", tool: "Edit", path: "/tmp/옮기기/c.js" });
    await waitFor(`!!${li}?.querySelector(':scope > .stats')?.textContent.includes('파일 1')`);
    await mvPlan([{ id: "r1", status: "done" }]);
    await mvPlan([{ id: "r1", title: "새 단계" }]);
    await waitFor(`!!${li}?.querySelector(':scope > .head.st-todo')`);
    expect(await evaluate(`!${li}.querySelector(':scope > .stats')`), "할 일인데 옛 걸린 시간·파일 수가 보임");
    await mvPlan([{ id: "r1", status: "doing" }]);
    await waitFor(`!!${li}?.querySelector(':scope > .stats')`);
    const text = await evaluate(`${li}.querySelector(':scope > .stats').textContent`);
    expect(text.startsWith("1분 미만") && text.includes("파일 0"), `옛 기록을 이음: ${text}`);
    return text;
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
