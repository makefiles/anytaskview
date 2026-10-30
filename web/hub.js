// 탭·새 창이 나눠 쓰는 SSE 연결(SharedWorker). 브라우저는 한 주소에 연결을 여섯 개까지만 열어, 탭마다 SSE 를 두면
// 일곱 번째 탭부터 화판이 멈췄다. 연결 하나로 탭들이 보는 세션을 모두 받아 탭마다 나눠 준다.
// 탭 → 여기: { want: id 또는 null }(보는 세션을 바꿈, 그 세션은 스냅샷부터 다시 받는다), { bye: true }(문서를 떠남)
// 여기 → 탭: { ev, data }(SSE 사건 이름과 글 그대로)
const chan = crypto.randomUUID();
// 탭 port → { want, waiting }. waiting: 스냅샷을 기다리는 중이라 그전에 온 그 세션의 변경은 넘기지 않는다
// (스냅샷에 이미 들어 있다. 연결 하나의 사건은 순서대로 오므로 스냅샷 뒤의 변경만 넘기면 빠짐이 없다)
const ports = new Map();
// 새 탭에 바로 줄 목록·프로젝트·설정. 목록은 받은 뒤 sess·drop 으로 고친다
let list = null, projects = null, config = null;
let open = false, posting = false, again = false, retry = 0, retryMs = 500;
// 서버가 스냅샷을 다시 보내야 할 id → 요청 번호. 보내는 사이 다른 탭이 같은 id 를 또 요청하면 번호가 바뀌므로,
// 앞 요청이 끝나도 지우지 않고 다음 요청에 싣는다(앞 요청의 스냅샷은 그 탭이 기다리기 전에 지나갔을 수 있다)
const fresh = new Map();
let freshSeq = 0;

const toAll = (ev, data) => { for (const port of ports.keys()) port.postMessage({ ev, data }); };
// EventSource 는 끊기면 스스로 다시 잇지만, 다시 이을 때 200 이 아닌 답(열쇠가 바뀌어 401 따위)을 받으면 아주 닫는다.
// worker 는 탭이 하나라도 열려 있으면 살아 있어 새로 고친 탭도 여기에 붙으므로, 아주 닫혔으면 조금씩 늦춰 새로 만든다
let es, reopenMs = 1000;
function connectEvents() {
  es = new EventSource(`/events?chan=${chan}`);
  es.addEventListener("open", () => {
    // 처음 잇거나 다시 이었다(서버 재시작 따위). 서버는 새 연결의 구독을 모르므로 모두 다시 알리고 스냅샷부터 받는다
    open = true;
    reopenMs = 1000;
    for (const p of ports.values()) if (p.want) p.waiting = true;
    sync();
  });
  es.addEventListener("error", () => {
    open = false;
    if (es.readyState !== 2) return; // 2 = CLOSED. 그 밖에는 스스로 다시 잇는다
    setTimeout(connectEvents, reopenMs);
    reopenMs = Math.min(reopenMs * 2, 30_000);
  });
  es.addEventListener("list", (ev) => {
    list = new Map(JSON.parse(ev.data).map((s) => [s.id, s]));
    toAll("list", ev.data);
  });
  es.addEventListener("sess", (ev) => {
    const s = JSON.parse(ev.data);
    list?.set(s.id, s);
    toAll("sess", ev.data);
  });
  es.addEventListener("drop", (ev) => {
    for (const id of JSON.parse(ev.data)) list?.delete(id);
    toAll("drop", ev.data);
  });
  es.addEventListener("projects", (ev) => { projects = ev.data; toAll("projects", ev.data); });
  es.addEventListener("config", (ev) => { config = ev.data; toAll("config", ev.data); });
  es.addEventListener("docs", (ev) => toAll("docs", ev.data)); // 문서 고정·숨김이 바뀜(탭마다 목록을 다시 받는다)
  es.addEventListener("snap", (ev) => {
    const id = JSON.parse(ev.data).id;
    for (const [port, p] of ports) if (p.want === id && p.waiting) { p.waiting = false; port.postMessage({ ev: "snap", data: ev.data }); }
  });
  es.addEventListener("res", (ev) => {
    const id = JSON.parse(ev.data).id;
    for (const [port, p] of ports) if (p.want === id && !p.waiting) port.postMessage({ ev: "res", data: ev.data });
  });
}
connectEvents();

// 탭들이 보는 id 를 모아 서버에 알린다. 한 번에 하나씩 보내고, 보내는 사이 바뀌었으면 끝난 뒤 한 번 더 보낸다.
// 요청만 실패하면(연결은 살아 있어 open 이 다시 오지 않는다) 조금씩 늦춰 다시 보낸다
async function sync() {
  if (!open) return; // 이어지면 open 에서 다시 부른다
  if (posting) { again = true; return; }
  posting = true;
  clearTimeout(retry);
  let failed = false;
  try {
    do {
      again = false;
      const sids = [...new Set([...ports.values()].map((p) => p.want).filter(Boolean))];
      const asked = [...fresh];
      let ok = false;
      try {
        const r = await fetch("/api/sub", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chan, sids, fresh: asked.map(([id]) => id) }) });
        ok = r.ok;
      } catch { /* 서버가 내려갔거나 요청만 실패했다 */ }
      if (!ok) { failed = true; break; }
      for (const [id, n] of asked) if (fresh.get(id) === n) fresh.delete(id);
    } while (again && open);
  } finally { posting = false; }
  if (failed && open) { retry = setTimeout(sync, retryMs); retryMs = Math.min(retryMs * 2, 10_000); }
  else if (!failed) retryMs = 500;
}

// 서버가 연결할 때 보내는 순서대로(프로젝트 → 설정 → 목록) 마지막 것을 준다
function greet(port) {
  if (projects !== null) port.postMessage({ ev: "projects", data: projects });
  if (config !== null) port.postMessage({ ev: "config", data: config });
  if (list) port.postMessage({ ev: "list", data: JSON.stringify([...list.values()]) });
}
onconnect = (ev) => {
  const port = ev.ports[0];
  const p = { want: null, waiting: false };
  ports.set(port, p);
  greet(port);
  port.onmessage = (m) => {
    const d = m.data || {};
    if (d.bye) { ports.delete(port); sync(); return; }
    // 뒤로 가기 캐시에서 돌아온 문서는 bye 뒤에 다시 말을 건다. 떠나 있던 사이의 목록을 다시 준다
    if (!ports.has(port)) { ports.set(port, p); greet(port); }
    p.want = typeof d.want === "string" ? d.want : null;
    p.waiting = !!p.want;
    if (p.want) fresh.set(p.want, ++freshSeq);
    sync();
  };
};
