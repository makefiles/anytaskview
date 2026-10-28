// 화면: 세션 목록, 맨 위 한 줄, 주의 띠, 가운데 그림, 계획 나무, 타임라인, 재생 막대.
// 서버가 SSE 로 보내는 결과(res)를 lib/scene.js 의 applyRes 로 적용한다. 재생도 같은 함수로 처음부터 다시 적용한다.
// 패널 폭·접힘·배율·거르기처럼 이 브라우저에만 남는 값은 localStorage 에 두고, 읽을 때 범위로 자른다.
import { newScene, applyRes, currentStep, own, MSG_LIMITS, entryText, itemText, searchTerms, matchAll, snippet, drawingStale, DRAW_SLACK } from "/lib/scene.js";
import { createCanvas, safeRef, groupSummary, inFinishedGroup } from "/canvas.js";

const ST_KO = { todo: "할 일", doing: "진행", done: "끝", fail: "실패", blocked: "막힘", wait: "승인 대기" };
const ST_ICO = { todo: "○", doing: "▶", done: "✓", fail: "✗", blocked: "‼", wait: "…" };
const SESS_KO = { working: "작업 중", input: "입력 필요", idle: "쉼", ended: "끝" };
const SESS_ICO = { working: "▶", input: "?", idle: "○", ended: "–" };
const RUN_KO = { running: "실행 중", done: "끝", fail: "실패", wait: "승인 대기", unknown: "알 수 없음", background: "뒤에서 실행" };
const NOTE_KO = { why: "이유", decision: "결정", blocked: "막힘", wait: "승인 대기" };
const MSG_KIND_KO = { comment: "의견", instruction: "지시" };
const MSG_STATE_KO = { queued: "대기", sent: "보냄", expired: "만료" };
const WHY_KO = { thread: "앞 대화에서 이어짐", claude: "Claude 가 고름", phrase: "이어받기 문구", hand: "사용자가 넣음" };
const STALL_MS = 5 * 60_000;
const ONLY_TL = new URLSearchParams(location.search).get("only") === "tl";
// 화판 쓰기 열쇠: scripts/atv board --url 주소의 #w= 로 온다. localStorage 는 포트까지 갈라 두므로 다른 포트의 페이지가 읽지 못한다
(() => {
  const m = location.hash.match(/[#&]w=([A-Za-z0-9_-]{32,})/);
  if (!m) return;
  try { localStorage.setItem("atv.w", m[1]); } catch { /* 저장이 막히면 쓰기는 못 한다 */ }
  history.replaceState(null, "", location.pathname + location.search);
})();

const $ = (id) => document.getElementById(id);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
// index.html 의 SVG 심벌(아이콘·로고)을 쓴다. 글자 노드가 없어 단추의 textContent 는 그대로다
function icon(id, cls) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"), use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  use.setAttribute("href", `#${id}`);
  svg.append(use);
  return svg;
}
const setIcon = (svg, id) => { const use = svg.querySelector("use"); if (use.getAttribute("href") !== `#${id}`) use.setAttribute("href", `#${id}`); };
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 저장이 막힌 브라우저에서도 화면은 돈다 */ } },
  json(k, fallback) { try { const v = JSON.parse(this.get(k)); return v && typeof v === "object" ? v : fallback; } catch { return fallback; } },
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, fallback) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

function fmtDur(ms) {
  if (!(ms >= 0)) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 10) return `${m}분 ${s % 60}초`;
  if (m < 60) return `${m}분`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}
function fmtAgo(t, now) {
  const d = now - t;
  if (d < 60_000) return "방금";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}분 전`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}시간 전`;
  return new Date(t).toLocaleDateString("ko-KR");
}
// 단계에 걸린 시간은 분 단위로 보인다(초 단위는 1초마다 바뀌어 눈을 끈다)
function fmtMin(ms) {
  if (!(ms >= 0)) return "";
  const m = Math.floor(ms / 60_000);
  return m < 1 ? "1분 미만" : m < 60 ? `${m}분` : `${Math.floor(m / 60)}시간 ${m % 60}분`;
}
const pad2 = (n) => String(n).padStart(2, "0");
const fmtClock = (t) => { const d = new Date(t); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
const base = (p) => String(p || "").split("/").filter(Boolean).pop() || p || "";
const sessName = (s) => s.name || s.title || base(s.cwd) || s.id.slice(0, 8);

// ---- 상태 ----
const state = {
  sessions: new Map(),   // id → 요약
  sid: null,
  scene: newScene(),
  seq: 0,
  snapped: false,        // 보는 세션의 스냅샷을 받았다(그 뒤의 변경만 적용한다)
  es: null,
  replay: null,          // { records, idx, scene } 재생 중일 때만
  replayLoading: null,   // 재생 기록을 받는 동안 온 변경
  replayToken: 0,        // 기록 요청 번호. 세션을 바꾸면 늘려 늦게 온 옛 응답을 버린다
  markerSeq: null,       // 「여기부터 새것」 표시 기준
  renderQueued: false,
  tlTopSeq: 0,           // 타임라인을 맨 위(최신)에서 마지막으로 본 사건 번호
  followed: null,        // 따라가기로 마지막에 옮겨 간 부품 id
  projects: { projects: {}, members: {} }, // 프로젝트 정의·소속과 큰 그림 요약(서버의 projects.json)
  config: { resume: null, trashDays: 30 }, // 서버 설정(이어받기 문구, 지난 대화를 휴지통으로 옮기기까지 날수·null 이면 끔)
  dragging: null,        // 목록에서 끌고 있는 세션 id
};

function theme() {
  const t = document.documentElement.dataset.theme;
  if (t) return t;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const canvas = createCanvas($("canvas"), {
  onCopy: copyRef,
  notesFor: (id) => viewScene().timeline.filter((e) => e.type === "note" && e.on === id),
  mailFor: (id) => { const ms = msgsTo(viewScene(), id); return ms.length ? mailBadge(ms) : null; },
  onMail: (id) => { const e = canvas.elementOf(id); if (e) askAbout(e); },
  getTheme: theme,
  // 배치를 고를 때 쓰는 칸 크기(100% 기준). 지금 배율로 나누면 줄여 둔 화면에서는 긴 띠도 「다 들어간다」가 되어 그대로 남는다
  getViewport: () => ({ w: scroller.clientWidth - 32, h: scroller.clientHeight - 32 }),
  // 도형 옮기기(Ctrl + 왼쪽 끌기·Shift + 화살표): 옮긴 자리는 화판 기록에 남는다
  canMove: () => (!canWrite() ? "도형을 옮기려면 화판 쓰기 열쇠가 필요합니다(맨 위 「쓰기 열쇠 없음」 의 설명)" : state.replay || state.replayLoading ? "다시 보기 중에는 옮기지 않습니다. 「실시간」 으로 돌아온 뒤 옮겨 주세요" : null),
  onMove: async (id, pos, inAt) => (await boardOp({ op: "move", sid: state.sid, id, in: inAt, ...(pos ? pos : { x: null }) })).ok,
  onRefuse: toast,
  getZoom: () => view.zoom,
  onPlaced: () => { if (askFor && !askBtn.hidden && $("canvas").contains(askFor)) showAsk(askFor); placeComposer(); },
  onFold: () => queueRender("view"), // 접고 펼친 뒤에도 상자마다의 보내기 표시를 다시 단다
});

const viewScene = () => (state.replay ? state.replay.scene : state.scene);
// 그 상자·단계에 보낸 글(대기·보냄·만료 모두)
const msgsTo = (scene, id) => Object.values(scene.msgs || {}).filter((m) => m.target?.id === id);
// 보낸 글 수 표시의 글과 툴팁
function mailBadge(msgs) {
  const q = msgs.filter((m) => m.state === "queued").length;
  return { text: `✉${msgs.length}`, queued: q > 0, title: `이 대상에 보낸 글 ${msgs.length}개${q ? ` · 대기 ${q}` : ""} · 누르면 보내기 창` };
}
const viewNow = () => (state.replay ? state.replay.records[state.replay.idx]?.t || Date.now() : Date.now());

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 1600);
}
async function copyRef(ref) {
  try { await navigator.clipboard.writeText(ref); toast(`복사함: ${ref}`); }
  catch { toast(`복사하지 못했습니다: ${ref}`); }
}

// 화판 쓰기(이름·묶음·메시지·지우기). 같은 요청을 다시 보내도 서버가 한 번만 처리하도록 요청 id(rid)를 붙인다
async function boardOp(body) {
  try {
    const r = await fetch("/api/board", {
      method: "POST",
      headers: { "content-type": "application/json", "x-atv-board": store.get("atv.w") || "" },
      body: JSON.stringify({ ...body, rid: crypto.randomUUID() }),
    });
    const out = r.headers.get("content-type")?.startsWith("application/json") ? await r.json() : { ok: false, msg: await r.text() };
    if (!out.ok) toast(out.msg || `실패 ${r.status}`);
    return out;
  } catch {
    toast("화판 서버에 닿지 못했습니다");
    return { ok: false };
  }
}
// 보고 있는 id 는 세션이나 프로젝트(큰 그림 화판)다
const isProj = (id) => !!id && Object.hasOwn(state.projects.projects, id);
const known = (id) => state.sessions.has(id) || isProj(id);
const projOf = (sid) => {
  const m = Object.hasOwn(state.projects.members, sid) ? state.projects.members[sid] : null;
  return m && m.pid && isProj(m.pid) ? m.pid : null;
};

// ---- 패널 폭·접힘 ----
// left 는 px, right·plan 은 비율. 화면 크기가 바뀌어도 같은 느낌이 나게 하고, 쓸 때마다 범위로 자른다
const LAYOUT_DEFAULT = { left: 260, right: 0.3, plan: 0.4, foldLeft: false, foldPlan: false, foldTl: false };
const layout = { ...LAYOUT_DEFAULT, ...store.json("atv.layout", {}) };
const main = document.querySelector("main"), side = $("side");

function applyLayout() {
  const W = main.clientWidth || window.innerWidth, H = side.clientHeight || 400;
  layout.left = clamp(num(layout.left, LAYOUT_DEFAULT.left), 160, 360);
  const left = layout.foldLeft ? 40 : layout.left;
  // 오른쪽: 300px~화면 60%, 그림 칸은 화면 30% 이상 남긴다
  const rightMax = Math.max(300, Math.min(0.6 * W, W - left - 12 - 0.3 * W));
  const right = clamp(num(layout.right, 0.3) * W, 300, rightMax);
  layout.right = right / W;
  layout.plan = clamp(num(layout.plan, 0.4), 0.1, 0.9);
  main.style.setProperty("--w-left", `${layout.left}px`);
  main.style.setProperty("--w-right", `${Math.round(right)}px`);
  side.style.setProperty("--h-plan", `${Math.round(clamp(layout.plan * H, 80, Math.max(80, H - 86)))}px`);
  main.classList.toggle("fold-left", !!layout.foldLeft);
  side.classList.toggle("fold-plan", !!layout.foldPlan);
  side.classList.toggle("fold-tl", !!layout.foldTl);
  $("fold-sessions").textContent = layout.foldLeft ? "▶" : "◀";
  $("fold-sessions").title = layout.foldLeft ? "세션 목록 펴기" : "세션 목록 접기";
  for (const [id, folded, what] of [["fold-plan", layout.foldPlan, "계획"], ["fold-tl", layout.foldTl, "타임라인"]]) {
    $(id).textContent = folded ? "▸" : "▾";
    $(id).title = `${what} ${folded ? "펴기" : "접기"}`;
    $(id).setAttribute("aria-expanded", String(!folded));
  }
}
const saveLayout = () => store.set("atv.layout", JSON.stringify(layout));

// 경계선: 끌기, 두 번 눌러 기본값, 화살표 키로 16px 씩
function splitter(id, { onMove, reset, step }) {
  const bar = $(id);
  bar.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    bar.setPointerCapture(ev.pointerId);
    bar.classList.add("drag");
    // 누른 자리에서 움직인 거리만큼만 바꾼다(손잡이 가운데를 잡아도 폭이 튀지 않게)
    const start = { x: ev.clientX, y: ev.clientY, ...layout };
    const move = (e) => { onMove(e.clientX - start.x, e.clientY - start.y, start); applyLayout(); };
    const up = () => {
      bar.classList.remove("drag");
      bar.removeEventListener("pointermove", move);
      saveLayout();
      queueRender();
    };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", up, { once: true });
    bar.addEventListener("pointercancel", up, { once: true });
  });
  bar.addEventListener("dblclick", () => { reset(); applyLayout(); saveLayout(); });
  bar.addEventListener("keydown", (ev) => {
    const d = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[ev.key];
    if (!d) return;
    ev.preventDefault();
    step(d * 16);
    applyLayout();
    saveLayout();
  });
}
splitter("split-left", {
  onMove: (dx, dy, s) => { layout.left = s.left + dx; },
  reset: () => { layout.left = LAYOUT_DEFAULT.left; },
  step: (d) => { layout.left += d; },
});
splitter("split-right", {
  onMove: (dx, dy, s) => { layout.right = s.right - dx / (main.clientWidth || 1); },
  reset: () => { layout.right = LAYOUT_DEFAULT.right; },
  step: (d) => { layout.right -= d / (main.clientWidth || 1); },
});
splitter("split-side", {
  onMove: (dx, dy, s) => { layout.plan = s.plan + dy / (side.clientHeight || 1); },
  reset: () => { layout.plan = LAYOUT_DEFAULT.plan; },
  step: (d) => { layout.plan += d / (side.clientHeight || 1); },
});
for (const [id, key] of [["fold-sessions", "foldLeft"], ["fold-plan", "foldPlan"], ["fold-tl", "foldTl"]]) {
  $(id).addEventListener("click", () => { layout[key] = !layout[key]; applyLayout(); saveLayout(); queueRender(); });
}
window.addEventListener("resize", applyLayout);

// ---- 그림 배율과 따라가기 ----
const scroller = $("canvas-scroll"), sizer = $("zoom-sizer"), canvasEl = $("canvas");
const savedZoom = Number(store.get("atv.zoom") || "1"); // 저장값이 없을 때 Number(null)=0 이 되지 않게 한다
const view = { zoom: clamp(num(savedZoom, 1) || 1, 0.4, 2), follow: store.get("atv.follow") !== "0" };
function fitSizer() {
  sizer.style.width = `${Math.ceil(canvasEl.offsetWidth * view.zoom) + 32}px`;
  sizer.style.height = `${Math.ceil(canvasEl.offsetHeight * view.zoom) + 32}px`;
}
// 배율을 바꿔도 (cx, cy) 화면 점 아래의 그림 자리가 그대로 있게 스크롤을 옮긴다
function setZoom(z, cx = scroller.clientWidth / 2, cy = scroller.clientHeight / 2) {
  z = clamp(Math.round(z * 100) / 100, 0.4, 2);
  const gx = (scroller.scrollLeft + cx - 16) / view.zoom, gy = (scroller.scrollTop + cy - 16) / view.zoom;
  view.zoom = z;
  canvasEl.style.transform = `scale(${z})`;
  fitSizer();
  scroller.scrollLeft = gx * z + 16 - cx;
  scroller.scrollTop = gy * z + 16 - cy;
  $("zoom-label").textContent = `${Math.round(z * 100)}%`;
  store.set("atv.zoom", String(z));
}
function zoomFit() {
  const w = canvasEl.offsetWidth, h = canvasEl.offsetHeight;
  if (!w || !h) return setZoom(1);
  setZoom(clamp(Math.min((scroller.clientWidth - 32) / w, (scroller.clientHeight - 32) / h), 0.4, 1));
  scroller.scrollLeft = 0;
  scroller.scrollTop = 0;
}
function setFollow(on) {
  view.follow = on;
  $("follow").setAttribute("aria-pressed", String(on));
  store.set("atv.follow", on ? "1" : "0");
  if (on) { state.followed = null; followNow(); }
}
new ResizeObserver(fitSizer).observe(canvasEl);
scroller.addEventListener("wheel", (ev) => {
  if (!(ev.ctrlKey || ev.metaKey)) { if (view.follow) setFollow(false); return; }
  ev.preventDefault();
  const r = scroller.getBoundingClientRect();
  setZoom(view.zoom * (ev.deltaY < 0 ? 1.1 : 1 / 1.1), ev.clientX - r.left, ev.clientY - r.top);
}, { passive: false });
scroller.addEventListener("pointerdown", () => { if (view.follow) setFollow(false); });
// 끌어 옮기기: 그림이 칸보다 크면 왼쪽 단추로 잡고 끌어 상하좌우로 옮긴다. 4px 넘게 움직여야 끌기로 보고,
// 끌기 뒤의 클릭은 막는다(상자를 누르면 경로를 복사하므로). 단추·입력 칸·말풍선 위에서는 끌지 않는다
const pan = { id: null, x: 0, y: 0, left: 0, top: 0, moved: false };
const scrollable = () => scroller.scrollWidth > scroller.clientWidth + 1 || scroller.scrollHeight > scroller.clientHeight + 1;
scroller.addEventListener("pointerdown", (ev) => {
  if (ev.button !== 0 || ev.ctrlKey || ev.pointerType === "touch" || !scrollable() || ev.target.closest("button, input, textarea, a, .badge")) return; // Ctrl 이면 도형 옮기기
  Object.assign(pan, { id: ev.pointerId, x: ev.clientX, y: ev.clientY, left: scroller.scrollLeft, top: scroller.scrollTop, moved: false });
});
scroller.addEventListener("pointermove", (ev) => {
  if (ev.pointerId !== pan.id) return;
  if (!(ev.buttons & 1)) { panEnd(ev); return; } // 칸 밖에서 놓아 pointerup 을 못 받았으면 여기서 끝낸다
  const dx = ev.clientX - pan.x, dy = ev.clientY - pan.y;
  if (!pan.moved && Math.hypot(dx, dy) < 4) return;
  if (!pan.moved) { pan.moved = true; scroller.setPointerCapture(ev.pointerId); scroller.classList.add("panning"); }
  scroller.scrollLeft = pan.left - dx;
  scroller.scrollTop = pan.top - dy;
});
function panEnd(ev) {
  if (ev.pointerId !== pan.id) return;
  pan.id = null;
  scroller.classList.remove("panning");
  // 끌기 바로 뒤에 오는 클릭 하나만 막는다(클릭이 오지 않는 경우에 다음 진짜 클릭을 먹지 않게 다음 차례에 푼다)
  if (pan.moved) { pan.swallow = true; setTimeout(() => { pan.swallow = false; }, 0); }
}
scroller.addEventListener("click", (e) => { if (pan.swallow) { e.stopPropagation(); e.preventDefault(); } }, { capture: true });
scroller.addEventListener("pointerup", panEnd);
scroller.addEventListener("pointercancel", panEnd);
const panRO = new ResizeObserver(() => scroller.classList.toggle("pannable", scrollable()));
panRO.observe(sizer);
panRO.observe(scroller);
scroller.addEventListener("keydown", () => { if (view.follow) setFollow(false); });
$("zoom-in").addEventListener("click", () => setZoom(view.zoom * 1.25));
$("zoom-out").addEventListener("click", () => setZoom(view.zoom / 1.25));
$("zoom-100").addEventListener("click", () => setZoom(1));
$("zoom-fit").addEventListener("click", zoomFit);
// 옮긴 도형을 모두 자동 자리로(Claude 가 고른 배치로) 되돌린다
$("auto-place").addEventListener("click", () => { if (state.sid && canWrite() && !state.replay && !state.replayLoading) boardOp({ op: "move", sid: state.sid, all: true }); });
$("follow").addEventListener("click", () => setFollow(!view.follow));

// 부품이 보이도록 그림을 옮긴다(배율 반영). center 면 가운데로
function revealPart(id, { center = true, flash = true } = {}) {
  const e = canvas.elementOf(id);
  if (!e) return false;
  const x = e.offsetLeft * view.zoom + 16, y = e.offsetTop * view.zoom + 16; // 부품의 offsetParent 는 #canvas 다
  const w = e.offsetWidth * view.zoom, h = e.offsetHeight * view.zoom;
  const inView = x >= scroller.scrollLeft && y >= scroller.scrollTop && x + w <= scroller.scrollLeft + scroller.clientWidth && y + h <= scroller.scrollTop + scroller.clientHeight;
  if (!inView || center) scroller.scrollTo({ left: x + w / 2 - scroller.clientWidth / 2, top: y + h / 2 - scroller.clientHeight / 2, behavior: "smooth" });
  if (flash) { e.classList.remove("flash"); void e.offsetWidth; e.classList.add("flash"); }
  return true;
}
// 진행 중인 부품: 목록 항목이면 그 목록 상자로 올린다
function doingPart(scene) {
  let hit = null;
  for (const it of Object.values(scene.items)) {
    if (it.status !== "doing" || it.kind === "step" || it.kind === "edge") continue;
    let p = it;
    for (let i = 0; p && p.kind === "item" && i < 10; i++) p = own(scene.items, p.in);
    if (p && (!hit || it.ord > hit.ord)) hit = { id: p.id, ord: it.ord };
  }
  return hit && hit.id;
}
function followNow() {
  if (!view.follow || state.replay || canvas.busy()) return; // 재는 중에는 자리가 틀리다. 배치가 끝나면 다시 불린다
  const id = doingPart(viewScene());
  if (!id || id === state.followed) return;
  if (revealPart(id, { center: false, flash: false })) state.followed = id;
}

// ---- 서버 연결 ----
// 탭·새 창은 SharedWorker(hub.js)의 연결 하나를 나눠 쓴다. 브라우저는 한 주소에 연결을 여섯 개까지만 열어
// 탭마다 연결하면 일곱 번째 탭부터 멈춘다. SharedWorker 가 없거나 뜨지 않으면 탭마다 연결한다
// SharedWorker 는 탭이 하나라도 열려 있으면 살아 있어, 판을 올린 뒤 새로 고친 탭도 옛 worker 에 붙는다.
// hub.js 나 /api/sub 의 약속을 바꾸면 HUB_VERSION 을 올려 새 worker 를 따로 띄운다(주소가 다르면 다른 worker)
const HUB_VERSION = 1;
let hub = null;
try {
  if (typeof SharedWorker === "function") {
    const w = new SharedWorker(`/hub.js?v=${HUB_VERSION}`, { name: "atv-hub" });
    hub = { port: w.port, target: null };
    w.port.onmessage = (ev) => hub?.target?.dispatchEvent(new MessageEvent(ev.data.ev, { data: ev.data.data }));
    w.addEventListener("error", () => { if (hub) { hub = null; connect(state.sid); } });
  }
} catch { hub = null; }
// EventSource 처럼 쓰는 사건 통로. 나눠 쓰는 연결이면 worker 에 보는 세션을 알리고, 그 세션은 스냅샷부터 다시 받는다
function openEvents(sid) {
  if (!hub) return new EventSource(sid ? `/events?session=${encodeURIComponent(sid)}` : "/events");
  const t = new EventTarget();
  t.close = () => { if (hub?.target === t) hub.target = null; };
  hub.target = t;
  hub.port.postMessage({ want: sid });
  return t;
}
function connect(sid) {
  if (state.es) state.es.close();
  if (sid !== state.sid) leaveSession();
  $("plan-now").classList.remove("live"); // 새 세션의 상태를 받기 전까지 앞 세션의 반짝임을 남기지 않는다
  state.sid = sid;
  state.scene = newScene();
  state.seq = 0;
  state.snapped = false;
  state.replay = null;
  state.replayLoading = null;
  state.replayToken++; // 받는 중이던 다른 세션의 기록은 버린다
  state.tlTopSeq = 0;
  state.followed = null;
  canvas.reset();
  tlCache = new Map();
  state.tlFocus = null;
  state.planReveal = null;
  state.markerSeq = sid ? Number(store.get(`atv.seen.${sid}`) || 0) : null;
  if (sid) history.replaceState(null, "", `${location.search}#s=${encodeURIComponent(sid)}`);
  const es = openEvents(sid);
  state.es = es;
  es.addEventListener("list", (ev) => {
    state.sessions = new Map(JSON.parse(ev.data).map((s) => [s.id, s]));
    if (!state.sid || !known(state.sid)) { const pick = defaultSession(); if (pick && pick !== state.sid) return connect(pick); }
    queueRender();
  });
  es.addEventListener("sess", (ev) => {
    const s = JSON.parse(ev.data), old = state.sessions.get(s.id);
    state.sessions.set(s.id, s);
    if (!state.sid) return connect(s.id); // 처음 생긴 세션을 바로 보여 준다
    // 바쁜 세션은 사건마다 마지막 활동 시각만 바뀐 요약을 보낸다. 목록의 「n분 전」·활동순은 2초 늦어도 되므로 모아서 그린다
    const rest = ({ lastT, seq, ...x }) => JSON.stringify(x);
    if (old && rest(old) === rest(s)) {
      state.listTimer ||= setTimeout(() => { state.listTimer = 0; queueRender("list"); }, 2000);
      return;
    }
    // 보는 화면이 이 세션의 요약을 쓰는 경우(같은 줄의 대화, 프로젝트의 대화 이력, 이 세션을 받는 쪽으로 연 보내기 창·모은 글)만
    // 화면 전체를, 아니면 목록만 다시 그린다
    const uses = isProj(state.sid) || rootOf(s.id) === rootOf(state.sid) || ask?.sid === s.id || compose.basket.sid === s.id;
    queueRender(uses ? "all" : "list");
  });
  // 서버는 프로젝트를 목록보다 먼저 보낸다(보던 id 가 프로젝트인지 목록을 받을 때 알아야 한다)
  es.addEventListener("projects", (ev) => {
    state.projects = JSON.parse(ev.data);
    queueRender();
  });
  es.addEventListener("config", (ev) => { state.config = JSON.parse(ev.data); });
  // 다른 탭이나 이 탭에서 지운 대화·푼 프로젝트. 보던 것이 지워졌으면 다른 대화로 옮겨 간다
  es.addEventListener("drop", (ev) => {
    const ids = JSON.parse(ev.data);
    for (const id of ids) {
      state.sessions.delete(id);
      try { localStorage.removeItem(`atv.seen.${id}`); } catch { /* 저장이 막혀도 화면은 돈다 */ }
    }
    if (ask && ids.includes(ask.sid)) closeComposer(false);
    // 지운 대화의 초안은 버린다(사용자가 지운 것). 모은 글은 자동으로 버리지 않고 띠에 「받을 대화가 없음」 으로 둔다
    if (Object.keys(compose.drafts).some((k) => ids.includes(k.split(" ")[0]))) {
      changeCompose((c) => { for (const k of Object.keys(c.drafts)) if (ids.includes(k.split(" ")[0])) delete c.drafts[k]; });
    }
    if (ids.includes(state.sid)) return connect(defaultSession());
    queueRender();
  });
  es.addEventListener("snap", (ev) => {
    const d = JSON.parse(ev.data);
    if (d.id !== state.sid) return;
    state.scene = d.scene;
    state.seq = d.seq;
    state.snapped = true;
    state.replay = null;
    state.replayLoading = null;
    state.replayToken++;
    canvas.invalidate();
    tlCache = new Map();
    if (finder.open) renderSearch(false); // 다른 세션으로 옮겨 다시 찾는 중이면 그 세션 기준으로
    queueRender();
  });
  es.addEventListener("res", (ev) => {
    const d = JSON.parse(ev.data);
    // 다른 세션 것이거나 스냅샷 전에 온 것(나눠 쓰는 연결에서 세션을 바꾸는 사이에 이미 오던 것)은 버린다
    if (d.id !== state.sid || !state.snapped || d.seq <= state.seq) return;
    if (d.seq !== state.seq + 1) { connect(state.sid); return; } // 빠진 것이 있다: 스냅샷부터 다시 받는다
    applyRes(state.scene, d.res);
    state.seq = d.seq;
    const rec = { seq: d.seq, t: d.t, res: d.res };
    if (state.replay) state.replay.records.push(rec);
    else if (state.replayLoading) state.replayLoading.push(rec); // 기록을 받는 사이에 온 변경은 받은 뒤에 이어 붙인다
    queueRender("view"); // 세션 목록은 요약(sess)이 올 때 그린다
  });
}

// 문서를 떠날 때 SSE 를 닫는다. 닫지 않으면 뒤로 가기 캐시(bfcache)에 든 옛 문서가 연결을 쥔 채 남아, 한 호스트에
// 6개까지인 브라우저 연결이 차서 같은 탭에서 다섯 번쯤 새로 열면 화판이 뜨지 않았다. 캐시에서 돌아오면 다시 잇는다
addEventListener("pagehide", () => { state.es?.close(); hub?.port.postMessage({ bye: true }); saveDraft(true); });
addEventListener("pageshow", (ev) => { if (ev.persisted) connect(state.sid); });

function defaultSession() {
  const fromHash = decodeURIComponent((location.hash.match(/#s=([^&]+)/) || [])[1] || "");
  if (fromHash && known(fromHash)) return fromHash;
  const list = threads("activity"); // 목록 정렬과 상관없이 지금 가장 바쁜(입력 필요 > 최근) 대화를 연다
  return list.length ? list[0][0].id : null;
}
// 입력을 기다리는 세션을 맨 위로, 끝난 세션을 맨 아래로
const SESS_RANK = { input: 0, working: 1, idle: 1, ended: 2 };
function sortedSessions() {
  return [...state.sessions.values()].sort((a, b) => (SESS_RANK[a.status] ?? 1) - (SESS_RANK[b.status] ?? 1) || b.lastT - a.lastT);
}
// 이어진 대화(/clear·fork·핸드온)는 prev 를 따라 올라간 뿌리가 같다. 사슬은 몇 주씩 길어질 수 있어 깊이를 자르지 않고,
// 고리는 지나온 세션을 기억해 멈춘다
function rootOf(id) {
  const seen = new Set([id]);
  let cur = id;
  for (;;) {
    const p = state.sessions.get(cur)?.prev;
    if (!p || !state.sessions.has(p) || seen.has(p)) return cur;
    seen.add(p);
    cur = p;
  }
}
// 목록의 한 줄 = 뿌리가 같은 세션들. 맨 앞이 대표(입력 필요 > 최근)다.
// 끝났는데 입력도 그림도 없는 세션은 빼되 지금 보는 세션은 남긴다.
// 줄 순서(사용자가 「정렬」 에서 고름): activity 는 대표 순서 그대로(입력 필요 위, 끝난 것 아래, 최근 활동 순),
// start 는 뿌리 대화가 늦게 시작한 줄부터(활동·상태로 자리를 바꾸지 않는다), name 은 대표 이름 가나다순
function threads(order = sessSort()) {
  const by = new Map();
  for (const s of sortedSessions()) {
    if (s.empty && s.id !== state.sid) continue;
    const r = rootOf(s.id);
    if (!by.has(r)) by.set(r, []);
    by.get(r).push(s);
  }
  const list = [...by.values()];
  const start = (t) => state.sessions.get(rootOf(t[0].id))?.startedAt || 0;
  if (order === "start") list.sort((a, b) => start(b) - start(a));
  else if (order === "name") list.sort((a, b) => sessName(a[0]).localeCompare(sessName(b[0]), "ko") || start(b) - start(a));
  return list;
}
const SORTS = { start: "시작순", activity: "활동순", name: "이름순" };
const sessSort = () => { const v = store.get("atv.sessSort"); return Object.hasOwn(SORTS, v) ? v : "start"; };
const hideEnded = () => store.get("atv.hideEnded") === "1";
// 모두 끝났고 마지막 활동이 하루 넘게 지난 줄은 그 묶음 아래의 접힌 「지난 세션」 으로 보낸다
const PAST_MS = 86_400_000;
const allEnded = (t) => t.every((s) => s.status === "ended");
const threadLast = (t) => Math.max(...t.map((s) => s.lastT || 0)); // 줄의 대화 가운데 가장 최근 활동(대표가 아닐 수 있다)
const isPast = (t, now) => allEnded(t) && now - threadLast(t) > PAST_MS;
// 한 줄 안의 대화들을 시작 순서로(맨 위 ◀ ▶). withEmpty 면 목록에서 숨긴 빈 대화도 넣는다(줄을 지울 때)
function threadOf(id, withEmpty = false) {
  const root = rootOf(id);
  return [...state.sessions.values()].filter((s) => (withEmpty || !s.empty || s.id === state.sid) && rootOf(s.id) === root).sort((a, b) => a.startedAt - b.startedAt);
}

// what: "all"(기본)·"view"(세션 목록을 뺀 화면)·"list"(세션 목록만). 한 프레임에 모아 한 번 그린다
// 반짝임(작업 중·입력 필요 글자, 계획 「지금」 줄): 글자를 한 벌 더 겹치고(빛 색) 그 위를 띠 모양 가림막이 지나가게 한다.
// transform 만 움직여 합성 단계에서 돌므로 주 스레드가 매 프레임 다시 그리지 않는다(background-position 을 움직이던
// 전 방식은 쉴 때도 한 코어의 4분의 1쯤을 썼다). 보일지는 CSS 가 정한다(움직임 줄이기면 숨김).
// 위상은 문서 시계에 맞춘다. 목록·「지금」 줄을 다시 만들어도 빛이 처음부터 다시 시작하지 않는다
const SHINE_MS = 2400;
function addShine(host) {
  const win = el("span", "shine"), copy = el("span");
  copy.append(...[...host.childNodes].map((n) => n.cloneNode(true)));
  win.setAttribute("aria-hidden", "true");
  win.append(copy);
  win.style.animationDelay = copy.style.animationDelay = `${-((document.timeline.currentTime ?? performance.now()) % SHINE_MS)}ms`;
  host.append(win);
  return host;
}

function queueRender(what = "all") {
  if (what !== "view") state.dirtyList = true;
  if (what !== "list") state.dirtyView = true;
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => {
    const list = state.dirtyList, view = state.dirtyView;
    state.renderQueued = state.dirtyList = state.dirtyView = false;
    render({ list, view });
  });
}

// ---- 계산 ----
function stepStats(scene, id, now) {
  const st = own(scene.items, id);
  let files = 0, cmds = 0, fails = 0;
  for (const e of scene.timeline) if (e.type === "fact" && e.f === "edit" && e.step === id) files++;
  for (const r of Object.values(scene.runs)) if (r.step === id) { cmds++; if (r.state === "fail") fails++; }
  const elapsed = st && st.startT ? (st.endT || now) - st.startT : null;
  return { files, cmds, fails, elapsed };
}
// 프로젝트 화판의 단위에는 훅 사실(파일·명령)이 붙지 않으므로 걸린 시간만 보인다
const statsText = (x) => (isProj(state.sid) ? fmtMin(x.elapsed) : `${fmtMin(x.elapsed)} · 파일 ${x.files} · 명령 ${x.cmds}${x.fails ? `(실패 ${x.fails})` : ""}`);
// 날짜가 다르면 날짜도(프로젝트의 대화 이력은 며칠에 걸친다)
const fmtWhen = (t, now) => (new Date(t).toDateString() === new Date(now).toDateString() ? fmtClock(t) : new Date(t).toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }));

// 주의 띠: 입력 필요·승인 대기 → 막힘 → 실패
const BAND_RANK = { input: 0, wait: 0, blocked: 1, fail: 2 };
function bandItems(scene) {
  const out = [];
  // 끝난 세션의 승인 대기·막힘은 더 할 수 있는 일이 없으므로 띄우지 않는다(실패는 남긴다)
  const live = scene.sess.status !== "ended";
  if (scene.sess.status === "input") {
    const last = [...scene.timeline].reverse().find((e) => e.type === "fact" && e.f === "notify");
    out.push({ kind: "input", ico: "?", text: `입력 필요${last && last.text ? ": " + last.text : ""}` });
  }
  // 끝난 묶음 안의 실패(아니라고 지운 후보 따위)는 지난 일이라 띄우지 않는다
  const groups = groupSummary(scene);
  for (const it of Object.values(scene.items)) {
    if (it.kind === "edge" || (it.kind !== "step" && it.status === "fail" && inFinishedGroup(scene, groups, it.id))) continue;
    const name = it.kind === "step" ? it.title : it.label || it.id;
    if (it.status === "wait" && !it.answered) { if (live) out.push({ kind: "wait", ico: ST_ICO.wait, text: `승인 대기: ${name}`, id: it.id, step: it.kind === "step", ord: it.ord }); }
    else if (it.status === "blocked") { if (live) out.push({ kind: "blocked", ico: ST_ICO.blocked, text: `막힘: ${name}${it.note ? " · " + it.note : ""}`, id: it.id, step: it.kind === "step", ord: it.ord }); }
    else if (it.status === "fail") out.push({ kind: "fail", ico: ST_ICO.fail, text: `실패: ${name}`, id: it.id, step: it.kind === "step", ord: it.ord });
  }
  return out.sort((a, b) => BAND_RANK[a.kind] - BAND_RANK[b.kind] || (b.ord || 0) - (a.ord || 0));
}

// ---- 그리기 ----
function render({ list = true, view = true } = {}) {
  const scene = viewScene(), now = viewNow();
  if (list) renderSessions(now);
  if (!view) { placeComposer(); return; } // 목록을 다시 만들면 세션 줄에 붙은 보내기 창의 자리도 다시 맞춘다
  renderTop(scene, now);
  renderPlan(scene, now);
  renderTimeline(scene, now);
  renderReplay();
  $("auto-place").hidden = !(canWrite() && !state.replay && !state.replayLoading && Object.values(scene.items).some((p) => p.pos)); // 옮긴 도형이 있을 때만
  renderBasket();
  const hasParts = Object.values(scene.items).some((it) => it.kind !== "step");
  $("empty").hidden = hasParts;
  renderStale(scene, hasParts, now);
  $("empty").textContent = isProj(state.sid) ? "아직 큰 그림이 없습니다. 이 프로젝트에 든 대화의 Claude·Codex 가 작업 단위를 시작·끝낼 때 그립니다." : `아직 그림이 없습니다. ${agentName(state.sessions.get(state.sid))} 가 draw 로 그리면 여기에 나타납니다.`;
  applyFocus(false);
  if (!ONLY_TL) canvas.render(scene).then(() => {
    for (const p of $("canvas").querySelectorAll(".part[data-id]")) markSend(p, "상자");
    if (state.focus?.part) applyFocus(true); else followNow(); // 찾기로 고른 부품이 있으면 따라가기보다 앞선다
    placeComposer();
  }).catch((e) => console.error("그림 실패", e));
  markSeen();
}

// 그림이 지금 작업(새 단계 묶음)보다 먼저 그린 것이면 그림 위 막대에 알린다(큰 그림 화판은 빼고).
// 같은 메시지의 draw 가 올 틈(DRAW_SLACK)은 기다렸다가 보인다. 그사이 다른 사건이 없어도 보이게 그때 한 번 다시 본다
let staleTimer = 0;
function renderStale(scene, hasParts, now) {
  const v = scene.view, el = $("stale");
  clearTimeout(staleTimer);
  const on = hasParts && !isProj(state.sid) && drawingStale(v);
  const wait = on ? v.taskT + DRAW_SLACK - now : 0;
  el.hidden = !on || wait > 0;
  if (on && wait > 0 && !state.replay) {
    staleTimer = setTimeout(() => { const sc = viewScene(); renderStale(sc, Object.values(sc.items).some((it) => it.kind !== "step"), viewNow()); }, wait + 50);
  }
  if (el.hidden) return;
  const at = v.shapeT ?? v.drawT; // 그림의 내용을 마지막으로 바꾼 때
  const d = new Date(at), day = at && d.toDateString() !== new Date(now).toDateString() ? `${d.getMonth() + 1}/${d.getDate()} ` : "";
  el.lastElementChild.textContent = "지난 작업 때 그린 그림" + (at ? ` · ${day}${pad2(d.getHours())}:${pad2(d.getMinutes())}` : "");
}

// 세션 목록: 프로젝트가 있으면 프로젝트별로(최근에 움직인 프로젝트 먼저, 빈 프로젝트도 보인다), 프로젝트 없는 세션은
// 「프로젝트 없음」, 끝난 프로젝트는 맨 아래 「끝난 프로젝트」 에 접어 둔다. 프로젝트 이름을 누르면 큰 그림 화판을 연다.
// 세션 줄을 끌어 프로젝트(머리나 그 아래 줄 어디든)에 놓으면 그 줄의 대화 전체가 옮겨 간다. 키보드는 줄의 「⋯」 메뉴로 한다
const gfold = new Set(Array.isArray(store.json("atv.gfold", [])) ? store.json("atv.gfold", []) : []);
const DRAG_TYPE = "text/x-atv-sid";
const canWrite = () => !!store.get("atv.w");
// 상자·단계에서 보내기 창을 열 수 있는가(프로젝트 화판·재생 중·쓰기 열쇠 없음이면 아니다)
const sendable = () => canWrite() && !state.replay && !!state.sid && !isProj(state.sid);
// 열 수 있을 때만 화면 읽기 프로그램에 Enter 동작을 알린다
function markSend(e, what) {
  if (sendable()) { e.setAttribute("aria-keyshortcuts", "Enter"); e.setAttribute("aria-description", `Enter: 이 ${what}에 대해 보내기`); }
  else { e.removeAttribute("aria-keyshortcuts"); e.removeAttribute("aria-description"); }
}
function sessRow(thread, now) {
  const s = thread[0], mine = thread.some((x) => x.id === state.sid);
  const row = el("div", "srow");
  const b = el("button", "sess" + (mine ? " sel" : "") + (s.status === "ended" ? " ended" : "") + (s.status === "input" || s.status === "working" ? ` ${s.status}` : ""));
  b.type = "button";
  if (mine) b.setAttribute("aria-current", "true");
  const r1 = el("div", "row1");
  r1.append(el("span", `sico ${s.status}`, SESS_ICO[s.status] || "○"), el("span", "txt", sessName(s)));
  const more = thread.length > 1 ? ` · 대화 ${thread.length}` : "";
  // 둘째 줄 맨 앞의 로고가 받는 쪽이다. 화면 읽기 프로그램에는 이름으로 읽힌다
  const logo = icon(agentLogo(s), "logo");
  logo.removeAttribute("aria-hidden");
  logo.setAttribute("role", "img");
  logo.setAttribute("aria-label", agentName(s));
  const r2 = el("div", "row2 txt");
  // 상태 글자는 따로 감싸 작업 중·입력 필요면 빛이 지나가게 한다(CSS .stw)
  const stw = el("span", `stw ${s.status}`, SESS_KO[s.status] || s.status);
  if (s.status === "working" || s.status === "input") addShine(stw);
  r2.append(logo, stw, ` · ${fmtAgo(s.lastT, now)} · ${base(s.cwd) || "폴더 모름"}${more}`);
  b.title = `${sessName(s)}\n${agentName(s)} · ${SESS_KO[s.status] || s.status} · ${s.cwd}${more && "\n이어진 대화(/clear·이어받기 문구)를 한 줄로 모았습니다. 맨 위 ◀ ▶ 로 앞뒤 대화를 봅니다"}`;
  b.append(r1, r2);
  b.addEventListener("click", () => { if (s.id !== state.sid) connect(s.id); }); // 앞 대화를 보는 중이어도 줄이 보이는 대화로 간다
  const menu = el("button", "mini smenu", "⋯");
  menu.type = "button";
  b.dataset.sid = menu.dataset.sid = s.id;
  menu.setAttribute("aria-haspopup", "menu");
  menu.setAttribute("aria-label", `${sessName(s)}: 메시지·프로젝트·지우기`);
  if (canWrite()) {
    b.draggable = true;
    b.addEventListener("dragstart", (ev) => {
      state.dragging = s.id;
      ev.dataTransfer.setData(DRAG_TYPE, s.id);
      ev.dataTransfer.effectAllowed = "move";
      document.body.classList.add("dragging");
    });
    b.addEventListener("dragend", endDrag);
    menu.title = "메시지 보내기·프로젝트로 옮기기·지우기";
    menu.addEventListener("click", () => openGroupMenu(s.id, menu));
  } else {
    menu.disabled = true;
    menu.title = $("nokey").title;
  }
  row.append(b, menu);
  return row;
}
function endDrag() {
  if (!state.dragging) return;
  state.dragging = null;
  document.body.classList.remove("dragging");
  for (const x of document.querySelectorAll(".gsec.drop")) x.classList.remove("drop");
  queueRender();
}
// 프로젝트 하나(머리 + 줄들)가 끌어 놓을 자리다. pid "" 은 「프로젝트 없음」(놓으면 프로젝트에서 뺀다)
function dropZone(sec, pid) {
  sec.addEventListener("dragover", (ev) => {
    if (!ev.dataTransfer.types.includes(DRAG_TYPE)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
    sec.classList.add("drop");
  });
  sec.addEventListener("dragleave", (ev) => { if (!sec.contains(ev.relatedTarget)) sec.classList.remove("drop"); });
  sec.addEventListener("drop", (ev) => {
    ev.preventDefault();
    const sid = ev.dataTransfer.getData(DRAG_TYPE);
    endDrag();
    if (sid && state.sessions.has(sid)) moveThread(sid, pid || null);
  });
}
// 프로젝트 머리: 접기, 이름(누르면 큰 그림 화판), ⋯ 메뉴(이름·끝·지우기). pid "" 은 「프로젝트 없음」(프로젝트와 다른 흐린 색)
function projHead(p, count) {
  const head = el("div", "ghead"), folded = gfold.has(p);
  const fold = el("button", "gtog", folded ? "▸" : "▾");
  fold.type = "button";
  fold.dataset.pid = p;
  fold.title = folded ? "펴기" : "접기";
  fold.setAttribute("aria-expanded", String(!folded));
  fold.addEventListener("click", () => {
    if (gfold.has(p)) gfold.delete(p); else gfold.add(p);
    store.set("atv.gfold", JSON.stringify([...gfold]));
    queueRender();
  });
  head.append(fold);
  if (!p) {
    head.append(el("span", "gfold none", `프로젝트 없음 · ${count}`));
    return head;
  }
  const pr = state.projects.projects[p];
  const name = el("button", "gfold" + (state.sid === p ? " sel" : ""), `${pr.name} · ${count}`);
  name.type = "button";
  if (state.sid === p) name.setAttribute("aria-current", "true");
  name.dataset.pid = p;
  name.title = `${pr.name}${pr.purpose ? `\n${pr.purpose}` : ""}\n눌러서 큰 그림 보기${pr.cur ? ` · 지금 ${pr.cur}` : ""}${pr.left ? ` · 남은 단계 ${pr.left}` : ""}`;
  name.addEventListener("click", () => { if (state.sid !== p) connect(p); });
  head.append(name);
  if (canWrite()) {
    const menu = el("button", "mini pmenu", "⋯");
    menu.type = "button";
    menu.dataset.pid = p;
    menu.setAttribute("aria-haspopup", "menu");
    menu.setAttribute("aria-label", `${pr.name}: 이름·끝·지우기`);
    menu.addEventListener("click", () => openProjectMenu(p, menu));
    head.append(menu);
  }
  return head;
}
// total: 끝난 세션 숨기기 전의 줄 수. 머리의 수와 「끌어 놓으세요」 안내는 숨긴 줄까지 센다
function projSection(p, members, now, total = members.length) {
  const sec = el("div", "gsec");
  sec.append(projHead(p, total));
  if (!gfold.has(p)) {
    sec.append(...sectionRows(p, members, now));
    if (!total) sec.append(el("div", "gempty", p ? "세션 줄을 여기로 끌어 놓으세요" : "여기로 끌어 놓으면 프로젝트에서 뺍니다"));
  }
  dropZone(sec, p);
  return sec;
}
// 묶음(프로젝트, 프로젝트 없음은 "") 하나의 줄들: 지금 줄, 그 아래 접힌 「지난 세션 · N」. 펼침은 묶음마다 기억한다.
// 지난 세션 판정은 재생 중에도 지금 시각으로 한다(재생 시각으로 하면 줄이 접힘 밖으로 나온다)
function sectionRows(key, list, now) {
  const real = Date.now();
  const recent = list.filter((t) => !isPast(t, real)), past = list.filter((t) => isPast(t, real));
  const out = recent.map((t) => sessRow(t, now));
  if (!past.length) return out;
  const open = new Set(store.json("atv.pastOpen", [])), on = open.has(key);
  const b = el("button", "pastfold", `${on ? "▾" : "▸"} 지난 세션 · ${past.length}`);
  b.type = "button";
  b.dataset.past = key;
  b.setAttribute("aria-expanded", String(on));
  b.title = "끝난 지 하루가 지난 대화입니다. 설정에서 정한 날수가 지나면 휴지통으로 옮깁니다(진행 중인 프로젝트의 대화는 남깁니다)";
  b.addEventListener("click", () => {
    if (on) open.delete(key); else open.add(key);
    store.set("atv.pastOpen", JSON.stringify([...open]));
    queueRender();
  });
  // 머리줄: 접기 단추와 ⋯(마우스를 올리면 보임) 「지난 세션 모두 지우기」
  const head = el("div", "ghead pasthead");
  head.append(b);
  if (canWrite()) {
    const menu = el("button", "mini pmenu", "⋯");
    menu.type = "button";
    menu.dataset.past = key;
    menu.setAttribute("aria-haspopup", "menu");
    menu.setAttribute("aria-label", "지난 세션: 모두 지우기");
    menu.addEventListener("click", () => openPastMenu(key, past, menu));
    head.append(menu);
  }
  out.push(head);
  // 접혀 있어도 지금 보는 줄은 단추 아래에 보인다(자리를 옮기지 않고 어느 줄을 보는지 알 수 있게)
  const shown = on ? past : past.filter((t) => t.some((x) => x.id === state.sid));
  out.push(...shown.map((t) => sessRow(t, now)));
  return out;
}
function renderSessions(now) {
  const body = $("sess-body");
  // 이름을 쓰는 중이거나 끄는 중에는 목록을 다시 만들지 않는다(끄는 요소·놓을 자리가 바뀌면 놓기가 사라진다)
  if (body.querySelector("input") || state.dragging) return;
  let list = threads();
  // 끝난 세션 숨기기: 모두 끝난 줄을 뺀다(지금 보는 줄은 남긴다). 숨긴 수는 목록 끝에 알린다
  const before = list;
  if (hideEnded()) list = list.filter((t) => !allEnded(t) || t.some((s) => s.id === state.sid));
  const hidden = before.length - list.length;
  // 줄이 너무 많으면 화면 순서와 상관없이 오래 쉰 줄부터 뺀다
  if (list.length > 80) {
    const keep = new Set([...list].sort((a, b) => threadLast(b) - threadLast(a)).slice(0, 80));
    list = list.filter((t) => keep.has(t));
  }
  const out = [];
  const projs = state.projects.projects, pids = Object.keys(projs);
  if (!pids.length) out.push(...sectionRows("", list, now));
  else {
    const by = new Map([...pids, ""].map((p) => [p, []])), totals = new Map();
    for (const t of list) by.get(projOf(t[0].id) || "").push(t);
    for (const t of before) { const p = projOf(t[0].id) || ""; totals.set(p, (totals.get(p) || 0) + 1); }
    const recent = (p) => Math.max(projs[p].lastT || 0, ...by.get(p).map(threadLast));
    const sort = sessSort();
    const cmp = sort === "name" ? (a, b) => projs[a].name.localeCompare(projs[b].name, "ko")
      : sort === "start" ? (a, b) => (projs[b].t || 0) - (projs[a].t || 0) : (a, b) => recent(b) - recent(a);
    const order = (done) => pids.filter((p) => !!projs[p].done === done).sort(cmp);
    for (const p of [...order(false), ""]) out.push(projSection(p, by.get(p), now, totals.get(p) || 0));
    const done = order(true);
    if (done.length) {
      const open = store.get("atv.doneOpen") === "1", head = el("div", "ghead");
      const b = el("button", "gfold dhead", `${open ? "▾" : "▸"} 끝난 프로젝트 · ${done.length}`);
      b.type = "button";
      b.dataset.pid = "-done";
      b.setAttribute("aria-expanded", String(open));
      b.addEventListener("click", () => { store.set("atv.doneOpen", open ? "0" : "1"); queueRender(); });
      head.append(b);
      out.push(head);
      if (open) for (const p of done) out.push(projSection(p, by.get(p), now, totals.get(p) || 0));
    }
  }
  if (!list.length && !hidden) out.push(el("p", "row2 txt", "아직 세션이 없습니다. Claude Code·Codex 세션을 시작하면 여기에 나타납니다."));
  if (hidden) out.push(el("p", "gempty", `끝난 세션 ${hidden}개를 숨겼습니다. 목록 위 정렬 단추에서 다시 보입니다.`));
  // 목록은 사건마다 새로 만든다. 키보드 초점이 목록 안에 있었으면 같은 세션·프로젝트의 같은 단추로 되돌린다
  const act = document.activeElement;
  let keep = null, gone = false;
  if (act && body.contains(act) && act.dataset.sid) {
    keep = `.${act.classList.contains("smenu") ? "smenu" : "sess"}[data-sid="${CSS.escape(act.dataset.sid)}"]`;
    gone = !state.sessions.has(act.dataset.sid);
  } else if (act && body.contains(act) && act.dataset.past !== undefined) {
    keep = `.pastfold[data-past="${CSS.escape(act.dataset.past)}"]`;
  } else if (act && body.contains(act) && act.dataset.pid !== undefined) {
    keep = `.${["pmenu", "gtog", "gfold"].find((c) => act.classList.contains(c))}[data-pid="${CSS.escape(act.dataset.pid)}"]`;
    gone = !!act.dataset.pid && act.dataset.pid !== "-done" && !isProj(act.dataset.pid);
  }
  body.replaceChildren(...out);
  // 보던 자리에서 목록이 튀지 않게. 그 세션·프로젝트가 지워졌으면 첫 세션 줄로, 끝으로 표시해 접힌 「끝난 프로젝트」 안으로
  // 들어갔으면 그 머리로 옮겨 초점을 잃지 않게 한다
  const folded = !gone && act?.dataset.pid && isProj(act.dataset.pid) && state.projects.projects[act.dataset.pid].done;
  // 줄이 접힌 「지난 세션」 안으로 들어갔으면 그 묶음의 「지난 세션」 단추로
  const past = !gone && act?.dataset.sid && body.querySelector(`.pastfold[data-past="${CSS.escape(projOf(act.dataset.sid) || "")}"]`);
  if (keep) (body.querySelector(keep) || (folded ? body.querySelector(".dhead") : past) || body.querySelector(".sess") || $("sess-sort")).focus({ preventScroll: true });
}

// 글자 자리를 잠깐 입력 칸으로 바꾼다(브라우저 prompt 창을 쓰지 않는다). Enter 저장, Esc 취소.
// 닫힌 뒤 초점이 갈 곳이 없으면 back(없으면 anchor)으로 돌려 키보드로 이어 쓸 수 있게 한다
function inlineEdit(anchor, value, save, back = anchor) {
  const input = el("input");
  input.value = value;
  input.maxLength = 80;
  input.setAttribute("aria-label", "새 이름");
  let finished = false;
  const done = (ok) => {
    if (finished) return; // 칸을 떼어 낼 때 생기는 blur 가 한 번 더 부른다
    finished = true;
    input.replaceWith(anchor);
    if (!document.activeElement || document.activeElement === document.body) back?.focus?.();
    const v = input.value.trim();
    if (ok && v && v !== value) save(v);
    queueRender(); // 입력하는 동안 멈춰 둔 세션 목록을 다시 그린다
  };
  // 기본 동작을 막는다: 닫으면서 초점을 단추로 옮기므로, 막지 않으면 같은 Enter 가 그 단추를 한 번 더 누른다
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === "Escape") { ev.preventDefault(); done(ev.key === "Enter"); }
  });
  input.addEventListener("blur", () => done(true), { once: true });
  anchor.replaceWith(input);
  input.focus();
  input.select();
}

function renderTop(scene, now) {
  const sess = scene.sess, cur = currentStep(scene), proj = isProj(state.sid) ? state.projects.projects[state.sid] : null;
  const chip = $("sess-chip");
  chip.className = proj ? `chip proj${proj.done ? " ended" : ""}` : `chip ${sess.status}`;
  // 세션이 실제로 일하는 동안(실시간)만 계획의 「지금」 줄에 빛이 지나간다. 단계가 진행 중이어도 세션이 쉬면 멈춘다
  $("plan-now").classList.toggle("live", !proj && sess.status === "working" && !state.replay && !state.replayLoading);
  chip.textContent = proj ? (proj.done ? "끝난 프로젝트" : "프로젝트") : SESS_KO[sess.status] || sess.status;
  let line = proj ? "큰 그림 없음" : "계획 없음";
  if (cur) {
    const st = own(scene.items, cur);
    line = `지금 ${st.title}${st.status !== "doing" ? ` (${ST_KO[st.status]})` : ""} · ${statsText(stepStats(scene, cur, now))}`;
  } else if (Object.values(scene.items).some((it) => it.kind === "step")) line = proj ? "진행 중인 단위 없음" : "진행 중인 단계 없음";
  if (proj) line += `${proj.left ? ` · 남은 단계 ${proj.left}` : ""} · 갱신 ${proj.lastT ? fmtAgo(proj.lastT, now) : "없음"}`;
  if (state.replay) line = `재생 중 · ` + line;
  $("headline").textContent = line;
  const stall = $("stall");
  const quiet = now - (sess.lastT || now);
  stall.hidden = !(!state.replay && sess.status === "working" && quiet > STALL_MS);
  stall.textContent = `멈춘 듯 · ${fmtDur(quiet)}째 사건 없음`;

  const band = bandItems(scene), b = $("band");
  b.hidden = bandHidden(band);
  // 1초마다 부르므로 내용이 같으면 다시 만들지 않는다(누르는 사이에 단추가 바뀌면 클릭이 사라진다)
  const bandKey = JSON.stringify([bandUi.open, band.map((x) => [x.kind, x.text, x.id])]);
  if (bandKey !== renderTop.bandKey) {
    renderTop.bandKey = bandKey;
    b.replaceChildren(...bandRows(band));
    if (bandUi.refocus) { bandUi.refocus = false; b.querySelector(".btoggle")?.focus(); }
  }

  const s = state.sessions.get(state.sid);
  const name = proj ? proj.name : s ? sessName(s) : base(scene.meta.cwd) || "";
  if ($("name-form").hidden) $("sess-name").textContent = proj || s ? name : "";
  $("sess-name").title = proj ? "눌러서 이 프로젝트의 이름을 바꿉니다" : "눌러서 이 세션의 이름을 바꿉니다";
  $("sess-name").hidden = !(s || proj) || !$("name-form").hidden;
  $("sess-agent").toggleAttribute("hidden", !s || !!proj); // svg 에는 hidden 속성(IDL)이 없다
  if (s) { setIcon($("sess-agent"), agentLogo(s)); $("sess-agent").setAttribute("aria-label", agentName(s)); }
  renderThreadNav(s);
  renderProjLink(s);
  // 프로젝트 화판은 대화가 아니라 받을 Claude 가 없다. 대화를 골라 보낸다
  $("compose").disabled = !canWrite() || !!proj;
  const who = agentName(state.sessions.get(state.sid));
  setIcon($("compose").querySelector("svg"), agentLogo(state.sessions.get(state.sid)));
  $("compose").querySelector("span").textContent = `${who} 에 보내기`;
  $("compose").title = proj ? "프로젝트 화판에서는 보내지 않습니다. 오른쪽 아래 대화 이력에서 대화를 골라 보내세요" : canWrite() ? `지금 보는 세션 전체에 대해 의견·지시를 써서 ${who} 에 보냅니다. 상자·단계에 대해서는 그 위의 「보내기」 를 누릅니다` : $("nokey").title;
  renderComposer(scene);
  const needs = band.some((x) => x.kind === "input" || x.kind === "wait");
  const prefix = needs ? "● 입력 필요 · " : band.some((x) => x.kind === "blocked") ? "막힘 · " : "";
  document.title = name ? `${prefix}${name} · AnyTaskView` : "AnyTaskView";
}

// 이어진 대화가 둘 이상이면 이름 옆에 ◀ n/m ▶. 그림은 대화마다 따로라 옮기면 그 대화의 화판을 연다
function renderThreadNav(s) {
  const th = s ? threadOf(s.id) : [], at = th.findIndex((x) => x.id === state.sid);
  $("thread-nav").hidden = th.length < 2 || at < 0;
  if ($("thread-nav").hidden) return;
  $("thread-pos").textContent = `대화 ${at + 1}/${th.length}`;
  $("thread-prev").disabled = at === 0;
  $("thread-next").disabled = at === th.length - 1;
}
// 세션 화판의 맨 위: 이 대화의 프로젝트(누르면 큰 그림), 없으면 「프로젝트 없음」(누르면 넣을 곳을 고르는 ⋯ 메뉴)
function renderProjLink(s) {
  const b = $("proj-link"), pid = s && projOf(s.id);
  b.hidden = !s;
  if (!s) return;
  const pr = pid && state.projects.projects[pid];
  b.classList.toggle("none", !pr);
  b.disabled = !pr && !canWrite();
  b.textContent = pr ? `프로젝트 ${pr.name}${pr.cur ? ` · 지금 ${pr.cur}` : ""}${pr.left ? ` · 남은 ${pr.left}` : ""}` : "프로젝트 없음";
  b.title = pr ? `「${pr.name}」 큰 그림 보기 · ${WHY_KO[state.projects.members[s.id]?.why] || ""}` : "이 대화를 넣을 프로젝트를 고릅니다";
  b.dataset.pid = pr ? pid : "";
}
$("proj-link").addEventListener("click", () => {
  const b = $("proj-link");
  if (b.dataset.pid) connect(b.dataset.pid);
  else if (state.sessions.has(state.sid)) openGroupMenu(state.sid, b);
});
for (const [id, d] of [["thread-prev", -1], ["thread-next", 1]]) {
  $(id).addEventListener("click", () => {
    const th = threadOf(state.sid), to = th[th.findIndex((x) => x.id === state.sid) + d];
    if (to) connect(to.id);
  });
}

// 주의 띠: 항목이 둘 이상이면 첫 줄만 보이고 「외 N개 ▾」 로 편다(화면이 아래로 밀리지 않게).
// 「닫기」 는 지금 항목을 숨기고, 닫을 때 없던 항목이 생기면 다시 보인다(세션마다, 이 탭이 열려 있는 동안)
const bandUi = { open: false, closed: new Map(), refocus: false }; // closed: 세션 id → 닫을 때의 항목 열쇠들
const bandItemKey = (x) => `${x.kind}|${x.id || ""}|${x.text}`;
function bandHidden(band) {
  const closed = bandUi.closed.get(state.sid);
  // 띠에서 빠진 항목은 잊는다: 풀린 뒤 같은 항목이 다시 오면 새 알림으로 보인다.
  // 재생 중이거나 스냅샷을 받기 전의 장면으로는 잊지 않는다
  if (closed && !state.replay && state.snapped) {
    const now = new Set(band.map(bandItemKey));
    for (const k of closed) if (!now.has(k)) closed.delete(k);
    if (!closed.size) bandUi.closed.delete(state.sid);
  }
  return !band.length || (!!closed && band.every((x) => closed.has(bandItemKey(x))));
}
function bandRows(band) {
  const more = band.length - 1, open = bandUi.open && more > 0, max = 8;
  const rows = (open ? band.slice(0, max) : band.slice(0, 1)).map((x, i) => {
    const row = el("div", `bi ${x.kind}`);
    row.append(el("span", "ico", x.ico), el("span", "txt", x.text));
    if (x.id) {
      const go = el("button", "mini", "보기");
      go.type = "button";
      go.addEventListener("click", () => reveal(x.id, x.step));
      row.append(go);
    }
    if (i === 0) {
      const tools = el("span", "btools");
      if (more) {
        const t = el("button", "mini btoggle", open ? "접기 ▴" : `외 ${more}개 ▾`);
        t.type = "button";
        t.setAttribute("aria-expanded", String(open));
        t.addEventListener("click", () => { bandUi.open = !bandUi.open; bandUi.refocus = true; renderTop.bandKey = null; render(); });
        tools.append(t);
      }
      const close = el("button", "mini", "닫기 ×");
      close.type = "button";
      close.title = "지금 알림을 숨깁니다. 새 알림이 오면 다시 보입니다";
      close.addEventListener("click", () => {
        bandUi.closed.set(state.sid, new Set(band.map(bandItemKey)));
        renderTop.bandKey = null;
        render();
        // 숨은 띠에 초점이 남지 않게 맨 위 줄의 누를 수 있는 첫 단추로(보통 「보내기」)
        [$("compose"), ...document.querySelectorAll("#top button")].find((x) => !x.disabled && !x.hidden && x.offsetParent)?.focus();
      });
      tools.append(close);
      row.append(tools);
    }
    return row;
  });
  if (open && band.length > max) rows.push(el("div", "bi", `외 ${band.length - max}개`));
  return rows;
}

// 띠의 「보기」: 단계는 계획에서, 부품은 그림에서 찾아 보여 준다
function reveal(id, isStep) {
  if (isStep) {
    if (layout.foldPlan) { layout.foldPlan = false; applyLayout(); saveLayout(); }
    const st = own(viewScene().items, id);
    if (st && st.status === "done" && !showDone()) setShowDone(true);
    render();
    const li = document.querySelector(`#plan-body li[data-id="${CSS.escape(id)}"]`);
    if (li) { li.scrollIntoView({ block: "center", behavior: "smooth" }); li.classList.remove("flash"); void li.offsetWidth; li.classList.add("flash"); }
    return;
  }
  setFollow(false);
  let p = own(viewScene().items, id);
  for (let i = 0; p && p.kind === "item" && i < 10; i++) p = own(viewScene().items, p.in);
  if (p) revealPart(p.id);
}

// 끝난 단계는 기본으로 숨기고 개수만 보인다. 실패·막힘과 지금 단계는 숨기지 않는다
const showDone = () => store.get("atv.showDone") === "1";
function setShowDone(on) { store.set("atv.showDone", on ? "1" : "0"); queueRender(); }
$("toggle-done").addEventListener("click", () => { state.planReveal = null; setShowDone(!showDone()); });

function renderPlan(scene, now) {
  const body = $("plan-body"), cur = currentStep(scene), nowBox = $("plan-now");
  const steps = Object.values(scene.items).filter((it) => it.kind === "step").sort((a, b) => a.ord - b.ord);
  const toggle = $("toggle-done");
  if (!steps.length) {
    nowBox.hidden = true;
    toggle.hidden = true;
    renderPlan.key = null;
    body.replaceChildren(el("p", "row2", isProj(state.sid) ? "이 프로젝트의 작업 단위가 여기에 보입니다." : "Claude 가 plan 으로 계획을 올리면 여기에 보입니다."));
    return;
  }
  // 지금 단계: 스크롤해도 위에 남는다
  nowBox.hidden = !cur;
  // 1초마다 불린다. 바뀔 때만 다시 만든다(전에는 매번 새로 만들어 반짝임이 매초 처음부터 다시 시작했다)
  const st = cur && own(scene.items, cur), nowKey = st ? `${st.status}\n${st.title}` : null;
  if (st && (nowKey !== renderPlan.nowKey || !nowBox.firstChild)) {
    const head = el("span", `st-${st.status}`);
    head.append(el("span", "ico", ST_ICO[st.status]), document.createTextNode(" 지금: "), el("span", "key", st.title));
    nowBox.replaceChildren(addShine(head));
  }
  renderPlan.nowKey = nowKey;
  const ids = new Set(steps.map((s) => s.id));
  const parentOf = (x) => (x.parent && ids.has(x.parent) ? x.parent : "");
  // 끝났고, 그 아래도 모두 끝났고, 지금 단계를 품지 않은 단계만 숨긴다
  const settled = new Map();
  const isSettled = (s) => {
    if (settled.has(s.id)) return settled.get(s.id);
    settled.set(s.id, false);
    const v = s.status === "done" && s.id !== cur && steps.filter((x) => parentOf(x) === s.id).every(isSettled);
    settled.set(s.id, v);
    return v;
  };
  const hideDone = !showDone();
  // 찾기로 고른 단계와 그 위 단계들은 숨기지 않는다
  const reveal = new Set();
  for (let id = state.planReveal, i = 0; id && ids.has(id) && i < 10; id = parentOf(own(scene.items, id)), i++) reveal.add(id);
  const doneCount = steps.filter((s) => s.status === "done").length;
  toggle.hidden = !doneCount;
  toggle.textContent = hideDone ? `끝난 단계 ${doneCount}개 보기` : "끝난 단계 숨기기";
  // 1초마다 불리므로 구조가 같으면 걸린 시간 글자만 고친다(다시 만들면 「보기」 강조와 대상 표시가 지워진다)
  const noteCount = (id) => scene.timeline.reduce((n, e) => n + (e.type === "note" && e.on === id ? 1 : 0), 0);
  const mailKey = (id) => { const ms = msgsTo(scene, id); return ms.length ? mailBadge(ms).title : ""; };
  const key = JSON.stringify([cur, hideDone, state.planReveal, steps.map((x) => [x.id, x.title, x.status, x.parent, x.note, !!x.answered, !!x.startT, noteCount(x.id), mailKey(x.id)])]);
  if (key === renderPlan.key && body.isConnected) {
    for (const li of body.querySelectorAll("li[data-id]")) {
      const stats = li.querySelector(":scope > .stats");
      const text = stats && statsText(stepStats(scene, li.dataset.id, now));
      if (stats && stats.textContent !== text) stats.textContent = text;
    }
    return;
  }
  renderPlan.key = key;
  const build = (parent) => {
    const ul = el("ul", "tree");
    let hidden = 0;
    for (const s of steps.filter((x) => parentOf(x) === parent)) {
      if (hideDone && isSettled(s) && !reveal.has(s.id)) { hidden++; continue; }
      const li = el("li", "step" + (s.id === cur ? " cur" : ""));
      li.dataset.id = s.id;
      li.tabIndex = 0; // 키보드로 단계에 가서 Enter 로 Claude 에 보낸다
      markSend(li, "단계");
      const head = el("div", `head st-${s.status}`);
      head.append(el("span", "ico", ST_ICO[s.status]), el("span", "title", s.title));
      if (s.status !== "todo" && s.status !== "doing") head.append(el("span", "tag", ST_KO[s.status]));
      if (s.answered) head.append(el("span", "tag", "답 받음"));
      const ms = msgsTo(scene, s.id);
      if (ms.length) {
        const mb = mailBadge(ms), mail = el("span", "mail" + (mb.queued ? " queued" : ""), mb.text);
        mail.title = mb.title;
        head.append(mail);
      }
      li.append(head);
      if (s.startT) li.append(el("div", "stats", statsText(stepStats(scene, s.id, now))));
      if (s.note) li.append(el("div", "snote", s.note));
      const notes = scene.timeline.filter((e) => e.type === "note" && e.on === s.id);
      if (notes.length) li.title = notes.map((n) => n.text).join("\n");
      const sub = build(s.id);
      if (sub.childElementCount) li.append(sub);
      ul.append(li);
    }
    if (hidden) {
      const li = el("li", "step");
      const head = el("div", "head st-done");
      head.append(el("span", "ico", ST_ICO.done), el("span", "muted", `끝난 단계 ${hidden}개`));
      li.append(head);
      ul.prepend(li);
    }
    return ul;
  };
  const act = document.activeElement, keep = act && body.contains(act) && act.matches("li[data-id]") ? act.dataset.id : null;
  const asked = !askBtn.hidden && askFor === act; // 되돌린 초점이 말풍선을 새로 띄우지 않게
  body.replaceChildren(build(""));
  const li = keep && body.querySelector(`li[data-id="${CSS.escape(keep)}"]`);
  if (li) {
    li.focus({ preventScroll: true });
    if (asked) showAsk(li); else hideAsk(true);
  }
}

// 작업 알림 입력: 새 기록은 훅이 sys 로 표시한다. 그 전에 쌓인 기록은 글 모양으로 알아본다
const isSysPrompt = (e) => e.sys || /^\s*<task-notification>/.test(e.text || "");
const sysText = (e) => (e.sys ? e.text : (String(e.text).match(/<summary>([\s\S]*?)(<\/summary>|$)/) || [])[1] || "백그라운드 작업 알림");

// 타임라인의 사실 한 줄을 표지와 글로 나눈다(표지 칸에 들어가게 짧게)
function factParts(e) {
  switch (e.f) {
    case "start": return ["세션", `시작 (${e.source})`];
    case "prompt": return ["알림", sysText(e)];
    case "edit": return ["수정", `${base(e.path)}${e.lines ? ":" + e.lines : ""}`];
    case "edit-fail": return ["수정 실패", `${base(e.path)}: ${e.error}`];
    case "todo": return ["할 일", `${e.tool}: ${e.text}`];
    case "agent-start": return ["에이전트", `시작${e.agentType ? " " + e.agentType : ""}`];
    case "agent-stop": return ["에이전트", `끝${e.agentType ? " " + e.agentType : ""}${e.last ? ": " + e.last : ""}`];
    case "notify": return ["입력 필요", e.text || ""];
    case "stop": return ["차례 끝", e.last || ""];
    case "end": return ["세션", `끝${e.reason ? ` (${e.reason})` : ""}`];
    case "gone": return ["세션", "끝 (claude 프로세스 없음)"];
    default: return [e.f, ""];
  }
}

// 타임라인 거르기: 종류별로 켜고 끈다(눌린 것이 보이는 것)
const TL_KINDS = [["talk", "대화"], ["run", "명령"], ["file", "파일"], ["note", "메모"], ["agent", "에이전트"]];
const tlHide = new Set(Array.isArray(store.json("atv.tlHide", [])) ? store.json("atv.tlHide", []) : []);
function tlKind(e) {
  if (e.type === "msg") return "talk";
  if (e.type === "note") return "note";
  if (e.type === "run") return "run";
  if (e.f === "edit" || e.f === "edit-fail" || e.f === "todo") return "file";
  if (e.f === "agent-start" || e.f === "agent-stop") return "agent";
  return "talk";
}
for (const [k, label] of TL_KINDS) {
  const b = el("button", "mini", label);
  b.type = "button";
  b.setAttribute("aria-pressed", String(!tlHide.has(k)));
  b.addEventListener("click", () => {
    if (tlHide.has(k)) tlHide.delete(k); else tlHide.add(k);
    b.setAttribute("aria-pressed", String(!tlHide.has(k)));
    store.set("atv.tlHide", JSON.stringify([...tlHide]));
    queueRender();
  });
  $("tl-filters").append(b);
}

// 프로젝트 화판의 오른쪽 아래: 이 프로젝트의 대화(기록된 사실만: 시작 시각·상태·고친 파일 수·올린 계획의 끝난 단계)와
// 큰 그림의 메모를 최근 것부터. 대화를 누르면 그 대화의 화판으로 간다
function renderHistory(scene, now) {
  const rows = [];
  for (const [sid, m] of Object.entries(state.projects.members)) {
    const s = m.pid === state.sid && state.sessions.get(sid);
    if (s && !s.empty) rows.push({ t: s.startedAt || s.lastT, s, why: m.why });
  }
  for (const e of scene.timeline) if (e.type === "note") rows.push({ t: e.t, e });
  rows.sort((a, b) => b.t - a.t);
  const items = rows.slice(0, 300).map((r) => {
    const li = el("li");
    li.append(el("span", "when", fmtWhen(r.t, now)));
    if (r.e) {
      if (r.e.kind) li.append(el("span", `k ${r.e.kind}`, NOTE_KO[r.e.kind]));
      const by = r.e.by && state.sessions.get(r.e.by);
      li.append(document.createTextNode(r.e.text + (r.e.on ? ` (${r.e.on})` : "") + (by ? ` · ${sessName(by)}` : "")));
      return li;
    }
    const s = r.s, b = el("button", "hist");
    b.type = "button";
    b.dataset.sid = s.id;
    b.append(el("span", `sico ${s.status}`, SESS_ICO[s.status] || "○"), document.createTextNode(` ${sessName(s)}`));
    b.title = `${WHY_KO[r.why] || ""} · 이 대화의 화판 보기`;
    b.addEventListener("click", () => connect(s.id));
    li.append(b, el("span", "muted", ` ${SESS_KO[s.status] || s.status} · 파일 ${s.edits || 0}${s.steps?.[1] ? ` · 단계 ${s.steps[0]}/${s.steps[1]}` : ""}`));
    return li;
  });
  if (!items.length) items.push(el("li", "muted", "아직 이 프로젝트에 든 대화가 없습니다. 세션 줄을 이 프로젝트로 끌어 놓거나, Claude 가 project 도구로 들어오면 여기에 쌓입니다."));
  // 다른 세션의 사건마다 다시 만들므로, 키보드 초점이 대화 단추에 있었으면 같은 대화의 단추로 되돌린다
  const focused = document.activeElement?.closest?.("#tl-body .hist")?.dataset.sid;
  $("tl-body").replaceChildren(...items);
  if (focused) $("tl-body").querySelector(`.hist[data-sid="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  $("tl-new").hidden = true;
}

// 타임라인 줄 요소. 열쇠는 기록 번호와 그 줄의 모양을 바꾸는 값(실행 상태·걸린 시간, 보낸 글 상태, 묶은 수정 횟수)이다.
// 기록 번호는 세션마다 따로 매기므로 다른 세션·스냅샷으로 바꿀 때 비운다
let tlCache = new Map();
// 타임라인 줄 하나를 가리키는 열쇠(한 기록에 줄이 여럿일 수 있다: 모아 보내기)
const tlKey = (e) => `${e.seq}:${e.mid || e.id || ""}`;
function rowKey(scene, row, now) {
  if (row.mark) return "mark";
  const e = row.e;
  if (e.type === "msg") return `m${e.seq}:${JSON.stringify(own(scene.msgs || {}, e.mid))}:${agentName(state.sessions.get(state.sid))}`;
  if (e.type === "run") { const r = own(scene.runs, e.id); return `r${e.seq}:${JSON.stringify(r)}:${runDur(r, now) ?? ""}`; }
  return `${e.type}${e.seq}:${row.n}`;
}
const runDur = (r, now) => { const d = r.state === "running" || r.state === "wait" ? now - r.start : r.dur ?? (r.end && r.start ? r.end - r.start : null); return d == null ? null : fmtDur(d); };
function tlRow(scene, { mark, e, n }, now) {
  if (mark) return el("li", "new-mark", "▲ 여기부터 새것");
  const li = el("li");
  li.dataset.seq = e.seq; // 찾기가 이 줄로 온다
  li.dataset.key = tlKey(e);
  li.append(el("span", "when", fmtClock(e.t)));
  // 한 줄 = 시각 | 종류 표지 | 글 세 칸(.tl-k·.tl-t). 표지 칸 폭이 같아 글 머리가 줄마다 맞고, 넘어간 줄도 글 머리 아래에서 잇는다
  const kind = (cls, label) => li.append(el("span", `tl-k${cls ? " k " + cls : ""}`, label));
  const body = (...parts) => { const t = el("span", "tl-t"); t.append(...parts); li.append(t); return t; };
  if (e.type === "msg") {
    const m = own(scene.msgs || {}, e.mid);
    kind(m.state, MSG_STATE_KO[m.state] || m.state);
    body(`화판 → ${agentName(state.sessions.get(state.sid))} (${MSG_KIND_KO[m.kind]}${m.target ? " · " + m.target.id : ""}): ${m.text}`);
    li.classList.add("prompt");
    li.title = m.text;
  } else if (e.type === "note") {
    kind(e.kind || "note", NOTE_KO[e.kind] || "메모");
    body(e.text + (e.on ? ` (${e.on})` : ""));
    if (safeRef(e.ref)) { li.classList.add("copy"); li.dataset.ref = e.ref; }
  } else if (e.type === "run") {
    const r = own(scene.runs, e.id), dur = runDur(r, now);
    kind(r.state, RUN_KO[r.state] || r.state);
    const t = body(r.desc || r.cmd);
    if (dur != null) t.append(el("span", "dur", ` · ${dur}`)); // 걸린 시간은 글 뒤에(표지를 짧게 두어 칸 폭을 맞춘다)
    li.title = r.cmd + (r.error ? `\n${r.error}` : "");
    if (r.agent) li.classList.add("sub");
  } else {
    if (e.agent) li.classList.add("sub");
    if (e.f === "prompt") { li.classList.add(isSysPrompt(e) ? "sys" : "prompt"); li.title = e.text; }
    // 사용자 입력은 「사용자」 표지를 붙여 화판에서 보낸 글·기계 기록과 가른다
    if (e.f === "prompt" && !isSysPrompt(e)) { kind("user", "사용자"); body(e.text); }
    else { const [label, text] = factParts(e); kind(`fact ${e.f}`, label); body(text); }
    if (e.f === "edit") {
      li.querySelector(".tl-t").append(el("span", "times", n > 1 ? `×${n}` : ""));
      if (safeRef(e.path)) {
        const line = String(e.lines || "").match(/^\d+/);
        li.classList.add("copy");
        li.dataset.ref = e.path + (line ? ":" + line[0] : "");
        li.title = e.path;
      }
    }
  }
  return li;
}
// 자식들을 nodes 순서로 맞춘다. 빠진 요소를 먼저 떼고, 이미 제자리에 있는 요소는 건드리지 않는다
function reconcile(parent, nodes) {
  const want = new Set(nodes);
  for (let c = parent.firstChild; c;) { const nx = c.nextSibling; if (!want.has(c)) c.remove(); c = nx; }
  let cur = parent.firstChild;
  for (const n of nodes) {
    if (n === cur) cur = cur.nextSibling;
    else parent.insertBefore(n, cur);
  }
}

function renderTimeline(scene, now) {
  const proj = isProj(state.sid);
  $("tl-title").textContent = proj ? "대화 이력" : "타임라인";
  $("tl-filters").hidden = proj;
  $("popout").hidden = proj;
  // 시각을 왼쪽 칸에 두고 글은 그 오른쪽에 내어 쓴다(대화 이력은 날짜가 붙어 폭이 달라 그대로 둔다)
  $("tl-body").classList.toggle("hang", !proj);
  if (proj) return renderHistory(scene, now);
  const ol = $("tl-body"), box = $("timeline");
  const items = [];
  // 시작 없이 끝만 온 하위 에이전트(종류도 없음)는 Claude Code 안쪽 보조 에이전트(다음 입력 제안 따위)로 보여 숨긴다
  const started = new Set(scene.timeline.filter((e) => e.f === "agent-start" && e.agent).map((e) => e.agent));
  const helper = (e) => e.f === "agent-stop" && !e.agentType && !started.has(e.agent);
  // 보통은 최근 400줄. 찾기로 고른 줄(tlFocus)이 그보다 옛것이거나 거르기로 숨긴 것이어도 그 줄까지 보인다
  const fi = state.tlFocus != null ? scene.timeline.findIndex((e) => e.seq === state.tlFocus) : -1;
  const from = Math.max(0, scene.timeline.length - 400), focus = fi >= 0 ? state.tlFocus : null;
  const entries = scene.timeline.slice(fi >= 0 ? Math.min(fi, from) : from).reverse()
    .filter((e) => e.seq === focus || (!tlHide.has(tlKind(e)) && !(e.agent && tlHide.has("agent")) && !helper(e)));
  // 먼저 줄을 정한다: 「여기부터 새것」 표시, 같은 파일을 잇달아 고친 기록은 한 줄로(가장 최근 줄에 횟수를 붙인다)
  const rows = [];
  let marked = false, prevEdit = null;
  for (const e of entries) {
    if (!marked && state.markerSeq && !state.replay && e.seq <= state.markerSeq && entries[0].seq > state.markerSeq) {
      rows.push({ mark: true });
      marked = true;
      prevEdit = null;
    }
    if (e.type === "fact" && e.f === "edit" && e.seq !== focus && prevEdit && prevEdit.e.seq !== focus && prevEdit.e.path === e.path && prevEdit.e.agent === e.agent) { prevEdit.n++; continue; }
    prevEdit = null;
    if ((e.type === "msg" && !own(scene.msgs || {}, e.mid)) || (e.type === "run" && !own(scene.runs, e.id))) continue;
    const row = { e, n: 1 };
    rows.push(row);
    if (e.type === "fact" && e.f === "edit") prevEdit = row;
  }
  // 줄마다 그 모양을 정하는 값으로 열쇠를 만들고, 열쇠가 같으면 지난번 요소를 그대로 쓴다.
  // 바뀌지 않은 줄을 다시 만들지 않으므로 사건 하나에 새 줄 하나만 배치된다(전에는 400줄을 매번 새로 만들었다)
  const next = new Map();
  for (const row of rows) {
    let key = rowKey(scene, row, now);
    while (next.has(key)) key += "'"; // 같은 열쇠가 둘이면(같은 기록 번호의 줄 둘) 따로 만든다
    const li = tlCache.get(key) || tlRow(scene, row, now);
    next.set(key, li);
    items.push(li);
  }
  tlCache = next;
  // 새 항목은 위에 붙는다. 사용자가 아래(옛 기록)를 보고 있으면 보던 자리를 지키고 「새 항목」 단추를 띄운다
  const latest = scene.timeline.length ? scene.timeline[scene.timeline.length - 1].seq : 0;
  const away = box.scrollTop > 8 && !state.replay;
  // 보던 줄(칸 위쪽에 걸친 첫 줄)을 기준으로 삼는다. 줄을 넣고 「새 항목」 단추까지 띄운 뒤 그 줄이 같은 자리에 오게 스크롤을 옮긴다
  // (단추도 목록을 밀어낸다). 그 줄이 없어졌으면(모양이 바뀌어 새로 만듦) 높이 차이로 맞춘다
  let anchor = null, top = 0;
  const before = away ? box.scrollHeight : 0;
  if (away) {
    const edge = box.getBoundingClientRect().top;
    anchor = [...ol.children].find((li) => li.getBoundingClientRect().bottom > edge) || null;
    if (anchor) top = anchor.getBoundingClientRect().top;
  }
  reconcile(ol, items);
  if (!away) state.tlTopSeq = latest;
  const fresh = scene.timeline.filter((e) => e.seq > state.tlTopSeq).length;
  const btn = $("tl-new");
  btn.hidden = !away || !fresh;
  btn.textContent = `▲ 새 항목 ${fresh}개`;
  if (away) box.scrollTop += anchor?.isConnected ? anchor.getBoundingClientRect().top - top : box.scrollHeight - before;
}
$("tl-new").addEventListener("click", () => { $("timeline").scrollTo({ top: 0, behavior: "smooth" }); });
$("timeline").addEventListener("scroll", () => {
  // 맨 위로 오면 찾기로 펼친 옛 줄을 접는다(찾은 줄로 옮기느라 맨 위가 된 것은 빼고)
  if ($("timeline").scrollTop <= 8 && state.tlFocus != null && performance.now() - (state.tlJumpT || 0) > 600) { state.tlFocus = null; queueRender("view"); }
  if ($("timeline").scrollTop <= 8 && !$("tl-new").hidden) queueRender();
});
$("popout").addEventListener("click", () => {
  if (!state.sid) return;
  window.open(`/?only=tl#s=${encodeURIComponent(state.sid)}`, `atv-tl-${state.sid}`, "popup,width=520,height=860");
});

function renderReplay() {
  const slider = $("slider"), label = $("replay-label");
  if (state.replay) {
    slider.max = String(state.replay.records.length - 1);
    slider.value = String(state.replay.idx);
    const r = state.replay.records[state.replay.idx];
    label.textContent = r ? `재생 ${state.replay.idx + 1}/${state.replay.records.length} · ${fmtClock(r.t)}` : "재생";
  } else {
    slider.max = String(Math.max(state.seq - 1, 0));
    slider.value = slider.max;
    label.textContent = `실시간 · 사건 ${state.seq}`;
  }
  $("live").disabled = !state.replay;
}

// 이 브라우저가 마지막으로 본 사건 번호를 기억한다(보이는 동안만)
function markSeen() {
  if (!state.sid || state.replay || document.visibilityState !== "visible") return;
  store.set(`atv.seen.${state.sid}`, String(state.seq));
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.sid) {
    state.markerSeq = Number(store.get(`atv.seen.${state.sid}`) || 0);
    queueRender();
  }
});

// ---- 재생 ----
async function enterReplay(idx) {
  if (!state.sid) return;
  if (!state.replay) {
    if (state.replayLoading) return; // 이미 받는 중
    const sid = state.sid, token = ++state.replayToken;
    state.replayLoading = [];
    $("auto-place").hidden = true;
    $("plan-now").classList.remove("live"); // 지난 기록을 받는 동안에도 반짝이지 않게
    let records;
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/log`);
      records = r.ok ? await r.json() : null;
    } catch { records = null; }
    if (token !== state.replayToken || sid !== state.sid) return; // 그사이 세션을 바꿨다
    const waiting = state.replayLoading;
    state.replayLoading = null;
    if (!records) return toast("기록을 받지 못했습니다");
    const last = records.length ? records[records.length - 1].seq : 0;
    for (const rec of waiting) if (rec.seq > last) records.push(rec);
    state.replay = { records, idx: 0, scene: newScene() };
    canvas.invalidate();
  }
  const rp = state.replay;
  rp.idx = Math.max(0, Math.min(idx, rp.records.length - 1));
  rp.scene = newScene();
  for (let i = 0; i <= rp.idx; i++) applyRes(rp.scene, rp.records[i].res);
  queueRender();
}
$("slider").addEventListener("input", (ev) => {
  const v = Number(ev.target.value);
  if (!state.replay && v >= Number(ev.target.max)) return;
  enterReplay(v);
});
$("live").addEventListener("click", () => {
  state.replay = null;
  canvas.invalidate();
  queueRender();
});

// ---- 테마 ----
const THEMES = ["", "light", "dark"], THEME_KO = { "": "자동", light: "밝게", dark: "어둡게" }, THEME_ICO = { "": "i-auto", light: "i-sun", dark: "i-moon" };
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  const next = THEMES[(THEMES.indexOf(t) + 1) % THEMES.length];
  setIcon($("theme").querySelector("svg"), THEME_ICO[t]);
  $("theme").setAttribute("aria-label", `테마: ${THEME_KO[t]}`);
  $("theme").title = `테마: ${THEME_KO[t]} · 누르면 ${THEME_KO[next]}`;
}
applyTheme(store.get("atv.theme") || "");
$("theme").addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme || "";
  const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  store.set("atv.theme", next);
  applyTheme(next);
  canvas.invalidate(); // Mermaid 색을 다시 그린다
  queueRender();
});
// ---- 도움말: 단추와 ? 키로 여닫는다. Esc 는 dialog 가 스스로 닫는다 ----
const help = $("help");
const toggleHelp = () => (help.open ? help.close() : help.showModal());
$("help-open").addEventListener("click", toggleHelp);
$("help-close").addEventListener("click", () => help.close());
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "?" || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const t = ev.target;
  if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return; // 글을 쓰는 중
  ev.preventDefault();
  toggleHelp();
});

// ---- 설정: 이어받기 문구, 지난 세션 정리 ----
const settings = $("settings");
$("settings-open").addEventListener("click", () => {
  const r = state.config.resume;
  $("cfg-phrase").value = r?.phrase || "";
  $("cfg-doc").value = r?.doc || "";
  $("cfg-trash").value = state.config.trashDays ?? "";
  settings.showModal();
  $("cfg-phrase").focus();
});
$("settings-close").addEventListener("click", () => settings.close());
$("settings-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const phrase = $("cfg-phrase").value.trim(), doc = $("cfg-doc").value.trim(), days = $("cfg-trash").value.trim();
  const out = await boardOp({ op: "config-set", resume: phrase ? { phrase, doc } : null, trashDays: days ? Number(days) : null });
  if (!out.ok) return;
  settings.close();
  toast(out.msg);
});

// 다른 창(뗀 타임라인)에서 테마를 바꾸면 따라간다
window.addEventListener("storage", (ev) => { if (ev.key === "atv.theme") applyTheme(ev.newValue || ""); });

// 타임라인·계획의 위치 복사
side.addEventListener("click", (ev) => {
  const hit = ev.target.closest("[data-ref]");
  if (hit) copyRef(hit.dataset.ref);
});

// 걸린 시간·「멈춘 듯」 표시를 1초마다 고친다(그림은 다시 그리지 않는다)
setInterval(() => {
  if (!state.sid) return;
  const scene = viewScene(), now = viewNow();
  renderTop(scene, now);
  renderPlan(scene, now);
  if (Object.values(scene.runs).some((r) => r.state === "running" || r.state === "wait")) renderTimeline(scene, now);
}, 1000);

// 세션을 바꿀 때: 그 세션에 쓰던 이름 고치기와 보내기 창을 닫는다. 보내기 창에 쓰던 글은 비운다
function leaveSession() {
  if (!$("name-form").hidden) { $("name-form").hidden = true; $("sess-name").hidden = false; }
  bandUi.open = false; // 띠 펼침은 그 세션에서만(다른 세션은 접힌 채로 연다)
  closeComposer(false); // 쓰던 글은 그 받는 곳의 글로 남는다
  hideAsk(true);
}

// ---- 세션·프로젝트 이름 ----
$("sess-name").addEventListener("click", () => {
  const s = state.sessions.get(state.sid), pr = isProj(state.sid) && state.projects.projects[state.sid];
  if (!s && !pr) return;
  $("name-input").value = pr ? pr.name : s.name || "";
  $("name-input").placeholder = pr ? "프로젝트 이름" : s.title || "이름";
  $("name-form").hidden = false;
  $("sess-name").hidden = true;
  $("name-input").focus();
});
const closeName = () => { $("name-form").hidden = true; queueRender(); };
$("name-cancel").addEventListener("click", closeName);
$("name-input").addEventListener("keydown", (ev) => { if (ev.key === "Escape") closeName(); });
$("name-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const sid = state.sid;
  closeName();
  // 세션 이름은 비우면 Claude Code 이름·첫 프롬프트로 돌아간다. 프로젝트 이름은 비울 수 없다
  if (isProj(sid)) { if ($("name-input").value.trim()) await boardOp({ op: "proj-rename", pid: sid, name: $("name-input").value }); }
  else if (sid) await boardOp({ op: "rename", sid, name: $("name-input").value });
});

// ---- 프로젝트 만들기·옮기기 ----
// 목록은 이어진 대화를 한 줄로 보이므로 프로젝트도 그 대화들 모두에 함께 정한다(서버가 한 번에 바꾼다).
// 빨리 두 번 옮겨도 고른 차례대로 처리되게 줄을 세운다
let projChain = Promise.resolve();
const queueProjects = (job) => { projChain = projChain.then(job, job); return projChain; };
// 서버는 한 번에 50개까지 받는다. 그보다 긴 대화 줄(몇 주 이어진 /clear·이어받기)은 나눠 보낸다
async function setThreadProject(sid, pid) {
  const ids = threadOf(sid).map((x) => x.id);
  for (let i = 0; i < ids.length; i += 50) if (!(await boardOp({ op: "proj-set", sids: ids.slice(i, i + 50), pid })).ok) return;
}
const moveThread = (sid, pid) => queueProjects(() => setThreadProject(sid, pid));
$("group-add").addEventListener("click", () => {
  if (layout.foldLeft) { layout.foldLeft = false; applyLayout(); saveLayout(); }
  const holder = el("span");
  $("sess-body").prepend(holder);
  inlineEdit(holder, "", (name) => queueProjects(() => boardOp({ op: "proj-new", name })), $("group-add")); // 닫히면 목록을 새로 그린다
});

// 「⋯」 메뉴: 끌기를 쓸 수 없을 때(키보드) 같은 일을 한다. 방향키로 고르고 Enter, Esc 로 닫는다
const gmenu = $("group-menu");
// 메뉴를 연 단추를 찾는 함수. 메뉴가 열린 동안 목록이 다시 그려져도 닫을 때 그 단추를 다시 찾아 초점을 돌려준다
let gmenuBack = null;
function showMenu(anchor, back, items, label = "메시지·프로젝트·지우기") {
  gmenu.replaceChildren(...items);
  gmenu.setAttribute("aria-label", label);
  gmenuBack = back;
  anchor.setAttribute("aria-expanded", "true");
  gmenu.hidden = false;
  const r = anchor.getBoundingClientRect();
  gmenu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - gmenu.offsetWidth - 8))}px`;
  gmenu.style.top = `${Math.max(8, Math.min(r.bottom + 4, innerHeight - gmenu.offsetHeight - 8))}px`;
}
function openGroupMenu(sid, anchor) {
  const cur = projOf(sid) || "";
  const item = (label, checked, run) => {
    const b = el("button", "gm-item", label);
    b.type = "button";
    b.setAttribute("role", "menuitemradio");
    b.setAttribute("aria-checked", String(checked));
    b.addEventListener("click", run);
    return b;
  };
  const named = Object.entries(state.projects.projects).sort((a, b) => !!a[1].done - !!b[1].done || a[1].name.localeCompare(b[1].name));
  const items = [
    ...named.map(([pid, g]) => item(g.done ? `${g.name} (끝)` : g.name, cur === pid, () => { closeGroupMenu(); moveThread(sid, pid); })),
    item("프로젝트 없음", !cur, () => { closeGroupMenu(); moveThread(sid, null); }),
  ];
  const make = el("button", "gm-item", "새 프로젝트…");
  make.type = "button";
  make.setAttribute("role", "menuitem");
  make.addEventListener("click", () => inlineEdit(make, "", (name) => {
    closeGroupMenu();
    queueProjects(async () => {
      const out = await boardOp({ op: "proj-new", name });
      if (out.ok) await setThreadProject(sid, out.pid);
    });
  }));
  // 맨 위 「프로젝트 없음」 단추에서 열면 그 단추로, 목록 줄에서 열면 그 줄의 ⋯ 로 초점을 돌려준다
  const back = anchor.id ? () => anchor : () => $("sess-body").querySelector(`.smenu[data-sid="${CSS.escape(sid)}"]`);
  showMenu(anchor, back, [messageItem(sid), el("hr", "gm-sep"), el("div", "gm-title", "프로젝트로 옮기기"), ...items, make, el("hr", "gm-sep"), deleteItem(sid)]);
  (gmenu.querySelector('[aria-checked="true"]') || items[0]).focus();
}
// 프로젝트 머리의 ⋯: 이름 바꾸기, 끝으로 표시·다시 진행, 지우기(대화는 남김), 끝난 대화까지 지우기(둘 다 두 번 눌러야 한다)
function openProjectMenu(pid, anchor) {
  const pr = state.projects.projects[pid];
  const item = (label, run, cls = "") => {
    const b = el("button", `gm-item ${cls}`.trim(), label);
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.addEventListener("click", run);
    return b;
  };
  const rename = item("이름 바꾸기…", () => inlineEdit(rename, pr.name, (name) => { closeGroupMenu(); boardOp({ op: "proj-rename", pid, name }); }));
  const done = item(pr.done ? "다시 진행으로 두기" : "끝으로 표시", () => { closeGroupMenu(); boardOp({ op: "proj-done", pid, done: !pr.done }); });
  const drop = item("지우기", () => {
    if (!drop.classList.contains("armed")) { drop.classList.add("armed"); drop.textContent = "한 번 더 누르면 지웁니다(대화는 남습니다)"; return; }
    closeGroupMenu();
    boardOp({ op: "proj-drop", pid });
  }, "gm-del");
  drop.title = "프로젝트를 지웁니다. 대화는 「프로젝트 없음」 으로 가고, 큰 그림 기록은 상태 폴더의 trash 에 30일 동안 남습니다";
  // 끝난 대화까지: 서버가 받은 때의 소속으로 끝난 대화를 휴지통으로 옮기고 프로젝트를 지운다(한 번에, 일부만 되면 프로젝트는 남는다).
  // 진행 중인 대화는 「프로젝트 없음」 으로 남는다. 여기 수는 안내일 뿐이다
  const ended = () => [...state.sessions.values()].filter((s) => projOf(s.id) === pid && s.status === "ended").length;
  const purge = item(`끝난 대화까지 지우기(${ended()}개)`, async () => {
    if (!purge.classList.contains("armed")) { purge.classList.add("armed"); purge.textContent = `한 번 더 누르면 프로젝트와 끝난 대화 ${ended()}개를 지웁니다`; return; }
    closeGroupMenu();
    const out = await boardOp({ op: "proj-purge", pid });
    if (out.ok) toast(out.msg);
  }, "gm-del");
  purge.title = "프로젝트와 그 안의 끝난 대화를 지웁니다. 진행 중인 대화는 「프로젝트 없음」 으로 가고, 지운 기록은 상태 폴더의 trash 에 30일 동안 남습니다";
  showMenu(anchor, () => $("sess-body").querySelector(`.pmenu[data-pid="${CSS.escape(pid)}"]`), [el("div", "gm-title", pr.name), rename, done, el("hr", "gm-sep"), drop, purge]);
  rename.focus();
}
// 지난 세션 머리의 ⋯: 그 묶음의 지난 세션(이어진 대화 포함, 끝난 것만)을 모두 휴지통으로. 두 번 눌러야 지운다
function openPastMenu(key, past, anchor) {
  const ids = () => [...new Set(past.flatMap((t) => threadOf(t[0].id, true)).filter((s) => s.status === "ended" && state.sessions.has(s.id)).map((s) => s.id))];
  const b = el("button", "gm-item gm-del", `지난 세션 모두 지우기(${past.length}줄)`);
  b.type = "button";
  b.setAttribute("role", "menuitem");
  b.title = "이 묶음의 지난 세션을 목록과 화판에서 지웁니다. 기록은 상태 폴더의 trash 에 30일 동안 남습니다";
  b.addEventListener("click", async () => {
    if (!b.classList.contains("armed")) { b.classList.add("armed"); b.textContent = `한 번 더 누르면 지난 세션 ${past.length}줄을 지웁니다`; return; }
    closeGroupMenu();
    const all = ids();
    let n = 0;
    for (let i = 0; i < all.length; i += 500) {
      const out = await boardOp({ op: "sess-delete", sids: all.slice(i, i + 500) });
      if (!out.ok) return;
      n += out.gone.length;
    }
    toast(`지난 세션의 대화 ${n}개를 지웠습니다`);
  });
  showMenu(anchor, () => $("sess-body").querySelector(`.pmenu[data-past="${CSS.escape(key)}"]`), [el("div", "gm-title", "지난 세션"), b], "지난 세션");
  b.focus();
}
// 「메시지 보내기…」: 보던 화면을 바꾸지 않고 그 줄의 대화(대표 = 진행 중인 것 먼저)에 보내기 창을 줄 아래에 연다
function messageItem(sid) {
  const b = el("button", "gm-item", "메시지 보내기…");
  b.type = "button";
  b.setAttribute("role", "menuitem");
  const s = state.sessions.get(sid);
  b.prepend(icon(agentLogo(s), "logo"));
  if (!s || s.status === "ended") {
    b.setAttribute("aria-disabled", "true");
    b.title = "끝난 대화에는 보낼 수 없습니다";
    return b;
  }
  b.title = `이 세션의 ${agentName(s)} 에 의견·지시를 보냅니다. 보던 화면은 그대로입니다`;
  b.addEventListener("click", () => {
    closeGroupMenu(false);
    openComposer({
      sid, target: null,
      anchor: () => $("sess-body").querySelector(`.sess[data-sid="${CSS.escape(sid)}"]`)?.parentElement,
      back: () => $("sess-body").querySelector(`.smenu[data-sid="${CSS.escape(sid)}"]`),
    });
  });
  return b;
}
// 「지우기」: 그 줄의 끝난 대화와 쉬는 Codex 앱 대화를 지운다(진행 중인 대화는 남는다). 한 번 누르면 글이 바뀌고, 한 번 더 누르면 지운다.
// 꺼짐은 disabled 대신 aria-disabled 로 둔다(disabled 는 초점을 받지 못해 방향키 이동이 그 자리에서 막힌다)
function deleteItem(sid) {
  const thread = threadOf(sid, true), ids = thread.filter((x) => x.drop ?? x.status === "ended").map((x) => x.id);
  const live = thread.length - ids.length, idle = thread.some((x) => x.idleApp);
  const b = el("button", "gm-item gm-del", live && ids.length ? `지우기(${idle ? "지울 수 있는" : "끝난"} 대화 ${ids.length}개만)` : "지우기");
  b.type = "button";
  b.setAttribute("role", "menuitem");
  if (!ids.length) {
    b.setAttribute("aria-disabled", "true");
    b.title = "진행 중인 대화는 지울 수 없습니다. 끝난 뒤에 지우세요(Codex 앱 대화는 쉬는 중이 되면 지울 수 있습니다)";
    return b;
  }
  b.title = idle
    ? "이 줄의 대화를 목록과 화판에서 지웁니다. Codex 앱(VS Code·데스크톱 앱) 대화는 끝났는지 알 수 없어 쉬는 중이어도 지웁니다. 그 대화에서 다시 일하면 목록에 다시 나타납니다. 기록은 상태 폴더의 trash 에 30일 동안 남습니다"
    : "이 줄의 끝난 대화를 목록과 화판에서 지웁니다. 기록은 상태 폴더의 trash 에 30일 동안 남습니다";
  b.addEventListener("click", async () => {
    if (!b.classList.contains("armed")) {
      b.classList.add("armed");
      b.textContent = `한 번 더 누르면 지웁니다(대화 ${ids.length}개)`;
      return;
    }
    closeGroupMenu();
    let n = 0;
    for (let i = 0; i < ids.length; i += 50) {
      const out = await boardOp({ op: "sess-delete", sids: ids.slice(i, i + 50) });
      if (!out.ok) return;
      n += out.gone.length;
    }
    toast(`대화 ${n}개를 지웠습니다`);
  });
  return b;
}
// 머리줄 「정렬」: 줄 순서 하나를 고르고, 끝난 세션 숨기기를 켜고 끈다(이 브라우저에 기억)
function sortLabel() {
  $("sess-sort").textContent = `${SORTS[sessSort()]} ▾`;
  $("sess-sort").setAttribute("aria-label", `정렬: ${SORTS[sessSort()]}${hideEnded() ? ", 끝난 세션 숨김" : ""}`);
}
$("sess-sort").addEventListener("click", () => {
  const anchor = $("sess-sort");
  const pick = (label, role, checked, run) => {
    const b = el("button", "gm-item", label);
    b.type = "button";
    b.setAttribute("role", role);
    b.setAttribute("aria-checked", String(checked));
    b.addEventListener("click", () => { run(); closeGroupMenu(); sortLabel(); queueRender(); });
    return b;
  };
  const sorts = Object.entries(SORTS).map(([k, label]) => pick(label, "menuitemradio", sessSort() === k, () => store.set("atv.sessSort", k)));
  sorts[0].title = "새로 시작한 줄이 위에 오고, 그 뒤로는 자리가 바뀌지 않습니다(/clear·이어받기로 이어진 대화는 처음 대화의 자리에 붙습니다)";
  sorts[1].title = "입력이 필요한 대화가 맨 위, 끝난 대화가 아래, 나머지는 최근에 움직인 순서입니다(일할 때마다 자리가 바뀝니다)";
  sorts[2].title = "이름 가나다순입니다";
  const hide = pick("끝난 세션 숨기기", "menuitemcheckbox", hideEnded(), () => store.set("atv.hideEnded", hideEnded() ? "0" : "1"));
  showMenu(anchor, () => anchor, [el("div", "gm-title", "정렬"), ...sorts, el("hr", "gm-sep"), hide], "정렬");
  (gmenu.querySelector('[aria-checked="true"]') || sorts[0]).focus();
});
sortLabel();
function closeGroupMenu(back = true) {
  if (gmenu.hidden) return;
  gmenu.hidden = true;
  const btn = gmenuBack?.();
  btn?.setAttribute("aria-expanded", "false");
  if (back) btn?.focus();
  gmenuBack = null;
}
gmenu.addEventListener("keydown", (ev) => {
  if (ev.target instanceof HTMLInputElement) return; // 새 프로젝트 이름을 쓰는 중
  const items = [...gmenu.querySelectorAll(".gm-item")], i = items.indexOf(document.activeElement);
  if (ev.key === "Escape") { ev.preventDefault(); closeGroupMenu(); }
  else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
    ev.preventDefault();
    items[(i + (ev.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
  }
});
document.addEventListener("pointerdown", (ev) => { if (!gmenu.hidden && !gmenu.contains(ev.target)) closeGroupMenu(false); });

// ---- Claude 에 보내기 ----
// 보내기 창 하나를 그림의 상자·계획의 단계 옆(말풍선), 세션 줄 아래(⋯ 「메시지 보내기…」), 맨 위 단추 아래에 띄운다.
// ask = { sid, target, anchor, back }: 받는 세션, 대상 부품·단계 id(없으면 세션 전체), 창을 붙일 요소와 닫을 때 초점을
// 돌려줄 요소를 찾는 함수. 목록·계획·그림은 사건마다 다시 그려지므로 요소 대신 찾는 함수를 둔다
const composer = $("composer");
// ask.key: 초안 자리(받는 세션·대상), ask.cid: 이 창에서 보낼 글의 번호, ask.typed: 이 창에서 글을 고쳤는가
let ask = null;
let sending = false; // 보내는 요청을 기다리는 중(그사이 Enter 를 또 눌러도 한 번만 보낸다)

// ---- 쓰다 둔 글·모은 글 저장 ----
// 탭이나 브라우저를 닫아도 남도록 localStorage 한 곳(atv.compose)에 { v: 1, basket: { sid, items }, drafts } 로 둔다.
// 초안은 받는 곳(세션·대상)마다 따로 둔다(다른 대상의 창에 남아 엉뚱한 곳으로 보내지 않게). 모든 탭이 같이 쓰므로
// 바꿀 때는 Web Lock 안에서 최신값을 읽어 고친 뒤 쓰고, 다른 탭은 storage 사건으로 다시 읽는다(열린 창의 글은 덮지 않는다).
// 글마다 cid 를 두어 서버가 같은 글을 두 번 받지 않는다(보내는 사이 탭이 닫혀 다시 보내도 한 번만 들어간다).
// 깨졌거나 모르는 판의 값은 덮어쓰지 않고 이 탭에만 둔다. 저장이 안 되면(saved=false) 띠와 보내기 창에 알린다
const COMPOSE_KEY = "atv.compose", MAX_DRAFTS = 50;
const compose = { basket: { sid: null, items: [] }, drafts: {}, broken: false, saved: true };
const draftKey = (a) => `${a.sid} ${a.target || ""}`;
const newCid = () => crypto.randomUUID();
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isMsg = (x) => isObj(x) && typeof x.cid === "string" && (x.kind === "comment" || x.kind === "instruction") && typeof x.text === "string";
// 저장소에서 읽어 메모리를 바꿨으면 true. 읽지 못했거나 깨진 값이면 메모리를 그대로 두고 false
function loadCompose() {
  let raw;
  try { raw = localStorage.getItem(COMPOSE_KEY); } catch { compose.saved = false; return false; }
  try {
    const d = raw === null ? { v: 1 } : JSON.parse(raw);
    if (!isObj(d) || d.v !== 1) throw new Error("모르는 판");
    const b = isObj(d.basket) ? d.basket : {}, items = Array.isArray(b.items) ? b.items.filter(isMsg) : [];
    if (items.length && typeof b.sid !== "string") throw new Error("받는 곳 없는 모은 글");
    compose.basket = { sid: items.length ? b.sid : null, items };
    compose.drafts = Object.fromEntries(Object.entries(isObj(d.drafts) ? d.drafts : {}).filter(([, x]) => isMsg(x)));
    compose.broken = false;
    return true;
  } catch { compose.broken = true; compose.saved = false; return false; }
}
function saveCompose() {
  if (compose.broken) return;
  // 초안은 최근 것 MAX_DRAFTS 개까지만 둔다(끝난 대화의 초안이 쌓이지 않게)
  for (const [k] of Object.entries(compose.drafts).sort((a, b) => (b[1].t || 0) - (a[1].t || 0)).slice(MAX_DRAFTS)) delete compose.drafts[k];
  try {
    localStorage.setItem(COMPOSE_KEY, JSON.stringify({ v: 1, basket: compose.basket, drafts: compose.drafts }));
    compose.saved = true;
  } catch { compose.saved = false; }
}
// fn 으로 고친다. 화면이 바로 쓰도록 메모리에 먼저 고치고, Web Lock 안에서 최신값을 다시 읽어 아직 쓰지 못한 고침을
// 모두 다시 얹은 뒤 쓴다(다른 탭과 겹치지 않게. 없는 브라우저는 바로 한다). 결과는 잠금 안의 것.
// fn 은 compose 만 고치고, 여러 번 불려도 결과가 같아야 한다(다시 읽을 때마다 다시 얹는다)
const unsaved = []; // 아직 저장소에 쓰지 못한 고침: 잠금을 기다리거나 저장이 실패한 것
// 저장소를 다시 읽고 아직 쓰지 못한 고침을 얹는다. 다시 읽기만 하면 이 탭의 고침이 사라진다
function refreshCompose() {
  loadCompose();
  for (const f of unsaved) f(compose);
}
function changeCompose(fn) {
  // 같은 초안 자리를 쓰는 고침은 마지막 것만 둔다(저장이 계속 실패해도 쌓이지 않게)
  if (fn.draft !== undefined) for (let i = unsaved.length - 1; i >= 0; i--) if (unsaved[i].draft === fn.draft) unsaved.splice(i, 1);
  unsaved.push(fn);
  fn(compose);
  renderBasket();
  const run = () => {
    const fresh = loadCompose();
    let out;
    // fn 이 앞선 잠금에서 이미 쓰여 목록에서 빠졌어도 결과를 얻으려고 다시 얹는다(여러 번 불려도 같다)
    for (const f of unsaved.includes(fn) ? unsaved : [...unsaved, fn]) { const r = f(compose); if (f === fn) out = r; }
    saveCompose();
    // 모두 얹어 썼거나, 저장소를 읽지 못해 메모리가 기준이면(얹은 것이 메모리에 남는다) 목록을 비운다
    // (잠금을 기다리는 것도 다시 얹어도 같다)
    if (compose.saved || !fresh) unsaved.length = 0;
    return out;
  };
  const job = navigator.locks?.request ? navigator.locks.request("atv-compose", run) : Promise.resolve().then(run);
  return job.finally(() => { renderBasket(); queueRender(); });
}
addEventListener("storage", (ev) => {
  if (ev.key !== COMPOSE_KEY && ev.key !== null) return;
  refreshCompose();
  renderBasket();
});
loadCompose();
const kindNow = () => composer.querySelector('input[name="c-kind"]:checked').value;
// 쓰는 동안 초안을 저장한다(0.3초 뒤). 글을 고치지 않은 창을 닫을 때는 쓰지 않는다(다른 탭의 초안을 덮지 않게)
let draftTimer = 0;
function saveDraft(now = false) {
  clearTimeout(draftTimer);
  if (!ask || !ask.typed) return;
  const key = ask.key, cid = ask.cid, text = $("c-text").value, kind = kindNow(), t = Date.now();
  // 다시 얹어도 같은 값이 되도록 시각은 여기서 한 번 정한다
  const put = (c) => {
    if (text.trim()) c.drafts[key] = { cid, kind, text, t };
    else if (c.drafts[key]?.cid === cid) delete c.drafts[key];
  };
  put.draft = key;
  // 문서를 떠날 때는 잠금을 기다릴 수 없어 바로 쓴다. 최신값을 다시 읽어 아직 쓰지 못한 고침과 함께 얹는다(다른 탭이
  // 그사이 쓴 것을 옛 메모리로 덮지 않게)
  if (now) { refreshCompose(); put(compose); saveCompose(); } else changeCompose(put);
}
$("c-text").addEventListener("input", () => {
  if (!ask) return;
  ask.typed = true;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 300);
});
composer.addEventListener("change", (ev) => { if (ev.target.name === "c-kind" && ask) { ask.typed = true; saveDraft(); } });

function openComposer(next) {
  if (!composer.hidden) closeComposer(false);
  refreshCompose();
  ask = { ...next, key: draftKey(next), typed: false };
  const d = compose.drafts[ask.key];
  ask.cid = d?.cid || newCid();
  $("c-text").value = d?.text || "";
  if (d) composer.querySelector(`input[name="c-kind"][value="${d.kind}"]`).checked = true;
  composer.hidden = false;
  renderComposer(viewScene(), true);
  $("c-text").focus();
}
function closeComposer(back = true) {
  if (composer.hidden) return;
  saveDraft();
  composer.hidden = true;
  const to = back ? ask.back?.() : null;
  ask = null;
  markTarget();
  to?.focus({ preventScroll: true });
}
$("compose").addEventListener("click", () => {
  if (!composer.hidden && ask && ask.sid === state.sid && !ask.target) return closeComposer();
  if (state.sid) openComposer({ sid: state.sid, target: null, anchor: () => $("compose"), back: () => $("compose") });
});
$("composer-close").addEventListener("click", () => closeComposer());
composer.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closeComposer(); });
// Enter 로 보내고 Shift+Enter 로 줄을 바꾼다. 한글을 조합하는 중의 Enter 는 글자를 마무리할 뿐 보내지 않는다
$("c-text").addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter" || ev.shiftKey || ev.isComposing || ev.keyCode === 229) return;
  ev.preventDefault();
  composer.requestSubmit();
});
// 그림의 부품·계획의 단계 이름
const itemName = (it) => (it.kind === "step" ? `단계 · ${it.title}` : `${it.label || it.id}`);
const SEND_HINT = {
  idle: "쉬는 중이라 보내면 바로 깨웁니다.",
  working: "일하는 중이라 이번 차례 안에서 받습니다.",
};
// Codex 는 화판 서버가 codex queue 로 보낸다. 일하는 중이면 이번 차례가 끝난 직후 새 차례로 받는다
const SEND_HINT_CODEX = {
  idle: "쉬는 중이라 보내면 바로 깨웁니다.",
  working: "일하는 중이라 이번 차례가 끝난 뒤 새 차례로 받습니다.",
};
const agentName = (s) => (s?.agent === "codex" ? "Codex" : "Claude");
const agentLogo = (s) => (s?.agent === "codex" ? "logo-codex" : "logo-claude");
function renderComposer(scene, force = false) {
  if (composer.hidden || !ask) return;
  const mine = ask.sid === state.sid;
  // 대상 부품이 지워졌으면 세션 전체로 바꾼다(재생 중이어도 지금 장면으로 본다). 다시 잇는 중(스냅샷 전, seq 0)의
  // 빈 장면으로는 판단하지 않는다. 쓰던 글은 세션 전체 초안이 없을 때만 그 자리로 옮긴다(있는 초안을 덮어쓰지 않게)
  if (ask.target && mine && state.seq && !own(state.scene.items, ask.target)) {
    const from = ask.key, cid = ask.cid;
    ask.target = null;
    const to = draftKey(ask);
    if (!compose.drafts[to]) {
      ask.key = to;
      changeCompose((c) => { if (c.drafts[from]?.cid === cid && !c.drafts[to]) { c.drafts[to] = c.drafts[from]; delete c.drafts[from]; } });
    }
  }
  const s = state.sessions.get(ask.sid);
  const it = ask.target && own(state.scene.items, ask.target);
  $("c-to").textContent = `받는 곳: ${s ? sessName(s) : ask.sid.slice(0, 8)} · ${it ? itemName(it) : "세션 전체"}`;
  const ended = !s || s.status === "ended";
  $("c-send").disabled = sending || ended || (mine && !!state.replay);
  $("c-collect").disabled = $("c-send").disabled;
  const codex = s?.agent === "codex";
  const head = `${agentName(s)} 에 보내기`;
  if ($("c-head").textContent !== head) {
    $("c-head").textContent = head;
    $("composer").setAttribute("aria-label", head);
    setIcon($("composer").querySelector("h2 svg"), agentLogo(s));
  }
  $("c-hint").textContent = (compose.saved ? "" : "저장되지 않음: 이 탭을 닫으면 쓰던 글이 사라집니다. ") + (ended ? "끝난 세션에는 보낼 수 없습니다."
    : codex && s.qerr ? `Codex 에 보내지 못했습니다(${s.qerr}). 다음에 보낼 때나 그 세션의 차례가 끝날 때 다시 보냅니다.`
    : codex ? (s.inbox ? SEND_HINT_CODEX[s.status] || "Codex 가 받을 준비가 됐습니다. 승인 창은 대신하지 못하니 Codex 화면에서 답하세요."
      : "이 대화는 그 Codex 화면에 더는 없습니다(/clear 로 새 대화가 시작됨). 보낸 글은 대기로 남습니다.")
    : s.inbox ? SEND_HINT[s.status] || "Claude 가 받을 준비가 됐습니다. 승인 창은 대신하지 못하니 터미널에서 답하세요."
    : "받을 훅이 아직 없습니다. 플러그인으로 설치한 세션에서 차례가 한 번 끝나면 준비됩니다. 그전에 보낸 글은 대기로 남습니다.");
  // 보낸 글은 보는 세션 것만 안다(다른 세션의 장면은 받지 않는다). 대상이 있으면 그 대상에 보낸 것만
  const msgs = mine ? Object.values(scene.msgs || {}).filter((m) => !ask.target || m.target?.id === ask.target).sort((a, b) => b.t - a.t).slice(0, 5) : [];
  const listKey = JSON.stringify(msgs.map((m) => [m.mid, m.state]));
  if (force || $("c-list").dataset.key !== listKey) {
    $("c-list").dataset.key = listKey;
    $("c-list").replaceChildren(...msgs.map((m) => {
      const li = el("li");
      li.append(el("span", `k ${m.state}`, MSG_STATE_KO[m.state] || m.state), document.createTextNode(`${MSG_KIND_KO[m.kind]}${m.target ? " · " + m.target.id : ""}: ${m.text}`));
      li.title = `${fmtClock(m.t)}${m.why ? " · " + m.why : ""}`;
      return li;
    }));
  }
  markTarget();
  placeComposer();
}
// 창을 붙일 요소의 아래에(넘치면 위에) 놓고 화면 안으로 자른다. 요소가 잠깐 없으면(다시 그리는 중) 그 자리에 둔다
function placeComposer() {
  if (composer.hidden || !ask) return;
  const a = ask.anchor(), w = composer.offsetWidth, h = composer.offsetHeight;
  const r = a?.isConnected ? a.getBoundingClientRect() : null;
  if (!r || (!r.width && !r.height)) {
    // 붙일 곳이 사라졌거나 접혀 있다: 그 자리에 두되 창 크기가 줄었으면 화면 안으로 당긴다
    composer.style.left = `${clamp(composer.offsetLeft, 8, Math.max(8, innerWidth - w - 8))}px`;
    composer.style.top = `${clamp(composer.offsetTop, 8, Math.max(8, innerHeight - h - 8))}px`;
    return;
  }
  if (canvas.busy() && $("canvas").contains(a)) return; // 배치를 재는 중에는 상자가 0,0 에 있다
  let top = r.bottom + 6;
  if (top + h > innerHeight - 8 && r.top - 6 - h >= 8) top = r.top - 6 - h;
  composer.style.left = `${clamp(r.left, 8, Math.max(8, innerWidth - w - 8))}px`;
  composer.style.top = `${clamp(top, 8, Math.max(8, innerHeight - h - 8))}px`;
}
// 고른 대상을 그림·계획에 점선으로 표시한다
function markTarget() {
  for (const e of document.querySelectorAll(".target")) e.classList.remove("target");
  if (composer.hidden || !ask?.target || ask.sid !== state.sid) return;
  canvas.elementOf(ask.target)?.classList.add("target");
  document.querySelector(`#plan-body li[data-id="${CSS.escape(ask.target)}"]`)?.classList.add("target");
}
composer.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const raw = $("c-text").value, text = raw.trim();
  if (!text || !ask || sending || $("c-send").disabled) return;
  const kind = kindNow(), to = ask, cid = ask.cid;
  // 보내는 글을 초안으로 맞춰 둔 뒤(0.3초 저장을 기다리지 않음), 보내는 사이에는 다시 쓰지 않는다(창을 닫아도).
  // 보낸 뒤 고치면 input 이 다시 켠다
  saveDraft();
  to.typed = false;
  sending = true;
  $("c-send").disabled = $("c-collect").disabled = true;
  let out;
  try { out = await boardOp({ op: "send", sid: to.sid, kind, text, target: to.target || null, cid }); }
  finally { sending = false; }
  renderComposer(viewScene());
  renderBasket();
  if (!out.ok) {
    // 앞서 보낸 같은 번호의 글과 내용이 다르다(보낸 뒤 탭이 닫혀 남은 초안을 고쳤다): 새 번호로 바꿔 다시 누르면 새 글로 간다
    if (out.conflict) renumber(to, cid);
    return;
  }
  toast("보냈습니다");
  // 이 글의 초안만 지운다: 번호가 같고 내용도 보낸 것과 같을 때(그사이 다른 탭에서 고친 초안은 남긴다)
  changeCompose((c) => {
    const d = c.drafts[to.key];
    if (d?.cid === cid && d.kind === kind && d.text === raw) delete c.drafts[to.key];
  });
  if (ask === to) { ask.typed = false; $("c-text").value = ""; closeComposer(); }
});

// ---- 모아 보내기 ----
// 보내기 창의 「모아 두기」 로 글을 모았다가 화면 아래 띠에서 한 번에 보낸다. 받는 세션은 하나뿐이다(그 세션의 상자·단계·
// 세션 전체를 섞어 모은다). 서버는 새 글을 모두 넣거나 하나도 넣지 않고, 이미 받은 cid 는 건너뛴다. 모은 글은 저장해 둔다
let clearArmed = 0; // 「비우기」 를 한 번 누른 뒤 다시 누르기를 기다리는 타이머
// 같은 번호로 다른 글을 보내려 했다: 거절된 쪽에만 새 번호를 준다. to 가 있으면 그 창의 초안(하나 보내기), 없으면
// 모은 글 가운데 그 번호의 글(묶음 보내기). 다른 쪽(같은 번호로 이미 보낸 글)은 건드리지 않는다
function renumber(to, cid) {
  const fresh = newCid();
  if (to && ask === to) ask.cid = fresh;
  changeCompose((c) => {
    if (to) { if (c.drafts[to.key]?.cid === cid) c.drafts[to.key].cid = fresh; }
    else for (const x of c.basket.items) if (x.cid === cid) x.cid = fresh;
  });
  toast("앞서 보낸 같은 글과 내용이 달라 새 글로 바꿨습니다. 다시 누르면 보냅니다");
}
$("c-collect").addEventListener("click", async () => {
  const text = $("c-text").value.trim();
  // 보내는 중인 글은 모으지 않는다(보낸 뒤에도 모은 목록에 남아 한 번 더 간다)
  if (!text || !ask || sending || $("c-collect").disabled) return;
  if (new TextEncoder().encode(text).length > MSG_LIMITS.bytes) return toast(`글은 ${MSG_LIMITS.bytes}바이트 이하`);
  const to = ask, draftCid = ask.cid, kind = kindNow(), alt = newCid(), target = to.target || null;
  const it = to.target && to.sid === state.sid && own(state.scene.items, to.target);
  const name = it ? itemName(it) : to.target || "세션 전체";
  const why = await changeCompose((c) => {
    const b = c.basket;
    if (b.items.length && b.sid !== to.sid) return "다른 세션에 보낼 글이 모여 있습니다. 먼저 보내거나 비우세요";
    // 다른 탭에서 같은 초안을 이미 모았으면(번호가 같다) 내용도 같을 때만 한 번으로 친다. 고친 글이면 새 번호로 따로 둔다
    const same = b.items.find((x) => x.cid === draftCid);
    const cid = same && (same.text !== text || same.kind !== kind || same.target !== target) ? alt : draftCid;
    if (!b.items.some((x) => x.cid === cid)) {
      if (b.items.length >= MSG_LIMITS.queued) return `한 번에 ${MSG_LIMITS.queued}개까지 모읍니다`;
      b.sid = to.sid;
      b.items.push({ cid, kind, text, target, name, t: Date.now() });
    }
    if (c.drafts[to.key]?.cid === draftCid) delete c.drafts[to.key];
    return "";
  });
  if (why) return toast(why);
  if (ask === to) { ask.typed = false; $("c-text").value = ""; closeComposer(); }
  toast(`모아 두었습니다(${compose.basket.items.length}개)`);
});
function renderBasket() {
  const b = compose.basket, n = b.items.length;
  $("basket").hidden = !n || ONLY_TL;
  if (!n) return;
  // 받을 대화가 끝났거나 목록에 없으면(지웠음) 보내지 못한다. 모은 글은 사용자가 빼거나 비울 때까지 둔다
  const s = state.sessions.get(b.sid), ended = !s || s.status === "ended";
  const where = s ? sessName(s) + (s.status === "ended" ? "(끝남: 보낼 수 없음)" : "") : `${b.sid.slice(0, 8)}(목록에 없음: 보낼 수 없음)`;
  $("b-sum").textContent = `모은 글 ${n}개 · 받는 곳: ${where}${compose.saved ? "" : " · 저장되지 않음: 이 탭을 닫으면 사라집니다"}`;
  $("b-send").disabled = sending || ended || !canWrite();
  $("b-send").title = ended ? "끝났거나 지운 대화에는 보낼 수 없습니다. 빼거나 비우세요" : "모은 글을 한 번에 보냅니다. 하나라도 보낼 수 없으면 하나도 보내지 않습니다";
  const key = JSON.stringify(b.items.map((x) => [x.cid, x.kind, x.name, x.text]));
  if ($("b-list").dataset.key === key) return;
  $("b-list").dataset.key = key;
  // 다시 만들면 초점을 잃으므로 빼기 단추에 있던 초점은 같은 자리(없으면 마지막 줄)로 돌린다
  const at = document.activeElement?.closest?.("#b-list li") ? [...$("b-list").children].indexOf(document.activeElement.closest("li")) : -1;
  $("b-list").replaceChildren(...b.items.map((x, i) => {
    const li = el("li"), out = el("button", "mini", "빼기");
    out.type = "button";
    out.dataset.cid = x.cid;
    out.setAttribute("aria-label", `${i + 1}번째 글 빼기`);
    li.append(el("span", "", `${MSG_KIND_KO[x.kind]} · ${x.name}: ${x.text}`), out);
    return li;
  }));
  if (at >= 0) ($("b-list").children[Math.min(at, n - 1)]?.querySelector("button") || $("b-view")).focus();
}
$("b-view").addEventListener("click", () => {
  const open = $("b-list").hidden;
  $("b-list").hidden = !open;
  $("b-view").setAttribute("aria-expanded", String(open));
  $("b-view").textContent = open ? "접기" : "보기";
});
$("b-list").addEventListener("click", async (ev) => {
  const cid = ev.target.closest("button[data-cid]")?.dataset.cid;
  if (!cid) return;
  await changeCompose((c) => {
    c.basket.items = c.basket.items.filter((x) => x.cid !== cid);
    if (!c.basket.items.length) c.basket.sid = null;
  });
  if (!compose.basket.items.length) $("compose").focus();
});
$("b-clear").addEventListener("click", async () => {
  // 쓴 글을 버리므로 한 번 더 눌러야 비운다
  if (!clearArmed) {
    $("b-clear").textContent = "한 번 더 누르면 비웁니다";
    clearArmed = setTimeout(() => { clearArmed = 0; $("b-clear").textContent = "비우기"; }, 3000);
    return;
  }
  clearTimeout(clearArmed);
  clearArmed = 0;
  $("b-clear").textContent = "비우기";
  await changeCompose((c) => { c.basket = { sid: null, items: [] }; });
  $("compose").focus();
});
$("b-send").addEventListener("click", () => {
  if (!compose.basket.items.length || sending || $("b-send").disabled) return;
  // 한 번에 한 탭만 보낸다. 잠근 뒤 최신 목록을 읽어 보내고, 성공하면 응답이 확인한 번호만 지운다(그사이 더 모은 글은 남는다)
  const run = async () => {
    refreshCompose();
    const { sid, items } = compose.basket;
    if (!items.length) return;
    sending = true;
    renderBasket();
    let out;
    try { out = await boardOp({ op: "send", sid, items: items.map(({ cid, kind, text, target }) => ({ cid, kind, text, target })) }); }
    finally { sending = false; }
    if (out.ok) {
      const done = new Set(out.cids);
      await changeCompose((c) => {
        c.basket.items = c.basket.items.filter((x) => !done.has(x.cid));
        if (!c.basket.items.length) c.basket.sid = null;
      });
      toast(`${items.length}개를 보냈습니다`);
    } else if (out.conflict) renumber(null, out.conflict);
    // 보내는 동안 단추가 꺼져 초점이 body 로 빠졌을 수 있다. 띠가 사라지면 맨 위 단추로, 남았으면(실패·그사이 더 모음)
    // 「한꺼번에 보내기」 로 돌린다. 그사이 다른 곳에서 쓰고 있으면 건드리지 않는다
    const act = document.activeElement, inBar = !act || act === document.body || $("basket").contains(act);
    renderBasket();
    renderComposer(viewScene());
    if (inBar) (compose.basket.items.length ? $("b-send") : $("compose")).focus();
  };
  if (navigator.locks?.request) navigator.locks.request("atv-send", run); else run();
});
// 보낸 글 수 표시를 누르면 그 단계의 보내기 창(그림의 상자는 canvas.js 가 onMail 로 알린다)
$("plan-body").addEventListener("click", (ev) => {
  const li = ev.target.closest(".mail")?.closest("li[data-id]");
  if (li) askAbout(li);
});

// 말풍선: 그림의 상자나 계획의 단계에 마우스가 들어오거나 초점이 오면 그 오른쪽 위 모서리에 띄운다.
// 나가면 잠깐 뒤에 숨긴다(말풍선으로 옮겨 가는 사이에 사라지지 않게)
const askBtn = $("ask");
let askFor = null, askHide = 0;
const askHost = (t) => (t instanceof Element ? t.closest("#canvas .part[data-id], #plan-body li[data-id]") : null);
function showAsk(hit) {
  if (!sendable()) return;
  clearTimeout(askHide);
  askFor = hit;
  const who = agentName(state.sessions.get(state.sid));
  setIcon(askBtn.querySelector("svg"), agentLogo(state.sessions.get(state.sid)));
  askBtn.setAttribute("aria-label", hit.matches("li") ? `이 단계에 대해 ${who} 에 보내기` : `이 상자에 대해 ${who} 에 보내기`);
  askBtn.hidden = false;
  // 상자는 오른쪽 위 가장자리에 걸쳐 올려 이름을 가리지 않는다(위가 화판 밖이면 안쪽). 상자와 맞닿게 두어야
  // 말풍선으로 옮겨 가는 사이에 바깥 묶음을 지나지 않는다(지나면 묶음의 말풍선으로 바뀐다). 계획 단계는 줄 안 오른쪽에 둔다
  const r = hit.getBoundingClientRect(), w = askBtn.offsetWidth, h = askBtn.offsetHeight;
  const top = hit.closest("#canvas-scroll, #plan-body").getBoundingClientRect().top;
  const y = !hit.matches("li") && r.top - h + 4 >= top ? r.top - h + 4 : r.top + 2;
  askBtn.style.left = `${clamp(r.right - w - 2, 4, innerWidth - w - 4)}px`;
  askBtn.style.top = `${clamp(y, 4, innerHeight - h - 4)}px`;
}
function hideAsk(now = false) {
  clearTimeout(askHide);
  const go = () => { askBtn.hidden = true; askFor = null; };
  if (now) go(); else askHide = setTimeout(go, 400);
}
function askAbout(hit) {
  if (!sendable()) return;
  const id = hit.dataset.id, inPlan = hit.matches("li");
  const find = () => (inPlan ? $("plan-body").querySelector(`li[data-id="${CSS.escape(id)}"]`) : canvas.elementOf(id));
  hideAsk(true);
  openComposer({ sid: state.sid, target: id, anchor: find, back: find });
}
for (const host of [$("canvas"), $("plan-body")]) {
  host.addEventListener("pointerover", (ev) => { const hit = askHost(ev.target); if (hit) showAsk(hit); });
  host.addEventListener("pointerout", (ev) => {
    const hit = askHost(ev.target);
    if (hit && !hit.contains(ev.relatedTarget) && ev.relatedTarget !== askBtn) hideAsk();
  });
  host.addEventListener("focusin", (ev) => { const hit = askHost(ev.target); if (hit) showAsk(hit); });
  host.addEventListener("focusout", (ev) => { if (ev.relatedTarget !== askBtn) hideAsk(); });
  // 상자·단계에 초점이 있을 때 Enter 로 연다(그 안의 다른 요소에서 누른 Enter 는 건드리지 않는다)
  host.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" || askHost(ev.target) !== ev.target) return;
    ev.preventDefault();
    askAbout(ev.target);
  });
}
askBtn.addEventListener("pointerenter", () => clearTimeout(askHide));
askBtn.addEventListener("pointerleave", () => hideAsk());
askBtn.addEventListener("click", () => { if (askFor) askAbout(askFor); });
// 스크롤하면 말풍선은 숨기고 보내기 창은 붙은 자리를 따라간다
document.addEventListener("scroll", (ev) => {
  if (!askBtn.hidden && askFor && (ev.target === document || (ev.target instanceof Node && ev.target.contains(askFor)))) {
    if (askFor === document.activeElement) showAsk(askFor); else hideAsk(true); // 초점으로 끌려온 스크롤이면 따라간다
  }
  placeComposer();
}, true);
addEventListener("resize", placeComposer);

if (ONLY_TL) {
  document.body.classList.add("only-tl");
  layout.foldTl = false;
}
// 쓰기 열쇠가 없으면 쓰기 단추를 끄고 위에 알린다(눌러도 1초 남짓 뜨는 알림만으로는 이유를 알기 어렵다)
if (!store.get("atv.w")) {
  $("nokey").hidden = false;
  for (const id of ["compose", "group-add", "sess-name", "settings-open"]) { $(id).disabled = true; $(id).title = $("nokey").title; }
}
applyLayout();
setZoom(view.zoom);
setFollow(view.follow);
// ---- 찾기: 이 화판(그림·계획) · 이 세션 타임라인 · 세션·프로젝트 · 다른 세션 기록(서버) ----
// 맨 위 「찾기」 나 / · Ctrl+K 로 연다. 입력하는 대로 결과가 바뀌고 ↑ ↓ 로 고르고 Enter(또는 누르기)로 연다.
// Esc 나 창 바깥을 누르면 닫는다. 낱말을 여럿 쓰면 모두 담은 것만 찾는다(대소문자 무시)
const finder = { open: false, q: "", active: -1, opts: [], ctl: null, timer: 0, remote: null, back: null };
const searchBox = $("search"), searchQ = $("search-q"), searchList = $("search-list");
const FIND_MAX = { board: 8, tl: 30, sess: 8 };
function openSearch() {
  if (!finder.open) {
    finder.open = true;
    finder.back = document.activeElement;
    finder.q = null; // 닫혔다 다시 열면 같은 말이어도 새로 찾고 첫 줄을 고른다(옛 서버 결과·오류를 쓰지 않는다)
    finder.remote = null;
    searchBox.hidden = false;
    searchQ.setAttribute("aria-expanded", "true");
    $("search-open").setAttribute("aria-expanded", "true");
    runSearch();
  }
  searchQ.focus();
  searchQ.select();
}
function closeSearch(restore = true) {
  if (!finder.open) return;
  finder.open = false;
  searchBox.hidden = true;
  searchQ.setAttribute("aria-expanded", "false");
  $("search-open").setAttribute("aria-expanded", "false");
  finder.ctl?.abort();
  clearTimeout(finder.timer);
  if (finder.remote?.loading) finder.remote = null; // 받는 중이던 서버 찾기를 버린다(같은 말로 다시 열면 다시 묻는다)
  if (restore && finder.back?.isConnected) finder.back.focus({ preventScroll: true });
}
// 맞은 낱말을 칠한 글(innerHTML 을 쓰지 않는다)
function marked(text, terms) {
  const out = document.createDocumentFragment(), low = text.toLowerCase();
  for (let i = 0; i < text.length;) {
    let at = -1, len = 0;
    for (const w of terms) { const k = low.indexOf(w, i); if (k >= 0 && (at < 0 || k < at || (k === at && w.length > len))) { at = k; len = w.length; } }
    if (at < 0) { out.append(text.slice(i)); break; }
    if (at > i) out.append(text.slice(i, at));
    out.append(el("mark", "", text.slice(at, at + len)));
    i = at + len;
  }
  return out;
}
// 타임라인 줄의 종류 이름(타임라인 표지와 같은 말)
function tlLabel(e) {
  if (e.type === "msg") return "보낸 글";
  if (e.type === "note") return NOTE_KO[e.kind] || "메모";
  if (e.type === "run") return "명령";
  if (e.f === "prompt" && !e.sys) return "사용자";
  return factParts(e)[0];
}
const partLabel = (it) => (it.kind === "step" ? "계획" : it.kind === "edge" ? "선" : "그림");
// 그림에서 보일 자리: 목록 항목은 그 목록, 선은 시작 부품
function partAnchor(scene, it) {
  let p = it;
  for (let i = 0; p && p.kind === "item" && i < 10; i++) p = own(scene.items, p.in);
  if (p && p.kind === "edge") p = own(scene.items, p.from);
  return p ? p.id : null;
}
function localGroups(terms) {
  const scene = viewScene(), now = Date.now(), groups = [];
  const board = [];
  for (const it of Object.values(scene.items).sort((a, b) => a.ord - b.ord)) {
    const text = itemText(it);
    if (!matchAll(text, terms)) continue;
    const go = it.kind === "step" ? { step: it.id } : { part: partAnchor(scene, it) };
    board.push({ kind: partLabel(it), text: snippet(text, terms), meta: it.status ? ST_KO[it.status] : "", go: { sid: state.sid, ...go } });
  }
  if (isProj(state.sid)) {
    // 큰 그림에는 타임라인이 없다: 메모는 붙은 단위·부품으로 간다
    for (let i = scene.timeline.length - 1; i >= 0; i--) {
      const e = scene.timeline[i], on = e.type === "note" ? own(scene.items, e.on || e.step) : null;
      if (on && matchAll(entryText(scene, e), terms)) board.push({ kind: NOTE_KO[e.kind] || "메모", text: snippet(entryText(scene, e), terms), meta: fmtWhen(e.t, now), go: { sid: state.sid, ...(on.kind === "step" ? { step: on.id } : { part: partAnchor(scene, on) }) } });
    }
  }
  if (board.length) groups.push({ title: isProj(state.sid) ? "이 큰 그림" : "이 화판", count: board.length, rows: board.slice(0, FIND_MAX.board), note: board.length > FIND_MAX.board ? `외 ${board.length - FIND_MAX.board}개 — 낱말을 더 써서 좁혀 보세요` : "" });
  if (!isProj(state.sid)) {
    const tl = [];
    let n = 0;
    for (let i = scene.timeline.length - 1; i >= 0; i--) {
      const e = scene.timeline[i], text = entryText(scene, e);
      if (matchAll(text, terms) && ++n <= FIND_MAX.tl) tl.push({ kind: tlLabel(e), text: snippet(text, terms), meta: fmtWhen(e.t, now), go: { sid: state.sid, seq: e.seq, key: tlKey(e) } });
    }
    if (n) groups.push({ title: "이 세션 타임라인", count: n, rows: tl, note: n > FIND_MAX.tl ? `외 ${n - FIND_MAX.tl}개(옛 기록) — 낱말을 더 써서 좁혀 보세요` : "" });
  }
  const sess = [];
  for (const [pid, p] of Object.entries(state.projects.projects)) {
    if (matchAll(`${p.name} ${p.purpose || ""}`, terms)) sess.push({ kind: "프로젝트", text: p.name, meta: p.done ? "끝난 프로젝트" : p.purpose || "", go: { sid: pid } });
  }
  for (const s of [...state.sessions.values()].sort((a, b) => b.lastT - a.lastT)) {
    if (s.empty || !matchAll(`${sessName(s)} ${s.title} ${s.cwd}`, terms)) continue;
    sess.push({ kind: "세션", text: sessName(s), meta: `${base(s.cwd) || "폴더 모름"} · ${fmtAgo(s.lastT, now)}`, go: { sid: s.id } });
  }
  if (sess.length) groups.push({ title: "세션 · 프로젝트", count: sess.length, rows: sess.slice(0, FIND_MAX.sess), note: sess.length > FIND_MAX.sess ? `외 ${sess.length - FIND_MAX.sess}개` : "" });
  return groups;
}
// 다른 세션 기록(서버). 보는 세션은 위 「이 세션 타임라인」 이 다 보이므로 뺀다
function remoteGroup(terms) {
  const r = finder.remote, rows = [];
  if (r.loading) return { title: "다른 세션 기록", rows, note: "다른 세션에서 찾는 중…" };
  if (r.error) return { title: "다른 세션 기록", rows, note: "다른 세션은 화판 서버에서 찾지 못했습니다" };
  const now = Date.now();
  let total = 0;
  for (const s of r.sessions) {
    if (s.id === state.sid) continue;
    total += s.n;
    const name = s.project ? `프로젝트 ${state.projects.projects[s.id]?.name || s.id}` : state.sessions.has(s.id) ? sessName(state.sessions.get(s.id)) : s.id.slice(0, 8);
    for (const h of s.hits) {
      const kind = h.note ? NOTE_KO[h.kind] || "메모" : h.type === "part" || h.type === "step" ? (h.type === "step" ? "계획" : "그림") : tlLabel(h);
      rows.push({ kind, text: h.text, meta: h.t ? `${name} · ${fmtWhen(h.t, now)}` : name, go: { sid: s.id, ...(h.seq != null ? { seq: h.seq, key: h.key } : h.type === "step" ? { step: h.id } : { part: h.id }) } });
    }
    if (s.n > s.hits.length) rows.push({ kind: "", text: `${name} 에서 외 ${s.n - s.hits.length}건`, meta: "열어서 다시 찾기", go: { sid: s.id, again: true } });
  }
  return { title: "다른 세션 기록", count: total || undefined, rows, note: r.more ? `세션 ${r.more}개 더 — 낱말을 더 써서 좁혀 보세요` : r.partial ? "앞의 세션만 찾음 — 낱말을 더 써서 좁혀 보세요" : rows.length ? "" : "다른 세션에는 없습니다" };
}
function runSearch() {
  const q = searchQ.value.trim();
  const changed = q !== finder.q;
  finder.q = q;
  clearTimeout(finder.timer);
  if (searchTerms(q).length && q.length >= 2) {
    if (changed || !finder.remote) { finder.remote = { loading: true }; finder.timer = setTimeout(() => remoteSearch(q), 250); }
  } else { finder.ctl?.abort(); finder.remote = null; }
  renderSearch(changed);
}
function remoteSearch(q) {
  finder.ctl?.abort();
  const ctl = (finder.ctl = new AbortController());
  fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctl.signal })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((d) => { if (finder.q === q) { finder.remote = { sessions: d.sessions || [], more: d.more || 0, partial: !!d.partial }; renderSearch(false); } })
    .catch((e) => { if (e.name !== "AbortError" && finder.q === q) { finder.remote = { error: true }; renderSearch(false); } });
}
function renderSearch(reset) {
  const terms = searchTerms(finder.q);
  const groups = terms.length ? [...localGroups(terms), ...(finder.remote ? [remoteGroup(terms)] : [])] : [];
  const keep = !reset && finder.active >= 0 ? finder.active : 0;
  finder.opts = [];
  finder.gen = (finder.gen || 0) + 1; // 다시 그릴 때마다 선택지 id 를 바꿔 화면 읽기 프로그램이 고른 줄을 다시 읽게 한다
  const out = [], notes = [];
  groups.forEach((g, gi) => {
    if (!g.rows.length) { if (g.note) notes.push(g.note); return; }
    const sec = el("div", "s-group");
    sec.setAttribute("role", "group");
    const head = el("div", "s-head", (g.count ? `${g.title} · ${g.count}` : g.title) + (g.note ? ` (${g.note})` : ""));
    head.id = `s-head-${finder.gen}-${gi}`;
    sec.setAttribute("aria-labelledby", head.id);
    sec.append(head);
    for (const r of g.rows) {
      const i = finder.opts.length, opt = el("div", "s-opt"), text = el("span", "s-text");
      opt.id = `s-opt-${finder.gen}-${i}`;
      opt.setAttribute("role", "option");
      text.append(marked(r.text, terms));
      opt.append(el("span", "s-kind", r.kind), text, el("span", "s-meta", r.meta || ""));
      opt.title = r.text;
      opt.addEventListener("pointerdown", (ev) => ev.preventDefault()); // 입력 칸의 초점을 지킨다
      opt.addEventListener("click", () => chooseFound(i));
      opt.addEventListener("pointermove", () => { if (finder.active !== i) setFound(i); });
      finder.opts.push({ el: opt, go: r.go });
      sec.append(opt);
    }
    out.push(sec);
  });
  // 알림 줄(목록 상자 밖, 화면 읽기 프로그램이 읽는다): 안내·결과 수·서버 상태
  const st = !terms.length ? "찾을 말을 쓰세요. 이 화판의 그림·계획, 이 세션의 타임라인(옛 기록까지), 세션·프로젝트의 이름과 폴더, 다른 세션의 기록에서 찾습니다. 낱말을 여럿 쓰면 모두 담은 것만 찾습니다."
    : finder.opts.length ? [`${finder.opts.length}개 찾음`, ...notes].join(" · ") : finder.remote?.loading ? "찾는 중…" : ["찾은 것이 없습니다", ...notes].join(" · ");
  if ($("search-status").textContent !== st) $("search-status").textContent = st;
  searchList.hidden = !out.length;
  searchList.replaceChildren(...out);
  setFound(finder.opts.length ? Math.min(keep, finder.opts.length - 1) : -1);
}
function setFound(i) {
  finder.active = i;
  finder.opts.forEach((o, k) => o.el.setAttribute("aria-selected", String(k === i)));
  const o = finder.opts[i];
  if (o) { searchQ.setAttribute("aria-activedescendant", o.el.id); o.el.scrollIntoView({ block: "nearest" }); }
  else searchQ.removeAttribute("aria-activedescendant");
}
function chooseFound(i) {
  const o = finder.opts[i];
  if (!o) return;
  const q = finder.q;
  closeSearch(false);
  const g = o.go;
  if (g.sid && g.sid !== state.sid) connect(g.sid); // 이어 아래 자리로 간다(스냅샷을 받은 뒤)
  if (g.again) { searchQ.value = q; openSearch(); return; }
  // 접어 둔 계획·타임라인 칸은 펴고 간다
  const unfold = (g.step && layout.foldPlan && "foldPlan") || (g.seq != null && layout.foldTl && "foldTl");
  if (unfold) { layout[unfold] = false; applyLayout(); saveLayout(); }
  state.focus = { sid: g.sid || state.sid, ...g };
  if (g.seq != null) state.tlFocus = g.seq; // 400줄 밖·거른 줄이라도 그 줄까지 보인다
  if (g.step) state.planReveal = g.step; // 끝난 단계·끝난 상위 단계 아래여도 그 단계까지 보인다(세션을 바꾸거나 「끝난 단계」 를 누를 때까지)
  queueRender();
}
// 찾은 자리로 간다: 타임라인 줄·계획 단계는 그린 바로 뒤에, 그림 부품은 배치가 끝난 뒤에
function applyFocus(afterCanvas) {
  const f = state.focus;
  if (!f || f.sid !== state.sid || !state.snapped) return;
  const flashIt = (e) => { e.classList.remove("flash"); void e.offsetWidth; e.classList.add("flash"); };
  if (f.seq != null) {
    const li = $("tl-body").querySelector(f.key ? `li[data-key="${CSS.escape(f.key)}"]` : `li[data-seq="${f.seq}"]`);
    if (li) { state.focus = null; state.tlJumpT = performance.now(); li.scrollIntoView({ block: "center" }); flashIt(li); li.tabIndex = -1; li.focus({ preventScroll: true }); }
    else if (afterCanvas) state.focus = null; // 그 줄이 없다(지워진 세션 따위)
  } else if (f.step) {
    const li = $("plan-body").querySelector(`li[data-id="${CSS.escape(f.step)}"]`);
    if (li) { state.focus = null; li.scrollIntoView({ block: "center" }); flashIt(li); li.focus({ preventScroll: true }); }
    else if (afterCanvas) state.focus = null;
  } else if (f.part && afterCanvas && !canvas.busy()) {
    if (canvas.unfold(f.part)) return; // 접힌 묶음 안: 펼쳐 다시 그린 뒤에 고른다
    state.focus = null;
    if (revealPart(f.part)) canvas.elementOf(f.part)?.focus({ preventScroll: true });
  } else if (!f.part) { state.focus = null; $("sess-name").focus({ preventScroll: true }); } // 세션·프로젝트만 골랐다
}
$("search-open").addEventListener("click", () => (finder.open ? closeSearch() : openSearch()));
searchQ.addEventListener("input", runSearch);
searchQ.addEventListener("keydown", (ev) => {
  if (ev.isComposing || ev.keyCode === 229) return; // 한글 조합 중(조합을 끝내는 Enter 가 한 번 더 온다)
  if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
    ev.preventDefault();
    if (finder.opts.length) setFound((finder.active + (ev.key === "ArrowDown" ? 1 : -1) + finder.opts.length) % finder.opts.length);
  } else if (ev.key === "Enter") { ev.preventDefault(); chooseFound(finder.active); }
  else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closeSearch(); }
});
document.addEventListener("pointerdown", (ev) => { if (finder.open && !searchBox.contains(ev.target) && !$("search-open").contains(ev.target)) closeSearch(false); }, true);
document.addEventListener("keydown", (ev) => {
  if (ONLY_TL || document.querySelector("dialog[open]")) return; // 떼어 본 타임라인 창에는 찾기가 없고, 도움말·설정 창 뒤에서는 열지 않는다
  if ((ev.key === "k" || ev.key === "K") && (ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey) { ev.preventDefault(); openSearch(); return; }
  if (ev.key !== "/" || ev.ctrlKey || ev.metaKey || ev.altKey || help.open) return;
  const t = ev.target;
  if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return; // 글을 쓰는 중
  ev.preventDefault();
  openSearch();
});

window.__atv = state; // 화면 검사 도구가 상태를 읽는다
connect(null);
