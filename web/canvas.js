// 가운데 그림: 부품을 DOM 으로 만들고 ELK 로 자리를 정한다.
// 상태만 바뀌면 다시 배치하지 않는다. 크기나 구조가 바뀔 때만 이전 순서를 넣어 다시 배치하고, 가장 최근 배치 결과만 그린다.
// 받은 글은 textContent 로만 넣는다. HTML 을 넣는 곳은 Mermaid 가 strict 로 그린 SVG 하나뿐이다(표 칸도 글로만 넣는다).

import { own } from "/lib/scene.js";
import { crossLines, pickRoute, midPoint } from "/route.js";

// 복사해도 되는 자리인가(제어 문자가 있으면 터미널에 붙였을 때 명령이 될 수 있다)
export const safeRef = (ref) => typeof ref === "string" && ref !== "" && !/[\x00-\x1f\x7f]/.test(ref);

const ST_KO = { todo: "할 일", doing: "진행", done: "끝", fail: "실패", blocked: "막힘", wait: "승인 대기" };
const ST_ICO = { todo: "○", doing: "▶", done: "✓", fail: "✗", blocked: "‼", wait: "…" };
const SVGNS = "http://www.w3.org/2000/svg";

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function svgEl(tag, attrs) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}
// 상자 모양 가운데 CSS 테두리로 그리지 못하는 것의 윤곽(0~100 칸에 그리고 상자 크기에 맞춰 늘인다). round·circle 은 CSS 로 그린다
const SHAPE_PATH = {
  diamond: "M50,1 L99,50 L50,99 L1,50 Z",
  hexagon: "M12,1 L88,1 L99,50 L88,99 L12,99 L1,50 Z",
  cylinder: "M1,12 L1,88 A49,11 0 0 0 99,88 L99,12 A49,11 0 0 0 1,12 A49,11 0 0 0 99,12",
  doc: "M1,1 L99,1 L99,86 C75,78 60,100 35,94 C20,90 10,88 1,92 Z",
};
const shaped = (p) => p.kind === "box" && p.shape && p.shape !== "rect";
// Mermaid 그림의 최대 폭(px). 더 넓으면 비율대로 줄인다. 높이로는 줄이지 않는다(긴 시퀀스·간트의 글이 읽을 수 없게 작아진다)
const MERMAID_MAX_W = 640;
// 마름모·원·육각형은 글 상자(폭 a, 높이 b)가 윤곽 안에 들도록 크기를 정한다.
// 마름모: a/W + b/H ≤ 1 을 W = 1.6a, H = 2.67b 로 맞춘다. 원(타원): (a/W)² + (b/H)² ≤ 1 을 W = H 비 그대로 √2 배로. 육각형: 위아래 변이 폭의 76%
const SHAPE_FIT = {
  diamond: (a, b) => ({ w: a * 1.6 + 24, h: b * 2.67 + 20 }),
  circle: (a, b) => ({ w: Math.max(a * 1.42 + 24, 56), h: Math.max(b * 1.42 + 36, 56) }),
  hexagon: (a, b) => ({ w: a / 0.76 + 16, h: b + 40 }),
};
// 원·막대 차트 색: Mermaid 기본(옅은 보라·노랑·연두)보다 서로 잘 구분되고 밝은·어두운 바탕에서 모두 읽히는 색
const CHART_COLORS = ["#4c78a8", "#f58518", "#54a24b", "#e45756", "#72b7b2", "#b279a2", "#eeca3b", "#9d755d"];

// 배치에 영향을 주는 값만 모은 열쇠. 이것이 같으면 다시 배치하지 않는다(접은 묶음과 그 요약 글도 넣는다)
function layoutKey(scene, parts, fold) {
  return JSON.stringify([scene.view.dir, parts.map((p) => [p.id, p.kind, p.label, p.in, p.from, p.to, p.text, p.src, p.ref, p.note, p.value, p.max, p.shape, p.icon, p.cols, p.rows]),
    [...fold.folded].sort().map((id) => [id, fold.info.get(id)])]);
}

// 끝난 묶음(화면의 접기와 주의 띠가 함께 쓴다): 안(하위 묶음·목록 항목까지)에 진행·막힘·대기가 없고, 자기 상태가 있으면
// 그것이 끝·실패, 없으면 안의 상태 있는 부품이 하나 이상이고 모두 끝·실패(상태 없는 설명 글 따위는 따지지 않는다).
// 묶음만 끝으로 두고 안에 승인 대기를 남긴 경우 그 대기가 접혀 숨지 않게 한다. 빈 묶음은 싣지 않는다.
// 묶음 id → { n: 안의 부품 수(항목 빼고), fail: 실패 수, allFail: 상태 있는 것이 모두 실패, done }
const FINISHED = new Set(["done", "fail"]), ACTIVE = new Set(["doing", "blocked", "wait"]);
export function groupSummary(scene) {
  const kids = new Map();
  for (const p of Object.values(scene.items)) {
    if (p.kind === "edge" || p.kind === "step" || !p.in) continue;
    if (!kids.has(p.in)) kids.set(p.in, []);
    kids.get(p.in).push(p);
  }
  const under = (id, out = [], depth = 0) => { if (depth < 10) for (const c of kids.get(id) || []) { out.push(c); under(c.id, out, depth + 1); } return out; };
  const info = new Map();
  for (const g of Object.values(scene.items)) {
    if (g.kind !== "group") continue;
    const all = under(g.id), marked = all.filter((d) => d.status), fail = marked.filter((d) => d.status === "fail").length;
    if (!all.length) continue;
    const done = !marked.some((d) => ACTIVE.has(d.status)) && (g.status ? FINISHED.has(g.status) : marked.length > 0 && marked.every((d) => FINISHED.has(d.status)));
    info.set(g.id, { n: all.filter((d) => d.kind !== "item").length, fail, allFail: g.status ? g.status === "fail" : marked.length > 0 && fail === marked.length, done });
  }
  return info;
}
// 끝난 묶음 안의 부품인가(그 안의 실패는 지난 일이라 주의 띠에 올리지 않는다)
export function inFinishedGroup(scene, info, id) {
  for (let p = own(scene.items, id)?.in, i = 0; p && i < 10; p = own(scene.items, p)?.in, i++) if (info.get(p)?.done) return true;
  return false;
}

// 끝난 묶음은 접는다. 맨 바깥 묶음이 모두 끝났으면 가장 나중에 만든 것은 펼쳐 둔다(방금 끝낸 작업이 통째로 접히지 않게).
// pick: 사용자가 누른 것(묶음 id → true 접음 / false 펼침)
function foldState(scene, pick) {
  const info = groupSummary(scene);
  const top = [...info.keys()].map((id) => scene.items[id]).filter((g) => own(scene.items, g.in)?.kind !== "group");
  const keep = top.length && top.every((g) => info.get(g.id).done) ? top.reduce((a, b) => (b.ord > a.ord ? b : a)).id : null;
  const folded = new Set();
  for (const [id, i] of info) if (pick.has(id) ? pick.get(id) : i.done && id !== keep) folded.add(id);
  return { folded, info };
}

// 배치 후보: 그림 전체를 한 방향으로 놓는 넷(LLM 이 준 방향·반대 방향, 각각 줄 바꿈 없음·있음)과, 바깥과 묶음 안의
// 방향을 다르게 놓는 「섞기」 둘. 한 방향만으로는 묶음이 있거나 선이 없는 그림이 긴 줄(가로·세로)밖에 되지 않는다
const OTHER_DIR = { RIGHT: "DOWN", DOWN: "RIGHT" };
// 섞기에서 묶음 경계를 넘는 선 대신 배치에만 넣는 선의 id 앞머리. 부품 id 에는 ~ 가 들어갈 수 없다
const LIFT = "~lift~";
// 묶음 안쪽 여백(ELK 의 elk.padding 과 같다). 화면에서 옮긴 도형을 묶음 안에 둘 때도 쓴다
const GROUP_PAD = { top: 30, left: 12, bottom: 14, right: 12 };
const MOVE_STEP = 10; // Shift + 화살표 한 번에 옮기는 px
const LAYERED = {
  "elk.algorithm": "layered", "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES", "elk.spacing.nodeNode": "24",
  "elk.layered.spacing.nodeNodeBetweenLayers": "44", "elk.edgeLabels.placement": "CENTER",
};

// getViewport: 그림이 들어갈 칸의 크기 { w, h }(px). 모르면 LLM 이 준 방향 하나로만 배치한다.
// mailFor: 그 부품에 보낸 글 수 표시({ text, queued, title }, 없으면 null), onMail: 그 표시를 눌렀을 때(부품 id)
// 도형 옮기기: canMove() 는 옮길 수 없으면 까닭(글), onMove(id, pos|null) 은 옮긴 자리를 기록하고 성공 여부를 돌려준다(Promise),
// onRefuse(까닭) 은 옮기지 않을 때 알린다, getZoom() 은 그림 배율. onFold() 는 묶음을 접거나 펼쳤을 때 다시 그리게 한다
export function createCanvas(root, { onCopy, notesFor, mailFor = () => null, onMail = () => {}, getTheme, getViewport,
  canMove = () => null, onMove = async () => false, onRefuse = () => {}, getZoom = () => 1, onPlaced = () => {}, onFold = null }) {
  const elk = new window.ELK();
  const groupLayer = el("div", "layer groups"), partLayer = el("div", "layer parts");
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("class", "edges");
  svg.innerHTML = '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"></path></marker></defs>';
  const edgeLayer = document.createElementNS(SVGNS, "g");
  svg.appendChild(edgeLayer);
  const labelLayer = el("div", "layer labels");
  root.append(groupLayer, svg, partLayer, labelLayer);

  const nodes = new Map();      // 부품 id → 요소
  const mermaidCache = new Map(); // src → { svg } 또는 { error }
  // pendingKey: 지금 재고 있는 배치의 열쇠. 같은 구조로 다시 불리면 그 배치를 버리고 새로 시작하지 않는다
  // (사건이 잦으면 배치가 끝나기 전에 계속 새로 시작해 자리 잡기가 늦어지고 ELK 계산이 쌓였다)
  let lastKey = null, pendingKey = null, rev = 0, prevJson = new Map(), mermaidTheme = null, mermaidSeq = 0;
  // layout: 마지막 ELK 배치(옮긴 자리를 덮기 전). lastScene: 마지막으로 그린 장면. used: 놓은 자리(pos 와 같은 기준, 묶음 안이면 묶음 기준)
  // pending: 놓았으나 기록이 아직 장면에 오지 않은 자리 { pos(null 은 자동 자리로), ref(놓을 때의 부품), acked(서버가 기록함) }.
  // drag: 끄는 중인 도형
  let layout = null, lastScene = null, placedSig = null, used = new Map(), drag = null;
  const pending = new Map();
  // fold: 이번 그리기에서 접은 묶음과 묶음마다의 요약. foldPick: 사용자가 누른 것(세션을 바꾸면 잊는다)
  let fold = { folded: new Set(), info: new Map() }, refocus = null; // refocus: ▸·▾ 단추로 접고 편 묶음(새 단추에 초점을 줄 것)
  const foldPick = new Map();
  // 접힌 묶음 안의 부품이면 그것을 가린 가장 바깥 묶음
  const foldedAbove = (scene, id) => {
    let top = null;
    for (let p = own(scene.items, id)?.in, i = 0; p && i < 10; p = own(scene.items, p)?.in, i++) if (fold.folded.has(p)) top = p;
    return top;
  };
  const refold = () => (onFold ? onFold() : lastScene && render(lastScene, { animate: false }));

  // Mermaid(5.5MB)는 mermaid 부품이 처음 나올 때 불러온다. 그림이 없는 화판은 열 때마다 받고 읽느라 늦어지지 않는다
  // 받지 못했으면 오류를 그린 배치를 확정하지 않아, 다음 그리기(다음 사건) 때 다시 배치하며 다시 받는다. 쉬는 화판은 사건이 올 때까지 기다린다
  let mermaidLoad = null, mermaidRetry = false;
  const loadMermaid = () => (mermaidLoad ||= new Promise((ok, no) => {
    const s = document.createElement("script");
    s.src = "/vendor/mermaid.js";
    s.onload = () => ok();
    s.onerror = () => { mermaidLoad = null; mermaidRetry = true; s.remove(); no(new Error("Mermaid 를 불러오지 못했습니다")); };
    document.head.append(s);
  }));

  // Mermaid 는 그림 크기를 재려고 임시 요소(d<id>)를 붙인다. 자리를 주지 않으면 body 에 붙는데, body 는 행을 못박은 grid 라
  // 띠가 숨어 빈 2행에 그 요소가 들어가 그리는 동안 화면 전체를 그 높이만큼 아래로 민다. 화면 밖 고정 칸에서 재게 한다
  function mermaidWork() {
    let el = document.getElementById("mermaid-work");
    if (!el) {
      el = document.createElement("div");
      el.id = "mermaid-work";
      el.setAttribute("aria-hidden", "true");
      el.style.cssText = "position:fixed;left:-100000px;top:0;width:1600px;pointer-events:none";
      document.body.append(el);
    }
    return el;
  }

  async function mermaidSvg(src) {
    try { await loadMermaid(); } catch (e) { return { error: e.message }; }
    const theme = getTheme();
    if (theme !== mermaidTheme) {
      mermaidCache.clear();
      mermaidTheme = theme;
      // suppressErrorRendering: 문법 오류 때 Mermaid 가 페이지 끝에 자체 오류 그림을 덧붙이지 않게 한다
      window.mermaid.initialize({
        startOnLoad: false, securityLevel: "strict", theme: theme === "dark" ? "dark" : "default", htmlLabels: false, flowchart: { htmlLabels: false }, suppressErrorRendering: true,
        // 간트는 그리는 자리의 폭(따로 그리면 1200px)에 맞춰 늘어나 줄이면 글이 아주 작아진다. 폭을 정해 둔다
        gantt: { useWidth: 640, fontSize: 12, sectionFontSize: 12, barHeight: 18 },
        themeVariables: { fontFamily: '"Pretendard Variable", system-ui, sans-serif', fontSize: "14px", pieSectionTextSize: "14px", pieLegendTextSize: "14px", pieTitleTextSize: "16px", ...Object.fromEntries(CHART_COLORS.map((c, i) => [`pie${i + 1}`, c])), pieOpacity: "0.9", xyChart: { plotColorPalette: CHART_COLORS.join(",") } },
      });
    }
    if (mermaidCache.has(src)) return mermaidCache.get(src);
    const id = `atv-m${++mermaidSeq}`;
    let out;
    try {
      await window.mermaid.parse(src); // 문법이 틀리면 그리기 전에 여기서 멈춘다
      out = { svg: (await window.mermaid.render(id, src, mermaidWork())).svg };
    } catch (e) {
      out = { error: String(e && e.message ? e.message : e).slice(0, 300) };
      for (const left of [id, `d${id}`]) document.getElementById(left)?.remove(); // 그리다 남긴 임시 요소
    }
    mermaidCache.set(src, out);
    // 같은 부품의 src 를 자주 바꿔도 캐시가 끝없이 커지지 않게 오래된 것부터 버린다
    if (mermaidCache.size > 40) mermaidCache.delete(mermaidCache.keys().next().value);
    return out;
  }

  // 후보 하나의 ELK 그래프. mode: one(한 방향) · wrap(한 방향 + 줄 바꿈) · mixed(바깥 outer, 묶음 안 inner).
  // shape 의 상자 크기는 한 번 잰 것을 후보마다 같이 쓴다. cross 는 섞기에서 직접 그릴 선이다
  function buildGraph(shape, mode, outer, inner, ratio) {
    const sep = mode === "mixed";
    const plain = [], lifted = [], cross = [];
    for (const e of shape.edges) {
      if (!sep || shape.parentOf(e.a) === shape.parentOf(e.b)) {
        plain.push({ id: e.id, sources: [e.a], targets: [e.b], ...(e.label && { labels: [{ ...e.label }] }) });
        continue;
      }
      // ELK 는 SEPARATE_CHILDREN 에서 경계를 넘는 선의 경로를 내지 않는다.
      // 공통 조상 바로 아래의 두 조상끼리 이어 순서만 맞추고, 실제 선은 그린 뒤에 직접 긋는다
      const ca = shape.chain(e.a), cb = shape.chain(e.b);
      let i = 0;
      while (ca[i] === cb[i]) i++;
      lifted.push({ id: LIFT + e.id, sources: [ca[i]], targets: [cb[i]] });
      cross.push(e);
    }
    // 선이 하나도 없는 층(바깥이나 묶음 안)은 한 줄로 늘어서지 않게 칸 비율에 맞춰 채워 넣는다
    const linked = new Set([...plain, ...lifted].map((x) => shape.parentOf(x.sources[0])));
    const pack = (level) => (sep && !linked.has(level) && (shape.byParent.get(level) || []).length > 1
      ? { "elk.algorithm": "rectpacking", "elk.aspectRatio": String(ratio) } : null);
    const node = (p) => {
      if (p.kind !== "group" || shape.size.has(p.id)) return { id: p.id, ...shape.size.get(p.id) }; // 접은 묶음은 잎
      return {
        id: p.id,
        // 비었거나 제목이 자식보다 넓은 묶음도 제목이 다 보이게 최소 크기를 준다
        layoutOptions: {
          "elk.padding": `[top=${GROUP_PAD.top},left=${GROUP_PAD.left},bottom=${GROUP_PAD.bottom},right=${GROUP_PAD.right}]`, "elk.nodeSize.constraints": "MINIMUM_SIZE", "elk.nodeSize.minimum": shape.groupMin.get(p.id),
          ...(sep && { ...LAYERED, "elk.direction": inner, ...pack(p.id) }),
        },
        children: (shape.byParent.get(p.id) || []).map(node),
      };
    };
    const layoutOptions = {
      ...LAYERED, "elk.direction": outer, "elk.hierarchyHandling": sep ? "SEPARATE_CHILDREN" : "INCLUDE_CHILDREN",
      "elk.json.shapeCoords": "ROOT", "elk.json.edgeCoords": "ROOT", "elk.padding": "[top=8,left=8,bottom=8,right=8]",
      // 줄 바꿈: 한 방향으로 긴 사슬을 여러 토막으로 잘라 나란히 놓는다. 토막 수는 aspectRatio 를 따른다
      ...(mode === "wrap" && { "elk.layered.wrapping.strategy": "MULTI_EDGE", "elk.aspectRatio": String(ratio) }),
      ...pack(""),
    };
    return { graph: { id: "root", layoutOptions, children: (shape.byParent.get("") || []).map(node), edges: [...plain, ...lifted] }, cross };
  }

  // 후보를 모두 재고 고른다: 다 들어가는 배율(100% 상한)이 가장 큰 것(3% 안쪽은 같다고 본다),
  // 그중 줄 바꿈하지 않은 것, 직접 그린 선이 상자를 덜 지나는 것, 가로:세로가 칸에 가까운 것, 그래도 같으면 후보 순서
  async function bestLayout(shape, dir) {
    const vp = getViewport ? getViewport() : null;
    const known = vp && vp.w > 0 && vp.h > 0;
    const ratio = known ? vp.w / vp.h : 1.6;
    const other = OTHER_DIR[dir] || "DOWN";
    const cands = known ? [["one", dir], ["wrap", dir], ["one", other], ["wrap", other], ["mixed", dir, other], ["mixed", other, dir]] : [["one", dir]];
    const tried = [];
    let failure = null;
    for (const [mode, outer, inner] of cands) {
      const { graph, cross } = buildGraph(shape, mode, outer, inner, ratio);
      let out;
      try { out = await elk.layout(graph); } catch (e) { failure = e; continue; } // 한 후보가 실패해도 나머지로 고른다
      const { lines, w, h, hits } = crossLines(out, cross);
      tried.push({ out, lines, w, h, hits, wrap: mode === "wrap", fit: known ? Math.min(1, vp.w / w, vp.h / h) : 1, off: Math.abs(Math.log(w / h / ratio)) });
    }
    if (!tried.length) throw failure;
    const top = Math.max(...tried.map((x) => x.fit));
    return tried.filter((x) => x.fit * 1.03 >= top).sort((a, b) => a.wrap - b.wrap || a.hits - b.hits || a.off - b.off)[0];
  }

  function listItems(scene, parentId) {
    return Object.values(scene.items).filter((it) => it.kind === "item" && it.in === parentId).sort((a, b) => a.ord - b.ord);
  }

  // 항목 한 줄 = 상태 표시 + 글. 하위 항목은 그 아래 목록으로 들여 쓴다
  function fillItems(ul, scene, parentId) {
    for (const it of listItems(scene, parentId)) {
      const li = el("li"), row = el("div", "row" + (it.status ? ` st-${it.status}` : ""));
      row.append(el("span", "ico", ST_ICO[it.status] || "·"), el("span", "", it.label || it.id));
      if (safeRef(it.ref)) { row.classList.add("has-ref"); row.title = it.ref; row.dataset.ref = it.ref; }
      row.dataset.id = it.id;
      li.append(row);
      if (listItems(scene, it.id).length) {
        const sub = el("ul");
        fillItems(sub, scene, it.id);
        li.append(sub);
      }
      ul.append(li);
    }
  }

  // 부품 안쪽(크기가 바뀔 수 있는 내용)을 떨어진 요소에 만든다. Mermaid 를 기다리는 사이에 더 새 그리기가
  // 시작되면 이 결과는 버려야 하므로, 붙이는 것은 부른 쪽이 최신인지 확인한 뒤에 한다
  async function buildContent(p, scene) {
    const e = el("div");
    if (p.kind === "group") {
      const lbl = el("div", "lbl"), info = fold.info.get(p.id), shut = fold.folded.has(p.id);
      if (info) {
        const b = el("button", "fold", shut ? "▸" : "▾");
        b.type = "button";
        b.dataset.fold = p.id;
        b.setAttribute("aria-expanded", String(!shut));
        b.setAttribute("aria-label", shut ? "묶음 펼치기" : "묶음 접기");
        lbl.append(b);
      }
      lbl.append(document.createTextNode(p.label || ""));
      e.append(lbl);
      if (shut) e.append(el("div", "fsum", `${info.done ? "끝" : "접어 둠"} · 부품 ${info.n}개${info.fail ? ` · 실패 ${info.fail}` : ""}`));
    }
    else if (p.kind === "box") {
      if (SHAPE_PATH[p.shape]) {
        const out = svgEl("svg", { class: "shp", viewBox: "0 0 100 100", preserveAspectRatio: "none", "aria-hidden": "true" });
        out.append(svgEl("path", { d: SHAPE_PATH[p.shape], "vector-effect": "non-scaling-stroke" }));
        e.append(out);
      }
      const lbl = el("div", "lbl", p.label || p.id);
      if (p.icon) {
        const pic = svgEl("svg", { class: "pic", "aria-hidden": "true" });
        pic.append(svgEl("use", { href: `#ic-${p.icon}` }));
        lbl.prepend(pic);
      }
      e.append(lbl);
      // 긴 절대 경로가 상자를 키우지 않게 파일 이름:줄만 보인다. 전체 경로는 툴팁과 복사에 남는다
      if (p.ref) e.append(el("div", "ref", String(p.ref).split("/").pop()));
      if (p.note) e.append(el("div", "pnote", p.note));
    } else if (p.kind === "list") {
      e.append(el("div", "lbl", p.label || ""));
      const ul = el("ul");
      fillItems(ul, scene, p.id);
      e.append(ul);
    } else if (p.kind === "table") {
      if (p.label) e.append(el("div", "lbl", p.label));
      // 줄마다 칸 수가 달라도 표 모양이 깨지지 않게 가장 긴 줄에 맞춰 빈칸을 채운다
      const cols = p.cols || [], rows = p.rows || [];
      const width = Math.max(cols.length, ...rows.map((r) => r.length));
      const line = (cells, tag) => {
        const tr = el("tr");
        for (let i = 0; i < width; i++) tr.append(el(tag, "", cells[i] ?? ""));
        return tr;
      };
      const t = el("table", "tbl");
      if (cols.length) { const head = el("thead"); head.append(line(cols, "th")); t.append(head); }
      const body = el("tbody");
      for (const r of rows) body.append(line(r, "td"));
      t.append(body);
      e.append(t);
      if (p.note) e.append(el("div", "pnote", p.note));
    } else if (p.kind === "progress") {
      const max = p.max || 100, v = Math.min(p.value || 0, max);
      const bar = el("div", "bar"), fill = el("i");
      fill.style.width = `${max ? (v / max) * 100 : 0}%`;
      bar.append(fill);
      e.append(el("div", "lbl", p.label || ""), bar, el("div", "num", `${p.value ?? 0} / ${max}`));
    } else if (p.kind === "text") {
      if (p.label) e.append(el("div", "lbl", p.label));
      e.append(el("div", "body", p.text || ""));
    } else if (p.kind === "mermaid") {
      if (p.label) e.append(el("div", "lbl", p.label));
      const box = el("div", "msvg");
      const out = await mermaidSvg(p.src || "");
      if (out.svg) {
        box.innerHTML = out.svg; // Mermaid(strict)가 만든 SVG. 이 경로 하나만 HTML 을 넣는다
        for (const a of box.querySelectorAll("a")) a.replaceWith(...a.childNodes); // 링크는 벗겨 낸다
        // Mermaid 는 width="100%" 로 내는데, 상자는 내용 폭에 맞춰 줄어드는 칸이라 그림이 작게 눌린다.
        // 그림 자체 크기(viewBox)로 두고, 너무 넓으면 MERMAID_MAX_W 에 맞춰 비율대로 줄인다
        const g = box.querySelector("svg"), vb = g?.viewBox?.baseVal;
        if (vb && vb.width > 0 && vb.height > 0) {
          const k = Math.min(1, MERMAID_MAX_W / vb.width);
          g.setAttribute("width", String(Math.round(vb.width * k)));
          g.setAttribute("height", String(Math.round(vb.height * k)));
          g.style.maxWidth = "none";
        }
      }
      else box.append(el("div", "merr", `Mermaid 그리기 실패: ${out.error}`));
      e.append(box);
    }
    e.append(el("span", "stchip"), el("span", "badges"));
    return [...e.childNodes];
  }

  // 묶음 제목이 다 보이도록 제목 폭을 잰다(글꼴은 화면에 그려진 제목과 같게)
  const ruler = document.createElement("canvas").getContext("2d");
  function groupMinWidth(e, label) {
    const lbl = e.querySelector(":scope > .lbl");
    if (!lbl || !label) return 120;
    ruler.font = getComputedStyle(lbl).font;
    const btn = lbl.querySelector(":scope > .fold");
    return Math.ceil(ruler.measureText(label).width) + 9 + 30 + 8 + (btn ? btn.offsetWidth + 4 : 0);
  }

  // 상태·표시처럼 크기를 바꾸지 않는 것
  function decorate(e, p) {
    // 접은 묶음은 상태가 없어도 안이 끝났으면 끝으로 보인다(아니라고 지운 후보 따위로 실패가 섞여도 끝, 모두 실패일 때만 실패)
    const shut = fold.folded.has(p.id), info = fold.info.get(p.id);
    if (shut && !p.status && info?.done) p = { ...p, status: info.allFail ? "fail" : "done" };
    e.className = `part ${p.kind}` + (shut ? " folded" : "") + (p.status ? ` st-${p.status}` : " nostatus") + (p.ref ? " has-ref" : "") + (shaped(p) ? ` shaped shape-${p.shape}` : "") +
      (drag && drag.moved && drag.id === p.id ? " dragging" : "") + ((pending.has(p.id) ? pending.get(p.id).pos : p.pos) ? " moved" : ""); // 끄는 중에 다시 그려도 들린 모양을 지킨다
    const chip = e.querySelector(":scope > .stchip");
    if (chip) chip.textContent = p.status ? ST_ICO[p.status] : "";
    const badges = e.querySelector(":scope > .badges");
    if (badges) {
      badges.replaceChildren();
      if (p.edited) badges.append(el("span", "badge edited", "수정됨"));
      const notes = notesFor(p.id);
      if (notes.length) badges.append(el("span", "badge", `이유 ${notes.length}`));
      const mb = mailFor(p.id);
      if (mb) {
        const mail = el("span", "badge mail" + (mb.queued ? " queued" : ""), mb.text);
        mail.title = mb.title;
        badges.append(mail);
      }
    }
    const tip = [p.status && ST_KO[p.status], p.ref, ...notesFor(p.id).map((n) => n.text), shut && "누르면 펼칩니다"].filter(Boolean);
    e.title = tip.join("\n");
    if (safeRef(p.ref)) e.dataset.ref = p.ref; else delete e.dataset.ref;
  }

  // ELK 노드 id 로 쓸 부품: item 은 자기 list 로 올린다
  function anchorOf(scene, id) {
    let p = own(scene.items, id);
    for (let i = 0; p && p.kind === "item" && i < 10; i++) p = own(scene.items, p.in);
    return p && p.kind !== "edge" && p.kind !== "step" ? p.id : null;
  }
  function isAncestor(scene, a, b) {
    for (let p = own(scene.items, b)?.in, i = 0; p && i < 10; p = own(scene.items, p)?.in, i++) if (p === a) return true;
    return false;
  }

  async function render(scene, { animate = true } = {}) {
    const parts = Object.values(scene.items).filter((p) => p.kind !== "step").sort((a, b) => a.ord - b.ord);
    fold = foldState(scene, foldPick);
    // 접힌 묶음 안의 부품은 그리지 않는다
    const shown = parts.filter((p) => p.kind !== "edge" && p.kind !== "item" && !foldedAbove(scene, p.id));
    const key = layoutKey(scene, parts, fold);
    // 재고 있는 배치가 있으면 그것과, 없으면 마지막 배치와 견준다(재는 사이 구조가 앞으로 되돌아가도 새로 잰다)
    const relayout = key !== (pendingKey ?? lastKey);
    // rev 는 새 배치를 시작할 때만 올린다. 구조가 같은 그리기는 재고 있는 배치를 버리게 하지 않는다
    const myRev = relayout ? ++rev : rev;
    if (relayout) pendingKey = key;

    // 사라진 부품의 요소를 지운다
    const alive = new Set(shown.map((p) => p.id));
    for (const [id, e] of nodes) if (!alive.has(id)) { e.remove(); nodes.delete(id); }

    for (let p of shown) {
      let e = nodes.get(p.id);
      if (!e) {
        e = el("div");
        e.dataset.id = p.id;
        e.tabIndex = 0; // 키보드로 상자에 가서 Enter 로 Claude 에 보낸다(화면 쪽에서 처리)
        (p.kind === "group" ? groupLayer : partLayer).append(e);
        nodes.set(p.id, e);
      }
      if (relayout || p.kind === "list") {
        const kids = await buildContent(p, scene);
        if (myRev !== rev) return; // 더 새 그리기가 시작됐다
        e.replaceChildren(...kids);
        if (refocus === p.id) { refocus = null; e.querySelector(":scope > .lbl > button.fold")?.focus({ preventScroll: true }); }
      }
      // 기다리는 사이 구조가 같은 그리기가 상태를 바꿨을 수 있으므로 지금의 부품으로 꾸민다(구조가 같으니 부품 목록은 같다)
      p = own(scene.items, p.id) || p;
      decorate(e, p);
      // 옮긴 자리(pos)만 바뀐 것은 깜빡이지 않는다
      const json = JSON.stringify(p, (k, v) => (k === "pos" ? undefined : v)) + (p.kind === "list" ? JSON.stringify(listItems(scene, p.id)) : "");
      if (animate && prevJson.has(p.id) && prevJson.get(p.id) !== json && p.kind !== "group") {
        e.classList.remove("flash");
        void e.offsetWidth;
        e.classList.add("flash");
      }
      prevJson.set(p.id, json);
    }
    for (const id of [...prevJson.keys()]) if (!alive.has(id)) prevJson.delete(id);
    // 화살표 색(상태)은 배치 없이도 바꾼다
    for (const path of edgeLayer.querySelectorAll("path")) {
      const ed = own(scene.items, path.dataset.id);
      if (ed) path.setAttribute("class", ed.status ? `st-${ed.status}` : "");
    }
    lastScene = scene;
    // 구조가 같으면 ELK 를 다시 돌리지 않는다. 옮긴 자리만 바뀌었으면 놓기와 선만 다시 한다
    if (!relayout) { if (layout && pendingKey === null && posSig(scene) !== placedSig) place(scene); return; }

    // 배치: 묶음은 ELK 의 중첩 노드, 나머지는 크기를 잰 잎 노드
    const byParent = new Map();
    const parentOf = (id) => { const p = own(scene.items, id); return p && p.in && own(scene.items, p.in)?.kind === "group" ? p.in : ""; };
    for (const p of shown) {
      const parent = parentOf(p.id);
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push(p);
    }
    // 뿌리 쪽 묶음부터 그 부품 자신까지
    const chain = (id) => { const out = [id]; for (let p = parentOf(id), i = 0; p && i < 10; p = parentOf(p), i++) out.unshift(p); return out; };
    // 잴 때는 화판을 넓혀 둔다. 지난 배치의 좁은 폭에 맞춰 글이 접히면 잴 때마다 상자가 줄어든다
    root.style.width = "4000px";
    const size = new Map(), groupMin = new Map();
    for (const p of shown) {
      const e = nodes.get(p.id);
      if (p.kind === "group" && !fold.folded.has(p.id)) { groupMin.set(p.id, `(${groupMinWidth(e, p.label)}, 44)`); continue; } // 접은 묶음은 상자처럼 잰다
      e.style.left = "0px"; e.style.top = "0px"; e.style.width = ""; e.style.height = "";
      // offset 크기는 화면 배율(transform)과 상관없는 레이아웃 크기다
      let w = e.offsetWidth, h = e.offsetHeight;
      const fit = shaped(p) && SHAPE_FIT[p.shape];
      if (fit) {
        ({ w, h } = fit(w, h));
        w = Math.ceil(w); h = Math.ceil(h);
        e.style.width = `${w}px`; e.style.height = `${h}px`;
      }
      size.set(p.id, { width: w + 1, height: h + 1 });
    }
    const edges = [];
    const measure = el("span", "elabel");
    labelLayer.append(measure);
    // 접힌 묶음 안에 닿는 선은 접힌 상자에 닿는다. 안끼리의 선은 숨기고, 같은 두 끝을 잇는 선은 하나만 긋는다
    const seen = new Set();
    for (const ed of parts.filter((p) => p.kind === "edge")) {
      let a = anchorOf(scene, ed.from), b = anchorOf(scene, ed.to);
      a = a && (foldedAbove(scene, a) || a); b = b && (foldedAbove(scene, b) || b);
      if (!a || !b || a === b || isAncestor(scene, a, b) || isAncestor(scene, b, a)) continue;
      if ((fold.folded.has(a) || fold.folded.has(b)) && seen.has(`${a}\n${b}`)) continue;
      seen.add(`${a}\n${b}`);
      let label;
      if (ed.label) {
        measure.textContent = ed.label;
        label = { text: ed.label, width: measure.offsetWidth + 1, height: measure.offsetHeight + 1 };
      }
      edges.push({ id: ed.id, a, b, label });
    }
    measure.remove();
    let best;
    try { best = await bestLayout({ byParent, parentOf, chain, size, groupMin, edges }, scene.view.dir || "RIGHT"); }
    catch (e) { console.error("ELK 배치 실패", e); if (myRev === rev) pendingKey = null; return; }
    if (myRev !== rev) return; // 늦게 끝난 옛 배치는 버린다
    lastKey = mermaidRetry ? null : key;
    mermaidRetry = false;
    pendingKey = null;

    layout = { out: best.out, lines: best.lines, w: best.w, h: best.h, edges };
    place(lastScene || scene); // 재는 사이에 온 자리·상태까지(구조가 바뀌었으면 rev 로 이미 버렸다)
  }

  // 옮긴 자리를 정하는 값(바뀌었을 때만 다시 놓는다)
  function posSig(scene) {
    const out = [];
    for (const p of Object.values(scene.items)) if (p.pos) out.push([p.id, p.pos.x, p.pos.y]);
    return JSON.stringify([out, [...pending].map(([id, p]) => [id, p.pos]), drag && drag.moved ? [drag.id, drag.pos] : null]);
  }

  // ELK 배치 위에 옮긴 자리(pos)를 덮어 놓고 선을 긋는다(다시 배치해도 놓은 자리 그대로).
  // 맨 바깥 도형은 그림 안(0 아래로는 안 감), 묶음 안 도형은 그 묶음 안에서만 놓이고, 묶음을 옮기면 안의 도형이 함께 간다.
  // 옮긴 도형(옮긴 묶음 안의 도형 포함)에 닿는 선만 다시 긋는다: 두 끝이 같은 만큼 옮겨졌으면 ELK 의 선을 그만큼 옮기고,
  // 아니면 다른 상자를 덜 지나는 길을 새로 찾는다
  function place(scene) {
    if (!layout) return;
    // 놓은 자리의 기록이 왔거나(같은 자리), 서버가 기록한 뒤 그 부품의 기록이 새로 왔으면(다른 탭이 바로 이어 옮김 따위) 장면을 따른다
    for (const [id, p] of pending) {
      const it = own(scene.items, id), same = p.pos === null ? !it?.pos : it?.pos && it.pos.x === p.pos.x && it.pos.y === p.pos.y;
      if (!it || same || (p.acked && it !== p.ref)) pending.delete(id);
    }
    const posOf = (id) => (drag && drag.moved && drag.id === id ? drag.pos : pending.has(id) ? pending.get(id).pos : own(scene.items, id)?.pos || null);
    const elkOf = new Map(), final = new Map();
    used = new Map();
    const visit = (n, g, gElk) => {
      const elk = { x: n.x, y: n.y, width: n.width, height: n.height }, p = posOf(n.id);
      elkOf.set(n.id, elk);
      let rx, ry;
      if (!g) { rx = Math.max(0, p ? p.x : elk.x); ry = Math.max(0, p ? p.y : elk.y); }
      else if (!p) { rx = elk.x - gElk.x; ry = elk.y - gElk.y; }
      else {
        rx = Math.min(Math.max(p.x, GROUP_PAD.left), Math.max(GROUP_PAD.left, g.width - elk.width - GROUP_PAD.right));
        ry = Math.min(Math.max(p.y, GROUP_PAD.top), Math.max(GROUP_PAD.top, g.height - elk.height - GROUP_PAD.bottom));
      }
      used.set(n.id, { x: rx, y: ry });
      const r = { x: (g ? g.x : 0) + rx, y: (g ? g.y : 0) + ry, width: elk.width, height: elk.height };
      final.set(n.id, r);
      for (const c of n.children || []) visit(c, r, elk);
    };
    for (const n of layout.out.children || []) visit(n, null, null);
    let w = layout.w, h = layout.h;
    for (const [id, r] of final) {
      const e = nodes.get(id);
      if (e) {
        e.style.left = `${r.x}px`; e.style.top = `${r.y}px`;
        if (own(scene.items, id)?.kind === "group" && !fold.folded.has(id)) { e.style.width = `${r.width}px`; e.style.height = `${r.height}px`; }
        e.classList.toggle("moved", !!posOf(id));
      }
      w = Math.max(w, r.x + r.width + 8);
      h = Math.max(h, r.y + r.height + 8);
    }

    const delta = (id) => { const a = final.get(id), b = elkOf.get(id); return a && b ? { x: a.x - b.x, y: a.y - b.y } : { x: 0, y: 0 }; };
    const ends = new Map(layout.edges.map((e) => [e.id, e]));
    const leaves = [...final].filter(([id]) => own(scene.items, id)?.kind !== "group" || fold.folded.has(id)).map(([, r]) => r);
    const ctx = {};
    // 선 하나를 어떻게 그을지: null 이면 ELK·직접 그린 길 그대로, {dx,dy} 면 그만큼 옮김, "route" 면 새로 찾음
    const howOf = (id) => {
      const e = ends.get(id);
      if (!e) return null;
      const a = delta(e.a), b = delta(e.b);
      if (!a.x && !a.y && !b.x && !b.y) return null;
      return a.x === b.x && a.y === b.y ? a : "route";
    };
    const shift = (pts, d) => (d ? pts.map((p) => ({ x: p.x + d.x, y: p.y + d.y })) : pts);

    root.style.width = `${w}px`;
    root.style.height = `${h}px`;
    edgeLayer.replaceChildren();
    labelLayer.replaceChildren();
    const grow = (pts) => { for (const p of pts) { w = Math.max(w, p.x + 2); h = Math.max(h, p.y + 2); } };
    const drawEdge = (id, pts) => {
      const path = document.createElementNS(SVGNS, "path");
      path.setAttribute("d", pts.map((pt, i) => `${i ? "L" : "M"}${pt.x},${pt.y}`).join(" "));
      path.setAttribute("marker-end", "url(#arrow)");
      path.dataset.id = id;
      const st = own(scene.items, id)?.status;
      if (st) path.setAttribute("class", `st-${st}`);
      edgeLayer.append(path);
      grow(pts);
    };
    const drawLabel = (text, x, y) => {
      const l = el("span", "elabel", text);
      l.style.left = `${x}px`; l.style.top = `${y}px`;
      labelLayer.append(l);
    };
    const routed = new Set();
    const reroute = (id) => {
      if (routed.has(id)) return;
      routed.add(id);
      const e = ends.get(id), a = final.get(e.a), b = final.get(e.b);
      if (!a || !b) return;
      const pts = pickRoute(a, b, leaves, ctx, `${e.a}\n${e.b}`).pts;
      drawEdge(id, pts);
      if (e.label) {
        const m = midPoint(pts);
        drawLabel(e.label.text, Math.max(0, m.x - e.label.width / 2), Math.max(0, m.y - e.label.height / 2));
      }
    };
    // ELK 가 경로를 낸 선(섞기에서는 묶음 안의 선이 그 묶음 아래에 온다). 배치에만 넣은 선은 그리지 않는다
    const walk = (n) => {
      for (const ed of n.edges || []) {
        const s = ed.sections && ed.sections[0];
        if (!s || ed.id.startsWith(LIFT)) continue;
        const how = howOf(ed.id);
        if (how === "route") { reroute(ed.id); continue; }
        drawEdge(ed.id, shift([s.startPoint, ...(s.bendPoints || []), s.endPoint], how));
        for (const lb of ed.labels || []) drawLabel(lb.text, lb.x + (how ? how.x : 0), lb.y + (how ? how.y : 0));
      }
      (n.children || []).forEach(walk);
    };
    walk(layout.out);
    // 섞기에서 묶음 경계를 넘는 선
    for (const line of layout.lines) {
      const how = howOf(line.id);
      if (how === "route") { reroute(line.id); continue; }
      drawEdge(line.id, shift(line.pts, how));
      if (line.label) drawLabel(line.label.text, line.label.x + (how ? how.x : 0), line.label.y + (how ? how.y : 0));
    }
    // 옮긴 선이 그림 밖으로 나갔으면 그만큼 키운다
    root.style.width = `${w}px`;
    root.style.height = `${h}px`;
    svg.setAttribute("width", w);
    svg.setAttribute("height", h);
    placedSig = posSig(scene);
    onPlaced();
  }

  // ---- 도형 옮기기: Ctrl + 왼쪽 버튼으로 끈다. 움직이지 않고 누르면 그 도형만 자동 자리로. 초점이 있으면 Shift + 화살표 ----
  // 놓으면 바로 그 자리에 두고(pending) 기록이 오기를 기다린다. 기록하지 못하면 되돌린다
  // inAt: 끌기 시작 때 그 부품의 묶음. 그사이 Claude 가 묶음을 바꿨으면 서버가 옛 묶음 기준의 자리를 받지 않는다
  function commit(id, raw, inAt = own(lastScene?.items || {}, id)?.in ?? null) {
    const ref = own(lastScene?.items || {}, id);
    pending.set(id, { pos: raw, ref });
    place(lastScene);
    const p = raw && used.get(id); // 묶음 안·그림 안으로 줄인 자리
    const entry = { pos: p ? { x: Math.round(p.x), y: Math.round(p.y) } : null, ref };
    pending.set(id, entry);
    place(lastScene);
    Promise.resolve(onMove(id, entry.pos, inAt)).then((ok) => {
      if (pending.get(id) !== entry) return;
      if (ok) entry.acked = true; else pending.delete(id);
      if (lastScene) place(lastScene);
    });
  }
  const movable = (ev) => {
    const e = ev.target.closest?.(".part");
    return e && root.contains(e) && e.dataset.id ? e : null;
  };
  const refused = () => {
    const why = canMove() || (!layout || pendingKey !== null ? "그림을 배치하는 중입니다. 잠시 뒤에 옮겨 주세요" : null);
    if (why) onRefuse(why);
    return !!why;
  };
  root.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || !ev.ctrlKey) return;
    const e = movable(ev);
    if (!e) return;
    ev.preventDefault();
    if (refused()) return;
    const id = e.dataset.id, base = used.get(id);
    if (!base) return;
    drag = { id, el: e, pointerId: ev.pointerId, start: local(ev), sx: ev.clientX, sy: ev.clientY, base, pos: base, moved: false, raf: 0, inAt: own(lastScene?.items || {}, id)?.in ?? null };
    root.setPointerCapture(ev.pointerId);
  });
  root.addEventListener("pointermove", (ev) => {
    if (!drag || ev.pointerId !== drag.pointerId) return;
    if (!drag.moved && Math.hypot(ev.clientX - drag.sx, ev.clientY - drag.sy) < 4) return;
    if (!drag.moved) { drag.moved = true; drag.el.classList.add("dragging"); root.classList.add("moving"); }
    const at = local(ev);
    drag.pos = { x: drag.base.x + at.x - drag.start.x, y: drag.base.y + at.y - drag.start.y };
    if (!drag.raf) drag.raf = requestAnimationFrame(() => { if (drag) { drag.raf = 0; place(lastScene); } });
  });
  const endDrag = (ev, cancel) => {
    if (!drag || ev.pointerId !== drag.pointerId) return;
    const d = drag;
    drag = null;
    if (d.raf) cancelAnimationFrame(d.raf);
    d.el.classList.remove("dragging");
    root.classList.remove("moving");
    // 끌기·Ctrl + 클릭 바로 뒤의 클릭 하나는 경로 복사로 치지 않는다(Ctrl 을 먼저 떼고 버튼을 놓아도). 클릭이 오지 않을 때
    // 다음 진짜 클릭을 먹지 않게 다음 차례에 푼다
    swallowClick = true;
    setTimeout(() => { swallowClick = false; }, 0);
    // 끄는 사이 그 도형이 접힌 묶음 안으로 숨었으면 놓은 자리를 기록하지 않는다(배치에 없으면 자동 자리로 지워진다)
    if (cancel || !nodes.has(d.id)) { place(lastScene); return; }
    if (d.moved) commit(d.id, d.pos, d.inAt);
    else if (posOfScene(d.id)) commit(d.id, null, d.inAt); // 움직이지 않고 누름: 옮긴 도형이면 자동 자리로
  };
  // 화면 점을 그림 좌표로(스크롤·배율 반영). 그림이 움직여도 같은 그림 자리가 나온다
  const local = (ev) => { const r = root.getBoundingClientRect(), z = getZoom() || 1; return { x: (ev.clientX - r.left) / z, y: (ev.clientY - r.top) / z }; };
  const posOfScene = (id) => (pending.has(id) ? pending.get(id).pos : own(lastScene?.items || {}, id)?.pos || null);
  root.addEventListener("pointerup", (ev) => endDrag(ev, false));
  root.addEventListener("pointercancel", (ev) => endDrag(ev, true));
  // macOS 는 Ctrl + 왼쪽 클릭을 오른쪽 클릭으로 보아 메뉴를 띄운다. 끄는 중(누른 뒤 뗄 때까지)에만 막고,
  // Windows·Linux 의 Ctrl + 오른쪽 클릭 메뉴는 그대로 둔다
  let swallowClick = false;
  root.addEventListener("contextmenu", (ev) => { if (drag) ev.preventDefault(); });
  root.addEventListener("keydown", (ev) => {
    const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[ev.key];
    if (!step || !ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey) return;
    const e = movable(ev);
    if (!e) return;
    ev.preventDefault();
    if (refused()) return;
    const base = used.get(e.dataset.id);
    if (base) commit(e.dataset.id, { x: base.x + step[0] * MOVE_STEP, y: base.y + step[1] * MOVE_STEP });
  });

  // 부품이나 항목을 누르면 ref 를 복사한다. Ctrl 을 누른 채면 도형 옮기기라 하지 않는다
  root.addEventListener("click", (ev) => {
    if (ev.ctrlKey || swallowClick) return;
    const mail = ev.target.closest(".badge.mail");
    if (mail) { onMail(mail.closest(".part")?.dataset.id); return; } // 보낸 글 수는 복사하지 않고 보내기 창을 연다(접힌 묶음에서도)
    // 묶음의 ▸·▾ 단추, 또는 접힌 묶음 아무 곳: 펼치고 접는다. 다시 그리면 단추가 새로 만들어지므로 초점을 새 단추로 옮긴다
    const shut = ev.target.closest("button.fold, .part.group.folded");
    if (shut && root.contains(shut)) {
      const id = shut.dataset.fold || shut.dataset.id;
      if (shut.matches("button.fold")) refocus = id;
      foldPick.set(id, !fold.folded.has(id));
      refold();
      return;
    }
    const hit = ev.target.closest("[data-ref]");
    if (hit && root.contains(hit)) onCopy(hit.dataset.ref);
  });

  return {
    render,
    // 재고 있던 배치도 버린다(rev). 그대로 두면 끝난 뒤 lastKey 를 채워 다시 배치하라는 요청을 지운다
    reset() {
      rev++; lastKey = pendingKey = null; prevJson = new Map(); mermaidCache.clear(); layout = null; pending.clear(); foldPick.clear();
      // 끄는 중에 다른 세션으로 바뀌었다: 끄기를 버린다(들린 모양·커서·글자 고르기 막기를 풀고 포인터를 놓는다)
      if (drag) {
        if (drag.raf) cancelAnimationFrame(drag.raf);
        drag.el.classList.remove("dragging");
        try { root.releasePointerCapture(drag.pointerId); } catch { /* 이미 놓음 */ }
        drag = null;
      }
      root.classList.remove("moving");
    },
    invalidate() { rev++; lastKey = pendingKey = null; },
    isEmpty: () => nodes.size === 0,
    busy: () => pendingKey !== null, // 배치를 재는 중(부품이 아직 옛 자리나 0,0 에 있다)
    elementOf: (id) => nodes.get(id) || null,
    // 접힌 묶음 안의 부품이면 그 묶음들을 펼쳐 다시 그리게 하고 true(찾기로 고른 부품을 보이려고)
    unfold(id) {
      if (!lastScene || !foldedAbove(lastScene, id)) return false;
      for (let p = own(lastScene.items, id)?.in, i = 0; p && i < 10; p = own(lastScene.items, p)?.in, i++) if (fold.folded.has(p)) foldPick.set(p, false);
      refold();
      return true;
    },
  };
}
