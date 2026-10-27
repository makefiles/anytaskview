// 장면 규칙 시험: 명령 검사, 지금 단계, 훅 사실의 순서 처리, 재생이 실시간과 같은지
import { test } from "node:test";
import assert from "node:assert/strict";
import { newScene, applyRes, evalPlan, evalDraw, evalNote, evalFact, idsLine, currentStep, resumeRule, checkResume, LEGACY_RESUME, evalSend, expireMsgs } from "../lib/scene.js";

// 서버처럼: 검사 → 기록(JSON) → 기록을 되읽어 적용
function harness(resume) {
  const scene = newScene(), log = [];
  let seq = 0;
  const run = (fn, input, t, ht) => {
    const ctx = { t, seq: ++seq, ...(ht !== undefined && { ht }), ...(resume && { resume }) };
    const out = fn(scene, input, ctx);
    const res = JSON.parse(JSON.stringify(out.res));
    applyRes(scene, res);
    log.push(res);
    return out.msg;
  };
  return {
    scene, log,
    plan: (input, t = 1000) => run(evalPlan, input, t),
    draw: (input, t = 1000) => run(evalDraw, input, t),
    note: (input, t = 1000) => run(evalNote, input, t),
    fact: (f, t = 1000, ht = t) => run(evalFact, f, t, ht),
    replay() { const s = newScene(); for (const r of log) applyRes(s, r); return s; },
  };
}

test("plan: 새 단계는 title 필요, 지금 단계는 가장 최근에 doing 이 된 단계", () => {
  const h = harness();
  assert.match(h.plan({ steps: [{ id: "s1" }] }), /새 단계는 title 필요/);
  assert.equal(h.plan({ steps: [{ id: "s1", title: "원인", status: "doing" }, { id: "s2", title: "고치기" }] }), "계획 2단계 · 지금 s1");
  assert.equal(h.plan({ steps: [{ id: "s1", status: "done" }, { id: "s2", status: "doing" }] }), "계획 2단계 · 지금 s2");
  const msg = h.plan({ steps: [{ id: "s1", status: "doing" }] });
  assert.match(msg, /지금 s1 · doing 2: s1 s2/);
  assert.equal(h.scene.items.s1.startT, 1000);
});

test("plan: parent 순환과 깊이를 거부한다", () => {
  const h = harness();
  h.plan({ steps: [{ id: "a", title: "A" }, { id: "b", title: "B", parent: "a" }, { id: "c", title: "C", parent: "b" }] });
  assert.match(h.plan({ steps: [{ id: "a", parent: "c" }] }), /돌아서 자기에게 옴/);
  assert.match(h.plan({ steps: [{ id: "d", title: "D", parent: "c" }] }), /3단보다 깊음/);
});

test("단계와 부품은 이름 공간 하나를 쓴다", () => {
  const h = harness();
  h.plan({ steps: [{ id: "s1", title: "원인" }] });
  assert.match(h.draw({ ops: [{ id: "s1", kind: "box" }] }), /단계 id/);
  h.draw({ ops: [{ id: "a", kind: "box", label: "A" }] });
  assert.match(h.plan({ steps: [{ id: "a", title: "x" }] }), /부품 id/);
});

test("draw: edge 는 id 필수, 끝점은 만들 때만, 앞 op 가 거부되면 이유를 붙인다", () => {
  const h = harness();
  h.draw({ ops: [{ id: "a", kind: "box", label: "A" }, { id: "b", kind: "box", label: "B" }] });
  assert.match(h.draw({ ops: [{ kind: "edge", from: "a", to: "b" }] }), /id 'undefined' 모양이 틀림/);
  assert.equal(h.draw({ ops: [{ id: "e1", kind: "edge", from: "a", to: "b", label: "호출" }] }), "적용 1");
  assert.match(h.draw({ ops: [{ id: "e1", to: "a" }] }), /from·to 는 만들 때만 정함/);
  assert.match(h.draw({ ops: [{ id: "c", kind: "box", status: "nope" }, { id: "e2", kind: "edge", from: "c", to: "a" }] }), /e2 from 'c' 거부됨/);
});

test("draw: 목록 항목에는 화살표를 잇지 않는다", () => {
  const h = harness();
  h.draw({ ops: [{ id: "l", kind: "list" }, { id: "i", kind: "item", in: "l" }, { id: "a", kind: "box" }] });
  assert.match(h.draw({ ops: [{ id: "e", kind: "edge", from: "a", to: "i" }] }), /e to 'i' 은 목록 항목/);
});

test("draw: null 은 필드를 지우고, 받지 않는 필드는 알린다", () => {
  const h = harness();
  h.draw({ ops: [{ id: "a", kind: "box", label: "A", status: "fail", ref: "x.js:1" }] });
  const msg = h.draw({ ops: [{ id: "a", status: null, color: "red" }] });
  assert.match(msg, /무시한 필드: a\.color/);
  assert.equal(h.scene.items.a.status, undefined);
  assert.equal(h.scene.items.a.ref, "x.js:1");
});

test("draw: clear 는 ops 보다 먼저, 묶음을 지우면 자손과 화살표도 지운다", () => {
  const h = harness();
  h.plan({ steps: [{ id: "s1", title: "원인" }] });
  h.draw({ ops: [{ id: "g", kind: "group", label: "G" }, { id: "a", kind: "box", in: "g" }, { id: "b", kind: "box" }, { id: "e", kind: "edge", from: "a", to: "b" }] });
  h.draw({ ops: [{ id: "g", del: true }] });
  assert.deepEqual(Object.keys(h.scene.items).sort(), ["b", "s1"]);
  assert.match(h.draw({ clear: true, ops: [{ id: "b", label: "다시" }] }), /b 새 부품은 kind 필요/);
  assert.deepEqual(Object.keys(h.scene.items), ["s1"]);
});

test("draw: in 은 group(item 은 list·item)만, 순환과 3단 넘는 깊이는 거부", () => {
  const h = harness();
  h.draw({ ops: [{ id: "a", kind: "box" }, { id: "l", kind: "list", label: "목차" }] });
  assert.match(h.draw({ ops: [{ id: "x", kind: "box", in: "a" }] }), /in 'a' 은 box/);
  assert.match(h.draw({ ops: [{ id: "i", kind: "item", label: "1장" }] }), /item 은 in\(list\) 필요/);
  assert.equal(h.draw({ ops: [{ id: "i1", kind: "item", label: "1장", in: "l" }, { id: "i2", kind: "item", label: "1.1", in: "i1" }] }), "적용 2");
  h.draw({ ops: [{ id: "g1", kind: "group" }, { id: "g2", kind: "group", in: "g1" }, { id: "g3", kind: "group", in: "g2" }] });
  assert.match(h.draw({ ops: [{ id: "g1", in: "g3" }] }), /돌아서 자기에게 옴/);
  assert.match(h.draw({ ops: [{ id: "deep", kind: "box", in: "g3" }] }), /3단보다 깊음/);
});

test("draw: 내장 속성 이름(constructor 등)을 부품이나 kind 로 착각하지 않는다", () => {
  const h = harness();
  assert.match(h.draw({ ops: [{ id: "x", kind: "constructor", label: "X" }] }), /kind 'constructor' 모름/);
  assert.equal(h.plan({ steps: [{ id: "constructor", title: "C" }] }), "계획 1단계");
  h.draw({ ops: [{ id: "a", kind: "box" }] });
  assert.match(h.draw({ ops: [{ id: "e", kind: "edge", from: "toString", to: "a" }] }), /from 'toString' 없음/);
});

test("draw: 다른 id 로 같은 label 을 만들면 알린다", () => {
  const h = harness();
  h.draw({ ops: [{ id: "a", kind: "box", label: "parser.c" }] });
  assert.match(h.draw({ ops: [{ id: "p", kind: "box", label: "parser.c" }] }), /label 겹침: p\(=a\)/);
});

test("note: 막힘·승인 대기는 단계 상태를 바꾸고, 지금 단계는 그대로 남는다", () => {
  const h = harness();
  h.plan({ steps: [{ id: "s", title: "고치기", status: "doing" }] });
  assert.equal(h.note({ text: "승인 받아야 함", kind: "wait" }), "기록 · s 승인 대기");
  assert.equal(currentStep(h.scene), "s");
  h.fact({ f: "prompt", text: "ok" }, 2000);
  assert.equal(h.scene.items.s.answered, true);
  assert.equal(h.scene.items.s.status, "wait");
  assert.equal(h.scene.timeline.at(-1).step, "s");
  h.plan({ steps: [{ id: "s", status: "doing" }] });
  assert.equal(h.scene.items.s.answered, undefined);
});

test("작업 알림(sys) 입력은 제목이 되지 않고 승인 대기에 답한 것으로 치지 않는다", () => {
  const h = harness();
  h.plan({ steps: [{ id: "s", title: "고치기", status: "doing" }] });
  h.note({ text: "승인 받아야 함", kind: "wait" });
  h.fact({ f: "prompt", sys: true, text: "Background command completed" }, 2000);
  assert.equal(h.scene.sess.title, "");
  assert.equal(h.scene.items.s.answered, undefined);
  assert.equal(h.scene.sess.status, "working");
  assert.equal(h.scene.timeline.at(-1).sys, true);
  h.fact({ f: "prompt", text: "진짜 입력" }, 3000);
  assert.equal(h.scene.sess.title, "진짜 입력");
  assert.equal(h.scene.items.s.answered, true);
});

test("사실은 훅 시각 때 지금이던 단계에 붙는다", () => {
  const h = harness();
  h.plan({ steps: [{ id: "s1", title: "A", status: "doing" }], }, 1000);
  h.plan({ steps: [{ id: "s1", status: "done" }, { id: "s2", title: "B", status: "doing" }] }, 2000);
  h.fact({ f: "edit", tool: "Edit", path: "/w/a.js" }, 2100, 1500); // 늦게 도착했지만 s1 때 고친 것
  assert.equal(h.scene.timeline.at(-1).step, "s1");
});

test("실행: 끝이 먼저 와도 늦은 시작이 되돌리지 못하고, 단계는 시작 시각으로 채운다", () => {
  const h = harness();
  h.plan({ steps: [{ id: "a", title: "A", status: "doing" }] }, 10);
  h.plan({ steps: [{ id: "a", status: "done" }, { id: "b", title: "B", status: "doing" }] }, 20);
  h.fact({ f: "run-end", id: "r", dur: 5 }, 26, 25);
  h.fact({ f: "run-start", id: "r", cmd: "npm test" }, 27, 15);
  const r = h.scene.runs.r;
  assert.equal(r.state, "done");
  assert.equal(r.step, "a");
  assert.equal(r.start, 15);
  assert.equal(r.startMissing, undefined);
  assert.equal(h.scene.timeline.filter((e) => e.type === "run").length, 1);
});

test("실행: 정리 뒤에 도착한 시작은 열지 않고, 정리는 그보다 나중 시작한 실행을 닫지 않는다", () => {
  const h = harness();
  h.fact({ f: "stop" }, 21, 20);
  h.fact({ f: "run-start", id: "late" }, 22, 10);
  assert.equal(h.scene.runs.late.state, "unknown");
  assert.equal(h.scene.sess.status, "idle");
  h.fact({ f: "run-start", id: "new" }, 31, 30);
  h.fact({ f: "prompt", text: "x" }, 32, 25); // 늦게 온 입력(25)이 30 에 시작한 실행을 닫으면 안 된다
  assert.equal(h.scene.runs.new.state, "running");
});

test("실행: 승인 알림은 「승인 대기」, 세션 끝은 하위 에이전트 실행까지 닫는다", () => {
  const h = harness();
  h.fact({ f: "run-start", id: "m" }, 10);
  h.fact({ f: "run-start", id: "s", agent: "ag1" }, 11);
  h.fact({ f: "notify", ntype: "permission_prompt", text: "Bash 승인" }, 12);
  assert.equal(h.scene.runs.m.state, "wait");
  assert.equal(h.scene.sess.status, "input");
  h.fact({ f: "end", reason: "other" }, 20);
  assert.equal(h.scene.runs.m.state, "unknown");
  assert.equal(h.scene.runs.s.state, "unknown");
  assert.equal(h.scene.sess.status, "ended");
});

test("늦게 온 승인 알림은 그 뒤에 바뀐 세션 상태를 되돌리지 않는다", () => {
  const h = harness();
  h.fact({ f: "run-start", id: "r" }, 11, 10);
  h.fact({ f: "run-end", id: "r" }, 31, 30);
  h.fact({ f: "notify", ntype: "permission_prompt" }, 32, 20); // 실행이 끝나기 전에 떴던 알림이 늦게 왔다
  assert.equal(h.scene.sess.status, "working");
  h.fact({ f: "notify", ntype: "permission_prompt" }, 41, 40);
  assert.equal(h.scene.sess.status, "input");
});

test("수정 사실은 ref 가 같은 파일인 부품에 「수정됨」을 붙이고, 다음 입력에서 내린다", () => {
  const h = harness();
  h.fact({ f: "start", cwd: "/w/proj" });
  h.draw({ ops: [{ id: "a", kind: "box", ref: "src/a.js:12" }, { id: "b", kind: "box", ref: "./src/b.js" }] });
  h.fact({ f: "edit", tool: "Edit", path: "/w/proj/src/a.js" });
  assert.equal(h.scene.items.a.edited, true);
  assert.equal(h.scene.items.b.edited, undefined);
  h.fact({ f: "prompt", text: "다음" });
  assert.equal(h.scene.items.a.edited, undefined);
});

test("ids: 이름표와 label 앞부분을 한 줄로", () => {
  const h = harness();
  h.plan({ steps: [{ id: "s1", title: "원인 찾기", status: "doing" }] });
  h.draw({ ops: [{ id: "a", kind: "box", label: "parser.c", status: "doing" }, { id: "b", kind: "box" }, { id: "e1", kind: "edge", from: "a", to: "b" }] });
  assert.equal(idsLine(h.scene), 'plan: s1 "원인 찾기" doing | draw: a "parser.c" box doing, b box, e1 a>b edge');
});

test("ref 에 줄바꿈 같은 제어 문자는 받지 않는다(복사해 터미널에 붙이면 명령이 된다)", () => {
  const h = harness();
  assert.match(h.draw({ ops: [{ id: "a", kind: "box", ref: "src/a.c:1\nrm -rf ~" }] }), /제어 문자 없는/);
  assert.match(h.note({ text: "x", ref: "a\rb" }), /제어 문자 없는/);
});

test("__proto__ 는 이름표로 받지 않는다", () => {
  const h = harness();
  assert.match(h.draw({ ops: [{ id: "__proto__", kind: "box" }] }), /모양이 틀림/);
  assert.match(h.plan({ steps: [{ id: "__proto__", title: "x" }] }), /모양이 틀림/);
});

test("하위 에이전트가 끝나면 그 에이전트가 열어 둔 실행을 닫는다", () => {
  const h = harness();
  h.fact({ f: "run-start", id: "r1", agent: "ag" }, 10);
  h.fact({ f: "run-start", id: "r2", agent: "other" }, 11);
  h.fact({ f: "agent-stop", agent: "ag" }, 20);
  assert.equal(h.scene.runs.r1.state, "unknown");
  assert.equal(h.scene.runs.r2.state, "running");
});

test("이어받기 문구: 설정한 문구·인계 문서 경로에서 키를 읽고, 설정이 없으면 읽지 않으며, 앞 대화(prev)는 처음 한 번만 남긴다", () => {
  const r = resumeRule(LEGACY_RESUME);
  assert.equal(r.prompt("핸드온 anytaskview — 02 끝"), "anytaskview");
  assert.equal(r.prompt("  핸드온   phase2, 이어서"), "phase2");
  assert.equal(r.prompt("핸드오프"), null);
  assert.equal(r.prompt("이전 핸드온 phase2"), null, "맨 앞만 본다");
  assert.equal(r.path("/home/u/notes/pages/handoff/issue-1234.md"), "issue-1234");
  assert.equal(r.path("/home/u/handoff.md"), null);
  // 다른 사람의 문구: 「continue #<키>」, 인계 문서는 쓰지 않음
  const o = resumeRule({ phrase: "continue #<키>" });
  assert.equal(o.prompt("continue #auth-v2 please"), "auth-v2");
  assert.equal(o.prompt("continue # auth"), null, "<키> 앞이 붙어 있으면 붙여 쓴 것만");
  assert.equal(o.path("/x/handoff/k.md"), null);
  // <키> 뒤에 글이 있는 문구는 그 글까지 맞춰 본다
  const b = resumeRule({ phrase: "이어 [<키>]" });
  assert.deepEqual([b.prompt("이어 [alpha]"), b.prompt("이어  [alpha] 하자"), b.prompt("이어 alpha")], ["alpha", "alpha", null]);
  const w = resumeRule({ phrase: "핸드온 <키> 이어서" });
  assert.deepEqual([w.prompt("핸드온 kk 이어서 하자"), w.prompt("핸드온 kk")], ["kk", null]);
  assert.equal(resumeRule(null).prompt("핸드온 k1"), null, "설정이 없으면 읽지 않는다");
  assert.equal(checkResume(null), null);
  assert.equal(checkResume({ phrase: "핸드온 <키>", doc: "" }), null);
  for (const bad of [{ phrase: "핸드온" }, { phrase: "<키> 이어서" }, { phrase: "a <키> <키>" }, { phrase: "핸드온 <키>", doc: "/handoff/x.md" }, { phrase: "핸드온\n<키>" }, "핸드온 <키>"]) {
    assert.ok(checkResume(bad), `거부: ${JSON.stringify(bad)}`);
  }
  const h = harness(r);
  h.fact({ f: "start", source: "clear", prev: "OLD-1" });
  h.fact({ f: "start", source: "compact", prev: "OTHER" });
  assert.equal(h.scene.meta.prev, "OLD-1", "처음 것만");
  h.fact({ f: "prompt", text: "핸드온 k1" });
  assert.equal(h.scene.meta.handoff, "k1");
  h.fact({ f: "prompt", text: "핸드온 k2" });
  assert.equal(h.scene.meta.handoff, "k1", "첫 입력에서만 읽는다");
  h.fact({ f: "edit", tool: "Write", path: "/m/pages/handoff/k3.md" });
  assert.equal(h.scene.meta.handoff, "k3", "인계 문서를 쓰면 그 키를 갖는다");
  const none = harness();
  none.fact({ f: "prompt", text: "핸드온 k1" });
  none.fact({ f: "edit", tool: "Write", path: "/m/pages/handoff/k3.md" });
  assert.equal(none.scene.meta.handoff, undefined, "설정이 없으면 키를 남기지 않는다");
  const bad = harness();
  bad.fact({ f: "start", prev: "../x" });
  assert.equal(bad.scene.meta.prev, undefined, "세션 id 모양이 아니면 받지 않는다");
  assert.deepEqual(h.replay().meta, h.scene.meta, "재생도 같다");
});


test("같은 글 번호(cid): 만료된 글과 번호가 같으면 새로 넣는다(Claude 에 가지 않았으므로)", () => {
  const sc = newScene();
  const ctx = { t: 1000, seq: 1 };
  const X = "xxxxxxxx-0000-4000-8000-000000000001";
  applyRes(sc, evalSend(sc, { kind: "comment", text: "글", cid: X }, ctx, "m1").res);
  assert.equal(evalSend(sc, { kind: "comment", text: "글", cid: X }, ctx, "m2").done, true, "대기 중이면 이미 받음");
  applyRes(sc, expireMsgs(sc, [], "30분 동안 못 보내 만료", 10 * 60 * 60_000));
  const again = evalSend(sc, { kind: "comment", text: "글", cid: X }, ctx, "m2");
  assert.equal(again.res.find((r) => r.k === "msg")?.v.mid, "m2");
});

test("draw: 표·상자 모양·아이콘을 받고 한도·모르는 값은 거부한다", () => {
  const h = harness();
  assert.equal(h.draw({ ops: [
    { id: "t", kind: "table", label: "비교", status: "wait", cols: ["방안", "위험"], rows: [["색인", "쓰기 느려짐"], ["캐시"]], note: "추천: 색인" },
    { id: "d", kind: "box", label: "판단", shape: "diamond", icon: "db" },
    { id: "m", kind: "mermaid", src: "pie\n  \"A\" : 1", status: "doing" },
  ] }), "적용 3");
  assert.deepEqual(h.scene.items.t.rows, [["색인", "쓰기 느려짐"], ["캐시"]]);
  assert.equal(h.scene.items.d.shape, "diamond");
  assert.equal(h.scene.items.m.status, "doing");
  assert.deepEqual(h.replay().items, h.scene.items, "재생도 같다");
  // 모르는 모양·아이콘, 칸이 너무 많거나 긴 표, 글이 아닌 칸
  const msg = h.draw({ ops: [
    { id: "x1", kind: "box", shape: "star" },
    { id: "x2", kind: "box", icon: "rocket" },
    { id: "x3", kind: "table", cols: Array(9).fill("c") },
    { id: "x4", kind: "table", rows: [["가".repeat(121)]] },
    { id: "x5", kind: "table", rows: Array(41).fill(["a"]) },
    { id: "x6", kind: "table", rows: [[1, 2]] },
    { id: "x7", kind: "table", rows: "a" },
  ] });
  assert.match(msg, /^적용 0 · 거부 7/);
  assert.match(msg, /shape 'star' 모름/);
  assert.match(msg, /icon 'rocket' 모름/);
  // 표에만 있는 필드는 다른 종류에서 무시하고 알린다. null 은 지운다
  assert.match(h.draw({ ops: [{ id: "d", rows: [["a"]] }] }), /무시한 필드: d\.rows/);
  h.draw({ ops: [{ id: "d", shape: null, icon: null }, { id: "t", rows: null }] });
  assert.equal(h.scene.items.d.shape, undefined);
  assert.equal(h.scene.items.d.icon, undefined);
  assert.equal(h.scene.items.t.rows, undefined);
  // 표·Mermaid 는 상태를 받으므로 막힘 메모가 그 상태를 바꾼다
  assert.doesNotMatch(h.note({ text: "자료 없음", kind: "blocked", on: "m" }), /상태가 없음/);
  assert.equal(h.scene.items.m.status, "blocked");
});

test("승인 대기: 사용자 입력이면 단계와 그림 부품의 대기를 「답 받음」 으로, 상태가 바뀌거나 새 대기 메모면 다시 묻는다", () => {
  const h = harness();
  h.fact({ f: "start", cwd: "/w" });
  h.plan({ steps: [{ id: "s1", title: "고르기", status: "wait" }] });
  h.draw({ ops: [{ id: "opt", kind: "table", label: "방안", status: "wait" }, { id: "b", kind: "box", status: "wait" }, { id: "e", kind: "edge", from: "opt", to: "b", status: "wait" }] });
  h.fact({ f: "prompt", text: "2번으로" });
  assert.deepEqual(["s1", "opt", "b", "e"].map((id) => !!h.scene.items[id].answered), [true, true, true, false], "선의 대기 무늬는 그대로");
  assert.deepEqual(h.replay().items, h.scene.items);
  // 상태가 바뀌었다가 다시 대기가 되면 새 질문이다
  h.draw({ ops: [{ id: "b", status: "doing" }] });
  h.draw({ ops: [{ id: "b", status: "wait" }] });
  assert.equal(h.scene.items.b.answered, undefined);
  // 이미 답 받은 대기에 새 승인 대기 메모가 오면 다시 묻는다(단계·부품 모두)
  h.note({ text: "하나 더 고르기", kind: "wait", on: "opt" });
  h.note({ text: "다시 승인", kind: "wait", on: "s1" });
  assert.equal(h.scene.items.opt.answered, undefined);
  assert.equal(h.scene.items.s1.answered, undefined);
  // 같은 상태여도 승인 대기를 다시 보내면 새 질문이다(부품·단계)
  h.fact({ f: "prompt", text: "네" });
  h.draw({ ops: [{ id: "opt", status: "wait", rows: [["새 안"]] }] });
  h.plan({ steps: [{ id: "s1", status: "wait" }] });
  assert.equal(h.scene.items.opt.answered, undefined);
  assert.equal(h.scene.items.s1.answered, undefined);
  // 작업 알림(sys)은 사용자 입력이 아니다
  h.fact({ f: "prompt", text: "<task-notification>", sys: true });
  assert.equal(h.scene.items.opt.answered, undefined);
});
