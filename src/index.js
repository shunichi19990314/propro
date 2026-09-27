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
