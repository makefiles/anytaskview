// 섞기에서 묶음 경계를 넘는 선의 길 찾기(화면 요소 없이 좌표만 다룬다). canvas.js 가 쓰고, 시험이 node 에서 바로 부른다.
// 상자는 ELK 의 { x, y, width, height } 를 그대로 쓴다

// 상자 b 의 가운데에서 (tx, ty) 쪽으로 그은 선이 상자 테두리와 만나는 점
function borderPoint(b, tx, ty) {
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2, dx = tx - cx, dy = ty - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const s = Math.min(dx ? Math.abs(b.width / 2 / dx) : Infinity, dy ? Math.abs(b.height / 2 / dy) : Infinity);
  return { x: cx + dx * s, y: cy + dy * s };
}

// 선분 p→q 가 상자 b 를 지나는가(테두리에 3px 안쪽까지 닿는 것은 빼고)
function segmentHits(p, q, b) {
  const lo = [b.x + 3, b.y + 3], hi = [b.x + b.width - 3, b.y + b.height - 3], d = [q.x - p.x, q.y - p.y], o = [p.x, p.y];
  let t0 = 0, t1 = 1;
  for (let k = 0; k < 2; k++) {
    if (!d[k]) { if (o[k] <= lo[k] || o[k] >= hi[k]) return false; continue; }
    let a = (lo[k] - o[k]) / d[k], z = (hi[k] - o[k]) / d[k];
    if (a > z) [a, z] = [z, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, z);
  }
  return t0 < t1;
}

// 상자 a 에서 b 로 긋는 선의 후보: 두 가운데를 잇는 직선(테두리에서 자름), ㄱ자 둘(가로→세로, 세로→가로),
// ㄹ자 둘(두 상자 사이 틈의 가운데에서 꺾음). 꺾은선은 그 방향으로 상자 밖을 지나 나가고 들어올 수 있을 때만 낸다
function routes(a, b) {
  const ac = { x: a.x + a.width / 2, y: a.y + a.height / 2 }, bc = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const out = [[borderPoint(a, bc.x, bc.y), borderPoint(b, ac.x, ac.y)]];
  const outX = (x, r) => x < r.x || x > r.x + r.width, outY = (y, r) => y < r.y || y > r.y + r.height;
  if (outX(bc.x, a) && outY(ac.y, b)) {
    const sx = bc.x > ac.x ? a.x + a.width : a.x, ey = ac.y < b.y ? b.y : b.y + b.height;
    out.push([{ x: sx, y: ac.y }, { x: bc.x, y: ac.y }, { x: bc.x, y: ey }]);
  }
  if (outY(bc.y, a) && outX(ac.x, b)) {
    const sy = bc.y > ac.y ? a.y + a.height : a.y, ex = ac.x < b.x ? b.x : b.x + b.width;
    out.push([{ x: ac.x, y: sy }, { x: ac.x, y: bc.y }, { x: ex, y: bc.y }]);
  }
  const right = b.x >= a.x + a.width, left = b.x + b.width <= a.x, below = b.y >= a.y + a.height, above = b.y + b.height <= a.y;
  if (right || left) {
    const sx = right ? a.x + a.width : a.x, ex = right ? b.x : b.x + b.width, mx = (sx + ex) / 2;
    out.push([{ x: sx, y: ac.y }, { x: mx, y: ac.y }, { x: mx, y: bc.y }, { x: ex, y: bc.y }]);
  }
  if (below || above) {
    const sy = below ? a.y + a.height : a.y, ey = below ? b.y : b.y + b.height, my = (sy + ey) / 2;
    out.push([{ x: ac.x, y: sy }, { x: ac.x, y: my }, { x: bc.x, y: my }, { x: bc.x, y: ey }]);
  }
  return out;
}
// 꺾은선의 길이와, 길이로 따진 가운데 점(이름표 자리)
function pathLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return len;
}
function midPoint(pts) {
  let left = pathLength(pts) / 2;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1], q = pts[i], d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d >= left && d > 0) return { x: p.x + ((q.x - p.x) * left) / d, y: p.y + ((q.y - p.y) * left) / d };
    left -= d;
  }
  return pts[pts.length - 1];
}

// 섞기에서 직접 그릴 선과 이름표 자리. 선은 후보(routes) 중 두 끝이 아닌 상자(묶음 말고)를 덜 지나는 것,
// 같으면 덜 꺾인 것, 그다음 짧은 것을 고른다. 후보가 모두 지나면 돌아가는 길(detour)을 찾아 덜 지나면 그것을 쓴다. 이름표는 선 가운데에 두되 그림 왼쪽·위로 넘치면 안쪽으로 민다.
// 오른쪽·아래로 넘치면 그만큼 그림을 키운다(후보를 고를 때도 이 크기로 잰다).
// hits: 고른 선이 지나는 상자 수의 합. 배치 후보를 고를 때 적은 쪽을 고른다
// 후보가 모두 다른 상자를 지날 때 쓰는 돌아가는 길. 상자를 MARGIN 만큼 넓혀 장애물로 두고, 그 테두리와 상자 가운데의
// 좌표로 만든 격자 위에서 꺾임이 적고 짧은 길을 찾는다(꺾일 때마다 BEND 만큼 길게 친다). 두 끝은 상자 변의 가운데에서
// 곧게 나가고 들어온다
const MARGIN = 8, BEND = 40;
// 그림을 그리는 손(주 스레드)이 오래 멈추지 않게: 격자가 MAX_CELLS 보다 크면(상자가 아주 많음) 찾지 않고, 한 배치의 선들이
// 같이 쓰는 탐색 걸음이 STEPS 를 넘으면 그 뒤의 선은 덜 지나는 후보로 둔다
const MAX_CELLS = 40_000, STEPS = 60_000;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]; // 오른쪽·왼쪽·아래·위
const grow = (r) => ({ x0: r.x - MARGIN, y0: r.y - MARGIN, x1: r.x + r.width + MARGIN, y1: r.y + r.height + MARGIN });

// 장애물 격자: 점·가로 칸·세로 칸이 넓힌 상자 안에 드는지 미리 표시한다(선마다, 걸음마다 상자를 다시 훑지 않게).
// 한 배치의 선들이 같이 쓴다. 너무 크면 null
export function makeGrid(boxes) {
  const grown = boxes.map(grow), xs = new Set(), ys = new Set();
  for (const b of boxes) { xs.add(b.x + b.width / 2); ys.add(b.y + b.height / 2); }
  for (const r of grown) { xs.add(r.x0); xs.add(r.x1); ys.add(r.y0); ys.add(r.y1); }
  const X = [...xs].sort((p, q) => p - q), Y = [...ys].sort((p, q) => p - q), nx = X.length;
  if (nx * Y.length > MAX_CELLS) return null;
  const ix = new Map(X.map((x, i) => [x, i])), iy = new Map(Y.map((y, j) => [y, j]));
  // node: 점이 상자 안, h: (i,j)-(i+1,j) 가 상자 안을 지남, v: (i,j)-(i,j+1) 가 상자 안을 지남. 좌표 사이에는 다른 상자
  // 테두리가 없으므로 칸이 상자 안을 지나는지는 칸의 가운데로 정해진다
  const node = new Uint8Array(nx * Y.length), h = new Uint8Array(nx * Y.length), v = new Uint8Array(nx * Y.length);
  for (const r of grown) {
    const i0 = ix.get(r.x0), i1 = ix.get(r.x1), j0 = iy.get(r.y0), j1 = iy.get(r.y1);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const inX = i > i0 && i < i1, inY = j > j0 && j < j1;
        if (inX && inY) node[j * nx + i] = 1;
        if (inY && i < i1) h[j * nx + i] = 1;
        if (inX && j < j1) v[j * nx + i] = 1;
      }
    }
  }
  return { X, Y, nx, ix, iy, node, h, v, grown, steps: STEPS };
}

// a 에서 b 로 가는 돌아가는 길(점 목록). grid 는 a·b 를 포함한 상자들로 만든 것. 길이 없거나 격자에 없는 상자면 null.
// 꺾임까지 친 길이에 b 의 넓힌 상자까지 남은 거리를 더해 가까운 쪽부터 찾는다(A*)
export function detour(a, b, others, grid = makeGrid([a, b, ...others])) {
  if (!grid) return null;
  const { X, Y, nx, ix, iy, node, h, v, grown } = grid;
  const ga = grow(a), gb = grow(b);
  const ac = { x: a.x + a.width / 2, y: a.y + a.height / 2 }, bc = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  if (![ac.x, bc.x, ga.x0, ga.x1, gb.x0, gb.x1].every((x) => ix.has(x)) || ![ac.y, bc.y, ga.y0, ga.y1, gb.y0, gb.y1].every((y) => iy.has(y))) return null;
  // 상자 변의 가운데에서 넓힌 테두리까지 곧게 나가는 짧은 선: [변 위의 점, 격자 칸, 나가는 방향]. 다른 상자의 여백이 겹치면 못 쓴다
  const cuts = (p, q, r) => Math.max(p.x, q.x) > r.x0 && Math.min(p.x, q.x) < r.x1 && Math.max(p.y, q.y) > r.y0 && Math.min(p.y, q.y) < r.y1;
  const stubs = (r, c, g) => [
    [{ x: r.x + r.width, y: c.y }, { x: g.x1, y: c.y }, 0], [{ x: r.x, y: c.y }, { x: g.x0, y: c.y }, 1],
    [{ x: c.x, y: r.y + r.height }, { x: c.x, y: g.y1 }, 2], [{ x: c.x, y: r.y }, { x: c.x, y: g.y0 }, 3],
  ].filter(([p, q]) => !grown.some((w) => w.x0 !== g.x0 || w.y0 !== g.y0 || w.x1 !== g.x1 || w.y1 !== g.y1 ? cuts(p, q, w) : false))
    .map(([p, q, d]) => [p, iy.get(q.y) * nx + ix.get(q.x), d]).filter(([, cell]) => !node[cell]);
  const ends = new Map(); // 들어가는 칸 → [변 위의 점, 들어가는 방향]
  for (const [p, cell, d] of stubs(b, bc, gb)) ends.set(cell, [p, d ^ 1]);
  if (!ends.size) return null;
  const left = (x, y) => Math.max(gb.x0 - x, 0, x - gb.x1) + Math.max(gb.y0 - y, 0, y - gb.y1); // b 까지 남은 거리(넘지 않음)
  // 상태 = 칸 * 4 + 들어온 방향. 걸음이 많아 Map 대신 배열을 격자에 한 벌 두고 선마다 다시 채운다
  const n = node.length * 4, GOAL = n;
  if (!grid.cost) { grid.cost = new Float64Array(n + 1); grid.from = new Int32Array(n + 1); grid.done = new Uint8Array(n + 1); }
  const { cost, from, done } = grid;
  cost.fill(Infinity);
  done.fill(0);
  const starts = new Map(); // 처음 칸의 상태 → 변 위의 점
  let goalEnd = null;
  const hp = [], hk = []; // 우선순위 큐(가까울 법한 순): 값과 상태를 나란히 둔다
  const push = (c, k, x, y) => {
    if (cost[k] <= c) return false;
    cost[k] = c;
    let i = hp.length;
    hp.push(c + left(x, y));
    hk.push(k);
    while (i > 0) {
      const m = (i - 1) >> 1;
      if (hp[m] <= hp[i]) break;
      [hp[m], hp[i]] = [hp[i], hp[m]];
      [hk[m], hk[i]] = [hk[i], hk[m]];
      i = m;
    }
    return true;
  };
  const pop = () => {
    const k = hk[0], lp = hp.pop(), lk = hk.pop();
    if (hp.length) {
      hp[0] = lp;
      hk[0] = lk;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < hp.length && hp[l] < hp[m]) m = l;
        if (r < hp.length && hp[r] < hp[m]) m = r;
        if (m === i) break;
        [hp[m], hp[i]] = [hp[i], hp[m]];
        [hk[m], hk[i]] = [hk[i], hk[m]];
        i = m;
      }
    }
    return k;
  };
  for (const [p, cell, d] of stubs(a, ac, ga)) {
    const i = cell % nx, j = (cell - i) / nx;
    if (push(Math.abs(X[i] - p.x) + Math.abs(Y[j] - p.y), cell * 4 + d, X[i], Y[j])) { from[cell * 4 + d] = -1; starts.set(cell * 4 + d, p); }
  }
  while (hp.length) {
    const k = pop();
    if (done[k]) continue;
    done[k] = 1;
    if (k === GOAL) break;
    if (--grid.steps < 0) return null;
    const c = cost[k], d = k % 4, cell = (k - d) / 4, i = cell % nx, j = (cell - i) / nx;
    const end = ends.get(cell);
    if (end) {
      const [p, dir] = end;
      if (push(c + Math.abs(X[i] - p.x) + Math.abs(Y[j] - p.y) + (dir === d ? 0 : BEND), GOAL, p.x, p.y)) { from[GOAL] = k; goalEnd = p; }
    }
    for (let nd = 0; nd < 4; nd++) {
      const ni = i + DIRS[nd][0], nj = j + DIRS[nd][1];
      if (ni < 0 || nj < 0 || ni >= nx || nj >= Y.length) continue;
      const ncell = nj * nx + ni;
      // 지나는 칸: 가로면 왼쪽 점의 h, 세로면 위쪽 점의 v
      if (node[ncell] || (nd < 2 ? h[j * nx + Math.min(i, ni)] : v[Math.min(j, nj) * nx + i])) continue;
      if (push(c + Math.abs(X[ni] - X[i]) + Math.abs(Y[nj] - Y[j]) + (nd === d ? 0 : BEND), ncell * 4 + nd, X[ni], Y[nj])) from[ncell * 4 + nd] = k;
    }
  }
  if (!done[GOAL]) return null;
  // 거꾸로 따라가며 점을 모으고, 한 줄로 이어지는 가운데 점은 뺀다
  const pts = [goalEnd];
  for (let k = from[GOAL]; ;) {
    const cell = (k - (k % 4)) / 4, i = cell % nx;
    pts.push({ x: X[i], y: Y[(cell - i) / nx] });
    if (from[k] === -1) { pts.push(starts.get(k)); break; }
    k = from[k];
  }
  pts.reverse();
  return pts.filter((p, n) => n === 0 || n === pts.length - 1 ||
    !((pts[n - 1].x === p.x && p.x === pts[n + 1].x) || (pts[n - 1].y === p.y && p.y === pts[n + 1].y)));
}

// 상자 a 에서 b 로 그을 선 하나: 후보(routes) 가운데 다른 상자(leaves, 묶음 말고)를 덜 지나는 것, 같으면 덜 꺾인 것, 그다음 짧은 것.
// 후보가 모두 지나면 돌아가는 길(detour)을 찾아 덜 지나면 그것을 쓴다. ctx 는 한 배치의 선들이 같이 쓰는 격자와,
// 같은 두 끝(pair)의 돌아가는 길이다. { pts, n(지나는 상자 수), len }
export function pickRoute(a, b, leaves, ctx = {}, pair = null) {
  let best = null;
  for (const pts of routes(a, b)) {
    const n = leaves.filter((c) => c !== a && c !== b && pts.some((p, i) => i > 0 && segmentHits(pts[i - 1], p, c))).length;
    const cand = { pts, n, len: pathLength(pts) };
    if (!best || n < best.n || (n === best.n && (pts.length < best.pts.length || (pts.length === best.pts.length && cand.len < best.len)))) best = cand;
  }
  if (best.n) {
    // 격자는 한 배치의 잎 상자로 한 번만 만들고, 같은 두 끝의 길은 다시 찾지 않는다
    if (ctx.grid === undefined) ctx.grid = makeGrid(leaves);
    ctx.found ||= new Map();
    let pts;
    if (pair !== null && ctx.found.has(pair)) pts = ctx.found.get(pair);
    else { pts = detour(a, b, [], ctx.grid); if (pair !== null) ctx.found.set(pair, pts); }
    const n = pts ? leaves.filter((c) => c !== a && c !== b && pts.some((p, i) => i > 0 && segmentHits(pts[i - 1], p, c))).length : Infinity;
    if (n < best.n) best = { pts, n, len: pathLength(pts) };
  }
  return best;
}
export { midPoint };

export function crossLines(out, cross) {
  const boxes = new Map(), leaves = [];
  const walk = (n) => { for (const c of n.children || []) { boxes.set(c.id, c); if (c.children?.length) walk(c); else leaves.push(c); } };
  walk(out);
  let w = Math.max(1, out.width), h = Math.max(1, out.height), hits = 0;
  const lines = [], ctx = {};
  for (const e of cross) {
    const a = boxes.get(e.a), b = boxes.get(e.b);
    if (!a || !b) continue;
    const best = pickRoute(a, b, leaves, ctx, `${e.a}\n${e.b}`);
    hits += best.n;
    // 돌아가는 길은 상자 밖 여백(MARGIN)까지 나가므로 그만큼 그림을 키운다
    for (const p of best.pts) { w = Math.max(w, p.x + 2); h = Math.max(h, p.y + 2); }
    let label = null;
    if (e.label) {
      const m = midPoint(best.pts);
      label = { text: e.label.text, x: Math.max(0, m.x - e.label.width / 2), y: Math.max(0, m.y - e.label.height / 2) };
      w = Math.max(w, label.x + e.label.width);
      h = Math.max(h, label.y + e.label.height);
    }
    lines.push({ id: e.id, pts: best.pts, label });
  }
  return { lines, w, h, hits };
}
