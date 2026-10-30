// 문서 보기 시험: 세션 기록에 나온 md·html 목록, 문서 주소(/doc/<열쇠>/…)의 범위 검사와 응답 머리, 고정·숨김
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { boardFixture } from "./helpers.js";

function boardHeaders(f) {
  const host = `127.0.0.1:${f.port}`;
  return { "content-type": "application/json", origin: `http://${host}`, "x-atv-board": f.keys().board, cookie: `atv_r=${f.keys().read}` };
}
const board = (f, body) => f.request("POST", "/api/board", { headers: boardHeaders(f), body });

// 저장소 하나(.git)와 그 밖의 폴더를 만든다
function makeRepo(f) {
  const repo = path.join(f.dir, "repo"), out = path.join(f.dir, "outside");
  for (const d of [path.join(repo, ".git"), path.join(repo, "docs"), path.join(repo, "notes"), out]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(repo, "docs", "a.md"), "up: [index](../index.md)\n\n# 제목 A\n\n본문\n");
  fs.writeFileSync(path.join(repo, "docs", "b.html"), "<!doctype html><title>B 페이지</title><p>b</p>");
  fs.writeFileSync(path.join(repo, "notes", "d.md"), "# D\n");
  fs.writeFileSync(path.join(repo, "index.md"), "# 목차\n");
  fs.writeFileSync(path.join(repo, "docs", "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(repo, "docs", "app.js"), "alert(1)");
  fs.writeFileSync(path.join(repo, "src.js"), "x");
  fs.writeFileSync(path.join(out, "secret.md"), "# 밖\n");
  fs.symlinkSync(path.join(out, "secret.md"), path.join(repo, "docs", "link.md"));
  fs.writeFileSync(path.join(repo, ".env"), "SECRET=1\n");
  fs.symlinkSync(path.join(repo, ".env"), path.join(repo, "docs", "leak.md"));
  return { repo, out };
}

async function seed(f, repo, sid = "S1") {
  await f.hook(sid, { f: "start", cwd: repo, source: "startup" });
  await f.hook(sid, { f: "edit", tool: "Edit", path: path.join(repo, "docs", "b.html") });
  await f.hook(sid, { f: "edit", tool: "Write", path: "docs/a.md", create: true });
  await f.hook(sid, { f: "edit", tool: "Edit", path: path.join(repo, "src.js") });
  await f.hook(sid, { f: "edit", tool: "Write", path: path.join(repo, "gone.md"), create: true });
  await f.mcp("draw", { ops: [{ id: "b", kind: "box", label: "메모", ref: "notes/d.md:3" }] }, { env: sid });
}

test("문서 목록: 수정·그림 ref 의 md·html 만, 순서는 중요 문서(그림·이름) → 새로 만듦 → 최근 고침 → 없어진 파일, 제목·상태", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  const { repo } = makeRepo(f);
  await seed(f, repo);
  assert.equal((await f.request("GET", "/api/docs?id=S1")).status, 401, "읽기 토큰 없이는 목록을 주지 않는다");
  const r = await f.read("/api/docs?id=S1");
  assert.equal(r.status, 200);
  const docs = r.json.docs;
  assert.deepEqual(docs.map((d) => path.relative(repo, d.path)), ["notes/d.md", "docs/a.md", "docs/b.html", "gone.md"]);
  const [d, a, b, gone] = docs;
  assert.deepEqual(docs.map((x) => x.main), [true, false, false, false], "그림에 걸린 문서만 중요");
  assert.equal(a.title, "제목 A");
  assert.equal(a.kind, "md");
  assert.equal(a.created, true);
  assert.equal(b.title, "B 페이지");
  assert.equal(b.kind, "html");
  assert.equal(d.board, true);
  assert.equal(d.title, "D");
  assert.equal(gone.state, "missing");
  assert.equal(gone.url, undefined);
  // 이름·제목에 설계·계획 같은 말이 든 문서는 중요. 영어는 낱말일 때만(explanation 의 plan 은 아님)
  fs.writeFileSync(path.join(repo, "docs", "design-doc.md"), "# x\n");
  fs.writeFileSync(path.join(repo, "docs", "explanation.md"), "# 풀이\n");
  fs.writeFileSync(path.join(repo, "docs", "note.md"), "# 최종 설계서\n");
  for (const n of ["design-doc.md", "explanation.md", "note.md"]) await f.hook("S1", { f: "edit", tool: "Edit", path: path.join(repo, "docs", n) });
  const main = (await f.read("/api/docs?id=S1")).json.docs.filter((x) => x.main).map((x) => x.name).sort();
  assert.deepEqual(main, ["d.md", "design-doc.md", "note.md"]);
  assert.match(a.id, /^[0-9a-f]{16}$/);
  assert.match(a.url, /^\/doc\/[0-9a-f]{32}\/docs\/a\.md$/);
  assert.equal(new URL(a.url, "http://x").pathname.split("/")[2], new URL(b.url, "http://x").pathname.split("/")[2], "같은 저장소의 문서는 같은 열쇠");
  assert.equal((await f.read("/api/docs?id=NONE")).status, 404);
});

test("문서 주소: 열쇠·범위·확장자·링크·크기를 검사하고 html 은 격리 CSP 로 보낸다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  const { repo } = makeRepo(f);
  await seed(f, repo);
  const docs = (await f.read("/api/docs?id=S1")).json.docs;
  const a = docs.find((x) => x.path.endsWith("a.md")), b = docs.find((x) => x.path.endsWith("b.html"));
  const cap = a.url.split("/")[2], get = (p, headers = {}) => f.request("GET", p, { headers });
  // md: 쿠키 없이 열쇠만으로 읽는다(격리 틀은 쿠키를 보내지 못한다)
  const md = await get(a.url);
  assert.equal(md.status, 200);
  assert.match(md.text, /# 제목 A/);
  assert.match(md.headers["content-type"], /^text\/plain; charset=utf-8/);
  assert.equal(md.headers["cache-control"], "no-store");
  assert.equal(md.headers["x-content-type-options"], "nosniff");
  assert.match(md.headers["content-security-policy"], /^sandbox;/);
  // 목록에 없어도 같은 저장소 안의 문서·그림은 읽는다(링크 따라가기)
  assert.equal((await get(`/doc/${cap}/index.md`)).status, 200);
  const png = await get(`/doc/${cap}/docs/pic.png`);
  assert.equal(png.status, 200);
  assert.equal(png.headers["content-type"], "image/png");
  // html: 스크립트는 파일 안·CDN 만, 바깥 연결은 막고, 화판 안 iframe 으로만
  const html = await get(b.url);
  assert.equal(html.status, 200);
  assert.match(html.headers["content-type"], /^text\/html; charset=utf-8/);
  const csp = html.headers["content-security-policy"];
  assert.match(csp, /^sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox;/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /script-src 'unsafe-inline' https:\/\/cdnjs\.cloudflare\.com https:\/\/cdn\.jsdelivr\.net https:\/\/unpkg\.com/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.equal(html.headers["x-frame-options"], undefined);
  assert.equal(html.headers["cross-origin-resource-policy"], "cross-origin");
  assert.match(html.text, /<p>b<\/p><script>\/\* anytaskview \*\/[\s\S]*parent\.postMessage[\s\S]*<\/script>\n$/, "문서 링크·Esc 를 화판에 알리는 중계를 끝에 붙인다");
  // 거절: 모르는 열쇠, 열쇠 모양이 아님, .. , 링크로 저장소 밖, 받지 않는 확장자, 폴더, 없는 파일
  assert.equal((await get(`/doc/${"0".repeat(32)}/docs/a.md`)).status, 404);
  assert.equal((await get(`/doc/xyz/docs/a.md`)).status, 404);
  assert.equal((await get(`/doc/${cap}/docs/%2e%2e/%2e%2e/outside/secret.md`)).status, 400);
  assert.equal((await get(`/doc/${cap}/docs/..%2f..%2foutside%2fsecret.md`)).status, 400);
  assert.equal((await get(`/doc/${cap}/docs/link.md`)).status, 403, "링크가 저장소 밖을 가리킨다");
  assert.equal((await get(`/doc/${cap}/docs/leak.md`)).status, 404, "md 이름의 링크가 다른 종류의 파일(.env)을 가리킨다");
  assert.equal((await get(`/doc/${cap}/docs/app.js`)).status, 404);
  assert.equal((await get(`/doc/${cap}/docs`)).status, 404);
  assert.equal((await get(`/doc/${cap}/docs/none.md`)).status, 404);
  // 크기 상한(문서 2MiB)
  fs.writeFileSync(path.join(repo, "docs", "big.md"), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
  assert.equal((await get(`/doc/${cap}/docs/big.md`)).status, 413);
  // 저장소 안의 링크로 목록에 오른 문서가 저장소 밖을 가리키면 그 밖을 새 범위로 열지 않는다
  await f.hook("S1", { f: "edit", tool: "Edit", path: path.join(repo, "docs", "link.md") });
  const linked = (await f.read("/api/docs?id=S1")).json.docs.find((x) => x.path.endsWith("link.md"));
  assert.equal(linked.state, "bad");
  assert.equal(linked.url, undefined);
  // 저장소 밖 폴더의 문서는 그 문서가 목록에 오를 때까지 열쇠가 없다
  const caps = new Set((await f.read("/api/docs?id=S1")).json.docs.filter((x) => x.url).map((x) => x.url.split("/")[2]));
  assert.equal(caps.size, 1);
  // 화판 페이지는 iframe 을 같은 서버의 것만 연다
  assert.match((await f.read("/")).headers["content-security-policy"], /frame-src 'self'/);
});

test("문서 목록 범위: 이어진 대화 전체, 프로젝트에 들면 프로젝트의 모든 대화", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  const { repo } = makeRepo(f);
  await f.hook("T1", { f: "start", cwd: repo, source: "startup" }, { pid: 5001 });
  await f.hook("T1", { f: "edit", tool: "Edit", path: path.join(repo, "docs", "a.md") }, { pid: 5001 });
  await f.hook("T2", { f: "start", cwd: repo, source: "clear", prev: "T1" }, { pid: 5001 });
  await f.hook("T2", { f: "edit", tool: "Edit", path: path.join(repo, "index.md") }, { pid: 5001 });
  await f.hook("U1", { f: "start", cwd: repo, source: "startup" }, { pid: 5002 });
  await f.hook("U1", { f: "edit", tool: "Edit", path: path.join(repo, "notes", "d.md") }, { pid: 5002 });
  const names = async (id) => (await f.read(`/api/docs?id=${id}`)).json.docs.map((d) => path.relative(repo, d.path)).sort();
  assert.deepEqual(await names("T2"), ["docs/a.md", "index.md"]);
  assert.deepEqual(await names("T1"), ["docs/a.md", "index.md"]);
  assert.deepEqual(await names("U1"), ["notes/d.md"]);
  const P = JSON.parse((await board(f, { op: "proj-new", name: "문서" })).text).pid;
  await board(f, { op: "proj-set", sids: ["T1", "T2", "U1"], pid: P });
  assert.deepEqual(await names("U1"), ["docs/a.md", "index.md", "notes/d.md"]);
  assert.deepEqual(await names(P), ["docs/a.md", "index.md", "notes/d.md"], "프로젝트 화판에서도 같은 목록");
});

test("문서 고정·숨김: 화판 쓰기 열쇠로, 목록 맨 위·숨김 표시, 다시 띄워도 남는다", async (t) => {
  const f = await boardFixture();
  t.after(() => f.close());
  const { repo } = makeRepo(f);
  await seed(f, repo);
  const list = async () => (await f.read("/api/docs?id=S1")).json.docs;
  const b = (await list()).find((x) => x.path.endsWith("b.html"));
  const op = { op: "doc-mark", id: "S1", doc: b.id, pin: true };
  assert.equal((await f.request("POST", "/api/board", { headers: { ...boardHeaders(f), "x-atv-board": "1" }, body: op })).status, 403);
  assert.equal((await board(f, { ...op, doc: "0123456789abcdef" })).status, 400, "목록에 없는 문서");
  assert.equal((await board(f, op)).status, 200);
  let docs = await list();
  assert.equal(docs[0].id, b.id);
  assert.equal(docs[0].pin, true);
  const a = docs.find((x) => x.path.endsWith("a.md"));
  await board(f, { op: "doc-mark", id: "S1", doc: a.id, hide: true });
  docs = await list();
  assert.equal(docs.find((x) => x.id === a.id).hidden, true);
  await f.restart();
  docs = await list();
  assert.equal(docs[0].id, b.id, "다시 띄워도 고정이 남는다");
  assert.equal(docs.find((x) => x.id === a.id).hidden, true);
  await board(f, { op: "doc-mark", id: "S1", doc: b.id, pin: false });
  assert.equal((await list()).find((x) => x.id === b.id).pin, false);
});
