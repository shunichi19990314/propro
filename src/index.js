// Ultraviolet (UV) プロキシサーバー本体
// 静的ファイル + UV/BareMux/Epoxy ベンダースクリプト + WISP サーバーを提供。
//
// 性能チューニング:
//  - UV_WORKERS=N : リレーを N ワーカープロセスで起動 (複数 vCPU を使用。既定 1)
//  - WebSocket upgrade 時: TCP_NODELAY + ソケットバッファ拡大 (高遅延回線で有効)
import { hostname } from "node:os";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import cluster from "node:cluster";
import express from "express";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";

import { uvPath } from "@titaniumnetwork-dev/ultraviolet";
import { epoxyPath } from "@mercuryworkshop/epoxy-transport";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";

// 中継先のホワイトリスト (環境変数 WISP_WHITELIST: カンマ区切り正規表現)。
// 設定すると開放リレー化(滥用)を防げます。個人利用なら必ず設定を。
const wl = (process.env.WISP_WHITELIST || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (wl.length > 0) {
  wisp.options.hostname_whitelist = wl.map((s) => new RegExp(s));
}

const WORKERS = Math.max(1, parseInt(process.env.UV_WORKERS || "1", 10));

if (cluster.isPrimary && WORKERS > 1) {
  console.log(`primary ${process.pid}: forking ${WORKERS} workers`);
  for (let i = 0; i < WORKERS; i++) cluster.fork();
  cluster.on("exit", (w) => {
    console.log(`worker ${w.process.pid} exited; restarting`);
    cluster.fork();
  });
} else {
  main();
}

function main() {
  const app = express();
  // 1) 自分のフロントエンド (public/) を最優先で配信
  app.use(express.static("./public"));
  // 2) ベンダースクリプトを各パスにマウント
  app.use("/uv/", express.static(uvPath));
  app.use("/epoxy/", express.static(epoxyPath));
  app.use("/baremux/", express.static(baremuxPath));

  // --- 加速ダウンロード: サーバー側で並列 Range 分割中継 (非対応なら単一ストリーム) ---
  const WL_RE = wl.map((s) => new RegExp(s));
  const makeQueue = () => {
    const q = [];
    let wait = null, done = false, err = null;
    return {
      get depth() { return q.length; },
      push(c) { q.push(c); if (wait) { const w = wait; wait = null; w(); } },
      end() { done = true; if (wait) { const w = wait; wait = null; w(); } },
      fail(e) { err = e; done = true; if (wait) { const w = wait; wait = null; w(); } },
      async shift() {
        while (q.length === 0 && !done) await new Promise((r) => (wait = r));
        if (q.length) return q.shift();
        if (err) throw err;
        return null;
      },
    };
  };

  app.get("/dl/", async (req, res) => {
    const target = typeof req.query.url === "string" ? req.query.url : "";
    if (!target) return void res.status(400).send("url required");
    let u;
    try { u = new URL(target); } catch { return void res.status(400).send("bad url"); }
    if (WL_RE.length && !WL_RE.some((r) => r.test(u.hostname))) {
      return void res.status(403).send("host not allowed");
    }
    const n = Math.min(8, Math.max(1, parseInt(req.query.n || "4", 10) || 4));
    try {
      const head = await fetch(u, { method: "HEAD", redirect: "follow" });
      const len = parseInt(head.headers.get("content-length") || "0", 10) || 0;
      const ranges = (head.headers.get("accept-ranges") || "") === "bytes";
      res.setHeader("Content-Type", head.headers.get("content-type") || "application/octet-stream");
      const disp = head.headers.get("content-disposition");
      if (disp) res.setHeader("Content-Disposition", disp);
      res.setHeader("Cache-Control", "no-store");

      // Range 非対応 / サイズ不明 / n=1 はそのままパイプ
      if (!ranges || !len || n === 1) {
        const r = await fetch(u);
        res.status(r.status);
        if (len) res.setHeader("Content-Length", String(len));
        for await (const c of r.body) if (!res.write(c)) await new Promise((r2) => res.once("drain", r2));
        return void res.end();
      }

      // N 並列 Range を同時開始し、順番どおりにストリーム結合
      res.setHeader("Content-Length", String(len));
      const part = Math.ceil(len / n);
      const queues = Array.from({ length: n }, makeQueue);
      for (let i = 0; i < n; i++) {
        const start = i * part;
        const end = Math.min(len - 1, start + part - 1);
        (async () => {
          try {
            const r = await fetch(u, { headers: { Range: `bytes=${start}-${end}` } });
            if (r.status !== 206) throw new Error(`range ${i}: HTTP ${r.status}`);
            for await (const c of r.body) {
              queues[i].push(c);
              while (queues[i].depth > 64) await new Promise((r2) => setTimeout(r2, 10));
            }
            queues[i].end();
          } catch (e) { queues[i].fail(e); }
        })();
      }
      try {
        for (let i = 0; i < n; i++) {
          let c;
          while ((c = await queues[i].shift()) !== null) {
            if (!res.write(c)) await new Promise((r2) => res.once("drain", r2));
          }
        }
        res.end();
      } catch (e) { res.destroy(); }
    } catch (e) {
      if (!res.headersSent) res.status(502).send(String(e));
      else res.destroy();
    }
  });

  app.use((req, res) => {
    res.status(404);
    res.sendFile(fileURLToPath(new URL("../public/404.html", import.meta.url)));
  });

  const server = createServer();

  server.on("request", (req, res) => {
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    app(req, res);
  });

  // WebSocket upgrade: /wisp/ だけ WISP サーバーへ
  server.on("upgrade", (req, socket, head) => {
    if (req.url.endsWith("/wisp/")) {
      // 中継スループット調整: Nagle 無効化 + OS ソケットバッファ拡大
      socket.setNoDelay(true);
      try {
        socket.setRecvBufferSize(1024 * 1024);
        socket.setSendBufferSize(1024 * 1024);
      } catch {}
      wisp.routeRequest(req, socket, head);
      return;
    }
    socket.end();
  });

  let port = parseInt(process.env.PORT || "");
  if (isNaN(port)) port = 8080;

  server.on("listening", () => {
    const address = server.address();
    console.log(`worker ${process.pid} listening on :${address.port} (${hostname()})`);
  });

  process.on("SIGINT", () => server.close());
  process.on("SIGTERM", () => server.close());

  server.listen({ port });
}
