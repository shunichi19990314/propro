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
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
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

// 中継先のホワイトリスト (環境変数 WISP_WHITELIST: カンマ区切り正規表現)。
// 設定すると開放リレー化(滥用)を防げます。個人利用なら必ず設定を。
const wl = (process.env.WISP_WHITELIST || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (wl.length > 0) {
  wisp.options.hostname_whitelist = wl.map((s) => new RegExp(s));
}

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
