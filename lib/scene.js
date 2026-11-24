// 장면 모델: 명령(plan·draw·note)과 훅 사실을 검사해 「결과(res)」를 만들고, 결과를 장면에 적용한다.
// 시계·DOM·파일에 기대지 않는다. 서버와 브라우저(재생)가 이 파일 하나를 같이 쓴다.
// 기록에는 결과가 남고 재생은 applyRes 만 쓴다. 그래서 명령 규칙이 바뀌어도 옛 기록은 같게 재생된다.

export const RECORD_VERSION = 1;
export const STATUSES = ["todo", "doing", "done", "fail", "blocked", "wait"];
export const NOTE_KINDS = ["why", "decision", "blocked", "wait"];
// __proto__ 는 보통 객체 사전에 넣으면 프로토타입이 바뀌므로 받지 않는다
export const ID_RE = /^(?!__proto__$)[A-Za-z0-9_.:-]{1,64}$/;
export const LIMITS = { label: 80, note: 300, text: 2000, src: 4000, ref: 300, ops: 50, parts: 500, depth: 3, drawDepth: 4, cols: 8, rows: 40, cell: 120 };
// 상자 모양과 아이콘. 아이콘 그림은 web/index.html 의 ic-<이름> 심벌이다
export const SHAPES = ["rect", "round", "circle", "diamond", "hexagon", "cylinder", "doc"];
export const ICONS = ["server", "db", "file", "folder", "user", "users", "cloud", "code", "terminal", "bug", "test", "lock", "key", "gear", "phone", "monitor", "chart", "mail", "clock", "search", "warn", "net", "pkg", "branch", "link"];

// kind 마다 받는 필드. 여기에 없는 필드는 무시하고 결과에 알린다
const DRAW_FIELDS = {
  box: ["label", "status", "ref", "note", "in", "shape", "icon"],
  group: ["label", "status", "in"],
  edge: ["from", "to", "label", "status"],
  list: ["label", "in"],
  item: ["label", "status", "ref", "in"],
  table: ["label", "status", "note", "in", "cols", "rows"],
  progress: ["label", "value", "max", "in"],
  text: ["label", "text", "in"],
  mermaid: ["label", "status", "src", "in"],
};
export const DRAW_KINDS = Object.keys(DRAW_FIELDS);
const STEP_FIELDS = ["title", "status", "parent", "note"];
const OPEN_RUN = new Set(["running", "wait"]);

export function newScene() {
  return {
    meta: {},          // id, cwd, pid, startedAt
    items: {},         // id → 단계(kind "step") 또는 부품
    counter: 0,        // 만든 순서(ord)·진행이 된 순서(doingOrd)에 쓰는 증가값
    view: { dir: "RIGHT" },
    cur: [],           // 지금 단계가 바뀐 이력 [{t, id}]
    timeline: [],      // 사실·노트·실행 자리 {type, seq, t, …}
    runs: {},          // tool_use_id → 명령 실행
    sess: { status: "idle", lastT: 0, title: "" }, // name: 화판에서 붙인 이름, claudeName: Claude Code 의 /rename 이름
    msgs: {},          // 화판에서 Claude 에 보낸 메시지 mid → {mid, target, kind, text, state, t, sentT}
    agents: {},        // 하위 에이전트 id → {id, type, desc, startT, stopT}(이름표)
    explains: {},      // 판서: 작업 id(평평한 계획·계획 없음은 "") → {key, task, t, ord, page}
    partial: false,    // 모르는 결과를 만나 일부만 재생했는가
  };
}

// 결과를 장면에 적용한다. 재생과 실시간이 모두 이 함수만 쓴다
export function applyRes(scene, res) {
  for (const r of res) {
    switch (r.k) {
      case "put":
        scene.items[r.v.id] = r.v;
        scene.counter = Math.max(scene.counter, r.v.ord || 0, r.v.doingOrd || 0);
        break;
      case "del": delete scene.items[r.id]; break;
      case "view": Object.assign(scene.view, r.v); break;
      case "cur": scene.cur.push(r.v); break;
      case "tl": scene.timeline.push(r.v); break;
      case "run": scene.runs[r.v.id] = r.v; break;
      case "sess": Object.assign(scene.sess, r.v); break;
      case "meta": Object.assign(scene.meta, r.v); break;
      case "msg": scene.msgs ||= {}; scene.msgs[r.v.mid] = { ...own(scene.msgs, r.v.mid), ...r.v }; break;
      // 시작·설명·끝이 따로 도착하므로 필드마다 합친다
      case "agent": scene.agents ||= {}; scene.agents[r.v.id] = { ...own(scene.agents, r.v.id), ...r.v }; break;
      // 판서 한 장. 같은 작업(key)의 장은 통째로 바뀐다
      case "explain": scene.explains ||= {}; scene.explains[r.v.key] = r.v; break;
      // 수정의 바뀐 줄. 장면(메모리)에 두지 않고, 화면이 줄을 누를 때 서버가 기록 파일에서 읽어 준다
      case "diff": break;
      default: scene.partial = true;
    }
  }
  return scene;
}

// id 로 찾기. 사전이 보통 객체라 "constructor" 같은 내장 속성 이름을 부품으로 착각하지 않게 자기 속성만 본다
export const own = (dict, id) => (typeof id === "string" && Object.hasOwn(dict, id) ? dict[id] : undefined);

// 지금 단계 = 가장 최근에 진행(doing)이 된 단계. 그 뒤 막힘·승인 대기가 되어도 지금 단계로 남는다
const ACTIVE = new Set(["doing", "blocked", "wait"]);
export function currentStep(scene) {
  return currentIn(Object.values(scene.items));
}

// 가장 나중에 진행으로 둔 단계이고, 그 아래에 그 단계와 같은 때나 그 뒤에 진행·막힘·대기가 된(since) 하위 단계가 있으면 그 가운데
// 가장 나중에 진행으로 둔 것으로 내려간다(한 호출에서 작업을 하위 단계보다 뒤에 진행으로 두어도 지금 단계는 하위 단계다).
// 앞서 닫지 않고 남은 하위 단계는 그 작업을 다시 열어도 지금 단계가 되지 않는다
function currentIn(items) {
  const live = items.filter((it) => it.kind === "step" && ACTIVE.has(it.status) && it.doingOrd);
  const latest = (list) => list.reduce((best, it) => (!best || it.doingOrd > best.doingOrd ? it : best), null);
  let best = latest(live);
  for (let i = 0; best && i < 100; i++) {
    const kid = latest(live.filter((it) => it.parent === best.id && (it.since ?? 0) >= (best.since ?? 0)));
    if (!kid) break;
    best = kid;
  }
  return best ? best.id : null;
}

// 세션 목록 줄에 보일 한 대화의 지금: 지금 단계(제목·상태)와, 아직 답을 받지 않은 결정 대기·막힘 하나와 그 글.
// 결정 대기가 있으면 결정 대기(사용자가 할 일), 없으면 막힘이다. 글은 그 종류의 가장 최근 메모 가운데 지금의 대기·막힘을 세운
// 것이고(LLM 이 무엇을 기다리는지 적은 글), 그런 메모가 없으면 가장 나중에 올린 그 단계·부품의 메모·이름이다.
// 지금의 대기·막힘을 세운 메모: 붙은 단계·부품이 아직 그 상태이고, 그 상태가 된 뒤(since)에 썼고, 결정 대기면 마지막 사용자 입력
// 뒤에 썼다(입력이 그 앞의 대기에 답했다. 같은 단계를 plan 으로 다시 대기로 두면 상태가 그대로라 since 가 바뀌지 않는다).
// 끝난 대화는 싣지 않는다(지금 단계도, 더 할 수 있는 일이 없는 대기·막힘도. 화면의 주의 띠와 같다)
export function overview(scene) {
  if (scene.sess.status === "ended") return { cur: null, hold: null };
  const id = currentStep(scene), st = id ? own(scene.items, id) : null;
  const cur = st ? { title: st.title, status: st.status } : null;
  const open = (x, k) => !!x && x.kind !== "edge" && (k === "wait" ? x.status === "wait" && !x.answered : x.status === "blocked");
  const items = Object.values(scene.items);
  const kind = items.some((x) => open(x, "wait")) ? "wait" : items.some((x) => open(x, "blocked")) ? "blocked" : null;
  if (!kind) return { cur, hold: null };
  // on 이 없는 메모는 그때의 지금 단계에 붙었다
  for (let i = scene.timeline.length - 1; i >= 0; i--) {
    const e = scene.timeline[i];
    if (kind === "wait" && e.type === "fact" && e.f === "prompt" && !e.sys) break;
    const it = e.type === "note" && e.kind === kind ? own(scene.items, e.on || e.step) : null;
    if (open(it, kind) && !((e.t || 0) < (it.since || 0))) return { cur, hold: { kind, text: String(e.text).slice(0, 600) } };
  }
  const it = items.filter((x) => open(x, kind)).sort((x, y) => (y.ord || 0) - (x.ord || 0))[0];
  return { cur, hold: { kind, text: String(it.note || (it.kind === "step" ? it.title : it.label) || it.id).slice(0, 600) } };
}

// 세션 목록 카드의 「이번 차례」: 차례가 시작된 뒤에 고친 파일 수(같은 파일은 한 번), 실행한 명령 수, 실패한 명령 수와 가장 늦게
// 실패한 명령(설명이나 명령 앞부분), 차례를 연 글과 이 차례의 마지막 답의 첫 줄. 차례의 시작은 마지막 사용자 입력과, 쉬는 동안 화판에서
// 보내 Claude 가 받은 글(sentT) 가운데 늦은 것이다. 한 번에 받은 글이 여럿이면 그 글 모두가 차례를 연 글이다. 작업 중에 받은 글(inTurn:
// 앞 차례의 Stop 훅이 다음 차례까지 기다리다 받아 감)은 그 차례 안에서 읽으므로 차례를 열지 않는다.
// 타임라인은 서버가 받은 차례라 입력은 그 자리 뒤로, 화판 글은 받아 간 시각 뒤로 가른다.
// 같은 ms 에 그보다 먼저 찍힌 앞 차례의 답(Stop 훅이 답을 올리고 곧바로 글을 받아 감)은 넣지 않는다. 하위 에이전트가 한 일도 센다
const firstLine = (t, n = 300) => { const l = (String(t || "").split("\n").find((x) => x.trim()) || "").trim(); return l.length > n ? l.slice(0, n - 1) + "…" : l; };
export function recent(scene) {
  let from = 0, at = -1, sent = false, ask = "";
  for (let i = scene.timeline.length - 1; i >= 0; i--) {
    const e = scene.timeline[i];
    if (e.type === "fact" && e.f === "prompt" && !e.sys) { from = e.t || 0; at = i; ask = e.text; break; }
  }
  const got = Object.values(scene.msgs || {}).filter((m) => m.state === "sent" && !m.inTurn && (m.sentT || 0) > from);
  if (got.length) {
    from = Math.max(...got.map((m) => m.sentT));
    sent = true;
    ask = got.filter((m) => m.sentT === from).sort((a, b) => a.t - b.t).map((m) => firstLine(m.text)).join(" · ");
  }
  const files = new Set();
  let cmds = 0, fails = 0, failName = "", failT = -1, ans = "";
  for (let i = scene.timeline.length - 1; i > at && (!sent || (scene.timeline[i].t || 0) > from); i--) {
    const e = scene.timeline[i];
    if (e.type === "fact" && e.f === "edit" && e.path) files.add(normPath(e.path, scene.meta.cwd));
    else if (e.type === "fact" && e.f === "stop" && !ans) ans = firstLine(e.last);
    else if (e.type === "run") {
      const r = own(scene.runs, e.id);
      if (!r) continue;
      cmds++;
      if (r.state !== "fail") continue;
      fails++;
      const at = r.end ?? r.start ?? 0;
      if (at > failT) { failT = at; failName = firstLine(r.desc || r.cmd, 40); }
    }
  }
  return { files: files.size, cmds, fails, failName, ask: firstLine(ask), ans };
}

// 훅 시각 ht 때 지금이던 단계
export function stepAt(scene, ht) {
  for (let i = scene.cur.length - 1; i >= 0; i--) if (scene.cur[i].t <= ht) return scene.cur[i].id;
  return null;
}

// ---- 한 호출 안의 임시 상태 ----
// 바뀐 것만 덧칠해 두었다가 끝에서 결과로 바꾼다. 같은 호출의 앞 op 가 만든 부품을 뒤 op 가 쓸 수 있다
function draft(scene) {
  const over = new Map(), gone = new Set(), touched = [];
  const touch = (id) => { if (!touched.includes(id)) touched.push(id); };
  const d = {
    counter: scene.counter,
    get(id) { return gone.has(id) ? undefined : over.has(id) ? over.get(id) : own(scene.items, id); },
    put(v) { gone.delete(v.id); over.set(v.id, v); touch(v.id); },
    del(id) { over.delete(id); gone.add(id); touch(id); },
    all() {
      const out = [];
      for (const id of Object.keys(scene.items)) if (!gone.has(id) && !over.has(id)) out.push(scene.items[id]);
      for (const v of over.values()) out.push(v);
      return out;
    },
    res() {
      const res = [];
      for (const id of touched) {
        if (gone.has(id)) { if (scene.items[id]) res.push({ k: "del", id }); }
        else res.push({ k: "put", v: over.get(id) });
      }
      return res;
    },
  };
  return d;
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const short = (v) => String(v).slice(0, 20);
// 표의 한 줄(또는 머리글): 글 칸 배열
const cells = (v) => Array.isArray(v) && v.length <= LIMITS.cols && v.every((c) => typeof c === "string" && c.length <= LIMITS.cell);

function checkField(f, val) {
  switch (f) {
    case "label": case "title": return typeof val === "string" && val.length <= LIMITS.label ? null : `${f} 은 ${LIMITS.label}자 이하 글`;
    case "note": return typeof val === "string" && val.length <= LIMITS.note ? null : `note 는 ${LIMITS.note}자 이하 글`;
    case "text": return typeof val === "string" && val.length <= LIMITS.text ? null : `text 는 ${LIMITS.text}자 이하 글`;
    case "src": return typeof val === "string" && val.length <= LIMITS.src ? null : `src 는 ${LIMITS.src}자 이하 글`;
    // ref 는 누르면 클립보드로 간다. 줄바꿈 같은 제어 문자가 있으면 터미널에 붙였을 때 명령이 되므로 받지 않는다
    case "ref": return typeof val === "string" && val.length <= LIMITS.ref && !/[\x00-\x1f\x7f]/.test(val) ? null : `ref 는 제어 문자 없는 ${LIMITS.ref}자 이하 글`;
    case "status": return STATUSES.includes(val) ? null : `status '${short(val)}' 모름`;
    case "in": case "parent": case "from": case "to": return typeof val === "string" && ID_RE.test(val) ? null : `${f} 는 id`;
    case "value": case "max": return typeof val === "number" && Number.isFinite(val) && val >= 0 ? null : `${f} 는 0 이상 수`;
    case "shape": return SHAPES.includes(val) ? null : `shape '${short(val)}' 모름(${SHAPES.join("·")})`;
    case "icon": return ICONS.includes(val) ? null : `icon '${short(val)}' 모름`;
    case "cols": return cells(val) ? null : `cols 는 ${LIMITS.cols}개 이하 글 배열(칸마다 ${LIMITS.cell}자 이하)`;
    case "rows": return Array.isArray(val) && val.length <= LIMITS.rows && val.every(cells) ? null : `rows 는 ${LIMITS.rows}줄 이하, 줄마다 ${LIMITS.cols}칸 이하 글 배열(칸마다 ${LIMITS.cell}자 이하)`;
    default: return null;
  }
}

// 조상 수와 아래로 가장 깊은 자손까지의 단 수. 자기 단(1) + 부모의 조상 수 + 부모(1) + 자손 단 수가 한도(계획 LIMITS.depth,
// 그림 LIMITS.drawDepth)를 넘으면 거부한다. 그림은 작업마다 묶음 하나로 감싸므로(25) 계획보다 한 단 더 둔다
function depthOf(d, id, key) {
  let n = 0;
  for (let p = d.get(id)?.[key]; p && n <= LIMITS.drawDepth + 1; p = d.get(p)?.[key]) n++;
  return n;
}
function heightOf(d, id, key, all = d.all()) {
  let h = 0;
  for (const it of all) if (it[key] === id) h = Math.max(h, 1 + heightOf(d, it.id, key, all));
  return h;
}
// parent 를 id 의 부모로 두면 돌아서 자기에게 오는가
function makesCycle(d, id, parent, key) {
  for (let p = parent, n = 0; p && n < 100; p = d.get(p)?.[key], n++) if (p === id) return true;
  return false;
}

// 부품과 그 자손, 이어진 화살표를 함께 지운다
function removeCascade(d, rootId, key) {
  const all = d.all(), doomed = new Set([rootId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const it of all) if (!doomed.has(it.id) && it[key] && doomed.has(it[key])) { doomed.add(it.id); grew = true; }
  }
  if (key === "in") for (const it of all) if (it.kind === "edge" && (doomed.has(it.from) || doomed.has(it.to))) doomed.add(it.id);
  for (const id of doomed) d.del(id);
}

// 사용자가 다음 입력을 했으면 승인 대기를 「답 받음」 으로 둔다. 단계와 그림 부품 모두(선의 대기 무늬는 그대로)
// 승인 대기에 「답 받음」 을 붙인다. 서버가 끝난 단계에 붙인 대기(back)는 답을 받으면 원래 상태(끝·실패)로 돌린다
function answerWaits(d) {
  for (const it of d.all()) {
    if (it.status !== "wait" || it.answered || it.kind === "edge") continue;
    if (it.back) { const { back, ...v } = it; d.put({ ...v, status: back }); }
    else d.put({ ...it, answered: true });
  }
}

// ---- draw ----
export function evalDraw(scene, input, ctx) {
  const d = draft(scene), errs = [], rejected = new Set(), ignored = [], overlap = [], extra = [];
  if (!isObj(input)) return { res: [], msg: "입력이 객체가 아님" };
  const ops = input.ops === undefined ? [] : input.ops;
  if (!Array.isArray(ops)) return { res: [], msg: "ops 는 배열" };
  if (input.clear === true) for (const it of d.all()) if (it.kind !== "step") d.del(it.id);
  if (input.dir !== undefined) {
    if (input.dir === "RIGHT" || input.dir === "DOWN") { if (input.dir !== scene.view.dir) extra.push({ k: "view", v: { dir: input.dir } }); }
    else errs.push(`dir '${short(input.dir)}' 모름(RIGHT·DOWN)`);
  }
  let applied = 0, shaped = input.clear === true;
  ops.forEach((op, i) => {
    if (i >= LIMITS.ops) { if (i === LIMITS.ops) errs.push(`op ${LIMITS.ops}개 넘음: ${i + 1}번부터 거부`); return; }
    const before = isObj(op) ? d.get(op.id) : undefined;
    const e = drawOp(d, op, rejected, ignored, overlap, ctx?.t);
    if (e) { errs.push(e); if (isObj(op) && typeof op.id === "string") rejected.add(op.id); return; }
    applied++;
    // 만들기·지우기, 또는 상태·메모가 아닌 필드의 값이 실제로 바뀌었으면 그림의 내용을 바꾼 것이다(무시한 필드·같은 값은 아님)
    const after = d.get(op.id);
    if (!before || !after || CONTENT_FIELDS.some((f) => JSON.stringify(before[f]) !== JSON.stringify(after[f]))) shaped = true;
  });
  // 그림을 마지막으로 바꾼 시각(drawT)과 내용을 바꾼 시각(shapeT). 새 작업(view.taskT)보다 오래된 그림인지 가리는 데 쓴다
  if ((applied || input.clear === true) && ctx?.t) extra.push({ k: "view", v: { drawT: ctx.t, ...(shaped && { shapeT: ctx.t }) } });
  const res = [...d.res(), ...extra];
  let msg = `적용 ${applied}`;
  if (input.clear === true) msg = "비움 · " + msg;
  if (errs.length) msg += ` · 거부 ${errs.length}: ${errs.slice(0, 6).join("; ")}`;
  if (ignored.length) msg += ` · 무시한 필드: ${ignored.slice(0, 6).join(", ")}`;
  if (overlap.length) msg += ` · label 겹침: ${overlap.slice(0, 6).join(", ")}`;
  return { res, msg };
}

function drawOp(d, op, rejected, ignored, overlap, t) {
  if (!isObj(op)) return "op 가 객체가 아님";
  const id = op.id;
  if (typeof id !== "string" || !ID_RE.test(id)) return `id '${short(id)}' 모양이 틀림`;
  const old = d.get(id);
  if (old && old.kind === "step") return `${id} 는 단계 id(plan 으로 다룸)`;
  if (op.del === true) {
    if (!old) return `${id} 없음`;
    removeCascade(d, id, "in");
    return null;
  }
  if (!old && op.kind === undefined) return `${id} 새 부품은 kind 필요`;
  if (old && op.kind !== undefined && op.kind !== old.kind) return `${id} kind 를 바꿀 수 없음`;
  const kind = old ? old.kind : op.kind;
  const fields = own(DRAW_FIELDS, kind);
  if (!fields) return `${id} kind '${short(kind)}' 모름`;
  if (!old && d.all().filter((it) => it.kind !== "step").length >= LIMITS.parts) return `${id} 부품 ${LIMITS.parts}개 넘음`;

  const next = old ? { ...old } : { id, kind, ord: ++d.counter };
  for (const [f, val] of Object.entries(op)) {
    if (f === "id" || f === "kind" || f === "del") continue;
    if (!fields.includes(f)) { ignored.push(`${id}.${f}`); continue; }
    if (val === null) {
      if (f === "from" || f === "to") return `${id} ${f} 는 지울 수 없음`;
      delete next[f];
      continue;
    }
    const e = checkField(f, val);
    if (e) return `${id} ${e}`;
    next[f] = val;
  }

  if (old && (next.status !== old.status || op.status === "wait")) delete next.answered; // 상태가 바뀌거나 대기를 다시 보내면 새 질문이다
  if (t && next.status && next.status !== old?.status) next.since = t; // 그 상태가 된 때(목록 줄의 결정 대기·막힘 글이 지금의 대기·막힘을 세운 메모를 가린다)

  if (kind === "edge") {
    if (old) {
      if ((op.from !== undefined && op.from !== old.from) || (op.to !== undefined && op.to !== old.to)) return `${id} from·to 는 만들 때만 정함`;
    } else {
      if (!next.from || !next.to) return `${id} edge 는 from·to 필요`;
      for (const end of ["from", "to"]) {
        const t = d.get(next[end]);
        if (!t) return `${id} ${end} '${next[end]}' ${rejected.has(next[end]) ? "거부됨" : "없음"}`;
        if (t.kind === "edge" || t.kind === "step") return `${id} ${end} '${next[end]}' 은 ${t.kind === "edge" ? "화살표" : "단계"}`;
        // 목록 항목은 목록 안의 한 줄이라 첫 판에서는 화살표를 잇지 않는다(이으면 목록 테두리에 붙어 뜻이 흐려진다)
        if (t.kind === "item") return `${id} ${end} '${next[end]}' 은 목록 항목(화살표는 list 나 box 에 이음)`;
      }
    }
  }

  if (op.in !== undefined && op.in !== null) {
    const p = d.get(op.in);
    if (!p) return `${id} in '${op.in}' ${rejected.has(op.in) ? "거부됨" : "없음"}`;
    const okParent = kind === "item" ? p.kind === "list" || p.kind === "item" : p.kind === "group";
    if (!okParent) return `${id} in '${op.in}' 은 ${p.kind}(${kind === "item" ? "list·item" : "group"} 이어야 함)`;
    if (makesCycle(d, id, op.in, "in")) return `${id} in 이 돌아서 자기에게 옴`;
    if (depthOf(d, op.in, "in") + 2 + heightOf(d, id, "in") > LIMITS.drawDepth) return `${id} ${LIMITS.drawDepth}단보다 깊음`;
  }
  if (kind === "item" && !next.in) return `${id} item 은 in(list) 필요`;

  // 화면에서 옮긴 자리(pos)는 묶음 기준이라 묶음이 바뀌면 버린다
  if (old && old.pos && (next.in ?? null) !== (old.in ?? null)) delete next.pos;
  if (next.label && (!old || op.label !== undefined)) {
    const twin = d.all().find((it) => it.id !== id && it.kind === kind && it.label === next.label);
    if (twin) overlap.push(`${id}(=${twin.id})`);
  }
  d.put(next);
  return null;
}

// ---- plan ----
export function evalPlan(scene, input, ctx) {
  if (!isObj(input) || !Array.isArray(input.steps) || input.steps.length === 0) return { res: [], msg: "steps 배열이 필요함" };
  const d = draft(scene), errs = [], ignored = [];
  const before = currentStep(scene);
  let applied = 0;
  const fresh = new Set();
  input.steps.forEach((st, i) => {
    if (i >= LIMITS.ops) { if (i === LIMITS.ops) errs.push(`단계 ${LIMITS.ops}개 넘음`); return; }
    // 제목이 붙은 새 단계: 처음 보는 id 이거나, 끝난(done·fail) 단계의 id 를 새 제목으로 다시 쓴 것.
    // 이미 있던 단계 아래에 붙인 하위 단계는 그 작업을 나눈 것이라 세지 않는다
    const prev = isObj(st) ? own(scene.items, st.id) : undefined;
    const isFresh = isObj(st) && st.del !== true && typeof st.title === "string" &&
      (!prev || (prev.title !== st.title && FINISHED.has(prev.status))) &&
      !(st.parent != null && own(scene.items, st.parent) && !fresh.has(st.parent));
    const e = planOp(d, st, ctx, ignored);
    if (e) errs.push(e); else { applied++; if (isFresh) fresh.add(st.id); }
  });
  const res = d.res();
  const all = d.all(), after = currentIn(all);
  if (after !== before) res.push({ k: "cur", v: { t: ctx.t, id: after } });
  const steps = all.filter((it) => it.kind === "step"), doing = steps.filter((s) => s.status === "doing");
  let msg = `계획 ${steps.length}단계` + (after ? ` · 지금 ${after}` : "");
  if (applied < input.steps.length) msg = `적용 ${applied} · ` + msg;
  if (doing.length > 1) msg += ` · doing ${doing.length}: ${doing.sort((a, b) => a.ord - b.ord).map((s) => s.id).slice(0, 6).join(" ")}`;
  if (errs.length) msg += ` · 거부 ${errs.length}: ${errs.slice(0, 6).join("; ")}`;
  if (ignored.length) msg += ` · 무시한 필드: ${ignored.slice(0, 6).join(", ")}`;
  // 이 호출이 진행으로 둔 단계의 맨 위 단계(작업). 닫기만 한 호출은 지금 단계가 옛 단계로 돌아가도 일을 옮긴 것이 아니므로 보지 않는다.
  // 마지막으로 일한 작업은 view.taskTop 에 남겨, 지금 단계가 비거나 지워져도 다음 호출이 견줄 수 있게 한다
  const tree = planTree(steps);
  const started = input.steps.filter((st) => isObj(st) && st.status === "doing" && tree.byId.get(st.id)?.status === "doing").map((st) => st.id);
  const lead = started.includes(after) ? after : started.at(-1), top = lead && tree.topOf(lead);
  // 마지막 작업은 이 호출 뒤의 나무에서 다시 찾는다(평평한 계획을 나중에 작업 아래로 묶으면 옛 단계의 맨 위가 바뀐다).
  // 기록이 없으면(1.7.0 앞 판 기록) 호출 전 지금 단계의 맨 위를 쓴다
  const lastTop = tree.topOf(scene.view.taskTop ?? before) ?? scene.view.taskTop;
  if (top && top !== scene.view.taskTop) res.push({ k: "view", v: { taskTop: top } });
  // 하위 에이전트도 같은 세션 화판에 쓰고, 서버는 누가 불렀는지 모른다. 하위 에이전트가 도는 동안에는 새 작업도 알림도 따지지 않는다
  if (!agentRunning(scene, ctx.t)) {
    // 새 작업: 새 단계가 둘 이상이고, 지금 단계가 그 새 단계로 옮겨 갔다(진행 중인 작업에 단계를 덧붙인 것은 빼려고).
    // 또는 작업으로 짠 계획(하위 단계가 있는 단계가 하나라도 있음)에서 이 호출이 다른 위 단계(작업)나 그 단계를 진행으로 두었다
    // (미리 올려 둔 다음 작업을 시작함. 그 작업의 하위 단계는 다음 호출에 붙여도 된다).
    // 평평한 계획은 이 규칙에 걸리지 않고, 지금 단계를 나누는 것은 맨 위가 그대로다
    const taskMoved = !!top && tree.parents.size > 0 && top !== lastTop;
    if ((fresh.size >= TASK_STEPS && (!after || fresh.has(after))) || taskMoved) { res.push({ k: "view", v: { taskT: ctx.t } }); msg += leftoverHint(steps, fresh, tree, (after && tree.topOf(after)) || top); }
    // 작업을 끝내는 호출(진행·막힘·대기 단계가 하나도 남지 않음)에는 알리지 않는다. 답만 남아 그림을 그릴 다음 도구 호출이 없다.
    // 지금 단계(after)로 보지 않는 것은 처음부터 대기·막힘으로 올린 단계는 지금 단계가 되지 않기 때문이다
    else if (steps.some((s) => OPEN_STEP.has(s.status))) {
      const hint = staleHint(scene, all);
      if (hint) { msg += hint; res.push({ k: "view", v: { hintT: scene.view.taskT } }); }
    }
  }
  return { res, msg };
}

// 새 작업 = 제목이 붙은 새 단계를 둘 이상 올리고 지금 단계를 그리로 옮긴 plan 호출. 그 시각이 view.taskT 다
const TASK_STEPS = 2;
const FINISHED = new Set(["done", "fail"]);
// 그림의 내용 필드(상태·메모 말고). 이 값이 바뀌어야 그림을 새로 그린 것으로 친다
const CONTENT_FIELDS = [...new Set(Object.values(DRAW_FIELDS).flat())].filter((f) => f !== "status" && f !== "note");
// 열린 단계: 이것이 하나도 없는 plan 호출은 작업을 끝내는 호출이다
const OPEN_STEP = new Set(["doing", "blocked", "wait"]);
// 같은 메시지에서 plan 앞뒤로 온 draw 를 그 작업의 그림으로 칠 여유
export const DRAW_SLACK = 10_000;
// 하위 에이전트의 시작·끝을 이만큼 지난 기록까지 본다(끝 사실을 잃은 경우를 오래 끌지 않게)
const AGENT_WINDOW = 2 * 3600_000;

// 그림이 지금 작업보다 오래됐는가. 새 작업 앞뒤 10초 안에 내용을 바꿨거나(만들기·지우기·글), 그 뒤에 상태라도 바꿨으면 그 작업의 그림이다.
// 새 작업 바로 앞뒤에 상태만 바꾼 것은 앞 작업의 부품을 닫은 것으로 본다. 부품이 있는지는 부르는 쪽이 본다
export function drawingStale(view) {
  return !!view.taskT && !(view.shapeT >= view.taskT - DRAW_SLACK) && !(view.drawT >= view.taskT + DRAW_SLACK);
}

// 하위 에이전트가 도는 중인가: 최근 기록에 시작은 있고 같은 id 의 끝은 없는 하위 에이전트가 있다.
// 훅은 따로 도착해 끝이 시작보다 먼저 올 수 있으므로 순서와 상관없이 짝짓는다. 끝만 오는 에이전트는 알 수 없다
function agentRunning(scene, t) {
  const started = new Set(), stopped = new Set();
  for (let i = scene.timeline.length - 1; i >= 0; i--) {
    const e = scene.timeline[i];
    if (e.t < t - AGENT_WINDOW) break;
    if (e.type !== "fact" || !e.agent) continue;
    if (e.f === "agent-stop") stopped.add(e.agent);
    else if (e.f === "agent-start") started.add(e.agent);
  }
  for (const a of started) if (!stopped.has(a)) return true;
  return false;
}

// 이름표 칸·세션 줄에 보일 도는 하위 에이전트(시작 순). 끝을 잃은 것은 두 시간 뒤 돌지 않는 것으로 본다
export function agentsRunning(scene, now) {
  if (scene.sess.status === "ended") return [];
  return Object.values(scene.agents || {}).filter((a) => a.startT && !a.stopT && now - a.startT < AGENT_WINDOW).sort((a, b) => a.startT - b.startT);
}

// 이름표 칸·세션 줄에 보일 도는 다른 LLM 명령(시작 순). 뒤에서 실행한 것은 끝 알림·멈춤까지 돈다. 그래도 끝을 잃은 것은 두 시간 뒤 돌지 않는 것으로 본다
export const llmSince = (r) => r.start ?? r.end ?? 0; // 시작 사실을 잃었으면 뒤로 넘긴 때부터 센다
export function llmRunning(scene, now) {
  if (scene.sess.status === "ended") return [];
  return Object.values(scene.runs).filter((r) => r.llm && (OPEN_RUN.has(r.state) || r.state === "background") && now - llmSince(r) < AGENT_WINDOW).sort((a, b) => llmSince(a) - llmSince(b));
}
// [[이름, 수], …](세션 줄의 「Codex 2」)
export const llmCounts = (runs) => [...runs.reduce((m, r) => m.set(r.llm, (m.get(r.llm) || 0) + 1), new Map())];

// 새 작업을 올린 뒤 그 작업의 다음 plan 호출까지 그림이 그대로면, 그 결과 글에 작업마다 한 번 알린다.
// 같은 메시지에서 plan 뒤에 draw 가 오면 알림이 먼저 나가므로 「이 메시지가 이미 그리면 건너뜀」 을 문구에 둔다.
// 그림이 아예 없는 대화는 그리기 알림(scripts/nudge)이 맡는다
function staleHint(scene, all) {
  const v = scene.view;
  if (!drawingStale(v) || v.hintT === v.taskT) return "";
  const parts = all.filter((it) => it.kind !== "step");
  if (!parts.length) return "";
  const open = parts.filter((p) => p.kind !== "edge" && ACTIVE.has(p.status)).map((p) => p.id);
  const base = v.shapeT ?? v.drawT;
  const ago = base && base < v.taskT ? ` (last redrawn ${agoText(v.taskT - base)} before the task began)` : "";
  return ` · The drawing on the board is from before this task's steps${ago}` +
    (open.length ? `; parts still marked doing, blocked or wait there: ${open.slice(0, 6).join(" ")}${open.length > 6 ? " …" : ""}` : "") +
    ". If this task has its own structure (parts, options, a flow) and this message does not already draw it, add it to the drawing as a new group with your next tool calls (clear:true only when the subject changed completely); routine steps such as commit and push need none. This note appears once per task.";
}
// 새 작업을 올린 호출 결과 글에 앞 작업에서 할 일·진행으로 남은 단계를 알린다. 닫지 않은 단계는 계획 칸에 끝없이 남는다
// (phase2: 앞 작업의 「README 갱신」 이 할 일로 남음). 대기·막힘은 일부러 열어 둔 것이라 싣지 않는다(기록 재생에서 같은 대기를 되풀이해 알림)
// 단계 나무: 맨 위 단계(작업) 찾기와 하위 단계가 있는 단계. 없는 부모를 가리키면 그 단계가 맨 위다
function planTree(steps) {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const kids = new Map();
  for (const s of steps) if (s.parent && byId.has(s.parent)) kids.set(s.parent, [...(kids.get(s.parent) || []), s]);
  const parents = new Set(kids.keys());
  const topOf = (id) => {
    let s = byId.get(id);
    for (let i = 0; s?.parent && byId.has(s.parent) && i < 100; i++) s = byId.get(s.parent);
    return s?.id;
  };
  // 시작한 단계: 제가 할 일이 아니거나 아래에 시작한 단계가 있다(위 단계를 할 일로 둔 채 하위 단계만 진행하는 경우가 있다)
  const seen = new Map();
  const startedAt = (id, depth = 0) => {
    if (seen.has(id)) return seen.get(id);
    const s = byId.get(id);
    const v = !!s && (s.status !== "todo" || (depth < 100 && (kids.get(id) || []).some((k) => startedAt(k.id, depth + 1))));
    seen.set(id, v);
    return v;
  };
  return { byId, parents, topOf, started: (id) => startedAt(id) };
}

// 앞 작업에서 열린 채 남은 단계. 작업으로 짠 계획(하위 단계가 있는 단계가 하나라도 있음)이면 지금 작업 아래,
// 하위 단계를 가진 단계(작업 자체: 하위 단계가 다 끝나면 끝난 것으로 본다), 지금 작업 뒤에 둔 아직 시작하지 않은 위 단계(미리 올린 다음 작업:
// 저도 아래도 모두 할 일) 아래는 뺀다. 지금 작업 앞에 남긴 할 일은 건너뛰고 지나온 것이라 알린다
function leftoverHint(steps, fresh, tree, top) {
  const tasks = !!top && tree.parents.size > 0;
  const ordOf = (id) => tree.byId.get(id)?.ord ?? 0;
  const later = (t) => !tree.started(t) && ordOf(t) > ordOf(top);
  const skip = (s) => tasks && (tree.parents.has(s.id) || tree.topOf(s.id) === top || later(tree.topOf(s.id)));
  const left = steps.filter((s) => !fresh.has(s.id) && LEFT_STEP.has(s.status) && !skip(s)).sort((a, b) => a.ord - b.ord);
  if (!left.length) return "";
  // 결과 글은 한 줄이다. 제목의 줄바꿈은 한 칸으로
  const list = left.slice(0, 6).map((s) => `${s.id} ${s.status} "${String(s.title ?? "").replace(/\s+/g, " ").slice(0, 20)}"`).join(", ");
  return ` · Steps still open from earlier work: ${list}${left.length > 6 ? ` … (${left.length})` : ""}. ` +
    "Mark the finished ones done and remove the dropped ones (del:true); keep the ones still to do.";
}
const LEFT_STEP = new Set(["todo", "doing"]);
const agoText = (ms) => { const m = Math.max(1, Math.round(ms / 60_000)); return m < 90 ? `${m} min` : `${Math.round(m / 60)} h`; };

function planOp(d, st, ctx, ignored) {
  if (!isObj(st)) return "단계가 객체가 아님";
  const id = st.id;
  if (typeof id !== "string" || !ID_RE.test(id)) return `id '${short(id)}' 모양이 틀림`;
  const old = d.get(id);
  if (old && old.kind !== "step") return `${id} 는 부품 id(draw 로 다룸)`;
  if (st.del === true) {
    if (!old) return `${id} 없음`;
    removeCascade(d, id, "parent");
    return null;
  }
  if (!old && typeof st.title !== "string") return `${id} 새 단계는 title 필요`;
  // 끝난 단계의 id 를 새 제목으로 다시 쓰면 같은 자리(순서·부모)의 새 단계다(evalPlan 이 새 작업을 세는 기준과 같음).
  // 옛 상태·시각·메모를 이으면 상태를 안 줄 때 올리자마자 끝으로 보이고(phase2 10-27) 걸린 시간을 옛 시작부터 잰다.
  // 파일·명령·메모는 id 로 붙으므로 화면은 bornT 뒤 것만 이 단계의 것으로 센다(다시 쓰기 직전에 시작해 늦게 도착한 파일 수정은 새 단계에 들어간다)
  const reused = old && FINISHED.has(old.status) && typeof st.title === "string" && st.title !== old.title;
  const next = !old ? { id, kind: "step", status: "todo", ord: ++d.counter }
    : reused ? { id, kind: "step", status: "todo", ord: old.ord, bornT: ctx.t, ...(old.parent !== undefined && { parent: old.parent }) }
    : { ...old };
  for (const [f, val] of Object.entries(st)) {
    if (f === "id" || f === "del") continue;
    if (!STEP_FIELDS.includes(f)) { ignored.push(`${id}.${f}`); continue; }
    if (val === null) {
      if (f === "title") return `${id} title 은 지울 수 없음`;
      if (f === "status") next.status = "todo"; else delete next[f];
      continue;
    }
    const e = checkField(f, val);
    if (e) return `${id} ${e}`;
    next[f] = val;
  }
  if (st.parent !== undefined && st.parent !== null) {
    const p = d.get(st.parent);
    if (!p || p.kind !== "step") return `${id} parent '${st.parent}' 단계 없음`;
    if (makesCycle(d, id, st.parent, "parent")) return `${id} parent 가 돌아서 자기에게 옴`;
    if (depthOf(d, st.parent, "parent") + 2 + heightOf(d, id, "parent") > LIMITS.depth) return `${id} ${LIMITS.depth}단보다 깊음`;
  }
  setStatus(next, old?.status, ctx.t, d);
  if (st.status === "wait") delete next.answered; // 승인 대기를 다시 보내면 새 질문이다(상태가 같아도)
  d.put(next);
  return null;
}

// 상태가 바뀔 때 시각과 순서를 적는다. 진행 시작 시각(startT)과 끝 시각(endT)은 단계 시간 표시에 쓴다
function setStatus(next, prev, t, d) {
  if (next.status === prev) return;
  next.since = t;
  delete next.answered;
  delete next.back;
  if (next.status === "doing") {
    next.doingOrd = ++d.counter;
    if (next.startT === undefined) next.startT = t;
    delete next.endT;
  }
  if (next.status === "done" || next.status === "fail") next.endT = t;
}

// ---- note ----
export function evalNote(scene, input, ctx) {
  if (!isObj(input)) return { res: [], msg: "입력이 객체가 아님" };
  const { text, kind, on, ref } = input;
  if (typeof text !== "string" || !text.trim() || text.length > LIMITS.note) return { res: [], msg: `text 는 ${LIMITS.note}자 이하 글` };
  if (kind !== undefined && kind !== null && !NOTE_KINDS.includes(kind)) return { res: [], msg: `kind '${short(kind)}' 모름(${NOTE_KINDS.join("·")})` };
  if (ref !== undefined && ref !== null && checkField("ref", ref)) return { res: [], msg: checkField("ref", ref) };
  const d = draft(scene);
  if (on !== undefined && on !== null && !d.get(on)) return { res: [], msg: `on '${short(on)}' 없음` };
  const before = currentStep(scene);
  let msg = "기록", auto = null;
  if (kind === "blocked" || kind === "wait") {
    // 지금 단계가 없으면 이번 답에서 끝낸(끝·실패) 단계 가운데 가장 최근 것(같은 때면 뒤 단계)에 붙인다. 마지막 단계를 끝내는
    // 계획과 승인 대기 메모를 한 응답에 함께 보내면(지침: 화판 호출을 따로 보내지 않는다) 메모가 올 때는 지금 단계가 없다.
    // 붙이지 않으면 「승인 대기」 띠가 뜨지 않는다. 이번 답 = 마지막 사용자 입력 뒤(입력이 없으면 30분 안). 원래 상태를 back 에
    // 남겨 답을 받으면 돌린다
    if (!on && !before) {
      let since = ctx.t - 30 * 60_000, best = null;
      for (let i = scene.timeline.length - 1; i >= 0; i--) {
        const e = scene.timeline[i];
        if (e.type === "fact" && e.f === "prompt" && !e.sys) { since = e.t; break; }
      }
      for (const it of d.all()) {
        if (it.kind !== "step" || (it.status !== "done" && it.status !== "fail") || !(it.endT >= since)) continue;
        if (!best || it.endT > best.endT || (it.endT === best.endT && it.ord > best.ord)) best = it;
      }
      auto = best ? best.id : null;
    }
    const target = on ? d.get(on) : before ? d.get(before) : auto ? d.get(auto) : null;
    if (target && target.kind !== "step" && !own(DRAW_FIELDS, target.kind).includes("status")) {
      msg += ` · ${target.id}(${target.kind}) 에는 상태가 없음`;
    } else if (target) {
      const next = { ...target, status: kind };
      if (target.kind === "step") setStatus(next, target.status, ctx.t, d);
      else if (kind !== target.status) next.since = ctx.t;
      if (auto) next.back = target.status;
      delete next.answered; // 새 승인 대기 메모는 새 질문이다(이미 「답 받음」 인 대기에도)
      d.put(next);
      msg += ` · ${target.id} ${kind === "blocked" ? "막힘" : "승인 대기"}${auto ? "(방금 끝난 단계)" : ""}`;
    } else msg += " (지금 단계 없음)";
  }
  const entry = { type: "note", seq: ctx.seq, t: ctx.t, text, step: before };
  if (kind) entry.kind = kind;
  if (on || auto) entry.on = on || auto; // 붙은 단계(목록 줄의 결정 대기·막힘 글 찾기가 on 을 본다)
  if (ref) entry.ref = ref;
  const res = [...d.res(), { k: "tl", v: entry }];
  const after = currentIn(d.all());
  if (after !== before) res.push({ k: "cur", v: { t: ctx.t, id: after } });
  return { res, msg };
}

// ---- explain(판서) ----
// LLM 이 작업의 핵심을 짧은 입력(제목·칸·줄·강조)으로 보내면 화판이 화이트보드 한 장으로 그린다(web/talk.js).
// 장은 작업마다 하나다: 계획이 작업(위 단계)과 하위 단계로 짜여 있으면 마지막으로 일한 작업(view.taskTop), 평평한 계획이거나
// 계획이 없으면 대화에 한 장("" 키). 같은 작업에 다시 보내면 그 장을 바꾸고 장 순서(ord)는 지킨다.
// 모양이 틀린 필드는 그 필드만 버리고, 긴 글은 잘라서 받는다(둘 다 결과 글에 알려 다음 호출에서 고치게 한다)
export const EXPLAIN_ICONS = [...ICONS, "check", "cross", "bulb", "chat"];
export const EXPLAIN_LIMITS = { bytes: 8192, title: 40, sub: 60, parts: 4, head: 20, lines: 5, line: 40, note: 40, arrows: 3, label: 10, steps: 6, step: 50, memoLines: 4, memoLine: 60, likeLines: 3, likeLine: 80, summary: 80, rows: 5, row: 20, pages: 100 };
// 판의 틀: row(기본, 칸 가로 한 줄) · compare(안을 열, rows 를 줄로 둔 표) · before-after(전 → 후 두 칸) · hub(첫 칸이 가운데, 나머지가 가지)
export const EXPLAIN_LAYOUTS = ["row", "compare", "before-after", "hub"];
const EXPLAIN_MARKS = ["underline", "circle", "highlight", "box"];
const FLOW_SHAPES = ["box", "diamond", "bubble"];

// 지금 판서를 붙일 장의 키: 계획이 작업으로 짜여 있으면(하위 단계가 하나라도 있으면) 마지막으로 일한 작업, 아니면 대화에 한 장("").
// 화면도 이 키로 「지금 작업의 장」 을 찾는다
// 마지막 작업이 지워졌으면 지금 단계의 작업으로 간다. task 를 주면(LLM 이 장을 붙일 작업을 직접 고름) 있는 맨 위 단계일 때만 쓴다
export function explainKey(scene, task) {
  const tree = planTree(Object.values(scene.items).filter((it) => it.kind === "step"));
  if (!tree.parents.size) return "";
  if (task !== undefined) return typeof task === "string" && tree.byId.has(task) && tree.topOf(task) === task ? task : null;
  return (scene.view.taskTop != null && tree.topOf(scene.view.taskTop)) || tree.topOf(currentStep(scene)) || "";
}

export function evalExplain(scene, input, ctx) {
  const L = EXPLAIN_LIMITS;
  if (!isObj(input)) return { res: [], msg: "입력이 객체가 아님" };
  if (new TextEncoder().encode(JSON.stringify(input)).length > L.bytes) return { res: [], msg: `입력은 ${L.bytes}바이트 이하` };
  const dropped = [], cut = [];
  // 글 한 칸: 공백을 한 칸으로 줄이고, 넘치면 끝을 「…」 로 자른다
  const str = (v, max, name) => {
    if (v == null) return undefined;
    if (typeof v !== "string" || !v.trim()) { dropped.push(name); return undefined; }
    // 글자 수는 코드 포인트로 센다(이모지 같은 짝 글자를 반으로 자르지 않게)
    const s = v.replace(/\s+/g, " ").trim(), cps = Array.from(s);
    if (cps.length <= max) return s;
    cut.push(name);
    return cps.slice(0, max - 1).join("") + "…";
  };
  // 줄 한 개: 글이거나 {t, em, mark}. flow 칸의 줄은 shape·via, 단계는 by 도 받는다
  const lineOf = (v, max, name, extra = []) => {
    if (typeof v === "string") { const t = str(v, max, name); return t ? { t } : null; }
    if (!isObj(v)) { dropped.push(name); return null; }
    const t = str(v.t, max, name);
    if (!t) { if (v.t == null) dropped.push(name); return null; }
    const out = { t };
    if (v.em === true) out.em = true;
    if (v.mark != null) { if (EXPLAIN_MARKS.includes(v.mark)) out.mark = v.mark; else dropped.push(`${name}.mark`); }
    if (extra.includes("shape") && v.shape != null) { if (FLOW_SHAPES.includes(v.shape)) out.shape = v.shape; else dropped.push(`${name}.shape`); }
    if (extra.includes("shape") && v.via != null) { const via = str(v.via, L.label, `${name}.via`); if (via) out.via = via; }
    if (extra.includes("by") && v.by != null) out.by = v.by; // 칸 id 인지는 칸을 다 읽은 뒤 본다
    return out;
  };
  const list = (v, max, name) => {
    if (v == null) return [];
    if (!Array.isArray(v)) { dropped.push(name); return []; }
    if (v.length > max) dropped.push(`${name}[${max}~]`);
    return v.slice(0, max);
  };

  const title = str(input.title, L.title, "title");
  if (!title) return { res: [], msg: "title 이 필요함" };
  const page = { title };
  const sub = str(input.sub, L.sub, "sub");
  if (sub) page.sub = sub;

  page.parts = [];
  // id 가 없거나 겹친 칸은 자리 번호 p1·p2… 를 받는다. 다른 칸이 직접 쓴 id 와 겹치지 않게 그 번호는 건너뛴다
  const rawParts = list(input.parts, L.parts, "parts");
  const named = new Set(rawParts.map((p) => (isObj(p) && typeof p.id === "string" && ID_RE.test(p.id) ? p.id : null)).filter(Boolean));
  const fallback = (i) => { let n = i + 1; while (named.has(`p${n}`) || page.parts.some((q) => q.id === `p${n}`)) n++; return `p${n}`; };
  rawParts.forEach((p, i) => {
    const name = `parts[${i}]`;
    if (!isObj(p)) { dropped.push(name); return; }
    const head = str(p.head, L.head, `${name}.head`);
    if (!head) { if (p.head == null) dropped.push(`${name}(head 없음)`); return; }
    const id = typeof p.id === "string" && ID_RE.test(p.id) && !page.parts.some((q) => q.id === p.id) ? p.id : fallback(i);
    if (p.id != null && id !== p.id) dropped.push(`${name}.id`);
    const part = { id, head };
    if (p.icon != null) { if (EXPLAIN_ICONS.includes(p.icon)) part.icon = p.icon; else dropped.push(`${name}.icon`); }
    const flow = p.flow === true;
    if (flow) part.flow = true;
    part.lines = list(p.lines, L.lines, `${name}.lines`).map((l, k) => lineOf(l, L.line, `${name}.lines[${k}]`, flow ? ["shape"] : [])).filter(Boolean);
    if (p.mark != null) { if (p.mark === "pick") part.mark = "pick"; else dropped.push(`${name}.mark`); }
    const note = str(p.note, L.note, `${name}.note`);
    if (note) part.note = note;
    page.parts.push(part);
  });
  if (!page.parts.length) return { res: [], msg: "parts 가 1개 이상 필요함(칸마다 head)" + (dropped.length ? ` · 버림: ${dropped.slice(0, 6).join(", ")}` : "") };

  // 틀: 그 틀에 맞지 않는 칸 수·필드는 버리고, 틀을 쓸 수 없으면 기본 틀(row)로 그린다
  let layout = "row";
  if (input.layout != null) { if (EXPLAIN_LAYOUTS.includes(input.layout)) layout = input.layout; else dropped.push("layout"); }
  const rows = list(input.rows, L.rows, "rows").map((r, k) => str(r, L.row, `rows[${k}]`)).filter(Boolean);
  const n = page.parts.length;
  if ((layout === "compare" && (!rows.length || n < 2)) || (layout === "before-after" && n < 2) || (layout === "hub" && n < 3)) {
    dropped.push(`layout(${layout} 는 ${{ compare: "rows 와 칸 둘 이상", "before-after": "칸 둘", hub: "칸 셋 이상" }[layout]}이 필요함)`);
    layout = "row";
  }
  if (rows.length && layout !== "compare") dropped.push("rows(compare 에서만 씀)");
  if (layout === "before-after" && n > 2) { dropped.push("parts[2~](before-after 는 칸 둘)"); page.parts.length = 2; }
  if (layout === "compare") {
    page.parts.forEach((p, i) => {
      if (p.flow) { delete p.flow; dropped.push(`parts[${i}].flow(compare 에서 안 씀)`); }
      if (p.icon) { delete p.icon; dropped.push(`parts[${i}].icon(compare 에서 안 씀)`); }
      if (p.lines.length > rows.length) { p.lines.length = rows.length; dropped.push(`parts[${i}].lines[${rows.length}~](rows 보다 많음)`); }
    });
  }
  // hub 의 가운데는 머리와 줄만 쓰는 타원이라 고른 표시·아이콘·흐름·바닥 메모를 그리지 않고(메모까지 넣으면 핵심 글이 작아진다),
  // 가운데 아래 가지(넷째 칸)는 낮아서 아이콘을 그리지 않는다
  if (layout === "hub") {
    const core = page.parts[0];
    for (const f of ["mark", "icon", "flow", "note"]) if (core[f]) { delete core[f]; dropped.push(`parts[0].${f}(hub 가운데에서 안 씀)`); }
    for (const l of core.lines) { delete l.shape; delete l.via; }
    if (page.parts[3]?.icon) { delete page.parts[3].icon; dropped.push("parts[3].icon(hub 아래 가지에서 안 씀)"); }
  }
  if (layout !== "row") page.layout = layout;
  if (layout === "compare") page.rows = rows;
  const at = new Map(page.parts.map((p, i) => [p.id, i]));

  // 화살표는 이웃한 칸끼리만 잇는다(떨어진 칸을 잇는 선은 칸을 가로질러 읽기 어렵다). before-after 는 전에서 후로 하나,
  // hub 는 가운데(첫 칸)와 가지 사이에 가지마다 하나, compare 는 쓰지 않는다
  const linked = (a, b) => (layout === "hub" ? (a === 0) !== (b === 0) : layout === "before-after" ? a === 0 && b === 1 : Math.abs(a - b) === 1);
  const why = { hub: "가운데와 가지를 잇지 않음", "before-after": "전에서 후로 가지 않음" }[layout] || "이웃한 칸의 id 가 아님";
  const taken = new Set(); // before-after·hub 에서 이미 화살표가 있는 자리(전후는 하나, 중심형은 가지마다 하나)
  if (layout === "compare" && input.arrows != null) dropped.push("arrows(compare 에서 안 씀)");
  const arrows = list(layout === "compare" ? null : input.arrows, L.arrows, "arrows").flatMap((a, i) => {
    const name = `arrows[${i}]`;
    if (!isObj(a) || !at.has(a.from) || !at.has(a.to) || !linked(at.get(a.from), at.get(a.to))) { dropped.push(`${name}(${why})`); return []; }
    const slot = layout === "before-after" ? "ba" : layout === "hub" ? (at.get(a.from) ? a.from : a.to) : null;
    if (slot !== null && taken.has(slot)) { dropped.push(`${name}(${layout === "hub" ? "그 가지에 이미 화살표가 있음" : "화살표는 하나"})`); return []; }
    if (slot !== null) taken.add(slot);
    const out = { from: a.from, to: a.to };
    const label = str(a.label, L.label, `${name}.label`);
    if (label) out.label = label;
    if (a.dash === true) out.dash = true;
    return [out];
  });
  if (arrows.length) page.arrows = arrows;

  if (layout !== "row" && input.steps != null) dropped.push(`steps(${layout} 에서 안 씀)`);
  const steps = list(layout === "row" ? input.steps : null, L.steps, "steps").map((s, i) => lineOf(s, L.step, `steps[${i}]`, ["by"])).filter(Boolean);
  for (const [i, s] of steps.entries()) if (s.by !== undefined && !at.has(s.by)) { dropped.push(`steps[${i}].by`); delete s.by; }
  if (steps.length) page.steps = steps;

  if (input.memo != null) {
    const m = isObj(input.memo) ? input.memo : null;
    const lines = m ? list(m.lines, L.memoLines, "memo.lines").map((l, k) => str(typeof l === "string" ? l : l?.t, L.memoLine, `memo.lines[${k}]`)).filter(Boolean) : [];
    if (lines.length) { page.memo = { lines }; const head = str(m.head, L.head, "memo.head"); if (head) page.memo.head = head; }
    else dropped.push("memo");
  }
  if (input.like != null) {
    const m = isObj(input.like) ? input.like : null;
    const lines = m ? list(m.lines, L.likeLines, "like.lines").map((l, k) => str(typeof l === "string" ? l : l?.t, L.likeLine, `like.lines[${k}]`)).filter(Boolean) : [];
    if (lines.length) page.like = { lines };
    else dropped.push("like");
  }
  const summary = str(input.summary, L.summary, "summary");
  if (summary) page.summary = summary;
  // 번호 단계가 있으면 판 아래가 단계 차지다: 비유 칸은 둘 자리가 없고, 정리는 단계 넷까지만 들어간다(web/talk.js 배치)
  if (page.steps && page.like) { delete page.like; dropped.push("like(steps 와 함께 못 씀)"); }
  if (page.steps?.length > 4 && page.summary) { delete page.summary; dropped.push("summary(steps 5개부터 못 씀)"); }

  // 어느 작업의 장인가: task(맨 위 단계 id)를 주면 그 작업, 아니면 마지막으로 일한 작업
  let key = explainKey(scene, input.task == null ? undefined : input.task);
  if (key === null) { dropped.push("task(작업으로 짠 계획의 맨 위 단계 id 가 아님)"); key = explainKey(scene); }
  const pages = scene.explains || {};
  let old = Object.hasOwn(pages, key) ? pages[key] : null;
  const res = [];
  // 끝난 작업의 id 를 새 제목으로 다시 쓴 새 작업(bornT 가 옛 장보다 늦음)이면 옛 장을 다른 키로 비켜 두고 새 장을 만든다
  if (old && key && (own(scene.items, key)?.bornT || 0) > old.t) {
    res.push({ k: "explain", v: { ...old, key: `${key}@${old.t}` } });
    old = null;
  }
  const count = Object.keys(pages).length + res.length;
  if (!old && count >= L.pages) return { res: [], msg: `판서는 대화마다 ${L.pages}장까지` };
  const task = key ? String(own(scene.items, key)?.title || "") : "";
  const ord = old ? old.ord : Object.values(pages).reduce((m, p) => Math.max(m, p.ord || 0), 0) + 1;
  const v = { key, task, t: ctx.t, ord, page };
  res.push({ k: "explain", v });
  const all = Object.values(applyRes({ explains: { ...pages } }, res).explains).sort((a, b) => a.ord - b.ord);
  let msg = `판서 ${all.findIndex((p) => p.key === key) + 1}/${all.length}장 ${old ? "바꿈" : "새로"}` + (task ? ` · 작업 「${task.slice(0, 30)}」` : "");
  if (cut.length) msg += ` · 잘림: ${cut.slice(0, 6).join(", ")}`;
  if (dropped.length) msg += ` · 버림: ${dropped.slice(0, 6).join(", ")}`;
  return { res, msg };
}

// ---- ids ----
// 단계 먼저, 그다음 부품을 만든 순서로 max 개까지 싣는다
export function idsLine(scene, max = 100) {
  const all = Object.values(scene.items).sort((a, b) => a.ord - b.ord);
  if (!all.length) return "비어 있음";
  const fmt = (it) => {
    if (it.kind === "step") return `${it.id} "${(it.title || "").slice(0, 20)}" ${it.status}`;
    if (it.kind === "edge") return `${it.id} ${it.from}>${it.to} edge`;
    return `${it.id}${it.label ? ` "${it.label.slice(0, 20)}"` : ""} ${it.kind}${it.status ? " " + it.status : ""}`;
  };
  const isStep = (it) => it.kind === "step";
  const shown = [...all.filter(isStep), ...all.filter((it) => !isStep(it))].slice(0, max);
  const s = shown.filter(isStep).map(fmt).join(", "), p = shown.filter((it) => !isStep(it)).map(fmt).join(", ");
  let text = [s && `plan: ${s}`, p && `draw: ${p}`].filter(Boolean).join(" | ");
  if (all.length > shown.length) text += ` | 외 ${all.length - shown.length}개`;
  return text;
}

// ---- 훅 사실 ----
// hook.js 가 줄인 사실(f 종류)을 결과로 바꾼다. ctx.ht 는 훅이 시작한 시각이다
export function evalFact(scene, fact, ctx) {
  if (!isObj(fact) || typeof fact.f !== "string") return { res: [], msg: "사실 모양이 틀림" };
  const d = draft(scene), res = [], sess = { lastT: ctx.t };
  const ht = typeof ctx.ht === "number" ? ctx.ht : ctx.t;
  const step = stepAt(scene, ht);
  const agent = fact.agent || undefined;
  const tl = (v) => res.push({ k: "tl", v: { type: "fact", seq: ctx.seq, t: ctx.t, step, ...(agent && { agent, agentType: fact.agentType }), ...v } });
  const runPut = (v) => res.push({ k: "run", v });
  // 하위 에이전트 이름표: 종류·설명은 실린 것만(먼저 온 설명을 빈 값으로 덮지 않는다)
  const agentPut = (v) => {
    if (typeof agent !== "string" || !ID_RE.test(agent)) return;
    const kind = typeof fact.agentType === "string" && fact.agentType ? { type: fact.agentType.slice(0, LIMITS.label) } : {};
    const desc = typeof fact.desc === "string" && fact.desc ? { desc: fact.desc.slice(0, LIMITS.label) } : {};
    res.push({ k: "agent", v: { id: agent, ...kind, ...desc, ...v } });
  };
  if (fact.f !== "start" && fact.cwd && !scene.meta.cwd) res.push({ k: "meta", v: { cwd: fact.cwd } });
  // SessionStart 를 놓친 Codex 세션(화판이 아직 뜨지 않았음): 서버가 다른 사실에 실어 준 Codex 메타로 채운다
  if (fact.f !== "start" && fact.via === "codex" && scene.meta.via !== "codex") {
    res.push({ k: "meta", v: { ...(fact.pid && { pid: fact.pid }), ...(fact.pstart && { pstart: fact.pstart }), ...codexMeta(fact) } });
  }
  // 정리 시각(settleT): 마지막으로 열린 실행을 닫은 사건(입력·차례 끝·세션 끝)의 훅 시각.
  // 그보다 앞선 시각의 사건이 늦게 도착하면 세션을 다시 「작업 중」으로 만들거나 실행을 다시 열지 않는다
  const settled = scene.sess.settleT || 0;
  const late = ht < settled;
  // 세션 상태(작업 중·입력 필요·쉼)는 마지막으로 상태를 바꾼 사건(stT)보다 오래된 사건으로 되돌리지 않는다
  const setSess = (status) => {
    if (scene.sess.status === "ended" || late || ht < (scene.sess.stT || 0)) return;
    sess.status = status;
    sess.stT = ht;
  };
  const working = () => setSess("working");
  // Claude Code 의 세션 이름(/rename, claude -n). 훅이 SessionStart·UserPromptSubmit 에 싣는다
  const claudeName = () => {
    if (typeof fact.title === "string" && fact.title && fact.title !== scene.sess.claudeName) sess.claudeName = fact.title.slice(0, LIMITS.label);
  };
  // Claude Code 가 대화 기록에 남긴 자동 요약 제목. 훅이 SessionStart·Stop 에 싣는다
  const aiTitle = () => {
    if (typeof fact.ai === "string" && fact.ai && fact.ai !== scene.sess.ai) sess.ai = fact.ai.slice(0, LIMITS.label);
  };
  const llmField = typeof fact.llm === "string" && fact.llm ? { llm: fact.llm.slice(0, 24) } : {}; // 다른 LLM 을 부른 명령의 이름
  // when 보다 먼저 시작해 아직 열려 있는 실행을 state 로 바꾼다. all 이 아니면 주 에이전트의 것만
  const settleOpen = (state, when, all = false, keep = null) => {
    for (const r of Object.values(scene.runs)) {
      if ((r.agent && !all) || !OPEN_RUN.has(r.state) || r.state === state || (r.start ?? 0) > when || keep?.(r)) continue;
      runPut({ ...r, state, ...(state === "unknown" && { end: when }) });
    }
    if (state === "unknown") sess.settleT = Math.max(settled, when);
  };
  // 뒤에서 실행을 닫는다. 걸린 시간은 PostToolUse 의 띄운 시간이 아니라 닫을 때까지다
  const closeBg = (r, state, when) => runPut({ ...r, state, end: when, ...(r.start != null && { dur: when - r.start }) });
  // 세션이 끝나면 끝 사실을 잃은 하위 에이전트와 뒤에서 실행도 닫는다(같은 세션을 다시 열었을 때 도는 것으로 되살아나지 않게)
  const closeAgents = (when) => {
    for (const a of Object.values(scene.agents || {})) if (a.startT && !a.stopT) res.push({ k: "agent", v: { id: a.id, stopT: when } });
    for (const r of Object.values(scene.runs)) if (r.state === "background") closeBg(r, "unknown", when);
  };

  switch (fact.f) {
    case "start": {
      // lastStart·pid·pstart 는 서버를 다시 띄울 때 어느 세션이 그 claude 의 지금 세션인지 고르는 데 쓴다.
      // Codex 세션(via): shared 는 한 프로세스에 세션이 여럿(데스크톱 앱·VS Code 의 app-server), home·bin 은 codex queue 로 보낼 때 쓴다
      const meta = {
        lastStart: ctx.t, ...(fact.cwd && { cwd: fact.cwd }), ...(fact.pid && { pid: fact.pid }), ...(fact.pstart && { pstart: fact.pstart }),
        ...codexMeta(fact),
      };
      linkPrev(scene, fact, meta); // /clear·fork: 같은 claude 의 직전 세션
      res.push({ k: "meta", v: meta });
      if (scene.sess.status === "ended") { sess.status = "idle"; sess.stT = ht; }
      claudeName();
      aiTitle();
      tl({ f: "start", source: fact.source || "startup" });
      break;
    }
    case "prompt":
      working();
      // 작업 알림(sys)은 사용자 입력이 아니다: 제목으로 쓰지 않고, 승인 대기에 답한 것으로 치지 않는다
      if (fact.sys) {
        tl({ f: "prompt", sys: true, text: fact.text || "" });
        // 알림은 차례 중에도 온다. 앞에서 도는 다른 LLM 은 표가 일찍 사라지지 않게 두고, 끝을 잃으면 다음 차례 끝이 닫는다
        settleOpen("unknown", ht, false, (r) => r.llm);
        // 뒤에서 실행한 명령의 끝 알림: 그 실행을 닫는다
        const bg = typeof fact.run === "string" ? own(scene.runs, fact.run) : null;
        if (bg && (bg.state === "background" || OPEN_RUN.has(bg.state))) closeBg(bg, fact.end === "fail" || fact.end === "stopped" ? fact.end : "done", ht);
        break;
      }
      if (!scene.sess.title && fact.text) {
        sess.title = fact.text.slice(0, 60);
        // 첫 입력이 이어받기 문구(「핸드온 <키>」 따위)면 그 키의 인계를 이어받은 대화다. 앞 대화는 서버가 골라 붙인다
        // handoff: 이 대화가 가진 키(이어받은 키, 뒤에 쓴 인계 문서의 키로 바뀐다. 앞 대화 짝짓기에 쓴다).
        // handon: 첫 입력의 이어받기 문구로 받은 키(바뀌지 않는다. 세션 목록 줄의 「← 키」 표시)
        const key = (ctx.resume || NO_RESUME).prompt(fact.text), meta = {};
        if (key && key !== scene.meta.handoff) meta.handoff = key;
        if (key) meta.handon = key;
        linkPrev(scene, fact, meta);
        if (Object.keys(meta).length) res.push({ k: "meta", v: meta });
      }
      claudeName();
      tl({ f: "prompt", text: fact.text || "" });
      for (const it of d.all()) if (it.edited) { const n = { ...it }; delete n.edited; d.put(n); }
      answerWaits(d);
      settleOpen("unknown", ht);
      break;
    case "run-start": {
      working();
      if (typeof fact.id !== "string") return { res: [], msg: "실행 id 없음" };
      const old = own(scene.runs, fact.id);
      if (old && !OPEN_RUN.has(old.state)) {
        // 끝이 먼저 왔다: 빠진 설명과 시작 시각·단계만 채우고 상태는 그대로 둔다
        const v = { ...old, cmd: old.cmd || fact.cmd, desc: old.desc || fact.desc, start: ht, ...(old.startMissing && { step }), ...llmField };
        delete v.startMissing;
        runPut(v);
      } else if (late && !old && !llmField.llm) {
        // 이미 정리한 뒤에 도착한 시작: 열지 않고 「알 수 없음」으로 둔다(다른 LLM 은 알림이 정리를 앞당겨도 표가 빠지지 않게 연다. 끝이 없으면 다음 차례 끝이 닫는다)
        runPut({ id: fact.id, state: "unknown", cmd: fact.cmd || "", desc: fact.desc || "", start: ht, end: settled, step, ...(agent && { agent }), ...llmField });
        res.push({ k: "tl", v: { type: "run", id: fact.id, seq: ctx.seq, t: ctx.t } });
      } else if (!old) {
        runPut({ id: fact.id, state: "running", cmd: fact.cmd || "", desc: fact.desc || "", start: ht, step, ...(agent && { agent }), ...llmField });
        res.push({ k: "tl", v: { type: "run", id: fact.id, seq: ctx.seq, t: ctx.t } });
      }
      break;
    }
    case "run-end":
    case "run-fail": {
      working();
      if (typeof fact.id !== "string") return { res: [], msg: "실행 id 없음" };
      const old = own(scene.runs, fact.id);
      // 뒤로 넘긴 결과가 이 실행을 닫은 뒤에 늦게 왔다(끝 알림이 먼저 도착): 다시 열지 않는다
      if (fact.bg && old?.end > ht) { runPut({ ...old, ...llmField, ...(typeof fact.task === "string" && fact.task && { task: fact.task }) }); break; }
      const state = fact.f === "run-fail" ? "fail" : !fact.bg ? "done" : scene.sess.status === "ended" ? "unknown" : "background";
      // 시작보다 끝이 먼저 오면 걸린 시간으로 시작 시각을 어림하고, 시작이 오면 그 값으로 바꾼다
      const fresh = { id: fact.id, cmd: fact.cmd || "", desc: fact.desc || "", step, startMissing: true, ...(typeof fact.dur === "number" && { start: ht - fact.dur }), ...(agent && { agent }) };
      const v = { ...(old || fresh), state, end: ht };
      if (typeof fact.dur === "number") v.dur = fact.dur;
      if (fact.error) v.error = fact.error;
      if (llmField.llm) v.llm = llmField.llm;
      if (typeof fact.task === "string" && fact.task) v.task = fact.task;
      runPut(v);
      if (!old) res.push({ k: "tl", v: { type: "run", id: fact.id, seq: ctx.seq, t: ctx.t } });
      break;
    }
    case "run-stop": {
      working();
      const r = fact.task && Object.values(scene.runs).find((x) => x.state === "background" && x.task === fact.task);
      if (r) closeBg(r, "stopped", ht);
      break;
    }
    case "edit": {
      working();
      // 바뀐 줄(diff)이 있으면 타임라인 줄에는 표시(diff: true)와 더하기·빼기 수만 두고 글은 따로 둔다
      const diff = typeof fact.diff === "string" ? fact.diff : "";
      const count = (v) => (Number.isInteger(v) && v >= 0 ? v : undefined);
      tl({
        f: "edit", tool: fact.tool, path: fact.path || "", ...(fact.lines && { lines: fact.lines }), ...(fact.create === true && { create: true }),
        ...(count(fact.add) !== undefined && { add: fact.add }), ...(count(fact.del) !== undefined && { del: fact.del }),
        ...(diff && { diff: true }), ...(diff && fact.cut === true && { cut: true }),
      });
      if (diff) res.push({ k: "diff", v: { seq: ctx.seq, text: diff } });
      const key = (ctx.resume || NO_RESUME).path(fact.path);
      if (key && key !== scene.meta.handoff) res.push({ k: "meta", v: { handoff: key } });
      const target = normPath(fact.path || "", scene.meta.cwd);
      if (target) for (const it of d.all()) {
        if (it.kind !== "step" && it.ref && !it.edited && normPath(refPath(it.ref), scene.meta.cwd) === target) d.put({ ...it, edited: true });
      }
      break;
    }
    case "edit-fail":
      working();
      tl({ f: "edit-fail", tool: fact.tool, path: fact.path || "", error: fact.error || "" });
      break;
    case "todo":
      tl({ f: "todo", tool: fact.tool, text: fact.text || "" });
      break;
    case "agent-start": {
      working();
      tl({ f: "agent-start" });
      // 끝난 에이전트를 이어서 다시 돌리면(같은 id) 다시 도는 것으로 둔다. 끝이 시작보다 먼저 도착한 것(끝 시각이 더 늦음)은 그대로
      const prev = typeof agent === "string" ? own(scene.agents || {}, agent) : undefined;
      agentPut({ startT: ht, ...(prev?.stopT && prev.stopT < ht && { stopT: 0 }) });
      break;
    }
    case "agent-call":
      // Agent 도구의 결과: 설명만 이름표에 합치고 타임라인 줄은 만들지 않는다
      agentPut({});
      break;
    case "agent-stop":
      tl({ f: "agent-stop", last: fact.last || "" });
      agentPut({ stopT: ht });
      // 끝난 하위 에이전트가 열어 둔 실행(승인 거부·중단으로 끝이 오지 않은 것)을 닫는다
      if (agent) for (const r of Object.values(scene.runs)) {
        if (r.agent !== agent || (r.start ?? 0) > ht) continue;
        if (OPEN_RUN.has(r.state)) runPut({ ...r, state: "unknown", end: ht });
        // 하위 에이전트의 뒤에서 실행은 끝 알림이 이 세션의 입력으로 오지 않고, 답을 마치면 함께 끝난다
        else if (r.state === "background") closeBg(r, "unknown", ht);
      }
      break;
    case "notify":
      setSess("input");
      tl({ f: "notify", ntype: fact.ntype || "", text: fact.text || "" });
      settleOpen("wait", ht);
      break;
    case "stop":
      setSess("idle");
      aiTitle();
      tl({ f: "stop", last: fact.last || "" });
      settleOpen("unknown", ht);
      break;
    case "end":
      sess.status = "ended";
      sess.stT = ht;
      expireMsgs(scene, res, "세션이 끝나 만료");
      tl({ f: "end", reason: fact.reason || "" });
      settleOpen("unknown", ht, true);
      closeAgents(ht);
      break;
    case "gone":
      if (scene.sess.status === "ended") return { res: [], msg: "이미 끝남" };
      sess.status = "ended";
      sess.stT = ht;
      expireMsgs(scene, res, "세션이 끝나 만료");
      tl({ f: "gone" });
      settleOpen("unknown", ht, true);
      closeAgents(ht);
      break;
    case "quiet":
      // 서버가 붙이는 사실: 작업 중인데 오래 조용하다. Esc 중단에는 훅이 없어 차례 끝을 잃는다.
      // 도는 명령·하위 에이전트가 있으면 그것을 기다리는 중이니 그대로 둔다(끝을 잃은 것은 에이전트처럼 두 시간 뒤 돌지 않는 것으로 본다).
      // 승인을 기다리던 명령(wait)도 센다: 승인된 명령은 끝날 때까지 wait 로 남는다. 조용한 것은 활동이 아니므로 마지막 활동 시각은 두고,
      // 다음 사건이 오면 다시 「작업 중」 이 된다. 상태를 바꾸지 못하는 때(늦은 사건)는 기록하지 않는다(30초마다 같은 기록이 쌓이지 않게)
      if (scene.sess.status !== "working" || late || ht < (scene.sess.stT || 0) || agentsRunning(scene, ctx.t).length) return { res: [], msg: "그대로" };
      if (Object.values(scene.runs).some((r) => OPEN_RUN.has(r.state) && ctx.t - (r.start ?? 0) < AGENT_WINDOW)) return { res: [], msg: "그대로" };
      setSess("idle");
      sess.lastT = scene.sess.lastT || ctx.t;
      tl({ f: "quiet" });
      break;
    default:
      return { res: [], msg: `사실 '${short(fact.f)}' 모름` };
  }
  res.unshift(...d.res());
  const now = currentIn(d.all()); // 답을 받아 끝난 단계로 돌아가면 지금 단계가 바뀐다
  if (now !== currentStep(scene)) res.push({ k: "cur", v: { t: ctx.t, id: now } });
  res.push({ k: "sess", v: sess });
  return { res, msg: "기록" };
}

// ref 의 「경로:줄」에서 경로만
export function refPath(ref) {
  const m = /^(.*?)(?::\d+(?:-\d+)?)?$/.exec(String(ref));
  return m ? m[1] : String(ref);
}

// ---- 이어진 대화: 앞 대화(prev)와 인계 키(handoff) ----
const PREV_RE = /^[A-Za-z0-9_-]{1,64}$/; // 세션 id 모양(store.js 의 SID_RE 와 같다)
// 이어받기 문구: 사용자가 설정에서 정하는 첫 입력 문구(phrase)와 인계 문서 경로(doc). <키> 자리에 공백 없는 글이 온다.
// 설정이 없으면 둘 다 키를 읽지 않는다. 07 판까지 코드에 박혀 있던 규칙이 LEGACY_RESUME 이다
export const KEY_SLOT = "<키>";
export const LEGACY_RESUME = { phrase: "핸드온 <키>", doc: "/handoff/<키>.md" };
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// 설정 값 검사. 맞으면 null, 틀리면 이유
export function checkResume(cfg) {
  if (cfg === null) return null;
  if (!isObj(cfg)) return "설정 모양이 틀림";
  const { phrase, doc = "" } = cfg;
  if (typeof phrase !== "string" || phrase.length > 60 || phrase.split(KEY_SLOT).length !== 2) return `문구는 ${KEY_SLOT} 를 한 번 넣은 60자 이하 글`;
  if (!phrase.slice(0, phrase.indexOf(KEY_SLOT)).trim()) return `문구는 ${KEY_SLOT} 앞에 글이 있어야 함`;
  if (typeof doc !== "string" || doc.length > 120 || (doc && doc.split(KEY_SLOT).length !== 2)) return `인계 문서 경로는 비우거나 ${KEY_SLOT} 를 한 번 넣은 120자 이하 글`;
  if (/[\x00-\x1f\x7f]/.test(phrase + doc)) return "제어 문자는 받지 않음";
  return null;
}
// 지난 대화를 휴지통으로 옮기기까지의 날수. 설정에 없으면 30일, null 이면 끈다.
// 설정 파일을 손으로 고쳐 틀린 값(-1, "0" 따위)이 들어 있으면 끈 것으로 본다(그대로 쓰면 날수와 상관없이 모두 옮긴다)
export const TRASH_DAYS_DEFAULT = 30;
export const trashDays = (cfg) => {
  if (!cfg || !Object.hasOwn(cfg, "trashDays")) return TRASH_DAYS_DEFAULT;
  return checkTrashDays(cfg.trashDays) ? null : cfg.trashDays;
};
export function checkTrashDays(v) {
  return v === null || (Number.isInteger(v) && v >= 1 && v <= 3650) ? null : "날수는 1~3650 사이 정수(비우면 끔)";
}
// 수정 한 번의 바뀐 줄(diff)을 남기는 크기(KB). 0 이면 남기지 않는다(더하기·빼기 수만). 틀린 값은 기본으로 본다
// 0~512KB 를 16KB(기본값) 단위로 고른다(훅은 512KB 까지 보낸다)
export const DIFF_KB_STEP = 16, DIFF_KB_MAX = 512;
export const DIFF_KB_DEFAULT = 16;
const okDiffKB = (v) => Number.isInteger(v) && v >= 0 && v <= DIFF_KB_MAX && v % DIFF_KB_STEP === 0;
export const diffKB = (cfg) => (okDiffKB(cfg?.diffKB) ? cfg.diffKB : DIFF_KB_DEFAULT);
export const checkDiffKB = (v) => (okDiffKB(v) ? null : `diff 보관 크기는 0~${DIFF_KB_MAX}KB 의 ${DIFF_KB_STEP}KB 단위`);
// 설정을 키를 읽는 두 함수로 바꾼다. 문구는 맨 앞만 보고, <키> 뒤에 글이 있으면(「이어 [<키>]」) 그 글까지 맞춰 본다.
// 키 뒤에 붙은 문장 부호는 뗀다
export function resumeRule(cfg) {
  const ok = cfg && !checkResume(cfg);
  let prompt = null, doc = null;
  if (ok) {
    const [before, after] = cfg.phrase.split(KEY_SLOT);
    const ws = (s) => esc(s).replace(/\s+/g, "\\s+");
    const sep = /\s$/.test(before) ? "\\s+" : "";
    prompt = new RegExp("^\\s*" + ws(before.trim()) + sep + (after.trim() ? "(\\S+?)" + ws(after.trimEnd()) : "(\\S+)"));
    if (cfg.doc) {
      const [a, b] = cfg.doc.split(KEY_SLOT);
      doc = new RegExp(esc(a) + "([^/]+)" + esc(b) + "$");
    }
  }
  return {
    prompt(text) {
      const m = prompt && prompt.exec(String(text || ""));
      const key = m ? m[1].replace(/[—–,.;:!?]+$/, "").slice(0, 80) : "";
      return key || null;
    },
    // 인계 문서를 고친 세션은 그 키의 인계를 쓴 세션이다
    path(p) {
      const m = doc && doc.exec(String(p || ""));
      return m ? m[1].slice(0, 80) : null;
    },
  };
}
const NO_RESUME = resumeRule(null);
// 서버가 사실에 붙여 보낸 앞 대화. 처음 한 번만 받고, 자기 자신은 받지 않는다
// Codex 세션 메타. 시작할 때마다 덮어써서(없으면 null) 다른 화면에서 이어 연 세션에 옛 값(shared·home·bin)이 남지 않게 한다
function codexMeta(fact) {
  if (fact.via !== "codex") return {};
  const str = (v) => (typeof v === "string" && v ? v.slice(0, 1024) : null);
  return { via: "codex", shared: fact.shared === true, home: str(fact.home), bin: str(fact.bin) };
}

function linkPrev(scene, fact, meta) {
  if (typeof fact.prev === "string" && PREV_RE.test(fact.prev) && !scene.meta.prev && fact.prev !== scene.meta.id) meta.prev = fact.prev;
}

// 상대 경로를 cwd 기준 절대 경로로 바꾸고 . 과 .. 을 푼다(posix)
export function normPath(p, cwd) {
  if (!p) return "";
  const full = p.startsWith("/") ? p : `${cwd || ""}/${p}`;
  const out = [];
  for (const seg of full.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop(); else out.push(seg);
  }
  return "/" + out.join("/");
}

// ---- 화판에서 쓰는 것: 세션 이름, Claude 에 보내는 메시지 ----
export const MSG_KINDS = ["comment", "instruction"];
export const MSG_LIMITS = { bytes: 4000, queued: 20, ttl: 30 * 60_000, batch: 32_000 };

// 화판 이름. 빈 글이면 지워서 Claude Code 이름·첫 프롬프트로 돌아간다
// ---- 화면에서 도형 옮기기 ----
// pos: 화면에서 옮긴 자리. 맨 바깥 부품은 그림 왼쪽 위 기준, 묶음 안 부품은 그 묶음 왼쪽 위 기준이다(화면이 묶음 안으로 줄인다).
// 입력: { id, x, y } 놓기 · { id, x: null } 그 부품만 자동 자리로 · { all: true } 모두 자동 자리로
export const MOVE_MAX = 20000;
const MOVABLE = new Set(["box", "group", "list", "table", "progress", "text", "mermaid"]);
export function evalMove(scene, input) {
  if (!isObj(input)) return { res: [], msg: "입력이 객체가 아님" };
  const d = draft(scene), unpos = (it) => { const { pos, ...v } = it; d.put(v); };
  if (input.all === true) {
    for (const it of d.all()) if (it.pos) unpos(it);
    const res = d.res();
    return { res, msg: res.length ? `자동 배치로 ${res.length}개` : "옮긴 도형 없음" };
  }
  const it = typeof input.id === "string" ? d.get(input.id) : undefined;
  if (!it || !MOVABLE.has(it.kind)) return { res: [], msg: "옮길 수 없는 부품" };
  // 끄는 사이 Claude 가 묶음을 바꿨으면(자리 기준이 바뀜) 받지 않는다. in 을 싣지 않은 요청은 따지지 않는다
  if (input.in !== undefined && (it.in ?? null) !== (input.in ?? null)) return { res: [], msg: "그사이 묶음이 바뀌어 옮기지 않음" };
  if (input.x === null) {
    if (!it.pos) return { res: [], msg: "그대로" };
    unpos(it);
    return { res: d.res(), msg: `${it.id} 자동 자리로` };
  }
  const ok = (n) => Number.isFinite(n) && n >= 0 && n <= MOVE_MAX;
  if (!ok(input.x) || !ok(input.y)) return { res: [], msg: `자리는 0~${MOVE_MAX} 의 수` };
  const pos = { x: Math.round(input.x), y: Math.round(input.y) };
  if (it.pos && it.pos.x === pos.x && it.pos.y === pos.y) return { res: [], msg: "그대로" };
  d.put({ ...it, pos });
  return { res: d.res(), msg: `${it.id} 옮김` };
}

// ---- 찾기 ----
// 타임라인 한 줄에서 찾을 글(화면 글과 같은 재료). 서버(모든 세션)와 화면(보는 세션)이 같이 쓴다
export function entryText(scene, e) {
  if (e.type === "note") return `${e.text || ""}${e.on ? ` (${e.on})` : ""}`; // 타임라인 글과 같게
  if (e.type === "msg") { const m = own(scene.msgs || {}, e.mid); return m ? m.text || "" : ""; }
  if (e.type === "run") { const r = own(scene.runs, e.id); return r ? `${r.llm ? `${r.llm} ` : ""}${r.desc || ""} ${r.cmd || ""} ${r.error || ""}`.trim() : ""; }
  switch (e.f) {
    case "prompt": case "todo": case "notify": return e.text || "";
    case "edit": return `${e.path || ""}${e.lines ? `:${e.lines}` : ""}`;
    case "edit-fail": return `${e.path || ""} ${e.error || ""}`;
    case "agent-start": return `${own(scene.agents || {}, e.agent)?.desc || ""} ${e.agentType || ""}`.trim();
    case "agent-stop": return `${own(scene.agents || {}, e.agent)?.desc || ""} ${e.agentType || ""} ${e.last || ""}`.trim();
    case "stop": return e.last || "";
    default: return "";
  }
}
// 부품·단계에서 찾을 글
export function itemText(it) {
  if (it.kind === "step") return `${it.title || ""} ${it.note || ""}`.trim();
  if (it.kind === "edge") return it.label || "";
  return [it.label, it.text, it.note, it.ref, ...(it.cols || []), ...(it.rows || []).flat()].filter(Boolean).join(" ");
}
// 낱말(공백으로 나눔)을 모두 담았는가. 대소문자를 가리지 않는다
export const searchTerms = (q) => String(q || "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
// 첫 낱말 둘레의 글 앞부분(찾기 결과 한 줄)
export function snippet(text, terms, len = 160) {
  const s = String(text || "").replace(/\s+/g, " "), at = terms.length ? s.toLowerCase().indexOf(terms[0]) : -1;
  const from = at > 40 ? at - 40 : 0;
  return `${from ? "…" : ""}${s.slice(from, from + len)}${from + len < s.length ? "…" : ""}`;
}
export const matchAll = (text, terms) => { const t = String(text || "").toLowerCase(); return terms.length > 0 && terms.every((w) => t.includes(w)); };

export function evalRename(scene, name) {
  if (typeof name !== "string") return { res: [], msg: "이름은 글이어야 함" };
  const v = name.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, LIMITS.label);
  if ((scene.sess.name || "") === v) return { res: [], msg: "그대로" };
  return { res: [{ k: "sess", v: { name: v || null } }], msg: v ? `이름: ${v}` : "이름 지움" };
}

const queued = (scene) => Object.values(scene.msgs || {}).filter((m) => m.state === "queued").sort((a, b) => a.t - b.t);
export { queued as queuedMsgs };

// cid: 화면이 글마다 붙이는 번호(브라우저에 저장한 초안·모은 글). 같은 글을 다시 보내도(보내는 사이 탭이 닫혀 다시 누름)
// 한 번만 넣으려고 메시지에 남긴다. 없으면 null, 모양이 틀리면 false
const CID_RE = /^[A-Za-z0-9-]{8,64}$/;
const cidOf = (input) => (input.cid == null ? null : typeof input.cid === "string" && CID_RE.test(input.cid) ? input.cid : false);
const cleanText = (text) => (typeof text === "string" ? text.replace(/\r\n?/g, "\n").trim() : "");
const sameMsg = (m, input) => m.kind === input.kind && m.text === cleanText(input.text) && (m.target?.id ?? null) === (input.target ?? null);
// 만료된 글은 Claude 에 가지 않았으므로 같은 번호로 다시 보내면 새로 넣는다
// 만료된 글은 받지 않은 것으로 친다. 다만 Codex 에 넣는 중 답이 없어 만료한 글(unsure)은 들어갔을 수 있어 받은 것으로 친다
const byCid = (scene, cid) => Object.values(scene.msgs || {}).find((m) => m.cid === cid && (m.state !== "expired" || m.unsure));

// 메시지 하나를 대기열에 넣는다. 대상은 지금 있는 단계나 부품의 id 만 받는다(제목은 싣지 않는다).
// 같은 cid 가 이미 있으면 내용이 같을 때 「이미 받음」(done, 기록하지 않음), 다르면 거절(conflict). 끝남·대상·한도보다 먼저 본다
export function evalSend(scene, input, ctx, mid) {
  if (!isObj(input)) return { res: [], msg: "메시지 모양이 틀림" };
  const cid = cidOf(input);
  if (cid === false) return { res: [], msg: "cid 모양이 틀림" };
  const old = cid && byCid(scene, cid);
  if (old) return sameMsg(old, input) ? { res: [], msg: `이미 받음 ${old.mid}`, done: true, mid: old.mid } : { res: [], msg: `이미 보낸 글(${old.mid})과 내용이 다름`, conflict: cid };
  if (scene.sess.status === "ended") return { res: [], msg: "끝난 세션에는 보낼 수 없음" };
  const kind = MSG_KINDS.includes(input.kind) ? input.kind : null;
  if (!kind) return { res: [], msg: `kind 는 ${MSG_KINDS.join("·")}` };
  const text = cleanText(input.text);
  if (!text) return { res: [], msg: "글이 비었음" };
  if (new TextEncoder().encode(text).length > MSG_LIMITS.bytes) return { res: [], msg: `글은 ${MSG_LIMITS.bytes}바이트 이하` }; // 브라우저도 이 파일을 쓰므로 Buffer 대신
  let target = null;
  if (input.target != null) {
    const it = own(scene.items, input.target);
    if (!it || it.kind === "edge") return { res: [], msg: `대상 ${String(input.target).slice(0, 64)} 없음` };
    target = { id: it.id, kind: it.kind === "step" ? "step" : "part" };
  }
  if (queued(scene).length >= MSG_LIMITS.queued) return { res: [], msg: `대기 메시지가 ${MSG_LIMITS.queued}개를 넘음` };
  const v = { mid, kind, text, target, state: "queued", t: ctx.t, ...(cid && { cid }) };
  return { res: [{ k: "msg", v }, { k: "tl", v: { type: "msg", mid, seq: ctx.seq, t: ctx.t } }], msg: `대기 ${mid}` };
}

// 모아 둔 글 여러 개를 한 번에 넣는다. 이미 받은 cid 는 건너뛰고(다시 보낸 묶음), 새 글은 하나라도 틀리면 하나도 넣지 않는다.
// 대기 한도는 이미 대기 중인 글과 새로 넣을 글을 합쳐 센다. mids 는 넣은·이미 있던 메시지 id(입력 순서)
export function evalSendMany(scene, inputs, ctx, mids) {
  if (!Array.isArray(inputs) || !inputs.length) return { res: [], msg: "보낼 글이 없음" };
  const fresh = [], seen = new Set(), got = [...mids];
  for (let i = 0; i < inputs.length; i++) {
    if (!isObj(inputs[i])) return { res: [], msg: `${i + 1}번째 글: 메시지 모양이 틀림` };
    const cid = cidOf(inputs[i]);
    if (cid === false) return { res: [], msg: `${i + 1}번째 글: cid 모양이 틀림` };
    if (cid && seen.has(cid)) return { res: [], msg: `${i + 1}번째 글: 같은 cid 가 두 번` };
    if (cid) seen.add(cid);
    const old = cid && byCid(scene, cid);
    if (!old) { fresh.push(i); continue; }
    if (!sameMsg(old, inputs[i])) return { res: [], msg: `${i + 1}번째 글: 이미 보낸 글(${old.mid})과 내용이 다름`, conflict: cid };
    got[i] = old.mid;
  }
  if (queued(scene).length + fresh.length > MSG_LIMITS.queued) return { res: [], msg: `대기 메시지가 ${MSG_LIMITS.queued}개를 넘음` };
  const res = [];
  for (const i of fresh) {
    const r = evalSend(scene, inputs[i], ctx, mids[i]);
    if (!r.res.length) return { res: [], msg: `${i + 1}번째 글: ${r.msg}` };
    res.push(...r.res);
  }
  const again = inputs.length - fresh.length;
  return { res, msg: `대기 ${fresh.length}개${again ? ` · 이미 받은 ${again}개` : ""}`, done: true, mids: got };
}

// 대기 메시지를 「보냄」으로 바꾸고 Claude 에 넘길 글을 만든다. 넘길 것이 없으면 text 가 빈 글
export function evalDeliver(scene, ctx) {
  // 한 번에 넘기는 글은 32KB 까지(남은 것은 다음 차례 끝에). 훅의 stderr 와 Claude 맥락을 지나치게 키우지 않는다
  const list = [];
  let bytes = 0;
  for (const m of queued(scene).filter((x) => ctx.t - x.t <= MSG_LIMITS.ttl)) {
    bytes += new TextEncoder().encode(m.text).length + 200;
    if (list.length && bytes > MSG_LIMITS.batch) break;
    list.push(m);
  }
  if (!list.length) return { res: [], text: "" };
  const KIND_KO = { comment: "의견", instruction: "지시" };
  const text = list.map((m) => {
    const target = m.target ? ` · 대상: ${m.target.kind === "step" ? "단계" : "부품"} ${m.target.id}` : "";
    return `[anytaskview] 사용자가 이 PC 의 화판에서 직접 쓴 글입니다. 종류: ${KIND_KO[m.kind]}${target} · id: ${m.mid}\n${m.text}`;
  }).join("\n\n");
  // 작업 중에 받아 간 글은 그 차례 안에서 읽는다(이번 차례를 새로 열지 않음). 다시 보낼 때마다 새로 적는다
  const inTurn = scene.sess.status === "working" || scene.sess.status === "input";
  return { res: list.map((m) => ({ k: "msg", v: { mid: m.mid, state: "sent", sentT: ctx.t, inTurn } })), text };
}

// 오래됐거나 세션이 끝나 못 보낸 메시지를 만료로 둔다
export function expireMsgs(scene, res, why, now = null) {
  for (const m of queued(scene)) if (now === null || now - m.t > MSG_LIMITS.ttl) res.push({ k: "msg", v: { mid: m.mid, state: "expired", why } });
  return res;
}
