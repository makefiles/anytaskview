// 상태 폴더: 열쇠 파일과 세션 기록(JSONL)을 둔다. 저장소 밖(~/.local/state/anytaskview)이고 이 사용자만 읽는다.
// 이 PC 의 umask 가 0002 라 모드를 반드시 정해서 만든다(폴더 0700, 파일 0600).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export const SID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// 화판 서버와 MCP 가 주고받는 약속의 판. 바뀌면 올린다. 다르면 MCP 가 「화판 서버를 다시 띄우라」고 알린다
export const PROTOCOL = 5; // 4: Codex(MCP 의 sid, 훅의 via·home), 5: 표·상자 모양·아이콘, 지난 대화 자동 휴지통

// 코드 표지: 서버·화면·MCP·훅 파일의 이름과 내용. 화판 서버는 뜰 때의 표지를 기억해 두고,
// 갱신으로 자기 코드가 밀려났는지(Claude: 판 폴더의 .orphaned_at, Codex: 같은 폴더를 덮어씀) 가린다.
// 수정 시각은 넣지 않는다(내용이 같은데 시각만 바뀌어 서버를 갈아 끼우지 않게)
export function codeSignature(root) {
  const h = crypto.createHash("sha1");
  for (const dir of ["lib", "web", "web/vendor", "mcp", "hook", "scripts"]) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, dir)).sort(); } catch { continue; }
    for (const n of names) {
      try {
        const file = path.join(root, dir, n);
        if (fs.statSync(file).isFile()) h.update(`${dir}/${n}\n`).update(fs.readFileSync(file));
      } catch { /* 갱신 중에 지워진 파일 */ }
    }
  }
  return h.digest("hex").slice(0, 12);
}
export const orphaned = (root) => fs.existsSync(path.join(root, ".orphaned_at"));
// 판 번호(package.json 의 version). 릴리스마다 올린다. 화판 서버와 MCP 가 견주어 낮은 판의 서버를 갈아 끼운다
export function codeVersion(root) {
  try { return String(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version || "0.0.0"); } catch { return "0.0.0"; }
}
// a 가 b 보다 낮으면 음수(1.2.0 < 1.10.0)
export function versionCmp(a, b) {
  const pa = String(a).split(".").map((x) => parseInt(x, 10) || 0), pb = String(b).split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

export function stateHome() {
  return process.env.ANYTASKVIEW_HOME || path.join(os.homedir(), ".local", "state", "anytaskview");
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // 이미 있던 폴더가 넓게 열려 있으면 좁힌다
  if ((fs.statSync(dir).mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}

const keyFile = (home) => path.join(home, "key.json");
const token = () => crypto.randomBytes(32).toString("base64url");

// 쓰기 열쇠(write, 훅·MCP), 읽기 토큰(read, 브라우저 쿠키), 화판 쓰기 열쇠(board, 브라우저 localStorage).
// 처음 시작할 때 만들고, 다른 프로세스가 먼저 만들었으면 그것을 읽는다.
// board 는 02 에서 더했다: 쿠키는 포트를 가리지 않아 127.0.0.1 의 다른 포트로도 가므로, 쓰기에는
// 포트까지 갈라 두는 localStorage 에 둔 열쇠를 따로 쓴다. 옛 열쇠 파일에는 board 만 더한다
export function ensureKeys(home) {
  ensureDir(home);
  try {
    fs.writeFileSync(keyFile(home), JSON.stringify({ write: token(), read: token(), board: token() }) + "\n", { mode: 0o600, flag: "wx" });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  let keys = readKeys(home);
  if (!keys) throw new Error(`열쇠 파일이 깨졌습니다: ${keyFile(home)}`);
  if (!keys.board) {
    keys = { ...keys, board: token() };
    const tmp = keyFile(home) + `.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(keys) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, keyFile(home));
  }
  return keys;
}

// 열쇠를 읽기만 한다. 없거나 깨졌으면 null
export function readKeys(home) {
  try {
    const k = JSON.parse(fs.readFileSync(keyFile(home), "utf8"));
    if (!(typeof k.write === "string" && typeof k.read === "string" && k.write.length >= 32 && k.read.length >= 32)) return null;
    return { write: k.write, read: k.read, ...(typeof k.board === "string" && k.board.length >= 32 && { board: k.board }) };
  } catch {
    return null;
  }
}

export function sessionsDir(home) {
  const dir = path.join(home, "sessions");
  ensureDir(dir);
  return dir;
}

// 지운 세션의 기록은 휴지통 폴더로 옮겨 두고 30일 뒤 비운다. 파일 이름 끝의 숫자가 지운 시각이다
// (옮겨도 mtime 은 마지막으로 기록한 때라 쓰지 않는다)
export const TRASH_DAYS = 30;
export function trashDir(home) {
  const dir = path.join(home, "trash");
  ensureDir(dir);
  return dir;
}
export function purgeTrash(home, now = Date.now()) {
  const dir = trashDir(home);
  for (const name of fs.readdirSync(dir)) {
    const m = /\.(\d+)\.jsonl$/.exec(name);
    if (m && now - Number(m[1]) > TRASH_DAYS * 86_400_000) fs.rmSync(path.join(dir, name), { force: true });
  }
}

// 기록 줄을 읽기만 한다(파일을 고치지 않는다). 끝나지 않은 마지막 줄은 건너뛴다. 쓰는 중인 파일을 읽을 때 쓴다
export function parseRecords(text) {
  const records = [];
  let broken = 0;
  const end = text.lastIndexOf("\n") + 1;
  for (const line of text.slice(0, end).split("\n")) {
    if (!line) continue;
    try { records.push(JSON.parse(line)); } catch { broken++; }
  }
  return { records, broken };
}

// 기록 파일을 읽는다. 끝이 잘린 마지막 줄은 파일에서 잘라 내 뒤에 이어 쓰는 줄이 깨지지 않게 한다.
// 중간 줄이 깨졌으면 그 줄만 건너뛰고 broken 으로 알린다
export function readRecords(file) {
  let text = fs.readFileSync(file, "utf8");
  const cut = text.lastIndexOf("\n") + 1;
  if (cut < text.length) {
    fs.truncateSync(file, Buffer.byteLength(text.slice(0, cut)));
    text = text.slice(0, cut);
  }
  return parseRecords(text);
}

// 프로젝트: 정의와 소속을 한 파일에 같이 둔다(한 번에 바뀌어 중간에 어긋나지 않게). 임시 파일에 쓰고 이름을 바꾼다.
// projects: id → { name, purpose, keys(이어받기 키), t(만든 때), done }, members: 세션 id → { pid(null 이면 사용자가 뺌), why }
export const projectsFile = (home) => path.join(home, "projects.json");
export function readProjects(home) {
  try {
    const p = JSON.parse(fs.readFileSync(projectsFile(home), "utf8"));
    if (p && typeof p.projects === "object" && typeof p.members === "object") return { projects: p.projects, members: p.members };
  } catch { /* 없거나 깨졌으면 빈 것으로 시작한다 */ }
  return { projects: {}, members: {} };
}
export async function writeProjects(home, data) {
  const tmp = projectsFile(home) + `.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(data) + "\n", { mode: 0o600 });
  await fs.promises.rename(tmp, projectsFile(home));
}
// 07 판까지의 묶음(groups.json). 프로젝트 파일이 없을 때 한 번 옮겨 온다(옛 파일은 지우지 않는다)
export function readLegacyGroups(home) {
  try {
    const g = JSON.parse(fs.readFileSync(path.join(home, "groups.json"), "utf8"));
    if (g && typeof g.groups === "object" && typeof g.members === "object") return g;
  } catch { /* 없으면 옮길 것이 없다 */ }
  return null;
}

export function projectsDir(home) {
  const dir = path.join(home, "projects");
  ensureDir(dir);
  return dir;
}

// 설정(이어받기 문구 따위). 파일이 없으면 null: 새 판이 처음 뜬 것이라 서버가 옛 기록을 보고 정한다
const configFile = (home) => path.join(home, "config.json");
export function readConfig(home) {
  try {
    const c = JSON.parse(fs.readFileSync(configFile(home), "utf8"));
    if (c && typeof c === "object" && !Array.isArray(c)) return c;
  } catch { /* 없거나 깨졌으면 null */ }
  return null;
}
export async function writeConfig(home, data) {
  const tmp = configFile(home) + `.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(data) + "\n", { mode: 0o600 });
  await fs.promises.rename(tmp, configFile(home));
}

// 경로가 속한 git 저장소와 브랜치. 작업 트리는 원래 저장소(공통 .git)로 맞추고 브랜치는 그 작업 트리의 것을 쓴다.
// 프로젝트 후보의 순서에만 쓴다. 폴더마다 한 번만 찾는다
const repoCache = new Map();
export function repoOf(dir) {
  if (typeof dir !== "string" || !dir.startsWith("/")) return null;
  if (repoCache.has(dir)) return repoCache.get(dir);
  let found = null;
  for (let d = dir; ; d = path.dirname(d)) {
    const dotgit = path.join(d, ".git");
    let st;
    try { st = fs.statSync(dotgit); } catch { st = null; }
    if (st) {
      try {
        let gitdir = dotgit, common = dotgit;
        if (st.isFile()) {
          const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotgit, "utf8"));
          if (m) gitdir = path.resolve(d, m[1].trim());
          try { common = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, "commondir"), "utf8").trim()); } catch { common = gitdir; }
        }
        const head = fs.readFileSync(path.join(gitdir, "HEAD"), "utf8");
        found = { repo: common, branch: (/^ref:\s*refs\/heads\/(.+)$/m.exec(head) || [])[1]?.trim() || "" };
      } catch { found = null; }
      break;
    }
    if (d === path.dirname(d)) break;
  }
  if (repoCache.size > 2000) repoCache.clear();
  repoCache.set(dir, found);
  return found;
}

// 127.0.0.1:port 에서 듣는 소켓의 주인. 다른 사용자가 포트를 먼저 잡았으면 훅·MCP 가 쓰기 열쇠를 보내지 않게 한다.
// "self" 이 사용자, "other" 다른 사용자, "none" 듣는 소켓 없음, "unknown" /proc 를 읽을 수 없는 시스템
export function portOwner(port) {
  let text;
  try { text = fs.readFileSync("/proc/net/tcp", "utf8"); } catch { return "unknown"; }
  const want = `0100007F:${Number(port).toString(16).toUpperCase().padStart(4, "0")}`;
  const any = `00000000:${Number(port).toString(16).toUpperCase().padStart(4, "0")}`;
  let owner = "none";
  for (const line of text.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f[3] !== "0A" || (f[1] !== want && f[1] !== any)) continue; // 0A = LISTEN
    if (Number(f[7]) !== process.getuid()) return "other";
    owner = "self";
  }
  // IPv6 의 모든 주소(::)와 IPv4 를 옮긴 주소(::ffff:127.0.0.1)에 묶은 소켓도 127.0.0.1 로 오는 연결을 받는다
  // (/proc 는 32비트 낱말마다 이 기계의 바이트 순서로 적는다)
  try {
    const t6 = fs.readFileSync("/proc/net/tcp6", "utf8");
    const port6 = `:${Number(port).toString(16).toUpperCase().padStart(4, "0")}`;
    const local6 = new Set(["00000000000000000000000000000000", "0000000000000000FFFF00000100007F"].map((a) => a + port6));
    for (const line of t6.split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f[3] !== "0A" || !local6.has(f[1])) continue;
      if (Number(f[7]) !== process.getuid()) return "other";
      owner = "self";
    }
  } catch { /* IPv6 가 없으면 넘어간다 */ }
  return owner;
}
