// 묶음을 넘는 선의 길 찾기(web/route.js): 직선·꺾은선 후보와, 모두 막혔을 때 돌아가는 길
import { test } from "node:test";
import assert from "node:assert/strict";
import { crossLines, detour, makeGrid } from "../web/route.js";

const box = (id, x, y, width = 60, height = 40) => ({ id, x, y, width, height });
// 선분이 상자 안쪽(테두리에서 3px 안)을 지나는가
function hits(p, q, b) {
  const x0 = b.x + 3, y0 = b.y + 3, x1 = b.x + b.width - 3, y1 = b.y + b.height - 3;
  return Math.max(p.x, q.x) > x0 && Math.min(p.x, q.x) < x1 && Math.max(p.y, q.y) > y0 && Math.min(p.y, q.y) < y1;
}
const segs = (pts) => pts.slice(1).map((q, i) => [pts[i], q]);
const onBorder = (p, b) => (p.x === b.x || p.x === b.x + b.width) ? p.y >= b.y && p.y <= b.y + b.height : (p.y === b.y || p.y === b.y + b.height) && p.x >= b.x && p.x <= b.x + b.width;

test("막힌 곳이 없으면 직선 하나", () => {
  const a = box("a", 20, 20), b = box("b", 200, 20);
  const { lines, hits: n } = crossLines({ width: 300, height: 100, children: [{ id: "g1", children: [a] }, { id: "g2", children: [b] }] }, [{ id: "e", a: "a", b: "b" }]);
  assert.equal(n, 0);
  assert.equal(lines[0].pts.length, 2);
});

test("직선·ㄱ자·ㄹ자가 모두 벽에 막히면 벽을 돌아가는 길을 찾고, 끝은 두 상자 변 위, 가운데는 어느 상자도 지나지 않는다", () => {
  const a = box("a", 20, 150), b = box("b", 420, 150), wall = box("wall", 220, 40, 40, 250);
  const out = { width: 500, height: 330, children: [{ id: "g1", children: [a] }, wall, { id: "g2", children: [b] }] };
  const { lines, hits: n, w, h } = crossLines(out, [{ id: "e", a: "a", b: "b", label: { text: "이름", width: 30, height: 16 } }]);
  const pts = lines[0].pts;
  assert.equal(n, 0, JSON.stringify(pts));
  assert.ok(onBorder(pts[0], a) && onBorder(pts.at(-1), b), JSON.stringify(pts));
  for (const [p, q] of segs(pts)) {
    assert.ok(p.x === q.x || p.y === q.y, "꺾은선은 가로·세로만");
    assert.ok(!hits(p, q, wall), `벽을 지남: ${JSON.stringify([p, q])}`);
  }
  for (const [p, q] of segs(pts).slice(1, -1)) assert.ok(!hits(p, q, a) && !hits(p, q, b), "두 끝 상자 안을 지남");
  assert.ok(pts.every((p) => p.x >= 0 && p.y >= 0 && p.x <= w && p.y <= h), "그림 안에 든다");
  assert.ok(lines[0].label.x >= 0 && lines[0].label.y >= 0);
});

test("끝 상자가 다른 상자로 빙 둘러싸여 길이 없으면 detour 는 null 이고, 덜 지나는 후보를 그대로 쓴다", () => {
  const a = box("a", 20, 150), b = box("b", 300, 150);
  const ring = [box("t", 280, 120, 100, 28), box("d", 280, 192, 100, 28), box("l", 280, 148, 18, 44), box("r", 362, 148, 18, 44)];
  assert.equal(detour(a, b, ring), null);
  const { lines, hits: n } = crossLines({ width: 420, height: 260, children: [{ id: "g1", children: [a] }, { id: "g2", children: [b, ...ring] }] }, [{ id: "e", a: "a", b: "b" }]);
  assert.ok(n >= 1);
  assert.ok(lines[0].pts.length >= 2);
});

test("돌아가는 길은 꺾임을 아낀다(벽 아래로 돌아가는 ㄷ자, 꺾임 둘)", () => {
  const a = box("a", 20, 150), b = box("b", 420, 150), wall = box("wall", 220, 40, 40, 250);
  // 두 상자의 아래 변에서 내려가 벽 아래(여백 8px)로 지나 올라온다
  assert.deepEqual(detour(a, b, [wall]), [{ x: 50, y: 190 }, { x: 50, y: 298 }, { x: 450, y: 298 }, { x: 450, y: 190 }]);
});

test("손이 오래 멈추지 않게: 격자가 너무 크면 찾지 않고, 한 배치의 탐색 걸음을 다 쓰면 그 뒤의 선은 후보로 둔다", () => {
  // 겹치지 않는 대각선 상자 300개: 가로·세로 좌표가 900개씩이라 격자가 상한을 넘는다
  const many = Array.from({ length: 300 }, (_, k) => box(`o${k}`, 10 + k * 30, 10 + k * 30, 10, 10));
  assert.ok(makeGrid(many) === null, "격자가 너무 큰데 만들었다");
  const a = box("a", 20, 150), b = box("b", 420, 150), wall = box("wall", 220, 40, 40, 250);
  const grid = makeGrid([a, b, wall]);
  grid.steps = 3;
  assert.equal(detour(a, b, [], grid), null);
  assert.ok(detour(a, b, [wall]), "새 격자에서는 찾는다");
});
