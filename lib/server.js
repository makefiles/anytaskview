// 화판 서버: MCP·훅에서 명령과 사실을 받아 세션마다 장면을 바꾸고, 기록하고, 브라우저에 SSE 로 보낸다.
// 127.0.0.1 에만 묶는다. 쓰기는 쓰기 열쇠(헤더), 읽기는 읽기 토큰(쿠키)이 맞아야 받는다.
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { newScene, applyRes, own, evalPlan, evalDraw, evalNote, evalFact, idsLine, evalAnswered, RECORD_VERSION, evalRename, evalSend, evalSendMany, evalDeliver, expireMsgs, queuedMsgs, MSG_LIMITS, resumeRule, checkResume, trashDays, checkTrashDays, LEGACY_RESUME, currentStep, normPath } from "./scene.js";
import { ensureKeys, sessionsDir, readRecords, parseRecords, SID_RE, PROTOCOL, readProjects, writeProjects, readLegacyGroups, projectsFile, projectsDir, readConfig, writeConfig, repoOf, trashDir, purgeTrash } from "./store.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JS = "text/javascript; charset=utf-8";
const STATIC = {
  "/": ["web/index.html", "text/html; charset=utf-8"],
  "/app.js": ["web/app.js", JS],
  "/canvas.js": ["web/canvas.js", JS],
  "/route.js": ["web/route.js", JS],
  "/hub.js": ["web/hub.js", JS],
  "/style.css": ["web/style.css", "text/css; charset=utf-8"],
  "/lib/scene.js": ["lib/scene.js", JS],
  "/vendor/elk.js": ["web/vendor/elk.js", JS],
  "/vendor/mermaid.js": ["web/vendor/mermaid.js", JS],
  "/icon.svg": ["web/icon.svg", "image/svg+xml"],
  // 글꼴은 2MB 라 오래 캐시한다(주소에 판을 붙여 부르므로 판이 바뀌면 새로 받는다)
  "/vendor/PretendardVariable.woff2": ["web/vendor/PretendardVariable.woff2", "font/woff2", "max-age=31536000, immutable"],
};
const CSP = "default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; " +
  "img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const COOKIE = "atv_r";
const MAX_BODY = 256 * 1024;
const BOARD_MAX_BODY = 256 * 1024; // 모아 보내기: 4000바이트 글 20개(JSON 으로 바꾸면 따옴표·줄 바꿈이 두 배가 된다)
const SUB_MAX_BODY = 16 * 1024;
const MAX_SUBS = 64; // 나눠 쓰는 연결 하나가 받는 세션·프로젝트 수(탭 수만큼)
const CHAN_RE = /^[A-Za-z0-9-]{16,64}$/;
const NOTE_IDS = 40; // 프로젝트 안내에 싣는 큰 그림 부품·단계 수
const INBOX_MAX_WAIT = 240_000; // 한 번 기다리는 길이. Node fetch 는 응답 머리를 5분 넘게 기다리지 않으므로 훅이 이 길이로 거듭 묻는다
const PID_RE = /^g[0-9a-f]{8}$/; // 프로젝트 id(07 판까지의 묶음 id 와 같은 모양이라 옮겨 와도 그대로 쓴다)
const LIVE_CHECK_MS = 30_000;
// codex queue 한 번을 기다리는 길이(시험은 ANYTASKVIEW_QUEUE_TIMEOUT 으로 줄인다)
const queueTimeout = () => Number(process.env.ANYTASKVIEW_QUEUE_TIMEOUT) || 20_000;
// 소속을 정한 근거. 높은 쪽이 정한 소속은 낮은 쪽이 바꾸지 못한다(손은 언제나 바꾼다).
// thread: 이어진 대화(/clear·fork·이어받기)에서 물려받음, claude: Claude 가 project 도구로, phrase: 이어받기 문구, hand: 사용자가 화판에서
const RANK = { thread: 0, claude: 1, phrase: 2, hand: 3 };
const WHY_KO = { thread: "앞 대화에서 이어짐", claude: "Claude 가 고름", phrase: "이어받기 문구", hand: "사용자가 넣음" };
const MAX_PROJECTS = 200, MAX_KEYS = 20;
const ago = (t, now = Date.now()) => {
  const m = Math.floor((now - t) / 60_000);
  return !t ? "없음" : m < 1 ? "방금" : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.floor(m / 60)}시간 전` : `${Math.floor(m / 1440)}일 전`;
};
const LOCKED_PAGE = `<!doctype html><meta charset="utf-8"><title>AnyTaskView</title>
<body style="font:15px/1.6 system-ui,sans-serif;max-width:40em;margin:3em auto;padding:0 1em">
<h1 style="font-size:1.2em">읽기 토큰이 필요합니다</h1>
<p>이 화판에는 작업 중인 코드와 명령이 보이므로, 이 PC 의 다른 사용자나 다른 웹 페이지가 읽지 못하게 막아 두었습니다.</p>
<p>터미널에서 anytaskview 플러그인 폴더의 <code>scripts/atv board --url</code> 을 실행하고, 나온 주소를 이 브라우저에서 한 번 여세요. 그 뒤로는 이 주소만 열면 됩니다. 폴더를 모르면 Claude 에게 「anytaskview 화판 여는 법」을 물어보세요.</p></body>`;

// /proc/<pid>/stat 의 시작 시각(22번째 칸). 같은 pid 가 다른 프로세스에 다시 쓰였는지 가리는 데 쓴다
export function procStart(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] || null;
  } catch {
    return null;
  }
}

// Codex 세션을 띄운 프로세스: app-server(데스크톱 앱·VS Code, 한 프로세스에 세션 여럿)인지와 그 실행 파일 경로
export function codexHost(pid) {
  let shared = false, bin = null;
  try { shared = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes("app-server"); } catch { /* 모르면 터미널 codex 로 본다 */ }
  try { bin = fs.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, ""); } catch { /* PATH 의 codex 를 쓴다 */ }
  return { shared, bin };
}

function same(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// onStop: 쓰기 열쇠로 「stop」 을 받았을 때 부른다(scripts/board.js 가 프로세스를 끝낸다). 없으면 stop 을 받지 않는다
export async function startBoard({ port = 4871, home, log = () => {}, onStop } = {}) {
  const keys = ensureKeys(home);
  const dir = sessionsDir(home);
  const pdir = projectsDir(home);
  const trash = trashDir(home);
  const sessions = new Map();  // 세션 id → { sid, file, scene, seq, bytes, chain, told }. told: Claude 에 마지막으로 알린 소속
  const pboards = new Map();   // 프로젝트 id → 큰 그림 화판 { sid(=프로젝트 id), file, scene, seq, bytes, chain, project, lastT }
  const pids = new Map();       // claude pid → { sid, start }. SessionStart 에서만 바꾼다
  // SSE 연결 { res, sids, chan }. sids 는 받는 세션·프로젝트 id(탭 하나의 연결이면 하나, 탭들이 나눠 쓰는 연결이면 여럿).
  // chan 은 나눠 쓰는 연결(SharedWorker)의 이름이다. 구독은 POST /api/sub 로 바꾼다
  const listeners = new Set();
  const chans = new Map(); // chan → 연결
  const waiters = new Map();    // 세션 id → 메시지를 기다리는 Stop 훅 { res, timer }. 세션마다 하나만 둔다
  const seenRids = new Map();   // 브라우저 쓰기 요청 id → 응답. 같은 요청이 두 번 와도 한 번만 처리한다
  let projects = readProjects(home), projectsChain = Promise.resolve(), configChain = Promise.resolve();
  let config = readConfig(home); // null 이면 새 판이 처음 뜬 것: 기록을 읽은 뒤 정한다(migrate)
  let resume = resumeRule(config?.resume);
  let boundPort = port;

  const boardOf = (id) => sessions.get(id) || pboards.get(id);
  const configView = () => ({ resume: config?.resume || null, trashDays: trashDays(config) });
  // 세션이 속한 프로젝트 id. 사용자가 뺐거나 프로젝트가 없어졌으면 null
  const memberPid = (sid, g = projects) => {
    const m = Object.hasOwn(g.members, sid) ? g.members[sid] : null;
    return m && m.pid && Object.hasOwn(g.projects, m.pid) ? m.pid : null;
  };
  const isCodex = (s) => s.scene.meta.via === "codex";
  // codex queue 로 받을 수 있는 Codex 세션: 끝나지 않았고, 그 codex 의 지금 세션이다(`/clear` 앞 세션은 codex 를 끝낼 때까지
  // 끝나지 않지만 더는 화면에 없다). 한 프로세스에 세션이 여럿인 app-server(shared)는 끝나지 않은 세션 모두
  const codexReady = (s) => {
    const { meta, sess } = s.scene;
    if (sess.status === "ended") return false;
    return !!meta.shared || (!!meta.pid && pids.get(meta.pid)?.sid === s.sid);
  };
  const summary = (s) => ({
    id: s.sid, cwd: s.scene.meta.cwd || "", title: s.scene.sess.title || "", status: s.scene.sess.status,
    name: s.scene.sess.name || s.scene.sess.claudeName || "",
    agent: isCodex(s) ? "codex" : "claude",
    // 화판 메시지를 받을 수 있음: Claude 는 Stop 훅이 기다리는 중(플러그인으로 설치한 세션), Codex 는 codex queue 로 보낼 수 있는 세션
    inbox: isCodex(s) ? codexReady(s) : waiters.has(s.sid),
    qerr: s.qerr || "", // Codex 에 보내지 못한 이유(다음 보내기·그 세션의 차례 끝에 다시 보낸다)
    lastT: s.scene.sess.lastT || s.scene.meta.startedAt || 0, startedAt: s.scene.meta.startedAt || 0, seq: s.seq, partial: s.scene.partial,
    prev: s.scene.meta.prev || null, // 이어진 대화의 앞 대화(/clear·fork·이어받기 문구)
    // 끝났는데 사용자 입력도 그림도 없는 세션(CLI 명령이 잠깐 띄운 MCP 따위). 목록에서 숨긴다
    empty: s.scene.sess.status === "ended" && !s.scene.sess.title && !Object.keys(s.scene.items).length,
    // 프로젝트 화판의 대화 이력에 쓰는 기록된 사실: 고친 파일 수, 올린 계획의 끝난 단계/전체(계획이 없으면 0/0)
    edits: s.scene.timeline.reduce((n, e) => n + (e.type === "fact" && e.f === "edit" ? 1 : 0), 0),
    steps: Object.values(s.scene.items).reduce((a, it) => (it.kind === "step" ? [a[0] + (it.status === "done" ? 1 : 0), a[1] + 1] : a), [0, 0]),
  });
  // 프로젝트 목록과 큰 그림 요약(지금 단계, 남은 단계 수, 승인 대기 수, 마지막 갱신)
  function projectsView() {
    const out = {};
    for (const [pid, p] of Object.entries(projects.projects)) {
      const b = pboards.get(pid), items = b ? Object.values(b.scene.items) : [];
      const cur = b && currentStep(b.scene);
      out[pid] = {
        ...p,
        lastT: b?.lastT || p.t || 0,
        cur: cur ? b.scene.items[cur].title : "",
        left: items.filter((it) => it.kind === "step" && it.status !== "done" && it.status !== "fail").length,
        wait: items.filter((it) => it.status === "wait" && !it.answered).length,
      };
    }
    return { projects: out, members: projects.members };
  }
  const write = (res, ev, data) => { if (!res.writableEnded) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); };
  const send = (sid, ev, data) => { for (const l of listeners) if (l.sids.has(sid)) write(l.res, ev, data); };
  const sendAll = (ev, data) => { for (const l of listeners) write(l.res, ev, data); };

  // 세션마다 한 줄로 세워 처리한다: 검사 → 기록 append → 끝난 뒤에 장면 적용·알림.
  // append 가 실패하면 장면을 바꾸지 않고, 쓰다 만 바이트를 잘라 낸다. 잘라 내지도 못하면 그 세션의 기록을 멈춘다
  function submit(s, src, type, op, run, ht) {
    const job = s.chain.then(async () => {
      if (s.broken) throw new Error("이 세션의 기록이 멈춰 있습니다");
      const ctx = { t: Date.now(), seq: s.seq + 1, ...(ht !== undefined && { ht }) };
      const out = run(s.scene, ctx);
      if (!out.res.length) return out;
      const line = JSON.stringify({ v: RECORD_VERSION, seq: ctx.seq, t: ctx.t, ...(ht !== undefined && { ht }), src, type, op, res: out.res }) + "\n";
      try {
        await fsp.appendFile(s.file, line, { mode: 0o600 });
      } catch (e) {
        try { await fsp.truncate(s.file, s.bytes); } catch { s.broken = true; }
        throw e;
      }
      s.bytes += Buffer.byteLength(line);
      // 기록에 쓴 그대로를 되읽어 적용한다. 실시간 장면과 재생 장면이 글자 하나까지 같아진다
      const rec = JSON.parse(line);
      s.seq = ctx.seq;
      applyRes(s.scene, rec.res);
      send(s.sid, "res", { id: s.sid, seq: rec.seq, t: rec.t, res: rec.res }); // id: 한 연결로 여러 세션을 받는 쪽이 가른다
      if (s.project) { s.lastT = rec.t; sendAll("projects", projectsView()); }
      else if (out.res.some((r) => r.k === "sess" || r.k === "meta")) sendAll("sess", summary(s));
      return out;
    });
    s.chain = job.catch((e) => log(`기록 실패 ${s.sid}: ${e.message}`));
    return job;
  }

  // 세션을 만들면 메타 기록을 줄의 맨 앞에 세우고 기다리지 않는다. 그래야 먼저 온 요청이 먼저 줄을 선다
  function sessionFor(sid, { cwd, pid }) {
    let s = sessions.get(sid);
    if (s) return s;
    s = { sid, file: path.join(dir, `${sid}.jsonl`), scene: newScene(), seq: 0, bytes: 0, chain: Promise.resolve() };
    sessions.set(sid, s);
    const made = s;
    submit(s, "board", "session", null, (_scene, ctx) => ({
      res: [{ k: "meta", v: { id: sid, ...(cwd && { cwd }), ...(pid && { pid }), startedAt: ctx.t } }], msg: "",
    })).catch(() => {
      // 메타 없이 이어 쓰지 않는다. 다음 요청이 세션을 새로 만든다
      made.broken = true;
      if (sessions.get(sid) === made) sessions.delete(sid);
    });
    return s;
  }

  // 프로젝트의 큰 그림 화판. 처음 쓸 때 만들고 메타 기록을 줄의 맨 앞에 세운다(세션의 sessionFor 와 같다)
  function boardFor(pid) {
    let b = pboards.get(pid);
    if (b) return b;
    b = { sid: pid, file: path.join(pdir, `${pid}.jsonl`), scene: newScene(), seq: 0, bytes: 0, chain: Promise.resolve(), project: true, lastT: 0, seen: new Map() };
    pboards.set(pid, b);
    const made = b;
    submit(b, "board", "project", null, (_scene, ctx) => ({ res: [{ k: "meta", v: { id: pid, startedAt: ctx.t } }], msg: "" })).catch(() => {
      made.broken = true;
      if (pboards.get(pid) === made) pboards.delete(pid);
    });
    return b;
  }

  // 기록 파일 하나를 읽어 장면을 되살린다
  function loadFile(file) {
    const { records, broken } = readRecords(file);
    const scene = newScene();
    let seq = 0, lastT = 0;
    for (const r of records) {
      if (r.v !== RECORD_VERSION) { scene.partial = true; continue; }
      applyRes(scene, Array.isArray(r.res) ? r.res : []);
      seq = Math.max(seq, r.seq || 0);
      lastT = Math.max(lastT, r.t || 0);
    }
    if (broken) scene.partial = true;
    return { file, scene, seq, lastT, bytes: fs.statSync(file).size, chain: Promise.resolve() };
  }

  function loadAll() {
    for (const name of fs.readdirSync(dir)) {
      const sid = name.replace(/\.jsonl$/, "");
      if (!name.endsWith(".jsonl") || !SID_RE.test(sid)) continue;
      const { lastT, ...s } = loadFile(path.join(dir, name));
      // 서버가 꺼진 동안에는 소속이 바뀌지 않으므로, 다시 띄운 뒤 첫 도구 결과에 같은 알림을 되풀이하지 않는다
      sessions.set(sid, { sid, ...s, told: memberPid(sid) });
    }
    for (const name of fs.readdirSync(pdir)) {
      const pid = name.replace(/\.jsonl$/, "");
      if (!name.endsWith(".jsonl") || !PID_RE.test(pid) || !Object.hasOwn(projects.projects, pid)) continue;
      const b = { sid: pid, ...loadFile(path.join(pdir, name)), project: true, seen: new Map() };
      b.loadSeq = b.seq; // 서버를 다시 띄우기 전에 본 것은 모르므로, 아직 보지 않은 대화도 여기까지는 봤다고 친다
      pboards.set(pid, b);
    }
    // 서버가 꺼져 있던 사이에 끝난 세션을 정리하고, 아직 살아 있는 claude 는 짝짓기 표에 다시 넣는다.
    // 같은 pid 라도 시작 시각(pstart)이 다르면 다른 프로세스가 번호를 다시 쓴 것이다.
    // 한 claude 에 세션이 여럿이면(/clear) 가장 나중에 SessionStart 가 온 세션을 고른다
    const lastStart = (s) => s.scene.meta.lastStart || s.scene.meta.startedAt || 0;
    for (const s of sessions.values()) {
      const { pid, pstart } = s.scene.meta;
      if (s.scene.sess.status === "ended" || !pid) continue;
      const start = procStart(pid);
      if (!start || (pstart && start !== pstart)) {
        submit(s, "board", "fact", { f: "gone" }, (sc, ctx) => evalFact(sc, { f: "gone" }, ctx));
        continue;
      }
      if (!pstart) continue; // SessionStart 를 받은 적 없는 세션은 짝짓기 표에 넣지 않는다
      const prev = pids.get(pid);
      if (!prev || lastStart(sessions.get(prev.sid)) < lastStart(s)) pids.set(pid, { sid: s.sid, start });
    }
  }

  function checkLive() {
    for (const [pid, ent] of pids) {
      if (ent.start === null) continue;          // 시작 시각을 못 읽은 경우는 가리지 않는다
      if (procStart(pid) === ent.start) continue;
      pids.delete(pid);
      // 이 claude 의 세션은 /clear 로 여럿일 수 있다. 끝을 받지 못한 옛 세션까지 모두 끝낸다
      for (const s of sessions.values()) {
        const { meta, sess } = s.scene;
        if (sess.status === "ended" || meta.pid !== pid || (s.sid !== ent.sid && meta.pstart !== ent.start)) continue;
        submit(s, "board", "fact", { f: "gone" }, (sc, ctx) => evalFact(sc, { f: "gone" }, ctx));
        release(s.sid);
      }
    }
  }

  async function readBody(req, max = MAX_BODY) {
    if (!/^application\/json\b/.test(req.headers["content-type"] || "")) throw Object.assign(new Error("JSON 만 받습니다"), { status: 415 });
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > max) throw Object.assign(new Error("본문이 너무 큽니다"), { status: 413 });
      chunks.push(c);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw Object.assign(new Error("JSON 이 깨졌습니다"), { status: 400 }); }
  }

  // 쓰기: 브라우저에서 온 요청(Origin 있음)은 열쇠가 맞아도 받지 않는다
  function writeDenied(req) {
    if (req.headers.origin !== undefined) return [403, "브라우저에서 온 쓰기는 받지 않습니다"];
    if (!same(req.headers["x-atv-key"], keys.write)) return [401, "쓰기 열쇠가 맞지 않습니다"];
    return null;
  }
  // 브라우저 쓰기(이름·묶음·메시지·지우기): 같은 화판 페이지에서 온 것만 받는다.
  // 맞춤 머리글은 다른 사이트가 붙이려면 사전 확인(OPTIONS)을 거쳐야 하는데 이 서버는 답하지 않는다.
  // 머리글 값은 화판 쓰기 열쇠(board)다. 쿠키는 127.0.0.1 의 다른 포트로도 새므로 쿠키만으로는 쓰지 못하게 한다
  // 화판 페이지(와 그 SharedWorker)에서 읽기 토큰을 가지고 온 POST 만 받는다
  function pageDenied(req) {
    if (req.headers.origin !== `http://${req.headers.host}`) return [403, "이 화판 페이지에서 온 쓰기만 받습니다"];
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin") return [403, "이 화판 페이지에서 온 쓰기만 받습니다"];
    if (!readOk(req)) return [401, "읽기 토큰이 없습니다"];
    return null;
  }
  function boardDenied(req) {
    const denied = pageDenied(req);
    if (denied) return denied;
    if (!keys.board || !same(req.headers["x-atv-board"], keys.board)) return [403, "화판 쓰기 열쇠가 없습니다. 터미널에서 scripts/atv board --url 이 찍는 주소를 이 브라우저로 한 번 다시 여세요"];
    return null;
  }
  const readOk = (req) => (req.headers.cookie || "").split(/;\s*/).some((c) => c.startsWith(COOKIE + "=") && same(c.slice(COOKIE.length + 1), keys.read));

  async function onMcp(req, res) {
    const body = await readBody(req);
    const pid = Number.isInteger(body.pid) && body.pid > 1 ? body.pid : null;
    if (body.tool === "stop") {
      if (!onStop) return text(res, 404, "이 서버는 stop 을 받지 않습니다");
      text(res, 200, "멈춤");
      setImmediate(onStop);
      return;
    }
    if (body.tool === "hello") {
      // MCP 가 처음 붙었다. SessionStart 훅이 서버보다 먼저 끝나 짝짓기 표에 없는 claude 를 메운다.
      // 이미 있으면 그대로 둔다(짝짓기는 SessionStart 가 먼저다)
      // 그때 빠진 「세션 시작」 사실(pid·시작 시각)도 대신 남겨, 서버를 다시 띄울 때 짝을 되찾게 한다
      if (pid && !pids.has(pid) && typeof body.env === "string" && SID_RE.test(body.env)) {
        const pstart = procStart(pid);
        pids.set(pid, { sid: body.env, start: pstart });
        const rec = { f: "start", source: "mcp", cwd: typeof body.cwd === "string" ? body.cwd : "", pid, pstart: pstart || undefined };
        const s = sessionFor(body.env, { cwd: rec.cwd, pid });
        await submit(s, "mcp", "fact", rec, (sc, ctx) => evalFact(sc, rec, ctx));
      }
      return json(res, 200, { proto: PROTOCOL });
    }
    // Codex 는 호출마다 세션 id 를 싣는다(body.sid). 한 프로세스에 세션이 여럿일 수 있어 짝짓기 표보다 앞세운다
    const sid = (typeof body.sid === "string" && SID_RE.test(body.sid) && body.sid) || (pid && pids.get(pid)?.sid) || body.env;
    if (typeof sid !== "string" || !SID_RE.test(sid)) return text(res, 400, "세션을 알 수 없음");
    if (body.tool === "bye") {
      // MCP 가 닫혔다: claude 가 끝났는지 곧 확인한다
      setTimeout(checkLive, 1500).unref();
      return text(res, 200, "");
    }
    const s = sessionFor(sid, { cwd: typeof body.cwd === "string" ? body.cwd : "", pid });
    const input = body.input;
    if (body.tool === "project") { await s.chain; return text(res, 200, await projectTool(s, input)); }
    const run = { plan: evalPlan, draw: evalDraw, note: evalNote }[body.tool];
    if (!run && body.tool !== "ids") return text(res, 400, `도구 '${String(body.tool).slice(0, 20)}' 모름`);
    // project 를 붙이면 그 프로젝트의 큰 그림 화판에 쓴다. 이 대화의 지금 소속과 같아야 한다(사용자가 옮긴 뒤 옛 프로젝트에 쓰지 않게)
    const want = isObj(input) && input.project != null ? input.project : null;
    let target = s;
    if (want !== null) {
      const cur = memberPid(sid);
      if (want !== cur) return text(res, 200, `거부: 이 대화는 프로젝트 ${String(want).slice(0, 20)} 소속이 아님(지금: ${cur ? `「${projects.projects[cur].name}」 ${cur}` : "없음"}). project 도구로 확인하세요` + told(s));
      if (body.tool === "draw" && input.clear === true) return text(res, 200, "거부: 프로젝트 화판은 여러 대화가 함께 써서 clear 를 받지 않음. 지울 부품은 del 로" + told(s));
      target = boardFor(want);
    }
    if (body.tool === "ids") {
      await target.chain;
      if (target !== s && Object.keys(target.scene.items).length <= 100) target.seen.set(sid, target.seq); // 잘리지 않았을 때만 본 것
      return text(res, 200, idsLine(target.scene) + told(s));
    }
    let clash = [];
    let out;
    try {
      out = await submit(target, "mcp", body.tool, input, (sc, ctx) => {
        // 줄을 기다리는 사이 사용자가 이 대화를 다른 프로젝트로 옮겼으면 옛 프로젝트에 쓰지 않는다
        if (target !== s && memberPid(sid) !== want) return { res: [], msg: "거부: 기다리는 사이 이 대화의 프로젝트가 바뀜. project 도구로 확인하세요" };
        const o = run(sc, input, ctx);
        if (target !== s) {
          // 이 대화가 큰 그림을 마지막으로 본 뒤 다른 대화가 바꾼 것을 덮는지 본다(쓰기는 한다)
          clash = overwrites(sc, o.res, sid, target.seen.get(sid) ?? target.loadSeq ?? 0);
          // 프로젝트 화판에는 부품·단계·메모마다 마지막으로 쓴 대화와, 부품·단계는 그 기록 번호(at)를 남긴다
          // 내용이 그대로인 put 은 앞서 쓴 대화를 남긴다(그대로 다시 쓴 대화가 남의 변경을 제 것처럼 가리지 않게)
          for (const r of o.res) {
            if (r.k === "tl") r.v = { ...r.v, by: sid };
            if (r.k !== "put") continue;
            const old = own(sc.items, r.v.id);
            r.v = old && !changedFields(old, r.v).length ? { ...r.v, by: old.by, at: old.at } : { ...r.v, by: sid, at: ctx.seq };
          }
        }
        return o;
      });
    } catch (e) {
      if (target === s) throw e;
      return text(res, 200, "거부: 프로젝트 화판에 쓰지 못함(그사이 프로젝트가 풀렸을 수 있음). project 도구로 확인하세요" + told(s));
    }
    return text(res, 200, out.msg + clashNote(clash) + told(s));
  }

  // ---- 프로젝트: 여러 대화에 걸친 일의 큰 그림 ----
  // 덮어쓰기: 부품·단계의 마지막 기록 번호(at)가 이 대화가 큰 그림을 마지막으로 본 번호(seen)보다 크고 쓴 대화가 다르면,
  // 그 값을 이 대화는 모르고 바꾸거나 지우는 것이다. 대화는 큰 그림을 projectNote(세션 시작·소속 알림·project 도구)나
  // ids 로만 본다(쓰기 결과에는 다른 부품이 보이지 않는다). 본 번호는 메모리에만 둔다(다시 띄우면 읽을 때의 번호부터)
  const CLASH_FIELDS = { kind: "종류", status: "상태", title: "제목", label: "이름", note: "메모", text: "글", src: "Mermaid", ref: "ref", in: "묶음", parent: "위 단계", from: "시작", to: "끝", value: "값", max: "최댓값" };
  function overwrites(scene, res, sid, seen) {
    const out = [];
    for (const r of res) {
      const id = r.k === "put" ? r.v.id : r.k === "del" ? r.id : null;
      const old = id !== null && own(scene.items, id);
      if (!old || !old.by || old.by === sid || !(old.at > seen)) continue;
      if (r.k === "del") { out.push({ id, by: old.by, what: "지움" }); continue; }
      const changed = changedFields(old, r.v);
      if (changed.length) out.push({ id, by: old.by, what: changed.map((f) => `${CLASH_FIELDS[f]} ${short(old[f])}→${short(r.v[f])}`).join(", ") });
    }
    return out;
  }
  const changedFields = (old, now) => Object.keys(CLASH_FIELDS).filter((f) => (old[f] ?? null) !== (now[f] ?? null));
  const short = (v) => (v == null ? "없음" : String(v).replace(/\s+/g, " ").slice(0, 30));
  function clashNote(list) {
    if (!list.length) return "";
    const who = (id) => { const o = sessions.get(id); return `「${o ? o.scene.sess.name || o.scene.sess.claudeName || o.scene.sess.title.slice(0, 30) || id.slice(0, 8) : id.slice(0, 8)}」`; };
    const shown = list.slice(0, 5).map((c) => `${c.id} ${c.what}(${who(c.by)} 대화가 바꾼 것)`);
    return `\n[anytaskview 프로젝트] 이 대화가 큰 그림을 마지막으로 본 뒤 다른 대화가 바꾼 것을 덮었습니다(쓰기는 됨): ${shown.join(" · ")}${list.length > 5 ? ` 외 ${list.length - 5}개` : ""}. 맞는지 ids 로 확인하고, 아니면 되돌리세요.`;
  }
  // 이 대화의 소속이 Claude 에 마지막으로 알린 것과 다르면(이어받기 문구·사용자가 바꿈) 도구 결과 뒤에 한 번 알린다
  function told(s) {
    const pid = memberPid(s.sid), was = s.told;
    s.told = pid;
    return was === pid || (was === undefined && !pid) ? "" : "\n" + projectNote(s.sid);
  }
  function projectNote(sid) {
    const pid = memberPid(sid);
    if (!pid) return "[anytaskview 프로젝트] 이 대화는 지금 어느 프로젝트에도 속하지 않습니다.";
    const p = projects.projects[pid], b = pboards.get(pid), why = projects.members[sid].why;
    // 이 글이 Claude 에 간다: 요약이 잘리지 않았으면 이 대화는 이 번호까지의 큰 그림을 봤다
    if (b && Object.keys(b.scene.items).length <= NOTE_IDS) b.seen.set(sid, b.seq);
    return `[anytaskview 프로젝트] 이 대화는 「${p.name}」(${pid}, ${WHY_KO[why] || why}) 소속입니다${p.purpose ? `. 목적: ${p.purpose}` : ""}. ` +
      `큰 그림은 plan·draw·note 에 project:"${pid}" 를 붙여 작업 단위를 시작·끝낼 때와 결정 때만 고칩니다. ` +
      `마지막 갱신 ${ago(b?.lastT || 0)} · ${b ? idsLine(b.scene, NOTE_IDS) : "비어 있음"}${b ? openNotes(b.scene) : ""}`;
  }
  // 아직 답을 받지 않은 결정 대기·막힘의 메모 글(최근 셋). 이름표만으로는 무엇을 기다리는지 알 수 없다
  function openNotes(scene) {
    // on 이 없는 메모는 그때의 지금 단계에 붙었다
    const target = (e) => e.on || e.step;
    const open = (e) => {
      const it = target(e) ? scene.items[target(e)] : null;
      return it && it.status === e.kind && !it.answered;
    };
    const list = scene.timeline.filter((e) => e.type === "note" && (e.kind === "wait" || e.kind === "blocked") && open(e)).slice(-3);
    return list.length ? ` | ${list.map((e) => `${e.kind === "wait" ? "결정 대기" : "막힘"}(${target(e)}): ${e.text.slice(0, 120)}`).join(" · ")}` : "";
  }
  // 세션이 쓴 저장소: 작업 폴더와 최근에 고친 파일 200개의 저장소
  function reposOf(o) {
    const dirs = new Set([o.scene.meta.cwd || ""]);
    for (const e of o.scene.timeline.filter((x) => x.type === "fact" && x.f === "edit").slice(-200)) dirs.add(path.dirname(normPath(e.path, o.scene.meta.cwd)));
    return [...dirs].map(repoOf).filter(Boolean);
  }
  // 이 대화에 보일 프로젝트 후보(끝나지 않은 것). 같은 저장소·브랜치에서 쓰인 프로젝트 먼저, 그다음 최근에 움직인 순서.
  // 경로는 순서에만 쓰고 소속을 정하지 않는다(같은 저장소에서 새 일을 시작할 수 있다)
  function candidates(s, n) {
    const here = repoOf(s.scene.meta.cwd || ""), view = projectsView().projects, rank = new Map();
    for (const pid of Object.keys(projects.projects)) if (!projects.projects[pid].done) rank.set(pid, { score: 0, t: view[pid].lastT });
    for (const [sid, m] of Object.entries(projects.members)) {
      const c = m.pid && rank.get(m.pid), o = sid !== s.sid && sessions.get(sid);
      if (!c || !o) continue;
      c.t = Math.max(c.t, o.scene.sess.lastT || 0);
      if (here && c.score < 2) for (const r of reposOf(o)) if (r.repo === here.repo) c.score = Math.max(c.score, r.branch === here.branch ? 2 : 1);
    }
    return [...rank].sort((a, b) => b[1].score - a[1].score || b[1].t - a[1].t).slice(0, n).map(([pid]) => pid);
  }
  const candText = (pid) => {
    const p = projects.projects[pid];
    return `${pid} 「${p.name}」${p.purpose ? ` — ${p.purpose.slice(0, 60)}` : ""}`;
  };
  // project 도구: list(후보 보기)·join(들어가기)·create(만들고 들어가기)·leave(나가기)
  async function projectTool(s, input) {
    const a = isObj(input) ? input : {}, sid = s.sid, action = a.action ?? "list";
    if (action === "list") {
      const list = candidates(s, 10);
      s.told = memberPid(sid);
      return projectNote(sid) + (list.length ? `\n진행 중인 프로젝트: ${list.map(candText).join(" · ")}` : "\n진행 중인 프로젝트 없음");
    }
    let r;
    if (action === "join") {
      if (typeof a.id !== "string" || !Object.hasOwn(projects.projects, a.id)) return `거부: 프로젝트 ${String(a.id).slice(0, 20)} 없음. list 로 확인하세요`;
      r = await changeProjects((g) => (Object.hasOwn(g.projects, a.id) ? joinIn(g, sid, a.id, "claude") : { ok: false, msg: "프로젝트 없음" }));
    } else if (action === "create") {
      const name = cleanName(a.name), purpose = cleanName(a.purpose, 120);
      if (!name) return "거부: create 에는 name 이 필요함";
      // 들어가지 못하면(사용자가 정한 소속) 만들지도 않는다
      r = await changeProjects((g) => {
        const pid = newProject(g, name, purpose);
        return pid ? joinIn(g, sid, pid, "claude") : { ok: false, msg: `프로젝트가 ${MAX_PROJECTS}개를 넘음` };
      });
    } else if (action === "leave") {
      r = await changeProjects((g) => {
        const m = Object.hasOwn(g.members, sid) ? g.members[sid] : null;
        if (!m || !m.pid) return { ok: false, msg: "속한 프로젝트 없음" };
        return joinIn(g, sid, null, "claude");
      });
    } else return "거부: action 은 list·join·create·leave";
    if (!r.ok) return `거부: ${r.msg}`;
    s.told = memberPid(sid);
    return projectNote(sid);
  }
  function newProject(g, name, purpose = "", keys = []) {
    if (Object.keys(g.projects).length >= MAX_PROJECTS) return null;
    let pid;
    do pid = "g" + crypto.randomBytes(4).toString("hex"); while (Object.hasOwn(g.projects, pid));
    g.projects[pid] = { name, purpose, keys, t: Date.now(), done: false };
    return pid;
  }
  // 소속 바꾸기(projects 줄 안에서). 높은 근거가 정한 소속은 낮은 근거로 바꾸지 않는다(손은 언제나 바꾼다).
  // 손으로 빼면 「뺌」(pid null)으로 남겨 자동으로 다시 넣지 않는다. 들어가면 끝난 프로젝트는 다시 진행으로 둔다
  function joinIn(g, sid, pid, why) {
    const m = Object.hasOwn(g.members, sid) ? g.members[sid] : null;
    if (why !== "hand" && m && RANK[m.why] > RANK[why]) return { ok: false, msg: `이 대화의 소속은 「${WHY_KO[m.why]}」 이라 바꾸지 않음` };
    if (pid === null) {
      if (why === "hand") g.members[sid] = { pid: null, why }; else delete g.members[sid];
      return { ok: true };
    }
    g.members[sid] = { pid, why };
    if (g.projects[pid].done) g.projects[pid].done = false;
    return { ok: true, pid };
  }
  // 이어받기 키는 한 프로젝트에만 둔다. 다른 프로젝트에 있던 키는 옮겨 온다
  function claimKey(g, pid, key) {
    for (const p of Object.values(g.projects)) if (p.keys?.includes(key)) p.keys = p.keys.filter((k) => k !== key);
    g.projects[pid].keys = [...(g.projects[pid].keys || []), key].slice(-MAX_KEYS);
  }
  // 이어받기 문구로 시작한 대화: 그 키의 프로젝트에 넣는다. 그 키를 가진 프로젝트가 없으면, 앞 대화에서 물려받은 프로젝트가
  // 있으면 그 프로젝트에 키를 붙이고(앞 대화가 키 없이 프로젝트에 들었던 경우), 그것도 없으면 그 이름으로 프로젝트를 만든다
  function joinByKey(sid, key) {
    return changeProjects((g) => {
      const m = Object.hasOwn(g.members, sid) ? g.members[sid] : null;
      if (m && RANK[m.why] > RANK.phrase) return { ok: false };
      let pid = Object.keys(g.projects).find((id) => g.projects[id].keys?.includes(key));
      if (!pid && m?.why === "thread" && memberPid(sid, g)) {
        pid = m.pid;
        claimKey(g, pid, key);
      }
      if (!pid) pid = newProject(g, key, "", [key]);
      return pid ? joinIn(g, sid, pid, "phrase") : { ok: false };
    });
  }
  // 인계 문서를 고친 대화가 프로젝트에 있으면 그 키를 프로젝트에 붙인다(소속은 바꾸지 않는다).
  // 이미 다른 프로젝트가 가진 키는 옮기지 않는다: 남의 인계 문서를 고쳤을 수 있고, 키 옮기기는 사용자(끌어 놓기)만 한다
  function addDocKey(sid, key) {
    return changeProjects((g) => {
      const pid = memberPid(sid, g);
      if (!pid || Object.values(g.projects).some((p) => p.keys?.includes(key))) return { ok: false };
      claimKey(g, pid, key);
      return { ok: true };
    });
  }
  // 이어진 대화(/clear·fork·이어받기)는 앞 대화의 프로젝트를 물려받는다. 앞서 줄 선 소속 바꾸기가 끝난 뒤의 소속을 본다.
  // 끝난 프로젝트는 물려받지 않는다(끝낸 뒤 /clear 로 이어 가는 대화는 대개 다른 일이다).
  // 사용자가 뺀 줄(「뺌」)은 /clear·fork 로 이어진 대화도 뺀 채로 둔다(목록의 한 줄이 사용자가 고른 자리에 남게).
  // 이어받기 문구로 이어진 대화에는 물려주지 않는다: 문구는 그 대화에 대한 사용자의 뜻이다
  function inheritProject(prev, sid, cleared) {
    return changeProjects((g) => {
      if (Object.hasOwn(g.members, sid)) return { ok: false };
      const pm = Object.hasOwn(g.members, prev) ? g.members[prev] : null;
      if (cleared && pm && pm.pid === null && pm.why === "hand") {
        g.members[sid] = { pid: null, why: "hand" };
        return { ok: true };
      }
      const from = memberPid(prev, g);
      if (!from || g.projects[from].done) return { ok: false };
      g.members[sid] = { pid: from, why: "thread" };
      return { ok: true };
    }).catch((e) => log(`프로젝트 저장 실패: ${e.message}`));
  }

  async function onHook(req, res) {
    const body = await readBody(req);
    const { sid, fact } = body;
    if (typeof sid !== "string" || !SID_RE.test(sid)) return text(res, 400, "세션을 알 수 없음");
    if (!fact || typeof fact.f !== "string") return text(res, 400, "사실이 없음");
    const pid = Number.isInteger(body.pid) && body.pid > 1 ? body.pid : null;
    // CLI 명령(`claude mcp list` 따위)은 SessionEnd 만 보낸다. 모르는 세션의 끝으로 빈 세션을 만들지 않는다
    if (fact.f === "end" && !sessions.has(sid)) return json(res, 200, { ok: true });
    let rec = fact, clearedFrom = null;
    if (fact.f === "start") {
      // 짝짓기 표는 여기서만 바꾼다. pid 와 그 시작 시각을 세션 메타에도 남겨 서버를 다시 띄울 때 대조한다
      const pstart = pid ? procStart(pid) : null;
      // Codex: 그 프로세스가 app-server(데스크톱 앱·VS Code, 세션 여럿)인지와 codex queue 로 보낼 때 쓸 실행 파일
      const host = fact.via === "codex" && pid ? codexHost(pid) : null;
      const prev = pid && !host?.shared ? pids.get(pid)?.sid : null;
      if (pid) pids.set(pid, { sid, start: pstart });
      rec = { ...fact, pid: pid || undefined, pstart: pstart || undefined, bin: host?.bin || undefined, shared: host?.shared || undefined };
      // /clear·fork 로 이어진 세션: 앞 대화를 남기고 그 프로젝트를 물려받는다. app-server 는 같은 pid 의 다른 세션이 앞 대화가 아니다
      if ((fact.source === "clear" || fact.source === "fork") && prev && prev !== sid) {
        rec.prev = prev;
        clearedFrom = prev;
      }
    }
    // 작업 폴더: SessionStart 를 받기 전에 시작한 세션도 다른 훅 사건의 cwd 로 채운다
    const cwd = typeof fact.cwd === "string" && fact.cwd ? fact.cwd : typeof body.cwd === "string" ? body.cwd : "";
    const s = sessionFor(sid, { cwd, pid });
    if (fact.f !== "start" && cwd && !s.scene.meta.cwd) rec = { ...rec, cwd };
    // Codex 세션인데 SessionStart 를 받지 못했다(그때 화판이 꺼져 있었음): 이 사실에 Codex 메타를 실어 채우고 짝짓기 표에도 넣는다.
    // 그 codex 에 짝지어진 세션이 이 세션보다 먼저 시작했으면 이 세션이 지금 세션이다(`/clear` 의 시작을 놓친 경우)
    if (fact.f !== "start" && body.via === "codex" && s.scene.meta.via !== "codex") {
      const pstart = pid ? procStart(pid) : null;
      const host = pid ? codexHost(pid) : null;
      const cur = pid ? pids.get(pid) : null;
      const curStart = cur && cur.sid !== sid ? sessions.get(cur.sid)?.scene.meta.lastStart || 0 : null;
      if (pid && (!cur || (curStart !== null && curStart < (s.scene.meta.startedAt || Date.now())))) pids.set(pid, { sid, start: pstart });
      rec = { ...rec, via: "codex", home: typeof body.home === "string" ? body.home : "", pid: pid || undefined, pstart: pstart || undefined, bin: host?.bin || undefined, shared: host?.shared || undefined };
    }
    const ht = Number.isFinite(body.ht) ? body.ht : undefined;
    let linked = null, key = null;
    // 입력이 온 때의 프로젝트. 기록을 기다리는 사이 사용자가 옮겨도 그때의 프로젝트만 보고,
    // 이어받기 문구로 이 입력에서 막 들어간 프로젝트의 대기는 풀지 않는다
    const wasPid = rec.f === "prompt" && !rec.sys ? memberPid(sid) : null;
    await submit(s, "hook", "fact", rec, (sc, ctx) => {
      // 첫 입력의 이어받기 키(작업 알림은 사용자 입력이 아니다). 줄 안에서 보므로 이 대화의 첫 입력인지 정확히 안다
      if (rec.f === "prompt" && !rec.sys && !sc.sess.title) key = resume.prompt(rec.text);
      const r = withHandonPrev(s, sc, rec);
      linked = r.prev && r !== rec ? r.prev : null;
      return evalFact(sc, r, { ...ctx, resume });
    }, ht);
    // 기록에 남은 뒤에만 소속을 바꾼다. 이어받기 문구가 이어진 대화의 소속보다 앞서므로 뒤에 둔다
    if (clearedFrom || linked) await inheritProject(clearedFrom || linked, sid, !!clearedFrom);
    if (key) await joinByKey(sid, key).catch((e) => log(`프로젝트 저장 실패: ${e.message}`));
    const docKey = rec.f === "edit" ? resume.path(rec.path) : null;
    if (docKey) await addDocKey(sid, docKey).catch((e) => log(`프로젝트 저장 실패: ${e.message}`));
    if (rec.f === "end") release(sid);
    // 사용자 입력이면 그 대화가 든 프로젝트의 큰 그림에 남은 승인 대기도 「답 받음」 으로(사용자 결정 5-2)
    // 줄 안에서 본다(앞서 줄 선 큰 그림 기록이 먼저 반영된다). 풀 대기가 없으면 기록하지 않는다
    const pb = wasPid && memberPid(sid) === wasPid ? pboards.get(wasPid) : null; // 큰 그림이 아직 없으면 풀 대기도 없다
    if (pb) await submit(pb, "hook", "fact", { f: "answered", sid }, (sc) => evalAnswered(sc)).catch((e) => log(`큰 그림 기록 실패 ${pb.sid}: ${e.message}`));
    // Codex: 보내지 못하고 남은 글을 차례가 끝났을 때·세션이 (다시) 시작했을 때 다시 보낸다
    if (isCodex(s) && (rec.f === "stop" || rec.f === "start")) deliverCodex(s);
    const reply = { ok: true };
    if (fact.f === "start") {
      // 이 대화의 화판에 이미 그림이 있는가(재개·압축). 훅이 그리기 알림을 끄는 데 쓴다
      reply.drawn = Object.values(s.scene.items).some((it) => it.kind !== "step");
      // SessionStart 의 stdout 은 Claude 맥락에 들어간다: 압축 전 이름표, 이 대화의 프로젝트(없으면 후보 5개까지)
      const lines = [];
      if (fact.source === "compact" && Object.keys(s.scene.items).length) lines.push(`anytaskview 화판에 이미 있는 이름표(압축 전): ${idsLine(s.scene)}`);
      const mine = memberPid(sid);
      if (mine) lines.push(projectNote(sid));
      else if (projects.members[sid]?.why !== "hand") {
        const c = candidates(s, 5);
        if (c.length) lines.push(`[anytaskview 프로젝트] 여러 대화에 걸친 일마다 큰 그림 화판이 있습니다. 지금 일이 아래 중 하나면 project {action:"join", id} 로 들어가고, 아니면 무시하세요: ${c.map(candText).join(" · ")}`);
      }
      s.told = mine;
      if (lines.length) reply.out = lines.join("\n");
    }
    return json(res, 200, reply);
  }

  // 첫 입력이 이어받기 문구(「핸드온 <키>」 따위)면 그 키를 가진 가장 최근 세션(그 키로 이어받았거나 인계 문서를 고친 세션)을 앞 대화로 붙인다.
  // 이 세션보다 먼저 시작한 세션만 고르므로 고리가 생기지 않는다. 줄 안에서 부르므로 이 세션의 첫 입력인지 정확히 안다
  function withHandonPrev(s, sc, fact) {
    if (fact.f !== "prompt" || fact.sys || sc.sess.title || sc.meta.prev) return fact;
    const key = resume.prompt(fact.text);
    if (!key) return fact;
    const born = sc.meta.startedAt || Date.now();
    let best = null;
    for (const o of sessions.values()) {
      if (o === s || o.scene.meta.handoff !== key || !((o.scene.meta.startedAt || 0) < born)) continue;
      if (!best || (o.scene.sess.lastT || 0) > (best.scene.sess.lastT || 0)) best = o;
    }
    return best ? { ...fact, prev: best.sid } : fact;
  }

  // ---- 프로젝트 정의·소속: 한 줄로 세워 바꾸고, 파일에 쓴 뒤에만 메모리·화면에 반영한다 ----
  // 끝난 대화를 휴지통으로 옮긴다(30일 뒤 비움). 옮긴 id 를 돌려준다.
  // still: 줄 선 기록을 기다린 뒤 다시 보는 조건(자동 정리는 그사이 바뀐 날수·프로젝트 소속을 다시 본다)
  async function trashSessions(ids, still = () => true) {
    const gone = [], projectJobs = [];
    for (const id of ids) {
      const s = sessions.get(id);
      if (!s) continue;
      // 줄 선 기록이 다 끝난 뒤에 본다. 기다리는 사이 새 사건(resume)이 와서 살아났으면 남긴다
      for (let c; c !== s.chain;) { c = s.chain; await c; }
      if (sessions.get(id) !== s || s.scene.sess.status !== "ended" || !still(s)) continue;
      // 확인부터 알림까지 await 없이 한 번에 한다. 그사이 다른 요청이 옛 파일 자리에 이어 쓰지 못하고,
      // 뒤의 세션을 기다리는 동안 같은 id 로 다시 생긴 세션은 이 알림과 프로젝트 소속 정리보다 뒤에 온다
      let t = Date.now();
      while (fs.existsSync(path.join(trash, `${id}.${t}.jsonl`))) t++; // 휴지통의 앞선 기록을 덮어쓰지 않게
      try { fs.renameSync(s.file, path.join(trash, `${id}.${t}.jsonl`)); }
      catch (e) { log(`지우기 실패 ${id}: ${e.message}`); continue; }
      sessions.delete(id);
      s.broken = true; // 이 세션을 이미 쥐고 있던 처리가 있어도 더 쓰지 않는다
      for (const [pid, ent] of pids) if (ent.sid === id) pids.delete(pid);
      gone.push(id);
      sendAll("drop", [id]);
      projectJobs.push(changeProjects((g) => {
        if (!Object.hasOwn(g.members, id)) return { ok: false };
        delete g.members[id];
        return { ok: true };
      }).catch((e) => log(`프로젝트 저장 실패: ${e.message}`)));
    }
    await Promise.all(projectJobs);
    return gone;
  }
  // 오래된 지난 대화를 휴지통으로. 목록의 한 줄처럼 이어진 대화(/clear·fork·이어받기, meta.prev)째로 본다:
  // 줄의 대화가 모두 끝났고, 가장 최근 활동이 설정한 날수(기본 30, null 이면 끔)보다 오래됐고, 진행 중인 프로젝트에 든 대화가 없을 때.
  // 진행 중인 프로젝트의 대화를 남기는 것은 사용자 결정이다(그 프로젝트의 대화 이력이 중간에 빠지지 않게).
  // 줄 일부만 옮기면 남은 대화가 앞 대화를 잃고 줄이 갈라진다
  async function sweepOld(now = Date.now()) {
    const rootOf = (s) => {
      const seen = new Set([s.sid]);
      for (let cur = s; ;) {
        const p = cur.scene.meta.prev, ps = p && sessions.get(p);
        if (!ps || seen.has(p)) return cur.sid;
        seen.add(p);
        cur = ps;
      }
    };
    const oldOne = (x, days) => {
      if (x.scene.sess.status !== "ended" || now - (x.scene.sess.lastT || x.scene.meta.startedAt || 0) <= days * 86_400_000) return false;
      const pid = memberPid(x.sid);
      return !pid || !!projects.projects[pid].done;
    };
    const old = (s) => {
      const days = trashDays(config), root = rootOf(s);
      return !!days && [...sessions.values()].every((x) => rootOf(x) !== root || oldOne(x, days));
    };
    if (!trashDays(config)) return 0;
    const ids = [...sessions.values()].filter(old).map((s) => s.sid);
    const gone = ids.length ? await trashSessions(ids, old) : [];
    if (gone.length) log(`지난 대화 ${gone.length}개를 휴지통으로 옮김(${trashDays(config)}일 넘음)`);
    return gone.length;
  }
  function changeProjects(fn) {
    const job = projectsChain.then(async () => {
      const next = structuredClone(projects);
      const r = fn(next);
      if (!r.ok) return r;
      await writeProjects(home, next);
      projects = next;
      sendAll("projects", projectsView());
      return r;
    });
    projectsChain = job.catch(() => {});
    return job;
  }
  const cleanName = (v, max = 80) => (typeof v === "string" ? v.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, max) : "");

  // 새 판이 처음 뜰 때 한 번: 07 판까지의 묶음을 프로젝트로 옮기고(소속은 「사용자가 넣음」), 이어받기 문구 설정을 정한다.
  // 옛 기록에 인계 키가 있으면 코드에 박혀 있던 핸드온 규칙을 쓰던 PC 이므로 그 규칙을 설정에 넣어 지금처럼 움직이게 한다
  async function migrate() {
    if (!fs.existsSync(projectsFile(home))) {
      const g = readLegacyGroups(home);
      if (g) {
        const next = { projects: {}, members: {} }, keyUse = new Map(); // 인계 키 → 그 키를 가진 세션이 있던 묶음들
        for (const [gid, v] of Object.entries(g.groups)) {
          if (PID_RE.test(gid) && v && typeof v.name === "string") next.projects[gid] = { name: v.name, purpose: "", keys: [], t: v.t || Date.now(), done: false };
        }
        for (const [sid, gid] of Object.entries(g.members)) {
          if (!Object.hasOwn(next.projects, gid)) continue;
          next.members[sid] = { pid: gid, why: "hand" };
          const key = sessions.get(sid)?.scene.meta.handoff;
          if (key) keyUse.set(key, (keyUse.get(key) || new Set()).add(gid));
        }
        // 한 묶음에서만 쓰인 키는 그 프로젝트의 키가 된다
        for (const [key, gids] of keyUse) if (gids.size === 1) next.projects[[...gids][0]].keys.push(key);
        await writeProjects(home, next);
        projects = next;
      }
    }
    if (!config) {
      const used = [...sessions.values()].some((s) => s.scene.meta.handoff);
      config = { resume: used ? LEGACY_RESUME : null };
      await writeConfig(home, config);
      resume = resumeRule(config.resume);
    }
  }

  // ---- 메시지: Stop 훅(asyncRewake)이 기다리다가 받아 간다 ----
  // 기다림 끝내기. 204 = 그만 기다려라(새 Stop 훅이 이어받음·세션 끝·서버 닫힘), 202 = 아직 없으니 다시 물어라
  function release(sid, status = 204) {
    const w = waiters.get(sid);
    if (!w) return;
    waiters.delete(sid);
    clearTimeout(w.timer);
    if (!w.res.writableEnded) { w.res.writeHead(status); w.res.end(); }
    const s = sessions.get(sid);
    if (s) sendAll("sess", summary(s));
  }
  // 기다리는 훅이 있고 대기 메시지가 있으면 「보냄」으로 기록한 뒤 넘긴다. 기록이 실패하면 넘기지 않는다
  async function deliverTo(s) {
    const w = waiters.get(s.sid);
    if (!w) return;
    // 아직 만료 처리 전인 오래된 메시지만 있으면 기다림을 빼앗지 않는다(만료는 expireOld 가 한다)
    const now = Date.now();
    if (!queuedMsgs(s.scene).some((m) => now - m.t <= MSG_LIMITS.ttl)) return;
    waiters.delete(s.sid);
    clearTimeout(w.timer);
    sendAll("sess", summary(s));
    let body = "", sent = [];
    try {
      await submit(s, "board", "deliver", null, (sc, ctx) => {
        const d = evalDeliver(sc, ctx);
        body = d.text;
        sent = d.res.map((r) => r.v.mid);
        return { res: d.res, msg: "" };
      });
    } catch {
      if (!w.res.writableEnded) { w.res.writeHead(204); w.res.end(); }
      return;
    }
    if (body && !w.res.destroyed && !w.res.writableEnded) {
      w.res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      w.res.end(body);
    } else if (sent.length) {
      // 넘기기 직전에 훅이 끊겼다: 세션이 살아 있으면 대기로 돌리고, 그사이 새로 기다리는 훅이 있으면 다시 넘긴다
      submit(s, "board", "requeue", null, (sc) => ({
        res: sent.map((mid) => ({ k: "msg", v: sc.sess.status === "ended" ? { mid, state: "expired", why: "세션이 끝나 만료" } : { mid, state: "queued", sentT: null } })),
        msg: "",
      })).then(() => deliverTo(s)).catch(() => {});
    } else if (!w.res.writableEnded) { w.res.writeHead(204); w.res.end(); }
  }
  async function onInbox(req, res) {
    const body = await readBody(req);
    const sid = body.sid;
    if (typeof sid !== "string" || !SID_RE.test(sid)) return text(res, 400, "세션을 알 수 없음");
    const s = sessions.get(sid);
    if (!s || s.scene.sess.status === "ended") { res.writeHead(204); return res.end(); }
    release(sid); // 한 세션에 기다리는 훅은 하나만: 옛 기다림은 「없음」으로 끝낸다
    const w = { res, timer: null };
    waiters.set(sid, w);
    sendAll("sess", summary(s));
    w.timer = setTimeout(() => { if (waiters.get(sid) === w) release(sid, 202); }, Math.min(Math.max(Number(body.wait) || 0, 0), INBOX_MAX_WAIT));
    res.on("close", () => { if (waiters.get(sid) === w) { waiters.delete(sid); clearTimeout(w.timer); sendAll("sess", summary(s)); } });
    await deliverTo(s);
  }
  // ---- 메시지: Codex 는 화판 서버가 codex queue 로 보낸다 ----
  // 쉬는 세션은 곧바로 새 차례로 받고, 일하는 중이면 그 차례가 끝난 직후 새 차례로 받는다.
  // 세션마다 한 줄로 세워 하나씩 보낸다. 큐에 넣는 데 성공한 글만 「보냄」 으로 기록한다(기록 전에 서버가 꺼지면 다시 보낼 수 있다).
  // 분명한 실패는 대기로 두고 이유를 보이며, 답이 없으면(시간 초과) 들어갔는지 모르므로 만료로 두고 다시 보내지 않는다
  function deliverCodex(s) {
    s.qjob = (s.qjob || Promise.resolve()).then(() => queueOnce(s)).catch((e) => log(`codex queue 실패 ${s.sid}: ${e.message}`));
    return s.qjob;
  }
  async function queueOnce(s) {
    if (!codexReady(s)) return;
    await s.chain; // 앞서 줄 선 기록(방금 넣은 글)이 장면에 들어간 뒤에 고른다
    // 큐에 넣었지만 「보냄」 기록이 실패한 글(qsent)은 다시 보내지 않는다(Codex 가 두 번 받는다)
    s.qsent ||= new Set();
    const msgs = Object.fromEntries(Object.entries(s.scene.msgs || {}).filter(([mid]) => !s.qsent.has(mid)));
    const d = evalDeliver({ ...s.scene, msgs }, { t: Date.now() });
    if (!d.text) return;
    const mids = d.res.map((r) => r.v.mid);
    const r = await codexQueue(s, d.text);
    const still = (sc) => mids.filter((mid) => own(sc.msgs || {}, mid)?.state === "queued");
    s.qerr = r.ok || r.unknown ? "" : r.why;
    // 들어갔거나 들어갔을 수 있는 글은 기록이 실패해도 다시 보내지 않는다
    if (r.ok || r.unknown) for (const mid of mids) s.qsent.add(mid);
    if (r.ok) {
      await submit(s, "board", "deliver", null, (sc, ctx) => ({ res: still(sc).map((mid) => ({ k: "msg", v: { mid, state: "sent", sentT: ctx.t } })), msg: "" }));
    } else if (r.unknown) {
      // 들어갔을 수 있다. unsure 를 붙여 같은 글 번호(cid)로 다시 보내면 「이미 받음」 이 되게 한다
      await submit(s, "board", "expire", null, (sc) => ({ res: still(sc).map((mid) => ({ k: "msg", v: { mid, state: "expired", unsure: true, why: `전달 확인 못 함(${r.why})` } })), msg: "" }));
    }
    sendAll("sess", summary(s));
  }
  // codex queue --thread <세션> --message <글>. 셸 없이 인자로 넘긴다. 실행 파일은 그 세션을 띄운 codex, 안 되면 PATH 의 codex
  function codexQueue(s, text) {
    const { bin, home } = s.scene.meta;
    // 기록에 남은 경로는 이름이 codex 이고 아직 있을 때만 쓴다
    const hostBin = bin && path.basename(bin) === "codex" && fs.existsSync(bin) ? bin : null;
    const bins = [...new Set([process.env.ANYTASKVIEW_CODEX_BIN, hostBin, "codex"].filter(Boolean))];
    const env = { ...process.env, ...(home && { CODEX_HOME: home }) };
    return new Promise((ok) => {
      // 실행 파일 하나로 해 보고, 분명히 실패하면(없음·0 아닌 종료) 다음 것으로. 답이 없으면 거기서 그친다
      const attempt = (i, why) => {
        if (i >= bins.length) return ok({ ok: false, why: why || "codex 를 찾지 못함" });
        let child, settled = false, err = "";
        const finish = (r) => {
          if (settled) return; // spawn 이 실패하면 error 뒤에 close 도 온다
          settled = true;
          clearTimeout(timer);
          if (r.retry) attempt(i + 1, r.why); else ok(r);
        };
        // PATH 의 codex 는 npm 래퍼(node)라 진짜 codex 를 손자로 띄운다. 프로세스 묶음으로 띄워 시간이 지나면 묶음째 죽이고,
        // 손자가 stderr 를 쥐고 있어 close 가 늦을 수 있으므로 기다리지 않고 그 자리에서 끝낸다
        const wait = queueTimeout();
        const timer = setTimeout(() => {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child?.kill("SIGKILL"); }
          child?.stderr?.destroy();
          finish({ ok: false, unknown: true, why: `${Math.round(wait / 1000)}초 안에 답이 없음` });
        }, wait);
        try {
          child = spawn(bins[i], ["queue", "--thread", s.sid, "--message", text], { env, stdio: ["ignore", "ignore", "pipe"], detached: true });
        } catch (e) { return finish({ retry: true, why: e.message }); }
        child.stderr.on("data", (c) => { if (err.length < 4000) err += c; });
        child.on("error", (e) => finish({ retry: true, why: e.code === "ENOENT" ? `${bins[i]} 없음` : e.message }));
        child.on("close", (code) => {
          if (code === 0) return finish({ ok: true });
          finish({ retry: true, why: (err.trim().split("\n").pop() || `종료 코드 ${code}`).slice(0, 200) });
        });
      };
      attempt(0, "");
    });
  }

  // 30분 넘게 못 보낸 메시지는 만료로 둔다
  function expireOld() {
    const now = Date.now();
    for (const s of sessions.values()) {
      if (!queuedMsgs(s.scene).some((m) => now - m.t > MSG_LIMITS.ttl)) continue;
      // Codex 큐에 넣었는데 「보냄」 기록만 실패한 글(qsent)은 들어갔으므로 unsure 로 둔다(같은 글 번호로 다시 보내면 「이미 받음」)
      const res = expireMsgs(s.scene, [], "30분 동안 못 보내 만료", now).map((r) => (s.qsent?.has(r.v.mid) ? { ...r, v: { ...r.v, unsure: true } } : r));
      submit(s, "board", "expire", null, () => ({ res, msg: "" })).catch(() => {});
    }
  }

  // ---- 브라우저 쓰기 ----
  async function onBoard(req, res) {
    const body = await readBody(req, BOARD_MAX_BODY);
    const rid = typeof body.rid === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(body.rid) ? body.rid : null;
    // 같은 rid 가 처리 중에 또 오면 같은 결과를 기다린다(먼저 등록하고 나서 처리한다)
    let job = rid ? seenRids.get(rid) : undefined;
    if (!job) {
      job = boardOp(body);
      if (rid) {
        seenRids.set(rid, job);
        if (seenRids.size > 500) seenRids.delete(seenRids.keys().next().value);
      }
    }
    const out = await job;
    return json(res, out.ok ? 200 : 400, out);
  }
  async function boardOp(body) {
    const sess = (sid) => (typeof sid === "string" && SID_RE.test(sid) ? sessions.get(sid) : undefined);
    let out;
    switch (body.op) {
      case "rename": {
        const s = sess(body.sid);
        if (!s) { out = { ok: false, msg: "세션 없음" }; break; }
        const r = await submit(s, "board", "rename", { name: body.name }, (sc) => evalRename(sc, body.name));
        out = { ok: true, msg: r.msg };
        break;
      }
      case "send": {
        const s = sess(body.sid);
        if (!s) { out = { ok: false, msg: "세션 없음" }; break; }
        const newMid = () => "m" + crypto.randomBytes(4).toString("hex");
        // items 가 있으면 모아 둔 글을 한 번에 넣는다(모두 넣거나 하나도 넣지 않는다)
        if (body.items !== undefined) {
          if (!Array.isArray(body.items) || !body.items.length || body.items.length > MSG_LIMITS.queued) { out = { ok: false, msg: `한 번에 1~${MSG_LIMITS.queued}개` }; break; }
          const inputs = body.items.map((x) => (isObj(x) ? { kind: x.kind, text: x.text, target: x.target ?? null, cid: x.cid ?? null } : null));
          const mids = inputs.map(newMid);
          const r = await submit(s, "board", "send", { items: inputs }, (sc, ctx) => evalSendMany(sc, inputs, ctx, mids));
          // done: 새로 넣었거나 이미 받은 글뿐(다시 보낸 묶음). 화면은 cids 로 모은 글에서 지운다
          out = r.done ? { ok: true, msg: r.msg, mids: r.mids, cids: inputs.map((x) => x.cid) } : { ok: false, msg: r.msg, ...(r.conflict && { conflict: r.conflict }) };
        } else {
          const input = { kind: body.kind, text: body.text, target: body.target ?? null, cid: body.cid ?? null };
          const mid = newMid();
          const r = await submit(s, "board", "send", input, (sc, ctx) => evalSend(sc, input, ctx, mid));
          out = r.res.length || r.done ? { ok: true, msg: r.msg, mid: r.mid || mid } : { ok: false, msg: r.msg, ...(r.conflict && { conflict: r.conflict }) };
        }
        // Codex 는 codex queue 를 부르는 동안(1초 안팎) 화면을 기다리게 하지 않는다. 결과는 SSE 로 간다
        if (out.ok) { if (isCodex(s)) deliverCodex(s); else await deliverTo(s); }
        break;
      }
      case "proj-new": {
        const name = cleanName(body.name);
        if (!name) { out = { ok: false, msg: "프로젝트 이름이 비었음" }; break; }
        out = await changeProjects((g) => {
          const pid = newProject(g, name);
          return pid ? { ok: true, msg: `프로젝트 ${name}`, pid } : { ok: false, msg: `프로젝트가 ${MAX_PROJECTS}개를 넘음` };
        });
        break;
      }
      case "proj-rename": {
        const name = cleanName(body.name);
        out = await changeProjects((g) => {
          if (!PID_RE.test(body.pid) || !Object.hasOwn(g.projects, body.pid)) return { ok: false, msg: "프로젝트 없음" };
          if (!name) return { ok: false, msg: "프로젝트 이름이 비었음" };
          g.projects[body.pid].name = name;
          return { ok: true, msg: `프로젝트 ${name}` };
        });
        break;
      }
      case "proj-done":
        out = await changeProjects((g) => {
          if (!PID_RE.test(body.pid) || !Object.hasOwn(g.projects, body.pid)) return { ok: false, msg: "프로젝트 없음" };
          g.projects[body.pid].done = body.done === true;
          return { ok: true, msg: body.done === true ? "끝으로 표시함" : "다시 진행으로 둠" };
        });
        break;
      case "proj-drop": {
        // 프로젝트를 푼다: 대화는 남고 「프로젝트 없음」 으로 간다. 큰 그림 기록은 휴지통으로(30일)
        const pid = body.pid;
        out = await changeProjects((g) => {
          if (!PID_RE.test(pid) || !Object.hasOwn(g.projects, pid)) return { ok: false, msg: "프로젝트 없음" };
          delete g.projects[pid];
          for (const [sid, m] of Object.entries(g.members)) if (m.pid === pid) delete g.members[sid];
          return { ok: true, msg: "프로젝트를 풀었음" };
        });
        if (!out.ok) break;
        const b = pboards.get(pid);
        if (b) {
          for (let c; c !== b.chain;) { c = b.chain; await c; }
          pboards.delete(pid);
          b.broken = true;
          let t = Date.now();
          while (fs.existsSync(path.join(trash, `${pid}.${t}.jsonl`))) t++;
          try { fs.renameSync(b.file, path.join(trash, `${pid}.${t}.jsonl`)); } catch (e) { if (e.code !== "ENOENT") log(`프로젝트 화판 옮기기 실패 ${pid}: ${e.message}`); }
        }
        sendAll("drop", [pid]);
        break;
      }
      case "proj-set": {
        // sids: 이어진 대화처럼 함께 옮길 세션들. 한 번에 바꿔, 빨리 두 번 옮겨도 세션마다 다른 프로젝트에 남지 않게 한다.
        // pid null 은 「프로젝트 없음」: 사용자가 뺀 것으로 남겨 자동으로 다시 넣지 않는다
        const ids = Array.isArray(body.sids) ? body.sids : [body.sid];
        out = await changeProjects((g) => {
          if (ids.length > 50) return { ok: false, msg: "한 번에 50개까지 옮깁니다" };
          if (!ids.length || !ids.every((id) => sess(id))) return { ok: false, msg: "세션 없음" };
          if (body.pid !== null && (!PID_RE.test(body.pid) || !Object.hasOwn(g.projects, body.pid))) return { ok: false, msg: "프로젝트 없음" };
          for (const id of ids) {
            joinIn(g, id, body.pid, "hand");
            // 이어받기 키가 있는 대화를 옮기면 그 키도 옮긴다. 다음에 그 문구로 이어받는 대화가 이 프로젝트로 온다
            const key = body.pid && sessions.get(id).scene.meta.handoff;
            if (key) claimKey(g, body.pid, key);
          }
          return { ok: true, msg: body.pid ? "프로젝트에 넣음" : "프로젝트에서 뺌" };
        });
        break;
      }
      case "config-set": {
        // 이어받기 문구(null 이면 끔)와 지난 대화를 휴지통으로 옮기는 날수(null 이면 끔, 없으면 그대로)
        const e = checkResume(body.resume ?? null) || (body.trashDays !== undefined && checkTrashDays(body.trashDays));
        if (e) { out = { ok: false, msg: e }; break; }
        out = await (configChain = configChain.then(async () => {
          const next = { ...config, resume: body.resume ? { phrase: body.resume.phrase, doc: body.resume.doc || "" } : null };
          if (body.trashDays !== undefined) next.trashDays = body.trashDays;
          await writeConfig(home, next);
          config = next;
          resume = resumeRule(config.resume);
          sendAll("config", configView());
          return { ok: true, msg: "설정을 저장함" };
        }).catch((err) => ({ ok: false, msg: `설정 저장 실패: ${err.message}` })));
        if (out.ok && body.trashDays !== undefined) sweepOld().catch((err) => log(`지난 대화 정리 실패: ${err.message}`));
        break;
      }
      case "sess-delete": {
        // 목록의 한 줄(이어진 대화들)을 지운다. 끝난 대화만 지우고, 기록은 휴지통으로 옮긴다(30일 뒤 비움)
        const ids = Array.isArray(body.sids) ? [...new Set(body.sids)] : [];
        if (ids.length > 50) { out = { ok: false, msg: "한 번에 50개까지 지웁니다" }; break; }
        if (!ids.length || !ids.every((id) => sess(id))) { out = { ok: false, msg: "세션 없음" }; break; }
        const moved = await trashSessions(ids);
        // 기다리는 사이 자동 정리가 먼저 옮긴 대화도 지운 것으로 센다(옮긴 뒤 같은 id 로 다시 생긴 대화는 옮긴 것으로 남는다)
        const gone = ids.filter((id) => moved.includes(id) || !sessions.has(id));
        if (!gone.length) { out = { ok: false, msg: "끝난 대화만 지웁니다" }; break; }
        const kept = ids.length - gone.length;
        out = { ok: true, msg: `대화 ${gone.length}개를 지움${kept ? ` · ${kept}개는 진행 중이라 남김` : ""}`, gone };
        break;
      }
      default:
        out = { ok: false, msg: "모르는 작업" };
    }
    return out;
  }

  // 받을 수 있는 id: 세션이나 프로젝트. 아직 한 번도 쓰지 않은 프로젝트도 받는다(큰 그림 화판은 처음 쓸 때 생기므로
  // 그 뒤의 변경(메타가 1번)을 받아야 한다)
  const watchable = (id) => typeof id === "string" && !!(boardOf(id) || (PID_RE.test(id) && Object.hasOwn(projects.projects, id)));
  // 아직 화판이 없는 프로젝트는 빈 장면을 보낸다(받는 쪽은 스냅샷을 받은 뒤의 변경만 쓴다)
  const snapOf = (res, sid) => { const s = boardOf(sid); write(res, "snap", s ? { id: s.sid, seq: s.seq, scene: s.scene } : { id: sid, seq: 0, scene: newScene() }); };
  function onEvents(req, res, wanted, chan) {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
    const l = { res, sids: new Set(watchable(wanted) ? [wanted] : []), chan: CHAN_RE.test(chan || "") ? chan : null };
    // 스냅샷과 구독 등록은 같은 동기 구간에서 한다(사이에 await 가 없어 그 사이 변경을 놓치지 않는다).
    // 프로젝트를 목록보다 먼저 보낸다: 화면이 프로젝트 id 를 보고 있으면 목록을 받을 때 그 id 를 알아야 한다
    write(res, "projects", projectsView());
    write(res, "config", configView());
    write(res, "list", [...sessions.values()].map(summary));
    for (const sid of l.sids) snapOf(res, sid);
    listeners.add(l);
    if (l.chan) chans.set(l.chan, l); // 같은 이름으로 다시 이으면(서버 재시작·연결 끊김) 새 연결이 이어받는다
    req.on("close", () => {
      listeners.delete(l);
      if (chans.get(l.chan) === l) chans.delete(l.chan);
    });
  }
  // 나눠 쓰는 연결의 구독을 바꾼다. sids = 이제 받을 id 전부. 새로 받는 id 와 fresh 에 든 id 는 같은 연결로 스냅샷을 보낸다
  // (탭이 빠진 사건을 알아채 다시 받으려 할 때 fresh). 스냅샷과 구독 변경은 같은 동기 구간에서 한다
  async function onSub(req, res) {
    const body = await readBody(req, SUB_MAX_BODY);
    const l = isObj(body) && typeof body.chan === "string" ? chans.get(body.chan) : undefined;
    if (!l) return text(res, 404, "연결이 없습니다");
    const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, MAX_SUBS) : []);
    const prev = l.sids, fresh = new Set(list(body.fresh));
    l.sids = new Set(list(body.sids).filter(watchable));
    for (const sid of l.sids) if (!prev.has(sid) || fresh.has(sid)) snapOf(l.res, sid);
    return json(res, 200, { ok: true, sids: [...l.sids] });
  }

  function sendFile(res, rel, type, cache = "no-cache") {
    const file = path.join(ROOT, rel);
    fs.stat(file, (err, st) => {
      if (err) return text(res, 404, "없음");
      res.writeHead(200, { "content-type": type, "content-length": st.size, "cache-control": cache });
      fs.createReadStream(file).pipe(res);
    });
  }

  async function handle(req, res) {
    await ready; // 기록을 다 읽기 전에 온 요청은 기다리게 한다
    res.setHeader("content-security-policy", CSP);
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("cross-origin-resource-policy", "same-origin");
    res.setHeader("cross-origin-opener-policy", "same-origin");
    // DNS rebinding 방지: 다른 이름으로 들어온 요청은 받지 않는다
    if (!new RegExp(`^(127\\.0\\.0\\.1|localhost):${boundPort}$`).test(req.headers.host || "")) return text(res, 403, "Host 가 맞지 않습니다");
    try {
      let url;
      try { url = new URL(req.url, "http://127.0.0.1"); } catch { return text(res, 400, "주소가 깨졌습니다"); }
      if (req.method === "POST" && (url.pathname === "/api/mcp" || url.pathname === "/api/hook" || url.pathname === "/api/inbox")) {
        const denied = writeDenied(req);
        if (denied) return text(res, ...denied);
        return url.pathname === "/api/mcp" ? await onMcp(req, res) : url.pathname === "/api/hook" ? await onHook(req, res) : await onInbox(req, res);
      }
      if (req.method === "POST" && url.pathname === "/api/sub") {
        const denied = pageDenied(req);
        if (denied) return text(res, ...denied);
        return await onSub(req, res);
      }
      if (req.method === "POST" && url.pathname === "/api/board") {
        const denied = boardDenied(req);
        if (denied) return text(res, ...denied);
        return await onBoard(req, res);
      }
      if (req.method !== "GET") return text(res, 405, "GET 만 받습니다");
      if (url.pathname === "/" && url.searchParams.has("t")) {
        if (!same(url.searchParams.get("t"), keys.read)) return text(res, 401, "읽기 토큰이 맞지 않습니다");
        // 쿠키를 심고 토큰 없는 주소로 보낸다(주소창·방문 기록에 토큰이 남지 않게)
        res.writeHead(302, { "set-cookie": `${COOKIE}=${keys.read}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`, location: "/", "cache-control": "no-store" });
        return res.end();
      }
      if (!readOk(req)) return url.pathname === "/" ? html(res, 401, LOCKED_PAGE) : text(res, 401, "읽기 토큰이 없습니다");
      if (STATIC[url.pathname]) return sendFile(res, ...STATIC[url.pathname]);
      if (url.pathname === "/api/sessions") return json(res, 200, [...sessions.values()].map(summary));
      const m = /^\/api\/sessions\/([A-Za-z0-9_-]{1,64})\/(snapshot|log)$/.exec(url.pathname);
      if (m) {
        const s = boardOf(m[1]);
        if (!s) return text(res, 404, "세션 없음");
        if (m[2] === "snapshot") return json(res, 200, { id: s.sid, seq: s.seq, scene: s.scene });
        // 재생 기록은 그때 파일에서 읽는다(메모리에 복사본을 두지 않는다). 모르는 판의 줄은 결과를 비워 서버와 같게 건너뛴다
        const { records } = parseRecords(await fsp.readFile(s.file, "utf8"));
        return json(res, 200, records.map((r) => ({ seq: r.seq, t: r.t, res: r.v === RECORD_VERSION && Array.isArray(r.res) ? r.res : [] })));
      }
      if (url.pathname === "/events") return onEvents(req, res, url.searchParams.get("session"), url.searchParams.get("chan"));
      return text(res, 404, "없음");
    } catch (e) {
      if (!e.status) log(`요청 처리 실패: ${e.stack || e.message}`);
      if (!res.headersSent) return text(res, e.status || 500, e.status ? e.message : "서버 오류");
      res.end();
    }
  }

  // 포트를 먼저 잡고 나서 기록을 읽는다. 여러 세션이 동시에 띄워 포트 경쟁에서 진 서버가 기록을 건드리지 않게 한다
  let markReady;
  const ready = new Promise((ok) => { markReady = ok; });
  // 처리 중 예외가 새어 나가도 서버 프로세스가 죽지 않게 한다
  const server = http.createServer((req, res) => handle(req, res).catch((e) => {
    log(`요청 처리 실패: ${e.stack || e.message}`);
    if (!res.headersSent) text(res, 500, "서버 오류"); else res.end();
  }));
  await new Promise((ok, fail) => { server.once("error", fail); server.listen(port, "127.0.0.1", ok); });
  boundPort = server.address().port;
  try { loadAll(); await migrate(); } catch (e) { server.close(); throw e; }
  markReady();
  const purge = () => {
    try { purgeTrash(home); } catch (e) { log(`휴지통 비우기 실패: ${e.message}`); }
    sweepOld().catch((e) => log(`지난 대화 정리 실패: ${e.message}`));
  };
  purge();
  const liveTimer = setInterval(() => { checkLive(); expireOld(); }, LIVE_CHECK_MS);
  const pingTimer = setInterval(() => { for (const l of listeners) l.res.write(": ping\n\n"); }, 20_000);
  const purgeTimer = setInterval(purge, 3_600_000);
  liveTimer.unref();
  pingTimer.unref();
  purgeTimer.unref();

  async function close() {
    clearInterval(liveTimer);
    clearInterval(pingTimer);
    clearInterval(purgeTimer);
    for (const sid of [...waiters.keys()]) release(sid); // 화면에 알리는 것이 있으므로 SSE 를 닫기 전에
    for (const l of listeners) l.res.end();
    // 보내는 중인 codex queue 의 결과를 기록한 뒤에 닫는다(기록 전에 닫으면 다시 띄운 서버가 같은 글을 또 보낸다). 시간 초과로 끝이 정해져 있다
    await Promise.all([...sessions.values()].map((s) => s.qjob));
    await Promise.all([...sessions.values(), ...pboards.values()].map((s) => s.chain));
    await new Promise((ok) => server.close(ok));
  }
  return { port: boundPort, close, checkLive, sweep: sweepOld, sessions, pids, waiters, pboards, get projects() { return projects; }, get config() { return config; }, get listeners() { return listeners.size; } };
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function text(res, status, body) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}
function json(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}
function html(res, status, body) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}
