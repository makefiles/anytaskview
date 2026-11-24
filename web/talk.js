// 판서: explain 도구가 보낸 한 장(lib/scene.js evalExplain)을 화이트보드처럼 그린다.
// LLM 은 글만 보내고 자리·색·크기는 모두 여기서 정한다. 칸은 가로 한 줄이고, 칸마다 마커 색 하나(빨강은 강조 전용)다.
// 손그림 선은 roughjs(전역 rough, /vendor/rough.js), 글씨는 나눔손글씨 펜(style.css 의 @font-face).
// 같은 장은 늘 같은 모양으로 그린다: roughjs 의 seed 를 그릴 때마다 1부터 센다.
// 글 폭을 재므로 svg 가 보일 때(display 가 none 이 아닐 때), 글꼴을 받은 뒤에 불러야 한다(fontReady)
export const TALK_W = 1280, TALK_H = 800;
const FONT = '"Nanum Pen Script", "Pretendard Variable", sans-serif';
export const fontReady = () => document.fonts.load('28px "Nanum Pen Script"').catch(() => {});

const C = { ink: "#22283a", red: "#d4372f", mut: "#7a828e", hl: "#ffe14a", memo: "#ffe98c", memoEdge: "#e3c34a", frame: "#c5c9cf", bulb: "#f2b400" };
const PALETTE = ["#1f5fbf", "#1f8a4c", "#e07816", "#7040b8"]; // 파랑·초록·주황·보라
const M = 46;
const NS = "http://www.w3.org/2000/svg";
const line = (l) => (typeof l === "string" ? { t: l } : l);
const pad2 = (n) => String(n).padStart(2, "0");

// 장 하나를 svg 에 그린다. rec = {key, task, t, ord, page}
export function drawTalk(svg, rec) {
  const B = rec.page;
  const rc = rough.svg(svg);
  let seed = 0;
  const root = document.createElementNS(NS, "g"), back = document.createElementNS(NS, "g"), front = document.createElementNS(NS, "g");
  root.setAttribute("class", "tk");
  root.append(back, front);
  svg.replaceChildren(root);
  let curBack = back, curFront = front; // 칸 안 내용은 칸마다 따로 묶어 그린 뒤 가운데로 옮긴다

  const opt = (color, width, extra = {}) => ({ stroke: color, strokeWidth: width, roughness: 0.6, bowing: 0.5, disableMultiStroke: true, seed: ++seed, ...extra });
  const hatch = (color) => ({ fill: color + "66", fillStyle: "hachure", hachureGap: 5.5, fillWeight: 1.6, hachureAngle: -40 });
  const put = (node, layer = "front") => ((layer === "back" ? curBack : curFront).append(node), node);
  const group = () => document.createElementNS(NS, "g");

  // 펜 글꼴은 획이 가늘어, 같은 색 테두리를 둘러 마커 굵기를 낸다
  function text(x, y, s, { size = 28, bold = false, color = C.ink, anchor = "start" } = {}) {
    const e = document.createElementNS(NS, "text");
    e.setAttribute("x", x); e.setAttribute("y", y);
    e.setAttribute("font-size", size);
    e.setAttribute("font-family", FONT);
    e.setAttribute("fill", color);
    e.setAttribute("stroke", color); e.setAttribute("stroke-width", bold ? 1.5 : 0.8); e.setAttribute("paint-order", "stroke");
    e.setAttribute("text-anchor", anchor);
    e.textContent = s;
    return put(e);
  }
  const width = (s, size, bold) => { const e = text(-9999, -9999, s, { size, bold }); const w = e.getComputedTextLength(); e.remove(); return w; };
  // 띄어쓰기 단위로 채우고, 한 낱말이 칸보다 길면 글자 단위로 자른다
  function wrap(s, size, max, bold) {
    const out = [];
    let cur = "";
    for (const word of String(s).split(" ")) {
      const next = cur ? cur + " " + word : word;
      if (width(next, size, bold) <= max) { cur = next; continue; }
      if (cur) out.push(cur);
      cur = word;
      while (cur.length > 1 && width(cur, size, bold) > max) {
        let n = cur.length - 1;
        while (n > 1 && width(cur.slice(0, n), size, bold) > max) n--;
        out.push(cur.slice(0, n));
        cur = cur.slice(n);
      }
    }
    if (cur) out.push(cur);
    return out;
  }
  const rr = (x, y, w, h, r) => {
    r = Math.min(r, w / 2, h / 2);
    return `M${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} H${x + r} Q${x},${y + h} ${x},${y + h - r} V${y + r} Q${x},${y} ${x + r},${y} Z`;
  };
  function badge(cx, cy, r, label, color) {
    put(rc.circle(cx, cy, r * 2, opt(color, 2, { fill: color, fillStyle: "solid", roughness: 0.4 })));
    text(cx, cy + r * 0.48, label, { size: r * 1.55, bold: true, color: "#fff", anchor: "middle" });
  }
  function arrowHead(x, y, ang, color) {
    const h = 16;
    put(rc.linearPath([[x - h * Math.cos(ang - 0.5), y - h * Math.sin(ang - 0.5)], [x, y], [x - h * Math.cos(ang + 0.5), y - h * Math.sin(ang + 0.5)]], opt(color, 3, { roughness: 0.4 })));
  }
  function arrow(x1, y1, x2, y2, bend, color = C.ink, dash = false) {
    const len = Math.hypot(x2 - x1, y2 - y1) || 1, nx = -(y2 - y1) / len, ny = (x2 - x1) / len;
    const cx = (x1 + x2) / 2 + nx * bend, cy = (y1 + y2) / 2 + ny * bend;
    put(rc.curve([[x1, y1], [cx, cy], [x2, y2]], opt(color, 3, { roughness: 0.5, ...(dash ? { strokeLineDash: [9, 9] } : {}) })));
    arrowHead(x2, y2, Math.atan2(y2 - cy, x2 - cx), color);
  }

  // 손으로 그린 아이콘. 이름은 그림 도구(draw)의 아이콘 이름에 check·cross·bulb·chat 을 더했다.
  // 따로 그림이 없는 이름은 같은 갈래의 그림을 빌려 쓴다
  const ICONS = {
    user(cx, cy, s, c) {
      put(rc.circle(cx, cy - s * 0.2, s * 0.38, opt(c, 2.6, hatch(c))));
      put(rc.path(`M${cx - s * 0.38},${cy + s * 0.42} Q${cx - s * 0.36},${cy + s * 0.02} ${cx},${cy + s * 0.02} Q${cx + s * 0.36},${cy + s * 0.02} ${cx + s * 0.38},${cy + s * 0.42} Z`, opt(c, 2.6, hatch(c))));
    },
    users(cx, cy, s, c) { ICONS.user(cx - s * 0.2, cy + s * 0.04, s * 0.8, c); ICONS.user(cx + s * 0.24, cy - s * 0.04, s * 0.8, c); },
    server(cx, cy, s, c) {
      for (const k of [-1, 0, 1]) {
        const y = cy + k * s * 0.3 - s * 0.13;
        put(rc.rectangle(cx - s * 0.42, y, s * 0.84, s * 0.26, opt(c, 2.4, hatch(c))));
        put(rc.line(cx + s * 0.18, y + s * 0.13, cx + s * 0.3, y + s * 0.13, opt(C.ink, 2.4)));
      }
    },
    monitor(cx, cy, s, c) {
      put(rc.rectangle(cx - s * 0.48, cy - s * 0.36, s * 0.96, s * 0.6, opt(c, 2.6, hatch(c))));
      put(rc.line(cx, cy + s * 0.24, cx, cy + s * 0.4, opt(c, 2.6)));
      put(rc.line(cx - s * 0.22, cy + s * 0.42, cx + s * 0.22, cy + s * 0.42, opt(c, 2.6)));
    },
    phone(cx, cy, s, c) {
      put(rc.path(rr(cx - s * 0.26, cy - s * 0.45, s * 0.52, s * 0.9, s * 0.08), opt(c, 2.6, hatch(c))));
      put(rc.line(cx - s * 0.06, cy + s * 0.34, cx + s * 0.06, cy + s * 0.34, opt(C.ink, 2.6)));
    },
    terminal(cx, cy, s, c) {
      put(rc.rectangle(cx - s * 0.48, cy - s * 0.36, s * 0.96, s * 0.72, opt(c, 2.6, hatch(c))));
      put(rc.linearPath([[cx - s * 0.3, cy - s * 0.12], [cx - s * 0.12, cy], [cx - s * 0.3, cy + s * 0.12]], opt(C.ink, 2.6)));
      put(rc.line(cx - s * 0.04, cy + s * 0.16, cx + s * 0.26, cy + s * 0.16, opt(C.ink, 2.6)));
    },
    code(cx, cy, s, c) {
      put(rc.linearPath([[cx - s * 0.16, cy - s * 0.3], [cx - s * 0.46, cy], [cx - s * 0.16, cy + s * 0.3]], opt(c, 3.4)));
      put(rc.linearPath([[cx + s * 0.16, cy - s * 0.3], [cx + s * 0.46, cy], [cx + s * 0.16, cy + s * 0.3]], opt(c, 3.4)));
      put(rc.line(cx + s * 0.08, cy - s * 0.38, cx - s * 0.08, cy + s * 0.38, opt(C.ink, 2.6)));
    },
    chat(cx, cy, s, c) {
      put(rc.ellipse(cx, cy - s * 0.06, s, s * 0.66, opt(c, 2.6, hatch(c))));
      put(rc.linearPath([[cx - s * 0.24, cy + s * 0.22], [cx - s * 0.36, cy + s * 0.44], [cx - s * 0.04, cy + s * 0.27]], opt(c, 2.6)));
      for (const k of [-1, 0, 1]) put(rc.circle(cx + k * s * 0.2, cy - s * 0.06, s * 0.08, opt(C.ink, 2, { fill: C.ink, fillStyle: "solid" })));
    },
    mail(cx, cy, s, c) {
      put(rc.rectangle(cx - s * 0.48, cy - s * 0.32, s * 0.96, s * 0.64, opt(c, 2.6, hatch(c))));
      put(rc.linearPath([[cx - s * 0.48, cy - s * 0.32], [cx, cy + s * 0.06], [cx + s * 0.48, cy - s * 0.32]], opt(C.ink, 2.4)));
    },
    folder(cx, cy, s, c) {
      put(rc.polygon([[cx - s * 0.5, cy - s * 0.22], [cx - s * 0.5, cy - s * 0.4], [cx - s * 0.14, cy - s * 0.4], [cx - s * 0.04, cy - s * 0.22], [cx + s * 0.5, cy - s * 0.22], [cx + s * 0.5, cy + s * 0.36], [cx - s * 0.5, cy + s * 0.36]], opt(c, 2.6, hatch(c))));
    },
    file(cx, cy, s, c) {
      put(rc.polygon([[cx - s * 0.34, cy - s * 0.46], [cx + s * 0.14, cy - s * 0.46], [cx + s * 0.34, cy - s * 0.26], [cx + s * 0.34, cy + s * 0.46], [cx - s * 0.34, cy + s * 0.46]], opt(c, 2.6, hatch(c))));
      for (const k of [-0.08, 0.08, 0.24]) put(rc.line(cx - s * 0.2, cy + k * s, cx + s * 0.2, cy + k * s, opt(C.ink, 2)));
    },
    db(cx, cy, s, c) {
      put(rc.path(`M${cx - s * 0.4},${cy - s * 0.3} V${cy + s * 0.3} A${s * 0.4},${s * 0.13} 0 0 0 ${cx + s * 0.4},${cy + s * 0.3} V${cy - s * 0.3}`, opt(c, 2.6, hatch(c))));
      put(rc.ellipse(cx, cy - s * 0.3, s * 0.8, s * 0.26, opt(c, 2.6)));
    },
    cloud(cx, cy, s, c) {
      put(rc.path(`M${cx - s * 0.36},${cy + s * 0.24} Q${cx - s * 0.56},${cy + s * 0.2} ${cx - s * 0.48},${cy} Q${cx - s * 0.5},${cy - s * 0.24} ${cx - s * 0.2},${cy - s * 0.2} Q${cx - s * 0.06},${cy - s * 0.46} ${cx + s * 0.2},${cy - s * 0.26} Q${cx + s * 0.5},${cy - s * 0.24} ${cx + s * 0.44},${cy + s * 0.04} Q${cx + s * 0.56},${cy + s * 0.24} ${cx + s * 0.34},${cy + s * 0.24} Z`, opt(c, 2.6, hatch(c))));
    },
    net(cx, cy, s, c) {
      const pts = [[cx, cy - s * 0.34], [cx - s * 0.38, cy + s * 0.26], [cx + s * 0.38, cy + s * 0.26]];
      put(rc.polygon(pts, opt(C.ink, 2.2)));
      for (const [x, y] of pts) put(rc.circle(x, y, s * 0.26, opt(c, 2.4, hatch(c))));
    },
    lock(cx, cy, s, c) {
      put(rc.path(`M${cx - s * 0.22},${cy - s * 0.06} V${cy - s * 0.22} Q${cx - s * 0.22},${cy - s * 0.46} ${cx},${cy - s * 0.46} Q${cx + s * 0.22},${cy - s * 0.46} ${cx + s * 0.22},${cy - s * 0.22} V${cy - s * 0.06}`, opt(C.ink, 3)));
      put(rc.rectangle(cx - s * 0.34, cy - s * 0.06, s * 0.68, s * 0.5, opt(c, 2.6, hatch(c))));
    },
    key(cx, cy, s, c) {
      put(rc.circle(cx - s * 0.24, cy, s * 0.36, opt(c, 2.6, hatch(c))));
      put(rc.linearPath([[cx - s * 0.06, cy], [cx + s * 0.46, cy], [cx + s * 0.46, cy + s * 0.16]], opt(C.ink, 2.8)));
      put(rc.line(cx + s * 0.3, cy, cx + s * 0.3, cy + s * 0.14, opt(C.ink, 2.8)));
    },
    gear(cx, cy, s, c) {
      for (let k = 0; k < 8; k++) { const a = (k * Math.PI) / 4; put(rc.line(cx + Math.cos(a) * s * 0.3, cy + Math.sin(a) * s * 0.3, cx + Math.cos(a) * s * 0.46, cy + Math.sin(a) * s * 0.46, opt(C.ink, 4))); }
      put(rc.circle(cx, cy, s * 0.66, opt(c, 2.6, hatch(c))));
      put(rc.circle(cx, cy, s * 0.2, opt(C.ink, 2.4)));
    },
    chart(cx, cy, s, c) {
      put(rc.linearPath([[cx - s * 0.46, cy - s * 0.44], [cx - s * 0.46, cy + s * 0.4], [cx + s * 0.46, cy + s * 0.4]], opt(C.ink, 2.6)));
      [[-0.28, 0.3], [0.02, 0.56], [0.3, 0.42]].forEach(([dx, h]) => put(rc.rectangle(cx + dx * s - s * 0.1, cy + s * 0.4 - h * s, s * 0.2, h * s, opt(c, 2.4, hatch(c)))));
    },
    clock(cx, cy, s, c) {
      put(rc.circle(cx, cy, s * 0.86, opt(c, 2.6, hatch(c))));
      put(rc.linearPath([[cx, cy - s * 0.26], [cx, cy], [cx + s * 0.2, cy + s * 0.1]], opt(C.ink, 3)));
    },
    search(cx, cy, s, c) {
      put(rc.circle(cx - s * 0.1, cy - s * 0.1, s * 0.56, opt(c, 2.6, hatch(c))));
      put(rc.line(cx + s * 0.1, cy + s * 0.1, cx + s * 0.42, cy + s * 0.42, opt(C.ink, 4.4)));
    },
    bug(cx, cy, s, c) {
      put(rc.ellipse(cx, cy + s * 0.06, s * 0.46, s * 0.66, opt(c, 2.6, hatch(c))));
      put(rc.circle(cx, cy - s * 0.32, s * 0.24, opt(C.ink, 2.4)));
      for (const k of [-0.1, 0.08, 0.26]) { put(rc.line(cx - s * 0.22, cy + k * s, cx - s * 0.44, cy + k * s - s * 0.06, opt(C.ink, 2.2))); put(rc.line(cx + s * 0.22, cy + k * s, cx + s * 0.44, cy + k * s - s * 0.06, opt(C.ink, 2.2))); }
    },
    test(cx, cy, s, c) {
      put(rc.polygon([[cx - s * 0.12, cy - s * 0.44], [cx + s * 0.12, cy - s * 0.44], [cx + s * 0.12, cy - s * 0.1], [cx + s * 0.38, cy + s * 0.4], [cx - s * 0.38, cy + s * 0.4], [cx - s * 0.12, cy - s * 0.1]], opt(c, 2.6, hatch(c))));
    },
    pkg(cx, cy, s, c) {
      put(rc.rectangle(cx - s * 0.42, cy - s * 0.3, s * 0.84, s * 0.66, opt(c, 2.6, hatch(c))));
      put(rc.line(cx - s * 0.42, cy - s * 0.06, cx + s * 0.42, cy - s * 0.06, opt(C.ink, 2.2)));
      put(rc.line(cx, cy - s * 0.3, cx, cy + s * 0.36, opt(C.ink, 2.2)));
    },
    branch(cx, cy, s, c) {
      put(rc.line(cx - s * 0.2, cy - s * 0.4, cx - s * 0.2, cy + s * 0.4, opt(C.ink, 2.8)));
      put(rc.path(`M${cx - s * 0.2},${cy + s * 0.12} Q${cx + s * 0.24},${cy + s * 0.08} ${cx + s * 0.24},${cy - s * 0.26}`, opt(C.ink, 2.8)));
      for (const [x, y] of [[cx - s * 0.2, cy - s * 0.4], [cx - s * 0.2, cy + s * 0.4], [cx + s * 0.24, cy - s * 0.3]]) put(rc.circle(x, y, s * 0.2, opt(c, 2.4, { fill: c, fillStyle: "solid" })));
    },
    link(cx, cy, s, c) {
      put(rc.path(rr(cx - s * 0.5, cy - s * 0.14, s * 0.56, s * 0.28, s * 0.14), opt(c, 3)));
      put(rc.path(rr(cx - s * 0.06, cy - s * 0.14, s * 0.56, s * 0.28, s * 0.14), opt(C.ink, 3)));
    },
    warn(cx, cy, s, c) {
      put(rc.polygon([[cx, cy - s * 0.45], [cx + s * 0.52, cy + s * 0.42], [cx - s * 0.52, cy + s * 0.42]], opt(c, 2.6, hatch(c))));
      put(rc.line(cx, cy - s * 0.12, cx, cy + s * 0.14, opt(C.red, 3.6)));
      put(rc.line(cx, cy + s * 0.26, cx, cy + s * 0.28, opt(C.red, 4)));
    },
    check(cx, cy, s, c) { put(rc.linearPath([[cx - s * 0.42, cy], [cx - s * 0.1, cy + s * 0.32], [cx + s * 0.48, cy - s * 0.4]], opt(c, 5, { roughness: 0.5 }))); },
    cross(cx, cy, s) { put(rc.line(cx - s * 0.36, cy - s * 0.36, cx + s * 0.36, cy + s * 0.36, opt(C.red, 4.4))); put(rc.line(cx + s * 0.36, cy - s * 0.36, cx - s * 0.36, cy + s * 0.36, opt(C.red, 4.4))); },
    bulb(cx, cy, s, c) {
      put(rc.circle(cx, cy - s * 0.1, s * 0.66, opt(c, 2.6, hatch(C.bulb))));
      put(rc.line(cx - s * 0.15, cy + s * 0.3, cx + s * 0.15, cy + s * 0.3, opt(c, 2.6)));
      put(rc.line(cx - s * 0.11, cy + s * 0.42, cx + s * 0.11, cy + s * 0.42, opt(c, 2.6)));
      for (const a of [-2.4, -1.57, -0.74]) put(rc.line(cx + Math.cos(a) * s * 0.46, cy - s * 0.1 + Math.sin(a) * s * 0.46, cx + Math.cos(a) * s * 0.62, cy - s * 0.1 + Math.sin(a) * s * 0.62, opt(C.bulb, 2.6)));
    },
  };

  // 글 한 줄에 강조 표시를 얹는다. 형광펜은 글 뒤(back 층)에 깐다
  function mark(el, kind) {
    const b = el.getBBox();
    if (kind === "underline") put(rc.line(b.x - 2, b.y + b.height + 2, b.x + b.width + 6, b.y + b.height, opt(C.red, 3.4)));
    if (kind === "circle") put(rc.ellipse(b.x + b.width / 2, b.y + b.height / 2, b.width + 46, b.height + 30, opt(C.red, 3, { roughness: 1 })));
    if (kind === "box") put(rc.rectangle(b.x - 10, b.y - 6, b.width + 20, b.height + 12, opt(C.red, 2.8)));
    if (kind === "highlight") {
      const g = rc.line(b.x - 6, b.y + b.height * 0.6, b.x + b.width + 6, b.y + b.height * 0.57, opt(C.hl, b.height * 0.72, { roughness: 0.4, bowing: 0.2 }));
      g.setAttribute("class", "hl");
      g.setAttribute("opacity", "0.75");
      put(g, "back");
    }
  }

  // 흐름 칸: 줄마다 상자·마름모·말풍선으로 그리고 아래로 잇는다
  function flowPart(x, w, y, lines, color) {
    const cx = x + w / 2, size = 28, lh = size * 1.15;
    lines.forEach((raw, i) => {
      const l = line(raw), shape = l.shape || "box";
      const rows = wrap(l.t, size, w - (shape === "diamond" ? 150 : 70), true);
      const tw = Math.max(...rows.map((r) => width(r, size, true)));
      const h = shape === "diamond" ? rows.length * lh + 48 : rows.length * lh + 24;
      const bw = shape === "diamond" ? tw + 110 : shape === "bubble" ? tw + 60 : tw + 40;
      if (i > 0) {
        arrow(cx, y - 34, cx, y - 5, 3, color);
        if (l.via) text(cx + 14, y - 12, l.via, { size: 24, bold: true, color: C.red });
      }
      if (shape === "diamond") put(rc.polygon([[cx, y], [cx + bw / 2, y + h / 2], [cx, y + h], [cx - bw / 2, y + h / 2]], opt(C.ink, 2.4)));
      else if (shape === "bubble") {
        put(rc.ellipse(cx, y + h / 2, bw, h, opt(C.ink, 2.4)));
        put(rc.linearPath([[cx - bw * 0.3, y + h * 0.84], [cx - bw * 0.4, y + h + 16], [cx - bw * 0.15, y + h * 0.96]], opt(C.ink, 2.4)));
      } else put(rc.path(rr(cx - bw / 2, y, bw, h, 10), opt(C.ink, 2.4)));
      let last;
      rows.forEach((r, k) => { last = text(cx, y + h / 2 - ((rows.length - 1) * lh) / 2 + k * lh + size * 0.32, r, { size, bold: true, color: l.em ? C.red : C.ink, anchor: "middle" }); });
      if (l.mark === "circle") put(rc.ellipse(cx, y + h / 2, bw + 40, h + 30, opt(C.red, 3, { roughness: 1 })));
      else if (l.mark) mark(last, l.mark);
      y += h + 40;
    });
  }

  // 칸 하나: 색 둥근 상자, 모서리 번호, 머리와 밑줄, 아이콘·줄(가운데로 옮기고 넘치면 줄임), 바닥 메모
  function drawPart(p, i, x, y, w, h, color) {
    put(rc.path(rr(x, y, w, h, 20), opt(color, 3.2)));
    if (p.mark === "pick") {
      put(rc.path(rr(x - 9, y - 9, w + 18, h + 18, 26), opt(C.red, 2.8, { roughness: 0.9 })));
      ICONS.check(x + w - 92, y - 22, 30, C.red);
      text(x + w - 12, y - 12, "고름", { size: 30, bold: true, color: C.red, anchor: "end" });
    }
    badge(x + 6, y + 6, 20, String(i + 1), color);

    let hy = y + 50, headEl = null;
    for (const r of wrap(p.head, 34, w - 64, true)) { headEl = text(x + w / 2, hy, r, { size: 34, bold: true, color, anchor: "middle" }); hy += 36; }
    if (headEl) {
      const hb = headEl.getBBox();
      put(rc.line(hb.x + 6, hb.y + hb.height + 2, hb.x + hb.width - 6, hb.y + hb.height + 1, opt(color, 2.4)));
    }

    const noteRows = p.note ? wrap(p.note, 23, w - 30) : [], noteLh = 26;
    noteRows.forEach((r, k) => text(x + w / 2, y + h - 16 - (noteRows.length - 1 - k) * noteLh, r, { size: 23, color: C.mut, anchor: "middle" }));
    const availTop = hy, availBottom = y + h - 18 - noteRows.length * noteLh - 6;

    const pg = group(), pb = group(), pf = group();
    pg.append(pb, pf);
    front.append(pg);
    curBack = pb;
    curFront = pf;
    let cy = 0;
    if (p.icon && ICONS[p.icon]) { ICONS[p.icon](x + w / 2, cy + 40, 76, color); cy += 96; }
    if (p.flow) flowPart(x, w, cy, p.lines || [], color);
    else for (const raw of p.lines || []) {
      const l = line(raw), size = 30;
      let last;
      for (const r of wrap(l.t, size, w - 36, l.em)) { last = text(x + w / 2, cy + size * 0.85, r, { size, bold: !!l.em, color: l.em ? C.red : C.ink, anchor: "middle" }); cy += size * 1.3; }
      if (l.mark && last) mark(last, l.mark);
    }
    curBack = back;
    curFront = front;
    if (!pf.childNodes.length) return;
    const bb = pg.getBBox(), availH = Math.max(10, availBottom - availTop);
    const s = Math.min(1, availH / bb.height, (w - 12) / bb.width), mx = x + w / 2;
    pg.setAttribute("transform", `translate(${mx} ${availTop + (availH - bb.height * s) / 2}) scale(${s}) translate(${-mx} ${-bb.y})`);
  }

  // 노란 포스트잇: 살짝 기울이고 그림자를 깐다. 높이는 글에 맞추되 주어진 자리를 넘지 않는다
  function drawMemo(x, y, w, h, m) {
    const rows = m.lines.flatMap((l) => wrap(line(l).t, 27, w - 40));
    h = Math.min(h, 30 + (m.head ? 44 : 0) + rows.length * 33 + 16);
    const g = group();
    g.setAttribute("transform", `rotate(-1.4 ${x + w / 2} ${y + h / 2})`);
    front.append(g);
    curFront = g;
    put(rc.rectangle(x + 6, y + 7, w, h, { fill: "#00000012", fillStyle: "solid", stroke: "none", roughness: 0.3, seed: ++seed }));
    put(rc.rectangle(x, y, w, h, opt(C.memoEdge, 1.6, { fill: C.memo, fillStyle: "solid", roughness: 0.4 })));
    let ty = y + 42;
    if (m.head) {
      const t = text(x + 20, ty, m.head, { size: 31, bold: true });
      const b = t.getBBox();
      put(rc.line(b.x, b.y + b.height + 1, b.x + b.width, b.y + b.height, opt(C.ink, 2)));
      ty += 44;
    }
    for (const r of rows) { if (ty > y + h) break; text(x + 20, ty, r, { size: 27 }); ty += 33; }
    curFront = front;
  }

  // 비유 칸: 「이를테면…」 머리와 전구
  function drawLike(x, y, w, h, l) {
    put(rc.path(rr(x, y, w, h, 16), opt(C.ink, 2.4)));
    text(x + 22, y + 44, "이를테면…", { size: 32, bold: true });
    ICONS.bulb(x + w - 40, y + 38, 44, C.ink);
    let ty = y + 92;
    for (const raw of l.lines) for (const r of wrap(line(raw).t, 28, w - 44)) { if (ty > y + h - 8) return; text(x + 22, ty, r, { size: 28 }); ty += 36; }
  }

  // 정리: 머리표가 달린 상자, 글은 세로 가운데. 세 줄을 넘으면 글자를 줄인다
  function drawSummary(x, y, w, h, s) {
    put(rc.path(rr(x, y, w, h, 16), opt(C.ink, 3)));
    put(rc.path(rr(x + 20, y - 20, 92, 40, 10), opt(C.ink, 2, { fill: C.ink, fillStyle: "solid", roughness: 0.4 })));
    text(x + 66, y + 10, "정리", { size: 30, bold: true, color: "#fff", anchor: "middle" });
    let size = 34, rows = wrap(s, size, w - 50, true);
    while ((rows.length > 3 || rows.length * size * 1.25 > h - 24) && size > 20) rows = wrap(s, --size, w - 50, true);
    const lh = size * 1.25, top = y + h / 2 - ((rows.length - 1) * lh) / 2 + size * 0.38;
    rows.forEach((r, k) => text(x + 26, top + k * lh, r, { size, bold: true }));
  }

  // 번호 단계: 단계마다 그 단계를 맡은 칸의 색. 길면 글자를 줄인다
  function drawSteps(x, y, w, steps, colorOf) {
    steps.forEach((raw, k) => {
      const l = line(raw), color = colorOf(l.by, k);
      badge(x + 22, y + 22, 21, String(k + 1), color);
      let size = 30;
      while (size > 20 && width(l.t, size) > w - 62) size--;
      const t = text(x + 56, y + 32, l.t, { size, color: l.em ? C.red : C.ink });
      const b = t.getBBox();
      put(rc.line(b.x, b.y + b.height + 1, b.x + b.width, b.y + b.height, opt(color, 2)));
      if (l.mark) mark(t, l.mark);
      y += 60;
    });
    return steps.length * 60;
  }

  // 화이트보드 테두리(알루미늄 틀)
  const frame = document.createElementNS(NS, "rect");
  for (const [k, v] of Object.entries({ x: 5, y: 5, width: TALK_W - 10, height: TALK_H - 10, rx: 10, fill: "#fdfdfb", stroke: C.frame, "stroke-width": 10 })) frame.setAttribute(k, v);
  back.append(frame);

  // 제목·부제, 오른쪽 위에 받은 시각
  const title = text(M + 10, 82, B.title, { size: 60, bold: true });
  put(rc.line(M + 4, 98, M + 16 + Math.min(title.getComputedTextLength(), TALK_W - 2 * M - 160), 95, opt(PALETTE[0], 4)));
  if (B.sub) text(M + 12, 138, B.sub, { size: 32 });
  const d = new Date(rec.t);
  text(TALK_W - M - 8, 64, `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`, { size: 26, color: C.mut, anchor: "end" });

  const parts = B.parts || [], steps = B.steps || [], rest = B.memo || B.like || B.summary;
  const top = B.sub ? 176 : 132, n = Math.max(1, parts.length);
  const partsH = steps.length ? 190 : rest ? 372 : TALK_H - M - top;
  const gap = (B.arrows || []).length ? 82 : 36, colW = (TALK_W - 2 * M - gap * (n - 1)) / n;
  const box = new Map();
  parts.forEach((p, i) => {
    const x = M + i * (colW + gap), color = PALETTE[i % PALETTE.length];
    box.set(p.id, { x, w: colW, color });
    drawPart(p, i, x, top, colW, partsH, color);
  });

  // 칸 사이 화살표와 그 위의 말: 출발 칸의 색
  const midY = top + partsH * 0.5;
  for (const a of B.arrows || []) {
    const s = box.get(a.from), t = box.get(a.to);
    if (!s || !t) continue;
    const ltr = s.x < t.x, x1 = ltr ? s.x + s.w + 8 : s.x - 8, x2 = ltr ? t.x - 8 : t.x + t.w + 8;
    arrow(x1, midY, x2, midY, ltr ? -14 : 14, s.color, a.dash);
    if (a.label) text((x1 + x2) / 2, midY - 26, a.label, { size: 28, bold: true, color: s.color, anchor: "middle" });
  }

  let y = top + partsH + 44;
  const colorOf = (by, k) => box.get(by)?.color || PALETTE[k % PALETTE.length];
  if (steps.length) {
    const side = B.memo ? 360 : 0;
    const used = drawSteps(M + 4, y, TALK_W - 2 * M - side - 30, steps, colorOf);
    if (B.memo) drawMemo(TALK_W - M - side + 6, y - 4, side - 10, used + 4, B.memo);
    y += used + 30;
    if (B.summary && TALK_H - M - y > 60) drawSummary(M, y, TALK_W - 2 * M, TALK_H - M - y, B.summary);
  } else if (rest) {
    const bh = TALK_H - M - 6 - y;
    let x = M;
    if (B.memo) { drawMemo(x + 4, y, 330, bh, B.memo); x += 364; }
    if (B.like) { const lw = B.summary ? 520 : TALK_W - M - x; drawLike(x, y, lw, bh, B.like); x += lw + 34; }
    if (B.summary) drawSummary(x, y, TALK_W - M - x, bh, B.summary);
  }
  svg.setAttribute("aria-label", talkText(rec));
}

// 화면 읽기 프로그램과 찾기용: 장의 글을 읽는 순서대로 한 줄로
export function talkText(rec) {
  const B = rec.page, out = [B.title, B.sub];
  const headOf = (id) => (B.parts || []).find((p) => p.id === id)?.head || id;
  (B.parts || []).forEach((p, i) => out.push(`${i + 1}. ${p.head}${p.mark === "pick" ? "(고름)" : ""}`, ...(p.lines || []).map((l) => line(l).t), p.note));
  for (const a of B.arrows || []) if (a.label) out.push(`${headOf(a.from)} → ${headOf(a.to)}: ${a.label}`);
  (B.steps || []).forEach((s, i) => out.push(`단계 ${i + 1}. ${line(s).t}`));
  if (B.memo) out.push(B.memo.head, ...B.memo.lines);
  if (B.like) out.push("이를테면", ...B.like.lines);
  if (B.summary) out.push(`정리: ${B.summary}`);
  return "판서: " + out.filter(Boolean).join(" · ");
}
