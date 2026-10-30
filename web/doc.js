// 문서 창의 md 그리기: markdown-it 로 그리고 DOMPurify 로 정화한다. 두 라이브러리는 문서를 처음 열 때 불러온다.
// 맨 위 블록마다 원문 줄 범위(data-line·data-line-end, 1부터)를 남겨 ref 줄로 옮겨 가기와 바뀐 문단 표시에 쓴다.
// mermaid 덩어리는 그림(canvas.js)이 쓰는 Mermaid(strict)로 그린다

let libs = null;
const loadScript = (src) => new Promise((ok, no) => {
  const s = document.createElement("script");
  s.src = src;
  s.onload = () => ok();
  s.onerror = () => { s.remove(); no(new Error(`${src} 를 불러오지 못했습니다`)); };
  document.head.append(s);
});
const loadLibs = () => (libs ||= Promise.all([loadScript("/vendor/markdown-it.js"), loadScript("/vendor/purify.js")]).then(() => {
  const md = window.markdownit({ html: true, linkify: true });
  md.core.ruler.push("atv_lines", (st) => {
    for (const t of st.tokens) if (t.map && t.level === 0 && t.nesting >= 0) { t.attrSet("data-line", String(t.map[0] + 1)); t.attrSet("data-line-end", String(t.map[1])); }
  });
  const fence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, i, opt, env, self) => {
    const t = tokens[i];
    if (t.info.trim().split(/\s+/)[0] !== "mermaid") return fence(tokens, i, opt, env, self);
    return `<div class="mmd" data-line="${t.attrGet("data-line")}" data-line-end="${t.attrGet("data-line-end")}"><pre>${md.utils.escapeHtml(t.content)}</pre></div>`;
  };
  // md 원시 HTML 의 class 는 버린다(화판의 .part 같은 이름이 본문을 화판 모양으로 바꾸지 않게). 코드 덩어리 언어와 mermaid 표시만 남긴다
  window.DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
    if (data.attrName === "class") data.attrValue = data.attrValue.split(/\s+/).filter((c) => /^(language-[\w-]+|mmd)$/.test(c)).join(" ");
  });
  return md;
}).catch((e) => { libs = null; throw e; }));

// md 안의 원시 HTML 은 정화한 뒤 남긴다. 화판을 덮거나 바꿀 수 있는 것(스타일·폼·틀)은 지우고,
// id·name 에는 앞말을 붙여 화판 요소의 id 와 겹치지 않게 한다(getElementById 가 문서 안 요소를 잡지 않게)
const PURIFY = {
  ALLOW_DATA_ATTR: false, ADD_ATTR: ["data-line", "data-line-end"], SANITIZE_NAMED_PROPS: true,
  FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "iframe", "object", "embed", "link", "meta", "base", "dialog"], FORBID_ATTR: ["style"],
};

// GitHub 와 같은 모양의 제목 앵커(#제목-이름)
const slug = (s) => s.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");

// text 를 article 에 그린다. docUrl 은 이 문서의 주소(/doc/<열쇠>/…): 상대 경로의 그림을 이 주소 기준으로 바꾼다.
// 돌려주는 것: 목차에 쓸 제목들 [{ el, level, text }]
export async function renderMd(article, text, { docUrl, mermaidSvg }) {
  const md = await loadLibs();
  article.innerHTML = window.DOMPurify.sanitize(md.render(text), PURIFY);
  const base = new URL(docUrl, location.origin), scope = base.pathname.split("/").slice(0, 3).join("/") + "/";
  for (const img of article.querySelectorAll("img")) {
    const src = img.getAttribute("src") || "";
    let u = null;
    try { u = new URL(src, base); } catch { /* 아래에서 대체 글로 */ }
    if (u && u.origin === location.origin && u.pathname.startsWith(scope)) { img.src = u.pathname; img.loading = "lazy"; continue; }
    // 바깥 그림은 화판 CSP 가 막는다: 대체 글만 남긴다
    img.replaceWith(Object.assign(document.createElement("span"), { className: "img-alt", textContent: `[그림: ${img.alt || src}]` }));
  }
  const heads = [], seen = new Map();
  for (const h of article.querySelectorAll("h1, h2, h3, h4")) {
    const s = slug(h.textContent), n = seen.get(s) || 0;
    seen.set(s, n + 1);
    h.dataset.slug = n ? `${s}-${n}` : s;
    if (h.matches("h1, h2, h3")) heads.push({ el: h, level: Number(h.tagName[1]), text: h.textContent });
  }
  for (const box of article.querySelectorAll(".mmd")) {
    const r = await mermaidSvg(box.textContent);
    if (r.svg) {
      box.innerHTML = r.svg;
      for (const a of box.querySelectorAll("a")) a.replaceWith(...a.childNodes); // click 링크는 벗긴다(그림과 같이)
      continue;
    }
    box.classList.add("err");
    box.append(Object.assign(document.createElement("p"), { className: "dnote", textContent: `Mermaid 그림을 그리지 못했습니다: ${r.error}` }));
  }
  return heads;
}

// diff 글(「@@ -a,b +c,d @@」 덩어리)에서 새 파일 기준으로 바뀐 줄 번호. 지운 줄은 그 자리의 다음 줄로 친다.
// 줄 번호가 없는 덩어리(Codex 의 「@@」)는 알 수 없으므로 null
export function changedLines(diff) {
  const out = new Set();
  let n = 1;
  for (const l of String(diff || "").split("\n")) {
    if (l.startsWith("@@")) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
      if (!m) return null;
      n = Math.max(1, Number(m[1]));
    } else if (l[0] === "+") out.add(n++);
    else if (l[0] === "-") out.add(n);
    else n++;
  }
  return out;
}

// 줄 번호들에 걸린 맨 위 블록들. 코드 덩어리는 markdown-it 가 줄 범위를 안쪽 <code> 에 단다
export function blocksAt(article, lines) {
  const out = [];
  for (const m of article.querySelectorAll(":scope > [data-line], :scope > pre > code[data-line]")) {
    const from = Number(m.dataset.line), to = Number(m.dataset.lineEnd) || from;
    for (const n of lines) if (n >= from && n <= to) { out.push(m.parentElement === article ? m : m.parentElement); break; }
  }
  return out;
}
