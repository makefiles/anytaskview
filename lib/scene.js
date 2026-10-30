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
// 프로젝트 큰 그림 화판에는 사용자 입력이 오지 않는다. 그 프로젝트에 든 대화에 입력이 오면 서버가 이것으로 대기를 푼다
export function evalAnswered(scene) {
  const d = draft(scene);
  answerWaits(d);
  const res = d.res();
  return { res, msg: res.length ? `답 받음 ${res.length}` : "대기 없음" };
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
    const e = drawOp(d, op, rejected, ignored, overlap);
    if (e) { errs.push(e); if (isObj(op) && typeof op.id === "string") rejected.add(op.id); return; }
    applied++;
    // 만들기·지우기, 또는 상태·메모가 아닌 필드의 값이 실제로 바뀌었으면 그림의 내용을 바꾼 것이다(무시한 필드·같은 값은 아님)
    const after = d.get(op.id);
    if (!before || !after || CONTENT_FIELDS.some((f) => JSON.stringify(before[f]) !== JSON.stringify(after[f]))) shaped = true;
  });
  // 그림을 마지막으로 바꾼 시각(drawT)과 내용을 바꾼 시각(shapeT). 새 작업(view.taskT)보다 오래된 그림인지 가리는 데 쓴다(큰 그림 화판은 따지지 않는다)
  if ((applied || input.clear === true) && ctx?.t && !ctx.project) extra.push({ k: "view", v: { drawT: ctx.t, ...(shaped && { shapeT: ctx.t }) } });
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

  if (old && (next.status !== old.status || op.status === "wait")) delete next.answered; // 상태가 바뀌거나 대기를 다시 보내면 새 질문이다

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
  // 하위 에이전트도 같은 세션 화판에 쓰고, 서버는 누가 불렀는지 모른다. 하위 에이전트가 도는 동안에는 새 작업도 알림도 따지지 않는다
  if (!ctx.project && !agentRunning(scene, ctx.t)) {
    // 새 작업: 새 단계가 둘 이상이고, 지금 단계가 그 새 단계로 옮겨 갔다(진행 중인 작업에 단계를 덧붙인 것은 빼려고)
    if (fresh.size >= TASK_STEPS && (!after || fresh.has(after))) { res.push({ k: "view", v: { taskT: ctx.t } }); msg += leftoverHint(steps, fresh); }
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
function leftoverHint(steps, fresh) {
  const left = steps.filter((s) => !fresh.has(s.id) && LEFT_STEP.has(s.status)).sort((a, b) => a.ord - b.ord);
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
    // 남겨 답을 받으면 돌린다. 프로젝트 큰 그림(ctx.project)에는 사용자 입력이 오지 않고 다른 대화가 끝낸 단위가 있어 붙이지 않는다
    if (!on && !before && !ctx.project) {
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
      if (auto) next.back = target.status;
      delete next.answered; // 새 승인 대기 메모는 새 질문이다(이미 「답 받음」 인 대기에도)
      d.put(next);
      msg += ` · ${target.id} ${kind === "blocked" ? "막힘" : "승인 대기"}${auto ? "(방금 끝난 단계)" : ""}`;
    } else msg += " (지금 단계 없음)";
  }
  const entry = { type: "note", seq: ctx.seq, t: ctx.t, text, step: before };
  if (kind) entry.kind = kind;
  if (on || auto) entry.on = on || auto; // 붙은 단계(큰 그림의 남은 결정 대기 찾기가 on 을 본다)
  if (ref) entry.ref = ref;
  const res = [...d.res(), { k: "tl", v: entry }];
  const after = currentIn(d.all());
  if (after !== before) res.push({ k: "cur", v: { t: ctx.t, id: after } });
  return { res, msg };
}

// ---- ids ----
export const idsLine = (scene, max = 100) => idsView(scene, max).text;
const BARE_MAX = 60;
// brief: 끝난 단계 가운데 최근 brief 개만 제목을 싣고 나머지는 id 만 싣는다(세션을 시작할 때 실리는 프로젝트 안내가
// 단위마다 길어지지 않게). id 만 실은 단계는 max 에 세지 않는다. cut: 싣지 못한 단계·부품이 있는가
export function idsView(scene, max = 100, brief = 0) {
  const all = Object.values(scene.items).sort((a, b) => a.ord - b.ord);
  const fmt = (it) => {
    if (it.kind === "step") return `${it.id} "${(it.title || "").slice(0, 20)}" ${it.status}`;
    if (it.kind === "edge") return `${it.id} ${it.from}>${it.to} edge`;
    return `${it.id}${it.label ? ` "${it.label.slice(0, 20)}"` : ""} ${it.kind}${it.status ? " " + it.status : ""}`;
  };
  if (!all.length) return { text: "비어 있음", cut: false };
  // 끝낸 때 순서(같으면 만든 순서). 최근 brief 개만 제목을 싣고, 그 앞은 최근 것부터 id 를 BARE_MAX 개까지 싣는다
  const done = all.filter((it) => it.kind === "step" && it.status === "done").sort((a, b) => (a.endT || 0) - (b.endT || 0) || a.ord - b.ord);
  const old = brief ? done.slice(0, Math.max(0, done.length - brief)) : [];
  const bare = old.slice(-BARE_MAX), dropped = old.length - bare.length;
  const steps = all.filter((it) => it.kind === "step" && !old.includes(it));
  // 그림도 같게 줄인다(큰 그림은 단위마다 상자·선이 쌓인다, 25): 끝난 부품은 최근 brief 개만 이름을 싣고 그 앞은 id 만, 선은 수만
  let parts = all.filter((it) => it.kind !== "step"), oldParts = [], bareParts = [], edges = 0;
  if (brief) {
    const fin = parts.filter((it) => it.kind !== "edge" && (it.status === "done" || it.status === "fail"));
    oldParts = fin.slice(0, Math.max(0, fin.length - brief));
    bareParts = oldParts.slice(-BARE_MAX);
    edges = parts.filter((it) => it.kind === "edge").length;
    parts = parts.filter((it) => it.kind !== "edge" && !oldParts.includes(it));
  }
  const partDropped = oldParts.length - bareParts.length;
  const shown = [...steps, ...parts].slice(0, max);
  const s = [bare.length ? `끝남 ${old.length}: ${bare.map((it) => it.id).join(" ")}${dropped ? ` 외 ${dropped}개` : ""}` : "", ...shown.filter((it) => it.kind === "step").map(fmt)].filter(Boolean).join(", ");
  const p = [bareParts.length ? `끝남 ${oldParts.length}: ${bareParts.map((it) => it.id).join(" ")}${partDropped ? ` 외 ${partDropped}개` : ""}` : "",
    ...shown.filter((it) => it.kind !== "step").map(fmt), edges ? `선 ${edges}개` : ""].filter(Boolean).join(", ");
  let text = [s && `plan: ${s}`, p && `draw: ${p}`].filter(Boolean).join(" | ");
  const left = steps.length + parts.length - shown.length + dropped + partDropped;
  if (left - dropped - partDropped) text += ` | 외 ${left - dropped - partDropped}개`;
  return { text, cut: left > 0 };
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
        const key = (ctx.resume || NO_RESUME).prompt(fact.text), meta = {};
        if (key && key !== scene.meta.handoff) meta.handoff = key;
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
  return { res: list.map((m) => ({ k: "msg", v: { mid: m.mid, state: "sent", sentT: ctx.t } })), text };
}

// 오래됐거나 세션이 끝나 못 보낸 메시지를 만료로 둔다
export function expireMsgs(scene, res, why, now = null) {
  for (const m of queued(scene)) if (now === null || now - m.t > MSG_LIMITS.ttl) res.push({ k: "msg", v: { mid: m.mid, state: "expired", why } });
  return res;
}
