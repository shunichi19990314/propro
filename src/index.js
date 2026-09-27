// Ultraviolet (UV) プロキシサーバー本体
// 静的ファイル + UV/BareMux/Epoxy のベンダースクリプト + WISP サーバーを1プロセスで提供します。
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import express from "express";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";

import { uvPath } from "@titaniumnetwork-dev/ultraviolet";
import { epoxyPath } from "@mercuryworkshop/epoxy-transport";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";

const app = express();

// 1) 自分のフロントエンド (public/) を最優先で配信
app.use(express.static("./public"));
// 2) ベンダーのスクリプトを各パスにマウント
app.use("/uv/", express.static(uvPath));         // UV 本体 (sw, bundle, client...)
app.use("/epoxy/", express.static(epoxyPath));   // Epoxy トランスポート (WISP クライアント)
app.use("/baremux/", express.static(baremuxPath)); // BareMux (トランスポート切り替え層)

// どれにも該当しなければ 404
app.use((req, res) => {
  res.status(404);
  res.sendFile(fileURLToPath(new URL("../public/404.html", import.meta.url)));
});

const server = createServer();

server.on("request", (req, res) => {
  // COOP/COEP は UV がクライアント側フックを使うために推奨
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  app(req, res);
});

// WebSocket の upgrade: /wisp/ だけ WISP サーバーへルーティング
server.on("upgrade", (req, socket, head) => {
  if (req.url.endsWith("/wisp/")) {
    wisp.routeRequest(req, socket, head);
    return;
  }
  socket.end();
});

let port = parseInt(process.env.PORT || "");
if (isNaN(port)) port = 8080;

server.on("listening", () => {
  const address = server.address();
  console.log("Listening on:");
  console.log(`\thttp://localhost:${address.port}`);
  console.log(`\thttp://${hostname()}:${address.port}`);
});

process.on("SIGINT", () => server.close());
process.on("SIGTERM", () => server.close());

server.listen({ port });
