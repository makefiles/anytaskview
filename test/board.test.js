// scripts/board.js --open: 서버가 없으면 띄우고, 열쇠 든 주소는 명령줄·출력에 남기지 않고 넘김 파일로 브라우저를 연다
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BOARD = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "board.js");

test("--open: 서버를 띄우고, 브라우저에는 이 사용자만 읽는 넘김 파일만 넘기며 주소를 찍지 않는다", { skip: process.platform !== "linux" }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atv-open-"));
  const home = path.join(dir, "home"), bin = path.join(dir, "bin"), port = String(20000 + (process.pid % 20000));
  fs.mkdirSync(bin);
  // 진짜 브라우저 대신 받은 인자를 적는 가짜 xdg-open
  fs.writeFileSync(path.join(bin, "xdg-open"), `#!/bin/sh\necho "$@" > "${dir}/opened"\n`, { mode: 0o755 });
  const env = { ...process.env, ANYTASKVIEW_HOME: home, PATH: `${bin}:${process.env.PATH}` };
  delete env.WSL_DISTRO_NAME;
  t.after(() => {
    spawnSync(process.execPath, [BOARD, "--stop", "--port", port], { env });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const r = spawnSync(process.execPath, [BOARD, "--open", "--port", port], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const keys = JSON.parse(fs.readFileSync(path.join(home, "key.json"), "utf8"));
  assert.ok(!(r.stdout + r.stderr).includes(keys.read), "출력에 읽기 토큰이 없다");
  for (let i = 0; i < 50 && !fs.existsSync(path.join(dir, "opened")); i++) spawnSync("sleep", ["0.05"]);
  const page = path.join(home, "open.html");
  assert.equal(fs.readFileSync(path.join(dir, "opened"), "utf8").trim(), page, "브라우저에는 넘김 파일 경로만 넘긴다");
  assert.equal(fs.statSync(page).mode & 0o777, 0o600);
  assert.ok(fs.readFileSync(page, "utf8").includes(`http://127.0.0.1:${port}/?t=${keys.read}`));
});

test("--open: 브라우저를 여는 명령이 바로 실패하면 실패로 알린다", { skip: process.platform !== "linux" }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atv-open-"));
  const home = path.join(dir, "home"), bin = path.join(dir, "bin"), port = String(20000 + ((process.pid + 7) % 20000));
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "xdg-open"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
  const env = { ...process.env, ANYTASKVIEW_HOME: home, PATH: `${bin}:${process.env.PATH}` };
  delete env.WSL_DISTRO_NAME;
  t.after(() => {
    spawnSync(process.execPath, [BOARD, "--stop", "--port", port], { env });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const r = spawnSync(process.execPath, [BOARD, "--open", "--port", port], { env, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /브라우저를 열지 못했습니다/);
});
