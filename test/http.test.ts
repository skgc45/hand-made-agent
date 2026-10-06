import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { test } from "node:test";
import type { Sessions } from "../src/session/index.js";
import {
  allowedContentType,
  allowedOrigin,
  HttpTransport,
} from "../src/transport/http.js";

const LOCAL = "127.0.0.1";

test("allowedOrigin", () => {
  const cases: [string, { host?: string; origin?: string }, string, boolean][] =
    [
      ["localhost:PORT", { host: "localhost:3000" }, LOCAL, true],
      ["127.0.0.1:PORT", { host: "127.0.0.1:3000" }, LOCAL, true],
      ["[::1]:PORT", { host: "[::1]:3000" }, LOCAL, true],
      ["Host なし", {}, LOCAL, false],
      ["evil.com", { host: "evil.com" }, LOCAL, false],
      ["evil.com:PORT", { host: "evil.com:3000" }, LOCAL, false],
      [
        "Origin がループバック（別ポート）",
        { host: "localhost:3000", origin: "http://localhost:5173" },
        LOCAL,
        true,
      ],
      [
        "Origin が別ホスト",
        { host: "localhost:3000", origin: "https://evil.com" },
        LOCAL,
        false,
      ],
      [
        "Origin が不正",
        { host: "localhost:3000", origin: "null" },
        LOCAL,
        false,
      ],
      ["外に開いたときは Host を見ない", { host: "evil.com" }, "0.0.0.0", true],
      [
        "外に開いても Origin は見る",
        { host: "evil.com", origin: "https://evil.com" },
        "0.0.0.0",
        false,
      ],
    ];
  for (const [name, headers, listen, want] of cases) {
    assert.equal(allowedOrigin(headers, listen), want, name);
  }
});

test("allowedContentType", () => {
  const cases: [string | undefined, boolean][] = [
    ["application/json", true],
    ["application/json; charset=utf-8", true],
    ["text/plain", false],
    ["application/x-www-form-urlencoded", false],
    [undefined, false],
  ];
  for (const [value, want] of cases) {
    assert.equal(allowedContentType(value), want, String(value));
  }
});

async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as net.AddressInfo;
  await new Promise((r) => srv.close(r));
  return port;
}

function get(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get(
        { port, host: LOCAL, path: "/threads", headers: { host } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      )
      .on("error", reject);
  });
}

test("GET /threads にも Host の検査が掛かる", async () => {
  const port = await freePort();
  const transport = new HttpTransport(port);
  const sessions = { list: async () => [] } as unknown as Sessions;
  void transport.start(sessions);
  try {
    let status = 0;
    for (let i = 0; i < 50 && status === 0; i++) {
      try {
        status = await get(port, `localhost:${port}`);
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    assert.equal(status, 200);
    assert.equal(await get(port, "evil.com"), 403);
  } finally {
    await transport.stop();
  }
});

function post(
  port: number,
  body: string | Buffer,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        port,
        host: LOCAL,
        method: "POST",
        path: "/",
        headers: {
          host: `localhost:${port}`,
          "content-type": "application/json",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => {
          data += c;
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: data }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

test("POST の不正な body は 4xx を {error} で返す", async () => {
  const port = await freePort();
  const transport = new HttpTransport(port);
  const sessions = {
    list: async () => [],
    steer: () => false,
    run: async function* () {},
  } as unknown as Sessions;
  void transport.start(sessions);
  try {
    let ready = 0;
    for (let i = 0; i < 50 && ready === 0; i++) {
      try {
        ready = await get(port, `localhost:${port}`);
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    const cases: [string, string | Buffer, number][] = [
      ["不正な JSON", "{", 400],
      ["null", "null", 400],
      ["配列", "[]", 400],
      ["文字列", '"x"', 400],
      ["threadId が数値", '{"threadId":1}', 400],
      ["threadId がオブジェクト", '{"threadId":{}}', 400],
      ["threadId に使えない文字", '{"threadId":"../x"}', 400],
      ["message が数値", '{"message":1}', 400],
      ["resume が配列でない", '{"resume":{}}', 400],
      ["runId が数値", '{"runId":1}', 400],
      ["messages が配列でない", '{"messages":"x"}', 400],
      ["1MB 超", Buffer.alloc(1_000_001, "a"), 413],
    ];
    for (const [name, body, want] of cases) {
      const res = await post(port, body);
      assert.equal(res.status, want, name);
      assert.equal(typeof JSON.parse(res.body).error, "string", name);
    }
    const ok = await post(port, '{"threadId":"ok_1","message":"hi"}');
    assert.equal(ok.status, 200);
  } finally {
    await transport.stop();
  }
});
