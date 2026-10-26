// 화면: 세션 목록, 맨 위 한 줄, 주의 띠, 가운데 그림, 계획 나무, 타임라인, 재생 막대.
// 서버가 SSE 로 보내는 결과(res)를 lib/scene.js 의 applyRes 로 적용한다. 재생도 같은 함수로 처음부터 다시 적용한다.
// 패널 폭·접힘·배율·거르기처럼 이 브라우저에만 남는 값은 localStorage 에 두고, 읽을 때 범위로 자른다.
import { newScene, applyRes, currentStep, own, MSG_LIMITS } from "/lib/scene.js";
import { createCanvas, safeRef } from "/canvas.js";

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
const fmtClock = (t) => new Date(t).toLocaleTimeString("ko-KR", { hour12: false });
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
  config: { resume: null }, // 서버 설정(이어받기 문구)
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
const LAYOUT_DEFAULT = { left: 220, right: 0.3, plan: 0.4, foldLeft: false, foldPlan: false, foldTl: false };
const layout = { ...LAYOUT_DEFAULT, ...store.json("atv.layout", {}) };
const main = document.querySelector("main"), side = $("side");

function applyLayout() {
  const W = main.clientWidth || window.innerWidth, H = side.clientHeight || 400;
  layout.left = clamp(num(layout.left, 220), 160, 360);
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
scroller.addEventListener("keydown", () => { if (view.follow) setFollow(false); });
$("zoom-in").addEventListener("click", () => setZoom(view.zoom * 1.25));
$("zoom-out").addEventListener("click", () => setZoom(view.zoom / 1.25));
$("zoom-100").addEventListener("click", () => setZoom(1));
$("zoom-fit").addEventListener("click", zoomFit);
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
    const s = JSON.parse(ev.data);
    state.sessions.set(s.id, s);
    if (!state.sid) return connect(s.id); // 처음 생긴 세션을 바로 보여 준다
    queueRender();
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
    queueRender();
  });
}

// 문서를 떠날 때 SSE 를 닫는다. 닫지 않으면 뒤로 가기 캐시(bfcache)에 든 옛 문서가 연결을 쥔 채 남아, 한 호스트에
// 6개까지인 브라우저 연결이 차서 같은 탭에서 다섯 번쯤 새로 열면 화판이 뜨지 않았다. 캐시에서 돌아오면 다시 잇는다
addEventListener("pagehide", () => { state.es?.close(); hub?.port.postMessage({ bye: true }); saveDraft(true); });
addEventListener("pageshow", (ev) => { if (ev.persisted) connect(state.sid); });

function defaultSession() {
  const fromHash = decodeURIComponent((location.hash.match(/#s=([^&]+)/) || [])[1] || "");
  if (fromHash && known(fromHash)) return fromHash;
  const list = threads();
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
// 끝났는데 입력도 그림도 없는 세션은 빼되 지금 보는 세션은 남긴다
function threads() {
  const by = new Map();
  for (const s of sortedSessions()) {
    if (s.empty && s.id !== state.sid) continue;
    const r = rootOf(s.id);
    if (!by.has(r)) by.set(r, []);
    by.get(r).push(s);
  }
  return [...by.values()];
}
// 한 줄 안의 대화들을 시작 순서로(맨 위 ◀ ▶). withEmpty 면 목록에서 숨긴 빈 대화도 넣는다(줄을 지울 때)
function threadOf(id, withEmpty = false) {
  const root = rootOf(id);
  return [...state.sessions.values()].filter((s) => (withEmpty || !s.empty || s.id === state.sid) && rootOf(s.id) === root).sort((a, b) => a.startedAt - b.startedAt);
}

function queueRender() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => { state.renderQueued = false; render(); });
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
const statsText = (x) => (isProj(state.sid) ? fmtDur(x.elapsed) : `${fmtDur(x.elapsed)} · 파일 ${x.files} · 명령 ${x.cmds}${x.fails ? `(실패 ${x.fails})` : ""}`);
// 날짜가 다르면 날짜도(프로젝트의 대화 이력은 며칠에 걸친다)
const fmtWhen = (t, now) => (new Date(t).toDateString() === new Date(now).toDateString() ? fmtClock(t) : new Date(t).toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }));

// 주의 띠: 입력 필요·승인 대기 → 막힘 → 실패
const BAND_RANK = { input: 0, wait: 0, blocked: 1, fail: 2 };
function bandItems(scene) {
  const out = [];
  if (scene.sess.status === "input") {
    const last = [...scene.timeline].reverse().find((e) => e.type === "fact" && e.f === "notify");
    out.push({ kind: "input", ico: "?", text: `입력 필요${last && last.text ? ": " + last.text : ""}` });
  }
  for (const it of Object.values(scene.items)) {
    if (it.kind === "edge") continue;
    const name = it.kind === "step" ? it.title : it.label || it.id;
    if (it.status === "wait" && !it.answered) out.push({ kind: "wait", ico: ST_ICO.wait, text: `승인 대기: ${name}`, id: it.id, step: it.kind === "step", ord: it.ord });
    else if (it.status === "blocked") out.push({ kind: "blocked", ico: ST_ICO.blocked, text: `막힘: ${name}${it.note ? " · " + it.note : ""}`, id: it.id, step: it.kind === "step", ord: it.ord });
    else if (it.status === "fail") out.push({ kind: "fail", ico: ST_ICO.fail, text: `실패: ${name}`, id: it.id, step: it.kind === "step", ord: it.ord });
  }
  return out.sort((a, b) => BAND_RANK[a.kind] - BAND_RANK[b.kind] || (b.ord || 0) - (a.ord || 0));
}

// ---- 그리기 ----
function render() {
  const scene = viewScene(), now = viewNow();
  renderSessions(now);
  renderTop(scene, now);
  renderPlan(scene, now);
  renderTimeline(scene, now);
  renderReplay();
  renderBasket();
  const hasParts = Object.values(scene.items).some((it) => it.kind !== "step");
  $("empty").hidden = hasParts;
  $("empty").textContent = isProj(state.sid) ? "아직 큰 그림이 없습니다. 이 프로젝트에 든 대화의 Claude·Codex 가 작업 단위를 시작·끝낼 때 그립니다." : `아직 그림이 없습니다. ${agentName(state.sessions.get(state.sid))} 가 draw 로 그리면 여기에 나타납니다.`;
  if (!ONLY_TL) canvas.render(scene).then(() => { followNow(); placeComposer(); }).catch((e) => console.error("그림 실패", e));
  markSeen();
}

// 세션 목록: 프로젝트가 있으면 프로젝트별로(최근에 움직인 프로젝트 먼저, 빈 프로젝트도 보인다), 프로젝트 없는 세션은
// 「프로젝트 없음」, 끝난 프로젝트는 맨 아래 「끝난 프로젝트」 에 접어 둔다. 프로젝트 이름을 누르면 큰 그림 화판을 연다.
// 세션 줄을 끌어 프로젝트(머리나 그 아래 줄 어디든)에 놓으면 그 줄의 대화 전체가 옮겨 간다. 키보드는 줄의 「⋯」 메뉴로 한다
const gfold = new Set(Array.isArray(store.json("atv.gfold", [])) ? store.json("atv.gfold", []) : []);
const DRAG_TYPE = "text/x-atv-sid";
const canWrite = () => !!store.get("atv.w");
function sessRow(thread, now) {
  const s = thread[0], mine = thread.some((x) => x.id === state.sid);
  const row = el("div", "srow");
  const b = el("button", "sess" + (mine ? " sel" : "") + (s.status === "ended" ? " ended" : ""));
  b.type = "button";
  const r1 = el("div", "row1");
  r1.append(el("span", `sico ${s.status}`, SESS_ICO[s.status] || "○"), el("span", "txt", sessName(s)));
  const more = thread.length > 1 ? ` · 대화 ${thread.length}` : "";
  const r2 = el("div", "row2 txt", `${s.agent === "codex" ? "Codex · " : ""}${SESS_KO[s.status] || s.status} · ${fmtAgo(s.lastT, now)} · ${base(s.cwd) || "폴더 모름"}${more}`);
  b.title = `${sessName(s)}\n${SESS_KO[s.status] || s.status} · ${s.cwd}${more && "\n이어진 대화(/clear·이어받기 문구)를 한 줄로 모았습니다. 맨 위 ◀ ▶ 로 앞뒤 대화를 봅니다"}`;
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
// 프로젝트 머리: 접기, 이름(누르면 큰 그림 화판), ⋯ 메뉴(이름·끝·풀기). pid "" 은 「프로젝트 없음」
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
    head.append(el("span", "gfold", `프로젝트 없음 · ${count}`));
    return head;
  }
  const pr = state.projects.projects[p];
  const name = el("button", "gfold" + (state.sid === p ? " sel" : ""), `${pr.name} · ${count}`);
  name.type = "button";
  name.dataset.pid = p;
  name.title = `${pr.name}${pr.purpose ? `\n${pr.purpose}` : ""}\n눌러서 큰 그림 보기${pr.cur ? ` · 지금 ${pr.cur}` : ""}${pr.left ? ` · 남은 단계 ${pr.left}` : ""}`;
  name.addEventListener("click", () => { if (state.sid !== p) connect(p); });
  head.append(name);
  if (canWrite()) {
    const menu = el("button", "mini pmenu", "⋯");
    menu.type = "button";
    menu.dataset.pid = p;
    menu.setAttribute("aria-haspopup", "menu");
    menu.setAttribute("aria-label", `${pr.name}: 이름·끝·풀기`);
    menu.addEventListener("click", () => openProjectMenu(p, menu));
    head.append(menu);
  }
  return head;
}
function projSection(p, members, now) {
  const sec = el("div", "gsec");
  sec.append(projHead(p, members.length));
  if (!gfold.has(p)) {
    sec.append(...members.map((t) => sessRow(t, now)));
    if (!members.length) sec.append(el("div", "gempty", p ? "세션 줄을 여기로 끌어 놓으세요" : "여기로 끌어 놓으면 프로젝트에서 뺍니다"));
  }
  dropZone(sec, p);
  return sec;
}
function renderSessions(now) {
  const body = $("sess-body");
  // 이름을 쓰는 중이거나 끄는 중에는 목록을 다시 만들지 않는다(끄는 요소·놓을 자리가 바뀌면 놓기가 사라진다)
  if (body.querySelector("input") || state.dragging) return;
  const list = threads().slice(0, 80);
  const out = [];
  const projs = state.projects.projects, pids = Object.keys(projs);
  if (!pids.length) out.push(...list.map((t) => sessRow(t, now)));
  else {
    const by = new Map([...pids, ""].map((p) => [p, []]));
    for (const t of list) by.get(projOf(t[0].id) || "").push(t);
    const recent = (p) => Math.max(projs[p].lastT || 0, ...by.get(p).map((t) => t[0].lastT));
    const order = (done) => pids.filter((p) => !!projs[p].done === done).sort((a, b) => recent(b) - recent(a));
    for (const p of [...order(false), ""]) out.push(projSection(p, by.get(p), now));
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
      if (open) for (const p of done) out.push(projSection(p, by.get(p), now));
    }
  }
  if (!list.length) out.push(el("p", "row2 txt", "아직 세션이 없습니다. Claude Code·Codex 세션을 시작하면 여기에 나타납니다."));
  // 목록은 사건마다 새로 만든다. 키보드 초점이 목록 안에 있었으면 같은 세션·프로젝트의 같은 단추로 되돌린다
  const act = document.activeElement;
  let keep = null, gone = false;
  if (act && body.contains(act) && act.dataset.sid) {
    keep = `.${act.classList.contains("smenu") ? "smenu" : "sess"}[data-sid="${CSS.escape(act.dataset.sid)}"]`;
    gone = !state.sessions.has(act.dataset.sid);
  } else if (act && body.contains(act) && act.dataset.pid !== undefined) {
    keep = `.${["pmenu", "gtog", "gfold"].find((c) => act.classList.contains(c))}[data-pid="${CSS.escape(act.dataset.pid)}"]`;
    gone = !!act.dataset.pid && act.dataset.pid !== "-done" && !isProj(act.dataset.pid);
  }
  body.replaceChildren(...out);
  // 보던 자리에서 목록이 튀지 않게. 그 세션·프로젝트가 지워졌으면 첫 세션 줄로, 끝으로 표시해 접힌 「끝난 프로젝트」 안으로
  // 들어갔으면 그 머리로 옮겨 초점을 잃지 않게 한다
  const folded = !gone && act?.dataset.pid && isProj(act.dataset.pid) && state.projects.projects[act.dataset.pid].done;
  if (keep) (body.querySelector(keep) || (gone ? body.querySelector(".sess") : folded ? body.querySelector(".dhead") : null))?.focus({ preventScroll: true });
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
  b.hidden = !band.length;
  // 1초마다 부르므로 내용이 같으면 다시 만들지 않는다(누르는 사이에 단추가 바뀌면 클릭이 사라진다)
  const bandKey = JSON.stringify(band.map((x) => [x.kind, x.text, x.id]));
  if (bandKey !== renderTop.bandKey) {
    renderTop.bandKey = bandKey;
    b.replaceChildren(...bandRows(band));
  }

  const s = state.sessions.get(state.sid);
  const name = proj ? proj.name : s ? sessName(s) : base(scene.meta.cwd) || "anytaskview";
  if ($("name-form").hidden) $("sess-name").textContent = proj || s ? name : "";
  $("sess-name").title = proj ? "눌러서 이 프로젝트의 이름을 바꿉니다" : "눌러서 이 세션의 이름을 바꿉니다";
  $("sess-name").hidden = !(s || proj) || !$("name-form").hidden;
  renderThreadNav(s);
  renderProjLink(s);
  // 프로젝트 화판은 대화가 아니라 받을 Claude 가 없다. 대화를 골라 보낸다
  $("compose").disabled = !canWrite() || !!proj;
  const who = agentName(state.sessions.get(state.sid));
  $("compose").textContent = `${who} 에 보내기`;
  $("compose").title = proj ? "프로젝트 화판에서는 보내지 않습니다. 오른쪽 아래 대화 이력에서 대화를 골라 보내세요" : canWrite() ? `지금 보는 세션 전체에 대해 의견·지시를 써서 ${who} 에 보냅니다. 상자·단계에 대해서는 그 위의 「보내기」 를 누릅니다` : $("nokey").title;
  renderComposer(scene);
  const needs = band.some((x) => x.kind === "input" || x.kind === "wait");
  const prefix = needs ? "● 입력 필요 · " : band.some((x) => x.kind === "blocked") ? "막힘 · " : "";
  document.title = `${prefix}${name} · anytaskview`;
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

function bandRows(band) {
  const rows = band.slice(0, 5).map((x) => {
    const row = el("div", `bi ${x.kind}`);
    row.append(el("span", "ico", x.ico), el("span", "txt", x.text));
    if (x.id) {
      const go = el("button", "mini", "보기");
      go.type = "button";
      go.addEventListener("click", () => reveal(x.id, x.step));
      row.append(go);
    }
    return row;
  });
  if (band.length > 5) rows.push(el("div", "bi", `외 ${band.length - 5}개`));
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
$("toggle-done").addEventListener("click", () => setShowDone(!showDone()));

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
  if (cur) {
    const st = own(scene.items, cur);
    const head = el("span", `st-${st.status}`);
    head.append(el("span", "ico", ST_ICO[st.status]), document.createTextNode(` 지금: ${st.title}`));
    nowBox.replaceChildren(head);
  }
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
  const doneCount = steps.filter((s) => s.status === "done").length;
  toggle.hidden = !doneCount;
  toggle.textContent = hideDone ? `끝난 단계 ${doneCount}개 보기` : "끝난 단계 숨기기";
  // 1초마다 불리므로 구조가 같으면 걸린 시간 글자만 고친다(다시 만들면 「보기」 강조와 대상 표시가 지워진다)
  const noteCount = (id) => scene.timeline.reduce((n, e) => n + (e.type === "note" && e.on === id ? 1 : 0), 0);
  const mailKey = (id) => { const ms = msgsTo(scene, id); return ms.length ? mailBadge(ms).title : ""; };
  const key = JSON.stringify([cur, hideDone, steps.map((x) => [x.id, x.title, x.status, x.parent, x.note, !!x.answered, !!x.startT, noteCount(x.id), mailKey(x.id)])]);
  if (key === renderPlan.key && body.isConnected) {
    for (const li of body.querySelectorAll("li[data-id]")) {
      const stats = li.querySelector(":scope > .stats");
      if (stats) stats.textContent = statsText(stepStats(scene, li.dataset.id, now));
    }
    return;
  }
  renderPlan.key = key;
  const build = (parent) => {
    const ul = el("ul", "tree");
    let hidden = 0;
    for (const s of steps.filter((x) => parentOf(x) === parent)) {
      if (hideDone && isSettled(s)) { hidden++; continue; }
      const li = el("li", "step" + (s.id === cur ? " cur" : ""));
      li.dataset.id = s.id;
      li.tabIndex = 0; // 키보드로 단계에 가서 Enter 로 Claude 에 보낸다
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

function factText(e) {
  switch (e.f) {
    case "start": return `세션 시작 (${e.source})`;
    case "prompt": return isSysPrompt(e) ? `알림: ${sysText(e)}` : `사용자: ${e.text}`;
    case "edit": return `수정 ${base(e.path)}${e.lines ? ":" + e.lines : ""}`;
    case "edit-fail": return `수정 실패 ${base(e.path)}: ${e.error}`;
    case "todo": return `할 일 도구(${e.tool}): ${e.text}`;
    case "agent-start": return `하위 에이전트 시작${e.agentType ? " " + e.agentType : ""}`;
    case "agent-stop": return `하위 에이전트 끝${e.agentType ? " " + e.agentType : ""}${e.last ? ": " + e.last : ""}`;
    case "notify": return `입력 필요: ${e.text}`;
    case "stop": return `차례 끝${e.last ? ": " + e.last : ""}`;
    case "end": return `세션 끝${e.reason ? ` (${e.reason})` : ""}`;
    case "gone": return "세션 끝 (claude 프로세스 없음)";
    default: return e.f;
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

function renderTimeline(scene, now) {
  const proj = isProj(state.sid);
  $("tl-title").textContent = proj ? "대화 이력" : "타임라인";
  $("tl-filters").hidden = proj;
  $("popout").hidden = proj;
  if (proj) return renderHistory(scene, now);
  const ol = $("tl-body"), box = $("timeline");
  const items = [];
  const entries = scene.timeline.slice(-400).reverse().filter((e) => !tlHide.has(tlKind(e)) && !(e.agent && tlHide.has("agent")));
  let marked = false, prevEdit = null;
  for (const e of entries) {
    if (!marked && state.markerSeq && !state.replay && e.seq <= state.markerSeq && entries[0].seq > state.markerSeq) {
      items.push(el("li", "new-mark", "▲ 여기부터 새것"));
      marked = true;
      prevEdit = null;
    }
    // 같은 파일을 잇달아 고친 기록은 한 줄로 묶는다(가장 최근 줄에 횟수를 붙인다)
    if (e.type === "fact" && e.f === "edit") {
      if (prevEdit && prevEdit.path === e.path && prevEdit.agent === e.agent) {
        prevEdit.n++;
        prevEdit.times.textContent = `×${prevEdit.n}`;
        continue;
      }
    }
    const li = el("li");
    li.append(el("span", "when", fmtClock(e.t)));
    prevEdit = null;
    if (e.type === "msg") {
      const m = own(scene.msgs || {}, e.mid);
      if (!m) continue;
      li.append(el("span", `k ${m.state}`, MSG_STATE_KO[m.state] || m.state));
      li.append(document.createTextNode(`화판 → ${agentName(state.sessions.get(state.sid))} (${MSG_KIND_KO[m.kind]}${m.target ? " · " + m.target.id : ""}): ${m.text}`));
      li.classList.add("prompt");
      li.title = m.text;
    } else if (e.type === "note") {
      if (e.kind) li.append(el("span", `k ${e.kind}`, NOTE_KO[e.kind]));
      li.append(document.createTextNode(e.text + (e.on ? ` (${e.on})` : "")));
      if (safeRef(e.ref)) { li.classList.add("copy"); li.dataset.ref = e.ref; }
    } else if (e.type === "run") {
      const r = own(scene.runs, e.id);
      if (!r) continue;
      const dur = r.state === "running" || r.state === "wait" ? now - r.start : r.dur ?? (r.end && r.start ? r.end - r.start : null);
      li.append(el("span", `k ${r.state}`, `${RUN_KO[r.state] || r.state}${dur != null ? " · " + fmtDur(dur) : ""}`));
      li.append(document.createTextNode(r.desc || r.cmd));
      li.title = r.cmd + (r.error ? `\n${r.error}` : "");
      if (r.agent) li.classList.add("sub");
    } else {
      if (e.agent) li.classList.add("sub");
      if (e.f === "prompt") { li.classList.add(isSysPrompt(e) ? "sys" : "prompt"); li.title = e.text; }
      li.append(document.createTextNode(factText(e)));
      if (e.f === "edit") {
        const times = el("span", "times");
        li.append(times);
        prevEdit = { path: e.path, agent: e.agent, n: 1, times };
        if (safeRef(e.path)) {
          const line = String(e.lines || "").match(/^\d+/);
          li.classList.add("copy");
          li.dataset.ref = e.path + (line ? ":" + line[0] : "");
          li.title = e.path;
        }
      }
    }
    items.push(li);
  }
  // 새 항목은 위에 붙는다. 사용자가 아래(옛 기록)를 보고 있으면 보던 자리를 지키고 「새 항목」 단추를 띄운다
  const latest = scene.timeline.length ? scene.timeline[scene.timeline.length - 1].seq : 0;
  const away = box.scrollTop > 8 && !state.replay;
  const before = box.scrollHeight;
  ol.replaceChildren(...items);
  if (!away) state.tlTopSeq = latest;
  else box.scrollTop += box.scrollHeight - before;
  const fresh = scene.timeline.filter((e) => e.seq > state.tlTopSeq).length;
  const btn = $("tl-new");
  btn.hidden = !away || !fresh;
  btn.textContent = `▲ 새 항목 ${fresh}개`;
}
$("tl-new").addEventListener("click", () => { $("timeline").scrollTo({ top: 0, behavior: "smooth" }); });
$("timeline").addEventListener("scroll", () => {
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
const THEMES = ["", "light", "dark"], THEME_KO = { "": "자동", light: "밝게", dark: "어둡게" };
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  $("theme").textContent = `테마: ${THEME_KO[t]}`;
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

// ---- 설정: 이어받기 문구 ----
const settings = $("settings");
$("settings-open").addEventListener("click", () => {
  const r = state.config.resume;
  $("cfg-phrase").value = r?.phrase || "";
  $("cfg-doc").value = r?.doc || "";
  settings.showModal();
  $("cfg-phrase").focus();
});
$("settings-close").addEventListener("click", () => settings.close());
$("settings-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const phrase = $("cfg-phrase").value.trim(), doc = $("cfg-doc").value.trim();
  const out = await boardOp({ op: "config-set", resume: phrase ? { phrase, doc } : null });
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
function showMenu(anchor, back, items) {
  gmenu.replaceChildren(...items);
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
// 프로젝트 머리의 ⋯: 이름 바꾸기, 끝으로 표시·다시 진행, 풀기(두 번 눌러야 푼다)
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
  const drop = item("풀기", () => {
    if (!drop.classList.contains("armed")) { drop.classList.add("armed"); drop.textContent = "한 번 더 누르면 풉니다(대화는 남습니다)"; return; }
    closeGroupMenu();
    boardOp({ op: "proj-drop", pid });
  }, "gm-del");
  drop.title = "프로젝트를 풉니다. 대화는 「프로젝트 없음」 으로 가고, 큰 그림 기록은 상태 폴더의 trash 에 30일 동안 남습니다";
  showMenu(anchor, () => $("sess-body").querySelector(`.pmenu[data-pid="${CSS.escape(pid)}"]`), [el("div", "gm-title", pr.name), rename, done, el("hr", "gm-sep"), drop]);
  rename.focus();
}
// 「메시지 보내기…」: 보던 화면을 바꾸지 않고 그 줄의 대화(대표 = 진행 중인 것 먼저)에 보내기 창을 줄 아래에 연다
function messageItem(sid) {
  const b = el("button", "gm-item", "메시지 보내기…");
  b.type = "button";
  b.setAttribute("role", "menuitem");
  const s = state.sessions.get(sid);
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
// 「지우기」: 그 줄의 끝난 대화를 지운다(진행 중인 대화는 남는다). 한 번 누르면 글이 바뀌고, 한 번 더 누르면 지운다.
// 꺼짐은 disabled 대신 aria-disabled 로 둔다(disabled 는 초점을 받지 못해 방향키 이동이 그 자리에서 막힌다)
function deleteItem(sid) {
  const thread = threadOf(sid, true), ids = thread.filter((x) => x.status === "ended").map((x) => x.id);
  const live = thread.length - ids.length;
  const b = el("button", "gm-item gm-del", live && ids.length ? `지우기(끝난 대화 ${ids.length}개만)` : "지우기");
  b.type = "button";
  b.setAttribute("role", "menuitem");
  if (!ids.length) {
    b.setAttribute("aria-disabled", "true");
    b.title = "진행 중인 대화는 지울 수 없습니다. 세션이 끝난 뒤에 지우세요";
    return b;
  }
  b.title = "이 줄의 끝난 대화를 목록과 화판에서 지웁니다. 기록은 상태 폴더의 trash 에 30일 동안 남습니다";
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
  if ($("composer").querySelector("h2").textContent !== head) { $("composer").querySelector("h2").textContent = head; $("composer").setAttribute("aria-label", head); }
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
  if (!canWrite() || state.replay || !state.sid || isProj(state.sid)) return;
  clearTimeout(askHide);
  askFor = hit;
  const who = agentName(state.sessions.get(state.sid));
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
  if (!canWrite() || state.replay || !state.sid || isProj(state.sid)) return;
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
window.__atv = state; // 화면 검사 도구가 상태를 읽는다
connect(null);
