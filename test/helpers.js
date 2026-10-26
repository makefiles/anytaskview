// 시험 도우미: 임시 상태 폴더로 화판을 띄우고, 쓰기·읽기 요청을 보낸다
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { startBoard } from "../lib/server.js";

export async function boardFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atv-test-"));
  const home = path.join(dir, "home");
  let board = await startBoard({ port: 0, home });
  const keys = () => JSON.parse(fs.readFileSync(path.join(home, "key.json"), "utf8"));
  const f = {
    dir, home,
    get port() { return board.port; },
    get board() { return board; },
    keys,
    async restart() { await board.close(); board = await startBoard({ port: 0, home }); },
    async close() { await board.close(); fs.rmSync(dir, { recursive: true, force: true }); },
    // 원시 요청(헤더를 마음대로 정한다)
    request(method, url, { headers = {}, body } = {}) {
      return new Promise((ok, fail) => {
        const req = http.request({ host: "127.0.0.1", port: board.port, method, path: url, headers: { host: `127.0.0.1:${board.port}`, ...headers } }, (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => ok({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
        });
        req.on("error", fail);
        if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
        req.end();
      });
    },
    write(pathname, body, extra = {}) {
      return f.request("POST", pathname, { headers: { "content-type": "application/json", "x-atv-key": keys().write, ...extra }, body });
    },
    async read(pathname) {
      const r = await f.request("GET", pathname, { headers: { cookie: `atv_r=${keys().read}` } });
      return r.headers["content-type"]?.startsWith("application/json") ? { ...r, json: JSON.parse(r.text) } : r;
    },
    mcp(tool, input, { pid = 4242, env = "env-session" } = {}) {
      return f.write("/api/mcp", { pid, env, cwd: "/w", tool, input });
    },
    hook(sid, fact, { pid = 4242, ht } = {}) {
      return f.write("/api/hook", { pid, sid, fact, ...(ht !== undefined && { ht }) });
    },
  };
  return f;
}
