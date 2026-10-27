// 가운데 그림: 부품을 DOM 으로 만들고 ELK 로 자리를 정한다.
// 상태만 바뀌면 다시 배치하지 않는다. 크기나 구조가 바뀔 때만 이전 순서를 넣어 다시 배치하고, 가장 최근 배치 결과만 그린다.
// 받은 글은 textContent 로만 넣는다. HTML 을 넣는 곳은 Mermaid 가 strict 로 그린 SVG 하나뿐이다(표 칸도 글로만 넣는다).

import { own } from "/lib/scene.js";
import { crossLines } from "/route.js";

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

// 배치에 영향을 주는 값만 모은 열쇠. 이것이 같으면 다시 배치하지 않는다
function layoutKey(scene, parts) {
  return JSON.stringify([scene.view.dir, parts.map((p) => [p.id, p.kind, p.label, p.in, p.from, p.to, p.text, p.src, p.ref, p.note, p.value, p.max, p.shape, p.icon, p.cols, p.rows])]);
}

// 배치 후보: 그림 전체를 한 방향으로 놓는 넷(LLM 이 준 방향·반대 방향, 각각 줄 바꿈 없음·있음)과, 바깥과 묶음 안의
// 방향을 다르게 놓는 「섞기」 둘. 한 방향만으로는 묶음이 있거나 선이 없는 그림이 긴 줄(가로·세로)밖에 되지 않는다
const OTHER_DIR = { RIGHT: "DOWN", DOWN: "RIGHT" };
// 섞기에서 묶음 경계를 넘는 선 대신 배치에만 넣는 선의 id 앞머리. 부품 id 에는 ~ 가 들어갈 수 없다
const LIFT = "~lift~";
const LAYERED = {
  "elk.algorithm": "layered", "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES", "elk.spacing.nodeNode": "24",
  "elk.layered.spacing.nodeNodeBetweenLayers": "44", "elk.edgeLabels.placement": "CENTER",
};

// getViewport: 그림이 들어갈 칸의 크기 { w, h }(px). 모르면 LLM 이 준 방향 하나로만 배치한다.
// mailFor: 그 부품에 보낸 글 수 표시({ text, queued, title }, 없으면 null), onMail: 그 표시를 눌렀을 때(부품 id)
export function createCanvas(root, { onCopy, notesFor, mailFor = () => null, onMail = () => {}, getTheme, getViewport }) {
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
      out = { svg: (await window.mermaid.render(id, src)).svg };
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
      if (p.kind !== "group") return { id: p.id, ...shape.size.get(p.id) };
      return {
        id: p.id,
        // 비었거나 제목이 자식보다 넓은 묶음도 제목이 다 보이게 최소 크기를 준다
        layoutOptions: {
          "elk.padding": "[top=30,left=12,bottom=14,right=12]", "elk.nodeSize.constraints": "MINIMUM_SIZE", "elk.nodeSize.minimum": shape.groupMin.get(p.id),
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
    if (p.kind === "group") { e.append(el("div", "lbl", p.label || "")); }
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
    return Math.ceil(ruler.measureText(label).width) + 9 + 30 + 8;
  }

  // 상태·표시처럼 크기를 바꾸지 않는 것
  function decorate(e, p) {
    e.className = `part ${p.kind}` + (p.status ? ` st-${p.status}` : " nostatus") + (p.ref ? " has-ref" : "") + (shaped(p) ? ` shaped shape-${p.shape}` : "");
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
    const tip = [p.status && ST_KO[p.status], p.ref, ...notesFor(p.id).map((n) => n.text)].filter(Boolean);
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
    const shown = parts.filter((p) => p.kind !== "edge" && p.kind !== "item");
    const key = layoutKey(scene, parts);
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
      }
      // 기다리는 사이 구조가 같은 그리기가 상태를 바꿨을 수 있으므로 지금의 부품으로 꾸민다(구조가 같으니 부품 목록은 같다)
      p = own(scene.items, p.id) || p;
      decorate(e, p);
      const json = JSON.stringify(p) + (p.kind === "list" ? JSON.stringify(listItems(scene, p.id)) : "");
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
    if (!relayout) return;

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
      if (p.kind === "group") { groupMin.set(p.id, `(${groupMinWidth(e, p.label)}, 44)`); continue; }
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
    for (const ed of parts.filter((p) => p.kind === "edge")) {
      const a = anchorOf(scene, ed.from), b = anchorOf(scene, ed.to);
      if (!a || !b || a === b || isAncestor(scene, a, b) || isAncestor(scene, b, a)) continue;
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

    const out = best.out;
    const place = (n) => {
      const e = nodes.get(n.id);
      if (e) {
        e.style.left = `${n.x}px`; e.style.top = `${n.y}px`;
        if (own(scene.items, n.id)?.kind === "group") { e.style.width = `${n.width}px`; e.style.height = `${n.height}px`; }
      }
      (n.children || []).forEach(place);
    };
    (out.children || []).forEach(place);
    // 직접 그린 선의 이름표까지 들어가는 크기
    root.style.width = `${best.w}px`;
    root.style.height = `${best.h}px`;
    svg.setAttribute("width", best.w);
    svg.setAttribute("height", best.h);

    edgeLayer.replaceChildren();
    labelLayer.replaceChildren();
    const drawEdge = (id, pts) => {
      const path = document.createElementNS(SVGNS, "path");
      path.setAttribute("d", pts.map((pt, i) => `${i ? "L" : "M"}${pt.x},${pt.y}`).join(" "));
      path.setAttribute("marker-end", "url(#arrow)");
      path.dataset.id = id;
      const st = own(scene.items, id)?.status;
      if (st) path.setAttribute("class", `st-${st}`);
      edgeLayer.append(path);
    };
    const drawLabel = (text, x, y) => {
      const l = el("span", "elabel", text);
      l.style.left = `${x}px`; l.style.top = `${y}px`;
      labelLayer.append(l);
    };
    // ELK 가 경로를 낸 선(섞기에서는 묶음 안의 선이 그 묶음 아래에 온다). 배치에만 넣은 선은 그리지 않는다
    const walk = (n) => {
      for (const ed of n.edges || []) {
        const s = ed.sections && ed.sections[0];
        if (!s || ed.id.startsWith(LIFT)) continue;
        drawEdge(ed.id, [s.startPoint, ...(s.bendPoints || []), s.endPoint]);
        for (const lb of ed.labels || []) drawLabel(lb.text, lb.x, lb.y);
      }
      (n.children || []).forEach(walk);
    };
    walk(out);
    // 섞기에서 묶음 경계를 넘는 선
    for (const line of best.lines) {
      drawEdge(line.id, line.pts);
      if (line.label) drawLabel(line.label.text, line.label.x, line.label.y);
    }
  }

  // 부품이나 항목을 누르면 ref 를 복사한다
  root.addEventListener("click", (ev) => {
    const mail = ev.target.closest(".badge.mail");
    if (mail) { onMail(mail.closest(".part")?.dataset.id); return; } // 보낸 글 수는 복사하지 않고 보내기 창을 연다
    const hit = ev.target.closest("[data-ref]");
    if (hit && root.contains(hit)) onCopy(hit.dataset.ref);
  });

  return {
    render,
    // 재고 있던 배치도 버린다(rev). 그대로 두면 끝난 뒤 lastKey 를 채워 다시 배치하라는 요청을 지운다
    reset() { rev++; lastKey = pendingKey = null; prevJson = new Map(); mermaidCache.clear(); },
    invalidate() { rev++; lastKey = pendingKey = null; },
    isEmpty: () => nodes.size === 0,
    busy: () => pendingKey !== null, // 배치를 재는 중(부품이 아직 옛 자리나 0,0 에 있다)
    elementOf: (id) => nodes.get(id) || null,
  };
}
