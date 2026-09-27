// Ultraviolet (UV) プロキシサーバー本体
// 静的ファイル + UV/BareMux/Epoxy ベンダースクリプト + WISP サーバー + 加速ダウンロード /dl/
//
// 性能/運用チューニング:
//  - UV_WORKERS=N : リレーを N ワーカープロセスで起動 (複数 vCPU。既定 1)
//  - WISP_WHITELIST : 中継許可ホスト (カンマ区切り正規表現)。/dl/ にも適用
//  - WebSocket upgrade 時: TCP_NODELAY + ソケットバッファ拡大
import { hostname } from "node:os";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import cluster from "node:cluster";
import express from "express";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";

import { uvPath } from "@titaniumnetwork-dev/ultraviolet";
import { epoxyPath } from "@mercuryworkshop/epoxy-transport";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";

// 中継先のホワイトリスト (開放リレー化/滥用防止)。個人利用なら必ず設定を。
const wl = (process.env.WISP_WHITELIST || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (wl.length > 0) {
  wisp.options.hostname_whitelist = wl.map((s) => new RegExp(s));
}

const WORKERS = Math.max(1, parseInt(process.env.UV_WORKERS || "1", 10));

if (cluster.isPrimary && WORKERS > 1) {
  let shuttingDown = false;
  console.log(`primary ${process.pid}: forking ${WORKERS} workers`);
  for (let i = 0; i < WORKERS; i++) cluster.fork();
  cluster.on("exit", (w) => {
    if (!shuttingDown) {
      console.log(`worker ${w.process.pid} exited; restarting`);
      cluster.fork();
    }
  });
  // BUGFIX: primary が SIGTERM で落ちるとワーカーが孤児化していたため、
  // 明示的にワーカーへ伝播する (Railway の graceful shutdown 対策)
  const stopPrimary = () => {
    shuttingDown = true;
    for (const w of Object.values(cluster.workers)) w?.kill("SIGTERM");
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on("SIGINT", stopPrimary);
  process.on("SIGTERM", stopPrimary);
} else {
  main();
}

function main() {
  const app = express();
  app.use(express.static("./public"));
  app.use("/uv/", express.static(uvPath));
  app.use("/epoxy/", express.static(epoxyPath));
  app.use("/baremux/", express.static(baremuxPath));

  const WL_RE = wl.map((s) => new RegExp(s));
  const allowed = (h) => WL_RE.length === 0 || WL_RE.some((r) => r.test(h));

  // BUGFIX(セキュリティ): 自動 redirect 追従はホワイトリスト検査を
  // 「最初のホストだけ」にしてしまい、別ホストへ飛び出して中継できた。
  // redirect:"manual" でホップ毎にホストを検査する。
  const MAX_HOPS = 5;
  async function fetchChecked(url, init = {}) {
    let u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new Error(`scheme not allowed: ${u.protocol}`);
    }
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      if (!allowed(u.hostname)) throw new Error(`host not allowed: ${u.hostname}`);
      const r = await fetch(u, { ...init, redirect: "manual" });
      if ([301, 302, 303, 307, 308].includes(r.status)) {
        const loc = r.headers.get("location");
        if (!loc) throw new Error("redirect without location");
        u = new URL(loc, u);
        try { await r.body?.cancel?.(); } catch {}
        continue;
      }
      return r;
    }
    throw new Error("too many redirects");
  }

  // --- 加速ダウンロード: サーバー側で並列 Range 分割中継 (非対応なら単一ストリーム) ---
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

  // BUGFIX: クライアント側が中断した際、drain 待ちが永久に残ってハングしていた。
  // drain と close を競合させ、close 時は例外で抜けて他パートも abort する。
  const drainOrClose = (res) =>
    new Promise((resolve, reject) => {
      const cleanup = () => { res.off("close", onClose); res.off("drain", onDrain); };
      const onClose = () => { cleanup(); reject(new Error("client closed")); };
      const onDrain = () => { cleanup(); resolve(); };
      res.once("close", onClose);
      res.once("drain", onDrain);
    });

  app.get("/dl/", async (req, res) => {
    const target = typeof req.query.url === "string" ? req.query.url : "";
    if (!target) return void res.status(400).send("url required");
    let u0;
    try { u0 = new URL(target); } catch { return void res.status(400).send("bad url"); }
    if (!allowed(u0.hostname)) return void res.status(403).send("host not allowed");
    const n = Math.min(8, Math.max(1, parseInt(req.query.n || "4", 10) || 4));
    const ac = new AbortController();
    res.on("close", () => ac.abort());
    try {
      const head = await fetchChecked(u0, { method: "HEAD", signal: ac.signal });
      const len = parseInt(head.headers.get("content-length") || "0", 10) || 0;
      const ranges = (head.headers.get("accept-ranges") || "") === "bytes";
      res.setHeader("Content-Type", head.headers.get("content-type") || "application/octet-stream");
      const disp = head.headers.get("content-disposition");
      if (disp) res.setHeader("Content-Disposition", disp);
      res.setHeader("Cache-Control", "no-store");

      // Range 非対応 / サイズ不明 / n=1 はそのままパイプ
      if (!ranges || !len || n === 1) {
        const r = await fetchChecked(u0, { signal: ac.signal });
        res.status(r.status);
        if (len) res.setHeader("Content-Length", String(len));
        for await (const c of r.body) {
          if (!res.write(c)) await drainOrClose(res);
        }
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
            const r = await fetchChecked(u0, {
              headers: { Range: `bytes=${start}-${end}` },
              signal: ac.signal,
            });
            if (r.status !== 206) throw new Error(`range ${i}: HTTP ${r.status}`);
            for await (const c of r.body) {
              queues[i].push(c);
              while (queues[i].depth > 64 && !ac.signal.aborted) {
                await new Promise((r2) => setTimeout(r2, 10));
              }
            }
            queues[i].end();
          } catch (e) {
            if (!ac.signal.aborted) queues[i].fail(e);
          }
        })();
      }
      try {
        for (let i = 0; i < n; i++) {
          let c;
          while ((c = await queues[i].shift()) !== null) {
            if (!res.write(c)) await drainOrClose(res);
          }
        }
        res.end();
      } catch (e) {
        // BUGFIX: 失敗パートがあるのに 200 のまま不完全なファイルを返さず、
        // 接続を破棄してクライアント側に失敗として見せる
        ac.abort();
        res.destroy();
      }
    } catch (e) {
      ac.abort();
      if (!res.headersSent) {
        const msg = String(e.message || e);
        res.status(msg.includes("not allowed") ? 403 : 502).send(msg);
      } else {
        res.destroy();
      }
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

  server.on("upgrade", (req, socket, head) => {
    if (req.url.endsWith("/wisp/")) {
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

  // BUGFIX: 長生き WS があると server.close() が完了せず終了できなかったため
  // 猶予後に強制終了する
  const stop = () => {
    // close 完了(接続ドレイン済)で即時終了、詰まっていれば10秒で強制終了
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  server.listen({ port });
}
