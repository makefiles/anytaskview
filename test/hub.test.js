// 탭들이 나눠 쓰는 연결(web/hub.js): 가짜 EventSource·fetch·타이머로 worker 를 돌려 구독 요청과 넘기는 사건을 본다
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function hub() {
  const posts = [], timers = [];
  let es;
  class FakeEventSource {
    constructor(url) { this.url = url; this.on = {}; es = this; }
    addEventListener(type, fn) { (this.on[type] ||= []).push(fn); }
    emit(type, data) { for (const fn of this.on[type] || []) fn({ data: JSON.stringify(data) }); }
  }
  const ctx = {
    crypto: { randomUUID: () => "c0ffee00-1111-2222-3333-444455556666" },
    EventSource: FakeEventSource,
    fetch: (url, opts) => new Promise((resolve, reject) => posts.push({ url, body: JSON.parse(opts.body), ok: () => resolve({ ok: true }), fail: () => reject(new Error("끊김")) })),
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    clearTimeout: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL("../web/hub.js", import.meta.url), "utf8"), ctx);
  const tab = () => {
    const port = { got: [], postMessage(m) { port.got.push({ ev: m.ev, data: JSON.parse(m.data) }); } };
    ctx.onconnect({ ports: [port] });
    port.say = (d) => port.onmessage({ data: d });
    return port;
  };
  const flush = () => new Promise((ok) => setImmediate(ok));
  return { es: () => es, posts, timers, tab, flush };
}

test("같은 세션을 두 탭이 거의 함께 열어도, 앞 요청이 끝날 때 뒤 탭의 스냅샷 요청을 지우지 않는다", async () => {
  const h = hub();
  h.es().emit("open", {});
  h.posts[0].ok();
  await h.flush();
  const a = h.tab();
  a.say({ want: "X" });
  assert.deepEqual(h.posts[1].body, { chan: "c0ffee00-1111-2222-3333-444455556666", sids: ["X"], fresh: ["X"] });
  h.es().emit("snap", { id: "X", seq: 5, scene: {} }); // 서버가 앞 요청의 스냅샷을 보냈다(응답은 아직)
  const b = h.tab();
  b.say({ want: "X" }); // 뒤 탭은 그 스냅샷이 지나간 뒤에 기다리기 시작한다
  h.posts[1].ok();
  await h.flush();
  assert.equal(h.posts.length, 3, "보내는 사이 바뀐 것을 한 번 더 보낸다");
  assert.deepEqual(h.posts[2].body.fresh, ["X"], "뒤 탭의 요청이 남는다");
  h.es().emit("snap", { id: "X", seq: 6, scene: {} });
  h.es().emit("res", { id: "X", seq: 7, res: [] });
  assert.deepEqual(a.got.filter((m) => m.ev !== "list").map((m) => [m.ev, m.data.seq]), [["snap", 5], ["res", 7]], "앞 탭은 스냅샷을 두 번 받지 않는다");
  assert.deepEqual(b.got.map((m) => [m.ev, m.data.seq]), [["snap", 6], ["res", 7]]);
});

test("스냅샷을 기다리는 탭에는 그 세션의 변경을 넘기지 않고, 다른 세션 것은 어느 탭에도 넘기지 않는다", async () => {
  const h = hub();
  h.es().emit("open", {});
  h.posts[0].ok();
  await h.flush();
  const a = h.tab();
  a.say({ want: "X" });
  h.es().emit("res", { id: "X", seq: 3, res: [] }); // 스냅샷 전: 스냅샷에 이미 들어 있다
  h.es().emit("snap", { id: "X", seq: 3, scene: {} });
  h.es().emit("res", { id: "Y", seq: 9, res: [] });
  h.es().emit("res", { id: "X", seq: 4, res: [] });
  assert.deepEqual(a.got.map((m) => [m.ev, m.data.seq]), [["snap", 3], ["res", 4]]);
});

test("구독 요청만 실패하면(연결은 살아 있음) 조금 뒤 같은 요청을 다시 보내고, 연결이 다시 이어지면 모든 탭이 스냅샷부터 받는다", async () => {
  const h = hub();
  h.es().emit("open", {});
  h.posts[0].ok();
  await h.flush();
  const a = h.tab();
  a.say({ want: "X" });
  h.posts[1].fail();
  await h.flush();
  assert.equal(h.timers.length, 1, "다시 보내기를 예약한다");
  h.timers[0].fn();
  assert.deepEqual(h.posts[2].body.fresh, ["X"], "스냅샷 요청이 남아 있다");
  h.posts[2].ok();
  await h.flush();
  h.es().emit("snap", { id: "X", seq: 1, scene: {} });
  // 서버가 다시 떴다: 새 연결의 구독을 다시 알리고, 그전의 변경은 넘기지 않는다
  h.es().emit("error", {});
  h.es().emit("open", {});
  assert.deepEqual(h.posts[3].body.sids, ["X"]);
  h.es().emit("res", { id: "X", seq: 2, res: [] });
  h.es().emit("snap", { id: "X", seq: 2, scene: {} });
  assert.deepEqual(a.got.map((m) => [m.ev, m.data.seq]), [["snap", 1], ["snap", 2]]);
});

test("연결이 아주 닫히면(다시 잇다가 401 따위) 조금 뒤 새로 만들고, 새 연결에 구독을 다시 알린다", async () => {
  const h = hub();
  const first = h.es();
  first.emit("open", {});
  h.posts[0].ok();
  await h.flush();
  const a = h.tab();
  a.say({ want: "X" });
  h.posts[1].ok();
  await h.flush();
  first.emit("error", {}); // 스스로 다시 잇는 중: 새로 만들지 않는다
  assert.equal(h.timers.length, 0);
  first.readyState = 2;
  first.emit("error", {});
  assert.equal(h.timers.length, 1);
  h.timers[0].fn();
  assert.notEqual(h.es(), first);
  h.es().emit("open", {});
  assert.deepEqual(h.posts[2].body.sids, ["X"]);
  h.es().emit("snap", { id: "X", seq: 4, scene: {} });
  assert.deepEqual(a.got.map((m) => [m.ev, m.data.seq]), [["snap", 4]]);
});

test("새 탭은 마지막 프로젝트·설정·목록(sess·drop 반영)을 바로 받고, 떠난 탭의 세션은 구독에서 뺀다", async () => {
  const h = hub();
  h.es().emit("open", {});
  h.posts[0].ok();
  await h.flush();
  h.es().emit("projects", { projects: {}, members: {} });
  h.es().emit("config", { resume: null });
  h.es().emit("list", [{ id: "X" }, { id: "Y" }]);
  h.es().emit("sess", { id: "Z" });
  h.es().emit("drop", ["Y"]);
  const a = h.tab();
  assert.deepEqual(a.got.map((m) => m.ev), ["projects", "config", "list"]);
  assert.deepEqual(a.got[2].data.map((s) => s.id), ["X", "Z"]);
  a.say({ want: "X" });
  h.posts[1].ok();
  await h.flush();
  a.say({ bye: true });
  assert.deepEqual(h.posts[2].body.sids, []);
});
