// 장면 모델: 명령(plan·draw·note)과 훅 사실을 검사해 「결과(res)」를 만들고, 결과를 장면에 적용한다.
// 시계·DOM·파일에 기대지 않는다. 서버와 브라우저(재생)가 이 파일 하나를 같이 쓴다.
// 기록에는 결과가 남고 재생은 applyRes 만 쓴다. 그래서 명령 규칙이 바뀌어도 옛 기록은 같게 재생된다.

export const RECORD_VERSION = 1;
export const STATUSES = ["todo", "doing", "done", "fail", "blocked", "wait"];
export const NOTE_KINDS = ["why", "decision", "blocked", "wait"];
// __proto__ 는 보통 객체 사전에 넣으면 프로토타입이 바뀌므로 받지 않는다
export const ID_RE = /^(?!__proto__$)[A-Za-z0-9_.:-]{1,64}$/;
export const LIMITS = { label: 80, note: 300, text: 2000, src: 4000, ref: 300, ops: 50, parts: 500, depth: 3 };

// kind 마다 받는 필드. 여기에 없는 필드는 무시하고 결과에 알린다
const DRAW_FIELDS = {
  box: ["label", "status", "ref", "note", "in"],
  group: ["label", "status", "in"],
  edge: ["from", "to", "label", "status"],
  list: ["label", "in"],
  item: ["label", "status", "ref", "in"],
  progress: ["label", "value", "max", "in"],
  text: ["label", "text", "in"],
  mermaid: ["label", "src", "in"],
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

function currentIn(items) {
  let best = null;
  for (const it of items) if (it.kind === "step" && ACTIVE.has(it.status) && it.doingOrd && (!best || it.doingOrd > best.doingOrd)) best = it;
  return best ? best.id : null;
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
    default: return null;
  }
}

// 조상 수와 아래로 가장 깊은 자손까지의 단 수. 자기 단(1) + 부모의 조상 수 + 부모(1) + 자손 단 수가 LIMITS.depth 를 넘으면 거부한다
function depthOf(d, id, key) {
  let n = 0;
  for (let p = d.get(id)?.[key]; p && n <= LIMITS.depth + 1; p = d.get(p)?.[key]) n++;
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
  let applied = 0;
  ops.forEach((op, i) => {
    if (i >= LIMITS.ops) { if (i === LIMITS.ops) errs.push(`op ${LIMITS.ops}개 넘음: ${i + 1}번부터 거부`); return; }
    const e = drawOp(d, op, rejected, ignored, overlap);
    if (e) { errs.push(e); if (isObj(op) && typeof op.id === "string") rejected.add(op.id); } else applied++;
  });
  const res = [...d.res(), ...extra];
  let msg = `적용 ${applied}`;
  if (input.clear === true) msg = "비움 · " + msg;
  if (errs.length) msg += ` · 거부 ${errs.length}: ${errs.slice(0, 6).join("; ")}`;
  if (ignored.length) msg += ` · 무시한 필드: ${ignored.slice(0, 6).join(", ")}`;
  if (overlap.length) msg += ` · label 겹침: ${overlap.slice(0, 6).join(", ")}`;
  return { res, msg };
}

function drawOp(d, op, rejected, ignored, overlap) {
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
    if (depthOf(d, op.in, "in") + 2 + heightOf(d, id, "in") > LIMITS.depth) return `${id} ${LIMITS.depth}단보다 깊음`;
  }
  if (kind === "item" && !next.in) return `${id} item 은 in(list) 필요`;

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
  input.steps.forEach((st, i) => {
    if (i >= LIMITS.ops) { if (i === LIMITS.ops) errs.push(`단계 ${LIMITS.ops}개 넘음`); return; }
    const e = planOp(d, st, ctx, ignored);
    if (e) errs.push(e); else applied++;
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
  return { res, msg };
}

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
  const next = old ? { ...old } : { id, kind: "step", status: "todo", ord: ++d.counter };
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
  d.put(next);
  return null;
}

// 상태가 바뀔 때 시각과 순서를 적는다. 진행 시작 시각(startT)과 끝 시각(endT)은 단계 시간 표시에 쓴다
function setStatus(next, prev, t, d) {
  if (next.status === prev) return;
  next.since = t;
  delete next.answered;
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
  let msg = "기록";
  if (kind === "blocked" || kind === "wait") {
    const target = on ? d.get(on) : before ? d.get(before) : null;
    if (target && target.kind !== "step" && !own(DRAW_FIELDS, target.kind).includes("status")) {
      msg += ` · ${target.id}(${target.kind}) 에는 상태가 없음`;
    } else if (target) {
      const next = { ...target, status: kind };
      if (target.kind === "step") setStatus(next, target.status, ctx.t, d);
      d.put(next);
      msg += ` · ${target.id} ${kind === "blocked" ? "막힘" : "승인 대기"}`;
    } else msg += " (지금 단계 없음)";
  }
  const entry = { type: "note", seq: ctx.seq, t: ctx.t, text, step: before };
  if (kind) entry.kind = kind;
  if (on) entry.on = on;
  if (ref) entry.ref = ref;
  const res = [...d.res(), { k: "tl", v: entry }];
  const after = currentIn(d.all());
  if (after !== before) res.push({ k: "cur", v: { t: ctx.t, id: after } });
  return { res, msg };
}

// ---- ids ----
export function idsLine(scene, max = 100) {
  const all = Object.values(scene.items).sort((a, b) => a.ord - b.ord);
  const fmt = (it) => {
    if (it.kind === "step") return `${it.id} "${(it.title || "").slice(0, 20)}" ${it.status}`;
    if (it.kind === "edge") return `${it.id} ${it.from}>${it.to} edge`;
    return `${it.id}${it.label ? ` "${it.label.slice(0, 20)}"` : ""} ${it.kind}${it.status ? " " + it.status : ""}`;
  };
  const steps = all.filter((it) => it.kind === "step"), parts = all.filter((it) => it.kind !== "step");
  if (!all.length) return "비어 있음";
  const shown = [...steps, ...parts].slice(0, max);
  const s = shown.filter((it) => it.kind === "step").map(fmt).join(", ");
  const p = shown.filter((it) => it.kind !== "step").map(fmt).join(", ");
  let out = [s && `plan: ${s}`, p && `draw: ${p}`].filter(Boolean).join(" | ");
  if (all.length > max) out += ` | 외 ${all.length - max}개`;
  return out;
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
  if (fact.f !== "start" && fact.cwd && !scene.meta.cwd) res.push({ k: "meta", v: { cwd: fact.cwd } });
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
  // when 보다 먼저 시작해 아직 열려 있는 실행을 state 로 바꾼다. all 이 아니면 주 에이전트의 것만
  const settleOpen = (state, when, all = false) => {
    for (const r of Object.values(scene.runs)) {
      if ((r.agent && !all) || !OPEN_RUN.has(r.state) || r.state === state || (r.start ?? 0) > when) continue;
      runPut({ ...r, state, ...(state === "unknown" && { end: when }) });
    }
    if (state === "unknown") sess.settleT = Math.max(settled, when);
  };

  switch (fact.f) {
    case "start": {
      // lastStart·pid·pstart 는 서버를 다시 띄울 때 어느 세션이 그 claude 의 지금 세션인지 고르는 데 쓴다
      const meta = { lastStart: ctx.t, ...(fact.cwd && { cwd: fact.cwd }), ...(fact.pid && { pid: fact.pid }), ...(fact.pstart && { pstart: fact.pstart }) };
      linkPrev(scene, fact, meta); // /clear·fork: 같은 claude 의 직전 세션
      res.push({ k: "meta", v: meta });
      if (scene.sess.status === "ended") { sess.status = "idle"; sess.stT = ht; }
      claudeName();
      tl({ f: "start", source: fact.source || "startup" });
      break;
    }
    case "prompt":
      working();
      // 작업 알림(sys)은 사용자 입력이 아니다: 제목으로 쓰지 않고, 승인 대기에 답한 것으로 치지 않는다
      if (fact.sys) {
        tl({ f: "prompt", sys: true, text: fact.text || "" });
        settleOpen("unknown", ht);
        break;
      }
      if (!scene.sess.title && fact.text) {
        sess.title = fact.text.slice(0, 60);
        // 첫 입력이 이어받기 문구(「핸드온 <키>」 따위)면 그 키의 인계를 이어받은 대화다. 앞 대화는 서버가 골라 붙인다
        const key = (ctx.resume || NO_RESUME).prompt(fact.text), meta = {};
        if (key && key !== scene.meta.handoff) meta.handoff = key;
        linkPrev(scene, fact, meta);
        if (Object.keys(meta).length) res.push({ k: "meta", v: meta });
      }
      claudeName();
      tl({ f: "prompt", text: fact.text || "" });
      for (const it of d.all()) {
        if (it.edited) { const n = { ...it }; delete n.edited; d.put(n); }
        else if (it.kind === "step" && it.status === "wait" && !it.answered) d.put({ ...it, answered: true });
      }
      settleOpen("unknown", ht);
      break;
    case "run-start": {
      working();
      if (typeof fact.id !== "string") return { res: [], msg: "실행 id 없음" };
      const old = own(scene.runs, fact.id);
      if (old && !OPEN_RUN.has(old.state)) {
        // 끝이 먼저 왔다: 빠진 설명과 시작 시각·단계만 채우고 상태는 그대로 둔다
        const v = { ...old, cmd: old.cmd || fact.cmd, desc: old.desc || fact.desc, start: ht, ...(old.startMissing && { step }) };
        delete v.startMissing;
        runPut(v);
      } else if (late && !old) {
        // 이미 정리한 뒤에 도착한 시작: 열지 않고 「알 수 없음」으로 둔다
        runPut({ id: fact.id, state: "unknown", cmd: fact.cmd || "", desc: fact.desc || "", start: ht, end: settled, step, ...(agent && { agent }) });
        res.push({ k: "tl", v: { type: "run", id: fact.id, seq: ctx.seq, t: ctx.t } });
      } else if (!old) {
        runPut({ id: fact.id, state: "running", cmd: fact.cmd || "", desc: fact.desc || "", start: ht, step, ...(agent && { agent }) });
        res.push({ k: "tl", v: { type: "run", id: fact.id, seq: ctx.seq, t: ctx.t } });
      }
      break;
    }
    case "run-end":
    case "run-fail": {
      working();
      if (typeof fact.id !== "string") return { res: [], msg: "실행 id 없음" };
      const old = own(scene.runs, fact.id);
      const state = fact.f === "run-fail" ? "fail" : fact.bg ? "background" : "done";
      // 시작보다 끝이 먼저 오면 걸린 시간으로 시작 시각을 어림하고, 시작이 오면 그 값으로 바꾼다
      const fresh = { id: fact.id, cmd: fact.cmd || "", desc: fact.desc || "", step, startMissing: true, ...(typeof fact.dur === "number" && { start: ht - fact.dur }), ...(agent && { agent }) };
      const v = { ...(old || fresh), state, end: ht };
      if (typeof fact.dur === "number") v.dur = fact.dur;
      if (fact.error) v.error = fact.error;
      runPut(v);
      if (!old) res.push({ k: "tl", v: { type: "run", id: fact.id, seq: ctx.seq, t: ctx.t } });
      break;
    }
    case "edit": {
      working();
      tl({ f: "edit", tool: fact.tool, path: fact.path || "", ...(fact.lines && { lines: fact.lines }) });
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
    case "agent-start":
      working();
      tl({ f: "agent-start" });
      break;
    case "agent-stop":
      tl({ f: "agent-stop", last: fact.last || "" });
      // 끝난 하위 에이전트가 열어 둔 실행(승인 거부·중단으로 끝이 오지 않은 것)을 닫는다
      if (agent) for (const r of Object.values(scene.runs)) {
        if (r.agent === agent && OPEN_RUN.has(r.state) && (r.start ?? 0) <= ht) runPut({ ...r, state: "unknown", end: ht });
      }
      break;
    case "notify":
      setSess("input");
      tl({ f: "notify", ntype: fact.ntype || "", text: fact.text || "" });
      settleOpen("wait", ht);
      break;
    case "stop":
      setSess("idle");
      tl({ f: "stop", last: fact.last || "" });
      settleOpen("unknown", ht);
      break;
    case "end":
      sess.status = "ended";
      sess.stT = ht;
      expireMsgs(scene, res, "세션이 끝나 만료");
      tl({ f: "end", reason: fact.reason || "" });
      settleOpen("unknown", ht, true);
      break;
    case "gone":
      if (scene.sess.status === "ended") return { res: [], msg: "이미 끝남" };
      sess.status = "ended";
      sess.stT = ht;
      expireMsgs(scene, res, "세션이 끝나 만료");
      tl({ f: "gone" });
      settleOpen("unknown", ht, true);
      break;
    default:
      return { res: [], msg: `사실 '${short(fact.f)}' 모름` };
  }
  res.unshift(...d.res());
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
const byCid = (scene, cid) => Object.values(scene.msgs || {}).find((m) => m.cid === cid && m.state !== "expired");

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
  return { res: list.map((m) => ({ k: "msg", v: { mid: m.mid, state: "sent", sentT: ctx.t } })), text };
}

// 오래됐거나 세션이 끝나 못 보낸 메시지를 만료로 둔다
export function expireMsgs(scene, res, why, now = null) {
  for (const m of queued(scene)) if (now === null || now - m.t > MSG_LIMITS.ttl) res.push({ k: "msg", v: { mid: m.mid, state: "expired", why } });
  return res;
}
