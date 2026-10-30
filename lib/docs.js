// 문서 보기: 세션 기록(수정 사실·그림 ref)에 나온 md·html 을 모으고, 그 문서와 같은 저장소 안의 문서·그림만 읽어 준다.
// 주소에는 경로 대신 서버가 뿌리(저장소 최상위, 저장소가 아니면 문서 폴더)마다 만든 열쇠를 쓴다: /doc/<열쇠>/<뿌리 아래 경로>.
// html 은 화판과 출처가 다른 격리 틀(sandbox iframe)에서 열리고 그 틀은 쿠키를 보내지 못하므로, 열쇠가 읽기 권한이다.
// 열쇠는 쿠키로 읽기를 확인한 목록 API 로만 나가고, 서버를 다시 띄우면 바뀐다
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { normPath, refPath } from "./scene.js";

export const DOC_RE = /\.(md|markdown|html?)$/i;
export const DOC_MAX = 2 * 1024 * 1024, IMG_MAX = 10 * 1024 * 1024;
export const LIST_MAX = 200;
const HEAD_BYTES = 8192; // 제목은 파일 앞부분에서만 찾는다
const MARKS_MAX = 200; // 범위마다 기억하는 고정·숨김 수
const CAP_RE = /^[0-9a-f]{32}$/;
// 「중요 문서」 로 치는 이름·제목: 계획서·설계서·매뉴얼 같은 대표 문서. 영어 낱말은 앞뒤가 글자가 아니어야 한다(explanation 의 plan 은 아님)
const MAIN_RE = /설계|계획|기획|매뉴얼|메뉴얼|사용법|가이드|명세|(^|[^a-z])(design|plan|planning|spec|manual|guide|readme|architecture|roadmap)s?([^a-z]|$)/i;
const TYPES = {
  md: "text/plain; charset=utf-8", markdown: "text/plain; charset=utf-8",
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
};
const extOf = (p) => (/\.([A-Za-z0-9]+)$/.exec(p)?.[1] || "").toLowerCase();
const isImg = (ext) => TYPES[ext]?.startsWith("image/");
// html 은 파일 안 스크립트와 알려진 CDN(사용자 결정 2026-10-30)만 돌고, 바깥·로컬 서버로 요청을 보내지 못한다
const CDN = "https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com";
export const HTML_CSP = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src 'none'; " +
  `script-src 'unsafe-inline' ${CDN}; style-src 'unsafe-inline' ${CDN} https://fonts.googleapis.com; font-src data: ${CDN} https://fonts.gstatic.com; ` +
  `img-src 'self' data: blob: ${CDN}; media-src 'self' data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'`;
// html 끝에 붙이는 중계: 같은 서버의 문서 링크와 Esc 를 화판(부모)에 알린다. 격리 틀은 화판에 닿지 못하므로
// 화판이 이 알림을 받아 문서 창 안에서 연다(같은 열쇠 아래의 문서인지는 화판이 다시 본다)
const RELAY = Buffer.from(`<script>/* anytaskview */(function(){var D=/\\.(md|markdown|html?)$/i;
document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a"):null;if(!a||e.defaultPrevented)return;
var h=a.getAttribute("href")||a.getAttributeNS("http://www.w3.org/1999/xlink","href");if(!h||h.charAt(0)==="#")return;var u;try{u=new URL(h,location.href)}catch(x){return}
if(u.host!==location.host||!D.test(u.pathname))return;e.preventDefault();parent.postMessage({atv:"open",path:u.pathname,hash:u.hash},"*")},true);
document.addEventListener("keydown",function(e){if(e.key==="Escape")parent.postMessage({atv:"esc"},"*")})})();</script>\n`);
// md 원문·그림: 바로 열어도 아무것도 돌지 않는다
export const FILE_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'";

// 세션 장면들에서 문서 후보: 절대 경로 → { path, created, board, t(마지막으로 고친 시각) }
export function collectDocs(scenes) {
  const out = new Map();
  const put = (p, patch) => {
    if (!DOC_RE.test(p)) return;
    const d = out.get(p) || { path: p, created: false, board: false, t: 0 };
    if (patch.created) d.created = true;
    if (patch.board) d.board = true;
    if (patch.t > d.t) d.t = patch.t;
    out.set(p, d);
  };
  for (const sc of scenes) {
    const cwd = sc.meta.cwd;
    for (const e of sc.timeline) if (e.type === "fact" && e.f === "edit" && e.path) put(normPath(e.path, cwd), { created: e.create === true, t: e.t || 0 });
    for (const it of Object.values(sc.items)) if (it.kind !== "step" && typeof it.ref === "string" && it.ref) put(normPath(refPath(it.ref), cwd), { board: true });
  }
  return out;
}

// 폴더에서 위로 올라가며 .git 이 있는 첫 폴더(작업 트리면 그 작업 트리). 없으면 null
function gitTop(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".git"))) return d;
    if (d === path.dirname(d)) return null;
  }
}

function titleOf(head, kind) {
  if (kind === "html") return (/<title[^>]*>([^<]{1,200})<\/title>/i.exec(head)?.[1] || "").trim();
  let fence = false;
  for (const line of head.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    else if (!fence) { const m = /^#{1,2}\s+(.+?)\s*#*\s*$/.exec(line); if (m) return m[1].slice(0, 200); }
  }
  return "";
}

export function createDocs({ home, secret }) {
  const caps = new Map(), capOf = new Map(); // 열쇠 → 뿌리, 뿌리 → 열쇠
  const heads = new Map(); // 실제 경로 → { mtimeMs, size, title } (시각·크기가 바뀔 때만 다시 읽는다)
  const marksFile = path.join(home, "docs.json");
  let marks = {};
  try { const m = JSON.parse(fs.readFileSync(marksFile, "utf8")); if (m && typeof m.scopes === "object") marks = m.scopes; } catch { /* 없거나 깨졌으면 빈 것 */ }
  let chain = Promise.resolve();

  const docId = (p) => crypto.createHmac("sha256", secret).update(p).digest("hex").slice(0, 16);
  const capFor = (root) => {
    if (!capOf.has(root)) { const c = crypto.randomBytes(16).toString("hex"); capOf.set(root, c); caps.set(c, root); }
    return capOf.get(root);
  };
  const urlOf = (root, real) => `/doc/${capFor(root)}/${path.relative(root, real).split(path.sep).map(encodeURIComponent).join("/")}`;

  async function describe(p) {
    const kind = /\.html?$/i.test(p) ? "html" : "md";
    let real, st;
    try { real = await fsp.realpath(p); st = await fsp.stat(real); }
    catch (e) { return { kind, state: e.code === "ENOENT" || e.code === "ENOTDIR" ? "missing" : "bad" }; }
    if (!st.isFile() || !DOC_RE.test(real)) return { kind, state: "bad" };
    // 뿌리는 링크를 풀기 전의 자리에서 찾는다. 저장소 안의 링크가 밖을 가리키면 그 밖을 새 범위로 열지 않는다
    let root;
    try { root = await fsp.realpath(gitTop(path.dirname(p)) || path.dirname(p)); } catch { return { kind, state: "bad" }; }
    if (!real.startsWith(root + path.sep)) return { kind, state: "bad" };
    const out = { kind, url: urlOf(root, real), mtime: Math.floor(st.mtimeMs), size: st.size, state: st.size > DOC_MAX ? "big" : "ok" };
    let h = heads.get(real);
    if (!h || h.mtimeMs !== st.mtimeMs || h.size !== st.size) {
      let title = "";
      try {
        const fd = await fsp.open(real, "r");
        try {
          const { buffer, bytesRead } = await fd.read(Buffer.alloc(HEAD_BYTES), 0, HEAD_BYTES, 0);
          title = titleOf(buffer.subarray(0, bytesRead).toString("utf8").replace(/�+$/, ""), kind);
        } finally { await fd.close(); }
      } catch { out.state = "bad"; }
      h = { mtimeMs: st.mtimeMs, size: st.size, title };
      heads.set(real, h);
      if (heads.size > 2000) heads.delete(heads.keys().next().value);
    }
    out.title = h.title;
    return out;
  }

  // 목록: 고정 → 중요 문서 → 새로 만듦 → 나머지 → 없어진 파일, 같은 묶음 안에서는 최근 것부터. 숨긴 문서는 표시만 달고 남긴다(되살리기).
  // 중요 문서(main)는 고정·그림에 걸림·이름이나 제목이 MAIN_RE 인 것으로, 화면의 탭이 기본으로 보이는 것이다
  async function list(key, scenes) {
    const found = collectDocs(scenes), m = marks[key] || {};
    const rows = await Promise.all([...found.values()].map(async (d) => {
      const id = docId(d.path);
      const r = { id, path: d.path, name: path.basename(d.path), dir: path.dirname(d.path).split("/").filter(Boolean).slice(-2).join("/"), created: d.created, board: d.board, t: d.t, pin: !!m.pin?.[d.path], hidden: !!m.hide?.[d.path], ...(await describe(d.path)) };
      r.main = r.pin || r.board || MAIN_RE.test(r.name.replace(DOC_RE, "")) || MAIN_RE.test(r.title || "");
      return r;
    }));
    const rank = (r) => (r.pin ? 0 : r.state === "missing" ? 4 : r.main ? 1 : r.created ? 2 : 3); // 없어진 파일은 맨 아래
    rows.sort((a, b) => rank(a) - rank(b) || (a.pin && b.pin ? m.pin[b.path] - m.pin[a.path] : 0) || (b.t || b.mtime || 0) - (a.t || a.mtime || 0) || a.path.localeCompare(b.path));
    return { key, docs: rows.slice(0, LIST_MAX), total: rows.length };
  }

  // 고정·숨김 바꾸기: 목록에 있는 문서(id)만. which 는 "pin" 또는 "hide"
  function mark(key, scenes, id, which, on) {
    const p = [...collectDocs(scenes).keys()].find((x) => docId(x) === id);
    if (!p) return Promise.resolve({ ok: false, msg: "목록에 없는 문서" });
    const job = chain.then(async () => {
      const m = (marks[key] ||= {}), set = (m[which] ||= {});
      if (on) set[p] = Date.now(); else delete set[p];
      const keys = Object.keys(set);
      if (keys.length > MARKS_MAX) for (const k of keys.sort((a, b) => set[a] - set[b]).slice(0, keys.length - MARKS_MAX)) delete set[k];
      const tmp = `${marksFile}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify({ v: 1, scopes: marks }) + "\n", { mode: 0o600 });
      await fsp.rename(tmp, marksFile);
      return { ok: true, msg: `${path.basename(p)} ${which === "pin" ? (on ? "고정" : "고정 풂") : on ? "숨김" : "되살림"}` };
    });
    chain = job.catch(() => {});
    return job;
  }

  // GET /doc/<열쇠>/<경로>: [상태, 머리, 몸통] 또는 [상태, 글]
  async function serve(rest) {
    const [cap, ...raw] = rest.split("/");
    if (!CAP_RE.test(cap) || !caps.has(cap)) return [404, "없음"];
    const root = caps.get(cap);
    let segs;
    try { segs = raw.map(decodeURIComponent); } catch { return [400, "주소가 깨졌습니다"]; }
    if (!segs.length || segs.some((s) => !s || s === "." || s === ".." || /[\/\\\0]/.test(s))) return [400, "경로가 맞지 않습니다"];
    const ext = extOf(segs.at(-1));
    if (!TYPES[ext]) return [404, "없음"];
    let real, st;
    try { real = await fsp.realpath(path.join(root, ...segs)); st = await fsp.stat(real); } catch { return [404, "없음"]; }
    if (real !== root && !real.startsWith(root + path.sep)) return [403, "이 문서의 저장소 밖입니다"];
    if (!st.isFile()) return [404, "없음"];
    // 링크가 가리키는 실제 파일의 확장자도 본다(docs/x.md → ../.env 같은 링크로 다른 파일을 읽지 못하게)
    const rext = extOf(real);
    if (!TYPES[rext] || isImg(rext) !== isImg(ext)) return [404, "없음"];
    if (st.size > (isImg(rext) ? IMG_MAX : DOC_MAX)) return [413, "파일이 너무 큽니다"];
    const html = /^html?$/.test(rext);
    let body = await fsp.readFile(real);
    if (html) body = Buffer.concat([body, RELAY]);
    return [200, {
      "content-type": TYPES[rext], "content-length": body.length, "cache-control": "no-store",
      "content-security-policy": html ? HTML_CSP : FILE_CSP,
      // 격리 틀(출처 없음) 안의 그림도 받게 한다. 열쇠가 없으면 주소를 알 수 없다
      "cross-origin-resource-policy": "cross-origin",
      "x-atv-mtime": String(Math.floor(st.mtimeMs)),
    }, body];
  }

  return { list, mark, serve, docId };
}
