// 장면 규칙 시험: 명령 검사, 지금 단계, 훅 사실의 순서 처리, 재생이 실시간과 같은지
import { test } from "node:test";
import assert from "node:assert/strict";
import { newScene, applyRes, evalPlan, evalDraw, evalNote, evalFact, idsLine, idsView, evalMove, entryText, itemText, searchTerms, matchAll, snippet, currentStep, resumeRule, checkResume, LEGACY_RESUME, evalSend, expireMsgs, drawingStale, DRAW_SLACK } from "../lib/scene.js";

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

test("옛 그림: 새 작업 뒤 그림이 그대로면 그 작업의 다음 plan 결과에 한 번 알린다", () => {
  const h = harness(), MIN = 60_000;
  h.plan({ steps: [{ id: "a1", title: "첫 작업", status: "doing" }, { id: "a2", title: "마무리" }] }, 1000);
  h.draw({ ops: [{ id: "x", kind: "box", label: "옛 상자", status: "doing" }, { id: "y", kind: "box", label: "끝난 상자", status: "done" }, { id: "xy", kind: "edge", from: "x", to: "y", status: "doing" }] }, 2000);
  assert.equal(h.scene.view.drawT, 2000);
  assert.equal(h.scene.view.shapeT, 2000);
  assert.doesNotMatch(h.plan({ steps: [{ id: "a1", status: "done" }, { id: "a2", status: "doing" }] }, 3000), /drawing/);
  // 새 작업을 올린 호출 자체는 알리지 않는다(같은 메시지에 draw 가 뒤따를 수 있다)
  const t2 = 2000 + 60 * MIN;
  assert.equal(h.plan({ steps: [{ id: "a2", status: "done" }, { id: "b1", title: "둘째 작업", status: "doing" }, { id: "b2", title: "검증" }] }, t2), "계획 4단계 · 지금 b1");
  assert.equal(h.scene.view.taskT, t2);
  assert.ok(drawingStale(h.scene.view));
  const msg = h.plan({ steps: [{ id: "b1", status: "done" }, { id: "b2", status: "doing" }] }, t2 + MIN);
  assert.match(msg, /^계획 4단계 · 지금 b2 · The drawing on the board is from before this task's steps \(last redrawn 60 min before the task began\)/);
  assert.match(msg, /still marked doing, blocked or wait there: x\./); // 끝난 상자·선은 싣지 않는다
  assert.match(msg, /this message does not already draw it, draw it with your next tool calls/);
  assert.match(msg, /routine steps such as commit and push need none/);
  assert.equal(h.scene.view.hintT, t2);
  assert.doesNotMatch(h.plan({ steps: [{ id: "b2", status: "doing", note: "다시" }] }, t2 + 2 * MIN), /drawing/); // 작업마다 한 번
  // 그 작업에서 그림을 쓰면(10초 뒤의 상태 갱신이라도) 옛 그림이 아니다. 다음 새 작업에서는 다시 알린다
  h.draw({ ops: [{ id: "x", status: "done" }] }, t2 + 3 * MIN);
  assert.ok(!drawingStale(h.scene.view));
  h.plan({ steps: [{ id: "b2", status: "done" }] }, t2 + 4 * MIN);
  h.plan({ steps: [{ id: "c1", title: "셋째", status: "doing" }, { id: "c2", title: "끝" }] }, t2 + 200 * MIN);
  assert.match(h.plan({ steps: [{ id: "c1", status: "done" }, { id: "c2", status: "doing" }] }, t2 + 201 * MIN), /last redrawn 4 h before the task began\)\. If this task/); // 상자를 모두 닫아 진행 중인 부품 목록은 없다
  assert.deepEqual(h.replay().view, h.scene.view);
});

test("옛 그림: 새 작업 앞뒤 10초 안에 내용을 바꾼 draw 는 그 작업의 그림이고, 옛 부품의 상태만 닫은 것은 아니다", () => {
  const h = harness(), t = 10 * 60_000;
  h.draw({ ops: [{ id: "x", kind: "box", label: "상자", status: "doing" }] }, 1000);
  // 같은 메시지에서 plan 뒤에 새 부품
  h.plan({ steps: [{ id: "a", title: "작업", status: "doing" }, { id: "b", title: "검증" }] }, t);
  h.draw({ ops: [{ id: "y", kind: "box", label: "새 상자" }] }, t + 5);
  assert.ok(!drawingStale(h.scene.view));
  assert.doesNotMatch(h.plan({ steps: [{ id: "a", status: "done" }, { id: "b", status: "doing" }] }, t + 1000), /drawing/);
  // plan 보다 먼저 온 새 부품(10초 안)
  h.plan({ steps: [{ id: "b", status: "done" }] }, 2 * t - 5000);
  h.draw({ ops: [{ id: "z", kind: "box", label: "다음 상자" }] }, 2 * t - 3000);
  h.plan({ steps: [{ id: "c", title: "다음 작업", status: "doing" }, { id: "d", title: "검증" }] }, 2 * t);
  assert.ok(!drawingStale(h.scene.view));
  // 새 작업과 같은 메시지에서 옛 부품의 상태만 닫으면(plan 앞뒤 모두) 옛 그림이다
  h.plan({ steps: [{ id: "c", status: "done" }, { id: "d", status: "done" }] }, 3 * t - 5000);
  h.draw({ ops: [{ id: "x", status: "done" }] }, 3 * t - 2000);
  h.plan({ steps: [{ id: "e", title: "또 다음", status: "doing" }, { id: "f", title: "검증" }] }, 3 * t);
  h.draw({ ops: [{ id: "y", status: "done", note: "끝" }] }, 3 * t + 500);
  assert.ok(drawingStale(h.scene.view));
  assert.match(h.plan({ steps: [{ id: "e", status: "done" }, { id: "f", status: "doing" }] }, 3 * t + 60_000), /from before this task's steps \(last redrawn 10 min before/);
  // 10초 넘게 앞에서 내용을 바꾼 것도 옛 그림이다
  h.plan({ steps: [{ id: "f", status: "done" }] }, 4 * t - 30_000);
  h.draw({ ops: [{ id: "w", kind: "box", label: "앞 작업 마지막 상자" }] }, 4 * t - DRAW_SLACK - 1);
  h.plan({ steps: [{ id: "g", title: "넷째", status: "doing" }, { id: "k", title: "검증" }] }, 4 * t);
  assert.ok(drawingStale(h.scene.view));
});

test("옛 그림: 새 작업은 새 단계 둘 이상으로 지금 단계가 옮겨 간 것(끝난 id 재사용은 됨, 덧붙이기·하위 단계·제목 다듬기·같은 id 두 번·거부는 아님)", () => {
  const h = harness();
  h.plan({ steps: [{ id: "s1", title: "읽기", status: "doing" }, { id: "s2", title: "고치기" }] }, 1000);
  h.draw({ ops: [{ id: "x", kind: "box", label: "상자", status: "doing" }] }, 2000);
  assert.equal(h.scene.view.taskT, 1000);
  h.plan({ steps: [{ id: "s1", status: "done" }, { id: "s2", status: "doing" }, { id: "s3", title: "시험 추가" }, { id: "s4", title: "문서" }] }, 300_000); // 진행 중에 덧붙임
  h.plan({ steps: [{ id: "s2a", title: "A-1", parent: "s2", status: "doing" }, { id: "s2b", title: "A-2", parent: "s2" }] }, 400_000); // 지금 단계를 나눔
  h.plan({ steps: [{ id: "s3", title: "시험 추가(파서)", status: "doing" }, { id: "s5", title: "하나 더" }] }, 500_000); // 열린 단계 제목 다듬기
  h.plan({ steps: [{ id: "n1", title: "새것", status: "doing" }, { id: "n1", title: "새것 다시" }] }, 600_000); // 같은 id 두 번
  h.plan({ steps: [{ id: "n2", title: "새것2", status: "doing" }, { id: "n3", title: "잘못된 부모", parent: "없음" }] }, 650_000); // 거부된 단계
  assert.equal(h.scene.view.taskT, 1000);
  // 끝난 단계의 id 를 새 제목으로 다시 쓰고 지금 단계를 옮기면 새 작업
  h.plan({ steps: ["s1", "s2", "s2a", "s2b", "s3", "s4", "s5", "n1", "n2"].map((id) => ({ id, status: "done" })) }, 700_000);
  h.plan({ steps: [{ id: "s1", title: "다른 작업 읽기", status: "doing" }, { id: "s2", title: "다른 작업 고치기" }] }, 800_000);
  assert.equal(h.scene.view.taskT, 800_000);
  // 한계: 앞 작업 단계를 진행 중으로 버려 둔 채 새 단계를 todo 로만 올리면 놓친다
  h.plan({ steps: [{ id: "m1", title: "버려 둔 뒤 새 작업" }, { id: "m2", title: "검증" }] }, 900_000);
  assert.equal(h.scene.view.taskT, 800_000);
  // 버려 둔 단계가 있어도 새 단계를 진행으로 두면 새 작업이다
  h.plan({ steps: [{ id: "k1", title: "새 작업", status: "doing" }, { id: "k2", title: "검증" }] }, 1_000_000);
  assert.equal(h.scene.view.taskT, 1_000_000);
});

test("옛 그림: 하위 에이전트가 도는 동안, 작업을 끝내는 호출, 그림이 없거나 비웠을 때, 큰 그림 화판에는 알리지 않는다", () => {
  // 하위 에이전트(같은 세션 화판에 쓴다)
  const h = harness();
  h.plan({ steps: [{ id: "m1", title: "원인 찾기", status: "doing" }, { id: "m2", title: "수정" }] }, 1000);
  h.draw({ ops: [{ id: "sus", kind: "box", label: "의심", status: "doing" }] }, 2000);
  h.fact({ f: "agent-start", agent: "sub1", agentType: "Explore" }, 3000);
  h.plan({ steps: [{ id: "r1", title: "파일 읽기", status: "doing" }, { id: "r2", title: "보고" }] }, 40_000);
  assert.equal(h.scene.view.taskT, 1000);
  assert.ok(!drawingStale(h.scene.view));
  h.fact({ f: "agent-stop", agent: "sub1", agentType: "Explore" }, 70_000);
  h.plan({ steps: ["m1", "m2", "r1", "r2"].map((id) => ({ id, status: "done" })) }, 3_000_000);
  h.plan({ steps: [{ id: "k1", title: "다음 작업", status: "doing" }, { id: "k2", title: "검증" }] }, 3_600_000);
  assert.equal(h.scene.view.taskT, 3_600_000); // 끝난 뒤에는 다시 따진다
  // 작업을 끝내는 호출(지금 단계가 없어짐)에는 알리지 않는다
  assert.doesNotMatch(h.plan({ steps: [{ id: "k1", status: "done" }, { id: "k2", status: "done" }] }, 3_700_000), /drawing/);
  assert.equal(h.scene.view.hintT, undefined);
  // 그림이 없으면(그리기 알림 nudge 몫), 비웠으면 알리지 않는다
  const e = harness();
  e.plan({ steps: [{ id: "a", title: "작업", status: "doing" }, { id: "b", title: "검증" }] }, 1000);
  assert.doesNotMatch(e.plan({ steps: [{ id: "a", status: "done" }, { id: "b", status: "doing" }] }, 600_000), /drawing/);
  e.draw({ ops: [{ id: "x", kind: "box", label: "상자" }] }, 700_000);
  e.draw({ clear: true }, 800_000);
  assert.equal(e.scene.view.shapeT, 800_000);
  e.plan({ steps: [{ id: "b", status: "done" }, { id: "c", title: "다음", status: "doing" }, { id: "d", title: "검증" }] }, 900_000);
  assert.doesNotMatch(e.plan({ steps: [{ id: "c", status: "done" }, { id: "d", status: "doing" }] }, 1_000_000), /drawing/);
  // 큰 그림 화판: 시각을 남기지 않고 알리지도 않는다
  const sc = newScene(), ctx = (t) => ({ t, seq: t, project: true });
  applyRes(sc, evalDraw(sc, { ops: [{ id: "u", kind: "box", label: "단위" }] }, ctx(1)).res);
  applyRes(sc, evalPlan(sc, { steps: [{ id: "u1", title: "01", status: "doing" }, { id: "u2", title: "02" }] }, ctx(2)).res);
  assert.deepEqual(sc.view, { dir: "RIGHT" });
  assert.doesNotMatch(evalPlan(sc, { steps: [{ id: "u1", status: "done" }, { id: "u2", status: "doing" }] }, ctx(3)).msg, /drawing/);
  // 옛 기록(시각 없음)은 옛 그림으로 보지 않는다
  assert.ok(!drawingStale({ dir: "RIGHT" }));
  assert.ok(drawingStale({ taskT: 50_000 }));
});

test("옛 그림: 대기로 시작한 작업도 열린 작업이고, 무시한 필드·같은 값은 내용 변경이 아니며, 늦게 온 하위 에이전트 시작은 끝과 짝짓는다", () => {
  const h = harness(), H = 3600_000;
  h.draw({ ops: [{ id: "x", kind: "box", label: "상자", status: "doing" }] }, 1000);
  // 승인부터 묻는 새 작업: 대기 단계는 지금 단계가 되지 않지만 작업은 열려 있다
  h.plan({ steps: [{ id: "w1", title: "적용 승인 받기", status: "wait" }, { id: "w2", title: "적용" }] }, H);
  assert.equal(h.scene.view.taskT, H);
  h.fact({ f: "prompt", text: "승인" }, H + 60_000);
  assert.match(h.plan({ steps: [{ id: "w1", note: "답 받음" }] }, H + 70_000), /from before this task's steps/);
  // 무시한 필드·같은 값을 다시 보낸 것은 내용 변경이 아니다(shapeT 그대로)
  h.draw({ ops: [{ id: "x", label: "상자" }, { id: "x", status: "done" }] }, H + 80_000);
  assert.equal(h.scene.view.shapeT, 1000);
  h.draw({ ops: [{ id: "x", label: "상자 이름 바꿈" }] }, H + 90_000);
  assert.equal(h.scene.view.shapeT, H + 90_000);
  // 하위 에이전트의 끝이 시작보다 먼저 도착해도 끝난 것으로 본다
  h.plan({ steps: [{ id: "w1", status: "done" }, { id: "w2", status: "done" }] }, 2 * H);
  h.fact({ f: "agent-stop", agent: "sub2", agentType: "Explore" }, 2 * H + 1000, 2 * H + 900);
  h.fact({ f: "agent-start", agent: "sub2", agentType: "Explore" }, 2 * H + 2000, 2 * H + 100);
  h.plan({ steps: [{ id: "v1", title: "다음 작업", status: "doing" }, { id: "v2", title: "검증" }] }, 3 * H);
  assert.equal(h.scene.view.taskT, 3 * H);
});

test("남은 단계: 새 작업을 올린 호출 결과에 앞 작업에서 열린 채 남은 단계를 한 번 알린다", () => {
  const h = harness();
  // phase2 처럼 앞 작업의 마지막 단계를 닫지 않고 끝냄
  h.plan({ steps: [{ id: "s1", title: "읽기", status: "doing" }, { id: "s2", title: "고치기" }, { id: "s3", title: "README 갱신" }] }, 1000);
  h.plan({ steps: [{ id: "s1", status: "done" }, { id: "s2", status: "done" }] }, 2000);
  const msg = h.plan({ steps: [{ id: "l1", title: "다음 작업", status: "doing" }, { id: "l2", title: "검증" }] }, 3000);
  assert.equal(h.scene.view.taskT, 3000);
  assert.equal(msg, '계획 5단계 · 지금 l1 · Steps still open from earlier work: s3 todo "README 갱신". ' +
    "Mark the finished ones done and remove the dropped ones (del:true); keep the ones still to do.");
  // 같은 작업의 다음 호출에는 다시 알리지 않는다
  assert.doesNotMatch(h.plan({ steps: [{ id: "l1", status: "done" }, { id: "l2", status: "doing" }] }, 4000), /still open/);
  // 지운 단계는 남지 않는다. 진행 단계도 싣고, 새 작업의 단계, 그 호출에서 닫은 단계, 일부러 열어 둔 대기·막힘은 싣지 않는다
  h.plan({ steps: [{ id: "s3", del: true }, { id: "l2", status: "done" }] }, 5000);
  h.plan({ steps: [{ id: "a1", title: "셋째", status: "doing" }, { id: "a2", title: "승인 받기" }, { id: "a3", title: "적용" }, { id: "a4", title: "막힌 일" }] }, 6000);
  h.plan({ steps: [{ id: "a2", status: "wait" }, { id: "a4", status: "blocked" }] }, 7000);
  const next = h.plan({ steps: [{ id: "a3", status: "done" }, { id: "b1", title: "넷째", status: "doing" }, { id: "b2", title: "검증" }] }, 8000);
  assert.match(next, /Steps still open from earlier work: a1 doing "셋째"\. /);
  assert.doesNotMatch(next.split("Steps still open")[1], /\b(a2|a3|a4|b1|b2|s3)\b/);
  // 남은 단계가 없으면 붙이지 않는다
  h.plan({ steps: ["a1", "a2", "a4", "b1", "b2"].map((id) => ({ id, status: "done" })) }, 9000);
  assert.equal(h.plan({ steps: [{ id: "c1", title: "다섯째", status: "doing" }, { id: "c2", title: "검증" }] }, 10_000), "계획 12단계 · 지금 c1");
});

test("남은 단계: 여섯 개까지 싣고, 하위 에이전트가 도는 동안과 큰 그림 화판에는 알리지 않는다", () => {
  const h = harness();
  h.plan({ steps: Array.from({ length: 8 }, (_, i) => ({ id: `o${i}`, title: `옛 단계 ${i} 제목이 아주 길어서\n잘리는 경우`, status: i ? "todo" : "doing" })) }, 1000);
  const msg = h.plan({ steps: [{ id: "n1", title: "새 작업", status: "doing" }, { id: "n2", title: "검증" }] }, 2000);
  assert.doesNotMatch(msg, /\n/); // 결과 글은 한 줄
  assert.match(msg, /o0 doing "옛 단계 0 제목이 아주 길어서 잘리"/);
  assert.match(msg, /o5 todo "[^"]*" … \(8\)\. Mark/);
  assert.doesNotMatch(msg, /o6/);
  // 하위 에이전트가 도는 동안은 새 작업으로 보지 않으므로 알리지도 않는다
  h.fact({ f: "agent-start", agent: "sub1", agentType: "Explore" }, 3000);
  assert.doesNotMatch(h.plan({ steps: [{ id: "r1", title: "파일 읽기", status: "doing" }, { id: "r2", title: "보고" }] }, 4000), /still open/);
  // 큰 그림 화판: 단위가 여럿 열려 있는 것이 보통이다
  const sc = newScene(), ctx = (t) => ({ t, seq: t, project: true });
  applyRes(sc, evalPlan(sc, { steps: [{ id: "u1", title: "01", status: "doing" }, { id: "u2", title: "02" }] }, ctx(1)).res);
  assert.doesNotMatch(evalPlan(sc, { steps: [{ id: "u3", title: "03", status: "doing" }, { id: "u4", title: "04" }] }, ctx(2)).msg, /still open/);
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

test("note: 마지막 단계를 끝낸 바로 뒤의 승인 대기·막힘은 방금 끝난 단계에 붙는다(한 응답에 함께 보낸 경우)", () => {
  const h = harness();
  h.plan({ steps: [{ id: "s1", title: "고치기", status: "doing" }, { id: "s2", title: "검증" }] });
  h.plan({ steps: [{ id: "s1", status: "done" }, { id: "s2", status: "doing" }] });
  h.plan({ steps: [{ id: "s2", status: "done" }] });
  assert.equal(currentStep(h.scene), null);
  assert.equal(h.note({ text: "커밋해도 될지 확인", kind: "wait" }), "기록 · s2 승인 대기(방금 끝난 단계)");
  assert.equal(h.scene.items.s2.status, "wait");
  assert.equal(h.scene.items.s1.status, "done");
  assert.equal(h.scene.timeline.at(-1).on, "s2");
  assert.deepEqual(h.replay().items, h.scene.items);
  // 사용자가 답하면 서버가 붙인 대기는 원래대로(끝) 돌아가고 지금 단계도 다시 없다
  assert.equal(currentStep(h.scene), "s2");
  h.fact({ f: "prompt", text: "승인" }, 5000);
  assert.equal(h.scene.items.s2.status, "done");
  assert.equal(h.scene.items.s2.back, undefined);
  assert.equal(currentStep(h.scene), null);
  assert.deepEqual(h.replay().items, h.scene.items);
  assert.deepEqual(h.replay().cur, h.scene.cur);
  // 가장 최근에 끝낸 단계가 실패면 그 단계에 붙인다(그 앞의 끝난 단계로 내려가지 않는다)
  const f = harness();
  f.plan({ steps: [{ id: "a", title: "가", status: "doing" }, { id: "b", title: "나" }] }, 1000);
  f.plan({ steps: [{ id: "a", status: "done" }, { id: "b", status: "doing" }] }, 2000);
  f.plan({ steps: [{ id: "b", status: "fail" }] }, 3000);
  assert.equal(f.note({ text: "도와주세요", kind: "blocked" }, 3001), "기록 · b 막힘(방금 끝난 단계)");
  assert.equal(f.scene.items.a.status, "done");
  // 진행을 거치지 않고 함께 끝낸 단계들 가운데서는 뒤 단계에 붙는다
  const k = harness();
  k.plan({ steps: [{ id: "a", title: "가", status: "doing" }, { id: "b", title: "나" }, { id: "c", title: "다" }] });
  k.plan({ steps: [{ id: "a", status: "done" }, { id: "b", status: "doing" }] }, 2000);
  k.plan({ steps: [{ id: "b", status: "done" }, { id: "c", status: "done" }] }, 3000);
  assert.equal(k.note({ text: "확인", kind: "wait" }, 3001), "기록 · c 승인 대기(방금 끝난 단계)");
  // 지난 답에서 끝낸 단계(마지막 사용자 입력보다 앞)는 다시 열지 않는다
  const m = harness();
  m.plan({ steps: [{ id: "a", title: "가", status: "doing" }] }, 1000);
  m.plan({ steps: [{ id: "a", status: "done" }] }, 2000);
  m.fact({ f: "prompt", text: "다음 일" }, 3000);
  assert.equal(m.note({ text: "확인", kind: "wait" }, 4000), "기록 (지금 단계 없음)");
  assert.equal(m.scene.items.a.status, "done");
  // 계획이 없으면 붙일 단계가 없다. 이유 메모(why)는 단계를 바꾸지 않는다
  const g = harness();
  assert.equal(g.note({ text: "기다림", kind: "wait" }), "기록 (지금 단계 없음)");
  h.plan({ steps: [{ id: "s2", status: "done" }] });
  h.note({ text: "이유", kind: "why" });
  assert.equal(h.scene.items.s2.status, "done");
  assert.equal(h.scene.timeline.at(-1).on, undefined);
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

test("ids 줄이기(brief): 끝난 단계는 최근 몇 개만 제목을 싣고 나머지는 id 만, id 만 실은 단계는 한도에 세지 않는다", () => {
  const h = harness();
  h.plan({ steps: Array.from({ length: 6 }, (_, i) => ({ id: `u0${i + 1}`, title: `단위 ${i + 1}`, status: i < 5 ? "done" : "doing" })) });
  h.draw({ ops: [{ id: "a", kind: "box", label: "지금 부품" }] });
  assert.deepEqual(idsView(h.scene, 40, 2), { text: 'plan: 끝남 3: u01 u02 u03, u04 "단위 4" done, u05 "단위 5" done, u06 "단위 6" doing | draw: a "지금 부품" box', cut: false });
  assert.equal(idsView(h.scene, 40).text, idsLine(h.scene, 40)); // brief 없이는 예전 그대로
  assert.deepEqual(idsView(h.scene, 3, 2), { text: 'plan: 끝남 3: u01 u02 u03, u04 "단위 4" done, u05 "단위 5" done, u06 "단위 6" doing | 외 1개', cut: true });
  // 제목을 싣는 최근 단계는 끝낸 때 순서로, id 만 싣는 단계는 최근 60개까지(넘으면 잘린 것으로 친다)
  const g = harness();
  for (const from of [0, 35]) g.plan({ steps: Array.from({ length: 35 }, (_, i) => ({ id: `d${from + i}`, title: `끝 ${from + i}` })) }); // 한 번에 50개까지
  for (let i = 69; i >= 0; i--) g.plan({ steps: [{ id: `d${i}`, status: "done" }] }, 1000 + (69 - i)); // 뒤 단계부터 끝냄
  const v = idsView(g.scene, 40, 1);
  assert.match(v.text, /^plan: 끝남 69: d60 d59 .* d1 외 9개, d0 "끝 0" done$/);
  assert.equal(v.cut, true);
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

test("도형 옮기기(move): 놓기·제자리로·모두 되돌리기, 단계·선·목록 항목은 옮기지 않고, 묶음이 바뀌면 자리를 버린다", () => {
  const h = harness();
  const move = (input) => { const out = evalMove(h.scene, input); applyRes(h.scene, JSON.parse(JSON.stringify(out.res))); h.log.push(out.res); return out.msg; };
  h.plan({ steps: [{ id: "s1", title: "단계" }] });
  h.draw({ ops: [{ id: "g", kind: "group", label: "묶음" }, { id: "a", kind: "box", label: "가", in: "g" }, { id: "b", kind: "box" }, { id: "e", kind: "edge", from: "a", to: "b" }, { id: "l", kind: "list" }, { id: "i", kind: "item", in: "l", label: "항목" }] });
  assert.equal(move({ id: "a", x: 12.4, y: 40 }), "a 옮김");
  assert.deepEqual(h.scene.items.a.pos, { x: 12, y: 40 });
  assert.equal(move({ id: "a", x: 12, y: 40 }), "그대로");
  for (const id of ["s1", "e", "i", "없음"]) assert.equal(move({ id, x: 1, y: 1 }), "옮길 수 없는 부품");
  assert.match(move({ id: "b", x: -1, y: 0 }), /자리는 0~/);
  assert.match(move({ id: "b", x: 1, y: Infinity }), /자리는 0~/);
  move({ id: "b", x: 100, y: 0 });
  move({ id: "g", x: 5, y: 5 });
  // Claude 가 다른 것을 고쳐도 자리는 남고, 묶음을 바꾸면 버린다
  h.draw({ ops: [{ id: "b", label: "나" }, { id: "a", status: "doing" }] });
  assert.deepEqual([h.scene.items.a.pos, h.scene.items.b.pos], [{ x: 12, y: 40 }, { x: 100, y: 0 }]);
  h.draw({ ops: [{ id: "a", in: null }] });
  assert.equal(h.scene.items.a.pos, undefined);
  // 끄는 사이 묶음이 바뀌었으면(요청에 실은 in 과 다름) 받지 않는다
  assert.equal(move({ id: "b", x: 5, y: 5, in: "g" }), "그사이 묶음이 바뀌어 옮기지 않음");
  assert.deepEqual(h.scene.items.b.pos, { x: 100, y: 0 });
  assert.equal(move({ id: "b", x: 6, y: 5, in: null }), "b 옮김");
  assert.equal(move({ id: "b", x: null }), "b 자동 자리로");
  assert.equal(h.scene.items.b.pos, undefined);
  assert.equal(move({ all: true }), "자동 배치로 1개");
  assert.equal(h.scene.items.g.pos, undefined);
  assert.equal(move({ all: true }), "옮긴 도형 없음");
  assert.deepEqual(h.replay().items, h.scene.items);
});

test("찾기 재료: 타임라인 줄·부품의 글, 낱말 모두 담기(대소문자 무시), 첫 낱말 둘레 앞부분", () => {
  const h = harness();
  h.plan({ steps: [{ id: "s1", title: "원인 찾기", note: "파서" }] });
  h.draw({ ops: [{ id: "t", kind: "table", label: "비교", cols: ["안"], rows: [["Redis 캐시"]] }] });
  h.fact({ f: "run-start", id: "r1", cmd: "npm test", desc: "시험 돌리기" });
  h.fact({ f: "edit", tool: "Edit", path: "/w/src/App.js", lines: "3" });
  h.note({ text: "빈 줄에서만 재현", kind: "why", on: "s1" });
  const [run, edit, note] = h.scene.timeline.filter((e) => e.type !== "fact" || e.f === "edit");
  assert.equal(entryText(h.scene, run), "시험 돌리기 npm test");
  assert.equal(entryText(h.scene, edit), "/w/src/App.js:3");
  assert.equal(entryText(h.scene, note), "빈 줄에서만 재현 (s1)");
  assert.equal(itemText(h.scene.items.t), "비교 안 Redis 캐시");
  assert.equal(itemText(h.scene.items.s1), "원인 찾기 파서");
  const q = searchTerms("  app.JS   src ");
  assert.deepEqual(q, ["app.js", "src"]);
  assert.ok(matchAll("/w/src/App.js:3", q));
  assert.ok(!matchAll("/w/src/Main.js", q));
  assert.ok(!matchAll("무엇이든", []));
  assert.equal(snippet("가".repeat(100) + "찾는말" + "나".repeat(300), ["찾는말"]).slice(0, 42), "…" + "가".repeat(40) + "찾");
});
