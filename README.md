# Ultraviolet (UV) Web プロキシの作り方

スクリーンショットのような「Web プロキシサイト」(Ultraviolet インスタンス)を
ゼロから作る手順と、**そのまま動くテンプレート**(このリポジトリ)です。
テンプレートは node 20 / express 5 / UV 3.2.x で `npm install` → `npm start` →
各エンドポイント 200 を確認済みです。

> スクショのインスタンスは古い **UV v2 + Bare サーバー**構成でしたが、
> 本テンプレートは現在の公式スタック **UV v3 + BareMux + Epoxy (WISP)** を採用しています。

---

## 1. 仕組み(アーキテクチャ)

```
┌─ ブラウザー ──────────────────────────────────────────────┐
│ フロントエンド (public/index.html + app.js)                │
│   │ 送信時: ① Service Worker 登録  ② トランスポート設定     │
│   ▼                                                        │
│ iframe src = /uv/service/<エンコード済みURL>                │
│   │  ← この配下が Service Worker (/uv/sw.js) の制御範囲     │
│   ▼                                                        │
│ UV 本体 (uv.client.js / uv.handler.js)                     │
│   fetch・DOM・Cookie・WebSocket をフックして書き換え        │
│   ▼                                                        │
│ BareMux worker → Epoxy クライアント (/epoxy/index.mjs)     │
└───│────────────────────────────────────────────────────────┘
    │  WebSocket (Wisp プロトコル)  wss://<あなたのドメイン>/wisp/
┌───▼─ サーバー (node src/index.js) ─────────────────────────┐
│ express (静的ファイル配信)  +  Wisp サーバー (wisp-js)      │
└───│────────────────────────────────────────────────────────┘
    │  宛先サイトへ TCP/TLS 接続
    ▼  example.com など
```

| 構成要素 | npm パッケージ | 役割 |
|---|---|---|
| UV 本体 (Service Worker 他) | `@titaniumnetwork-dev/ultraviolet` | プロキシの心臓部。`/uv/` 配下のスクリプト群 |
| BareMux | `@mercuryworkshop/bare-mux` | 通信方式(トランスポート)の切り替え層 |
| Epoxy | `@mercuryworkshop/epoxy-transport` | Wisp クライアント(ブラウザー側) |
| Wisp サーバー | `@mercuryworkshop/wisp-js` | 中継サーバー(`/wisp/`)。ここから実サイトへ接続 |
| Web サーバー | `express` | 静的ファイル配信とルーティング |

ポイント:
- **Service Worker のスコープ** = `/uv/`(SW は `/uv/sw.js` で登録)。トップページは
  制御外、プロキシ済みコンテンツ(`/uv/service/...`)だけが書き換え対象。
- URL はコーデック(xor / base32)で難読化されます。
- **HTTPS 必須**(SW の仕様)。`localhost` / `127.0.0.1` だけは例外。
- すべての通信は**あなたのサーバー経由**になります(= 運用者は流量を観測可能。§7 参照)。

---

## 2. リポジトリ構成

```
uv-proxy/
├─ package.json          # 依存関係と start スクリプト
├─ src/index.js          # サーバー本体 (静的配信 + /wisp/ ルーティング)
├─ public/
│  ├─ index.html         # フロントエンド (UI)
│  ├─ app.js             # フォーム→SW登録→トランスポート設定→iframe
│  ├─ register-sw.js     # Service Worker 登録ヘルパー
│  ├─ 404.html
│  └─ uv/uv.config.js    # UV 設定 (prefix / codec / 各スクリプトパス)
├─ Dockerfile            # コンテナ運用する場合
└─ .nvmrc                # Node 24 指定 (ホスティング側が参照)
```

`uv.bundle.js` などの本体スクリプトはリポジトリに含めず、
`npm install` したパッケージの `dist` をサーバーが `/uv/` にマウントします
(公式 Ultraviolet-App と同じ方式)。

---

## 3. ローカルで動かす

```bash
node -v          # >= 20 (24 推奨)
npm install
npm start
# → http://localhost:8080
```

`localhost` は HTTPS なしでも SW が登録できます。フォームに URL を入れて「開く」で
iframe 内にプロキシ経由のページが表示されます。

---

## 4. Render に公開する(スクショのサイトと同じホスティング)

1. このフォルダを `git init` → GitHub にプッシュ
2. Render ダッシュボード → **New → Web Service** → リポジトリを接続
3. 設定:
   - Runtime: **Node**
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Environment Variable: `NODE_VERSION=24`(`.nvmrc` でも可)
   - Instance: Free で動作確認可
4. Deploy。`https://<サービス名>.onrender.com` が自動発行され、
   HTTPS が自動設定されるので SW がそのまま動きます。
5. `PORT` 環境変数は Render が自動注入します(コード側は `process.env.PORT` を参照)。

**注意(スクショのエラーの正体):**
- 無料プランは約15分の無操作でスリープします。スリープ/停止中にリクエストすると
  ゲートウェイが **HTML のエラーページ(5xx)** を返し、UV クライアントがそれを
  JSON としてパースできず `SyntaxError: Unexpected token '<', "<!DOCTYPE "...`
  となります。スクショのInstancesもこの系統の障害です。
- 調べたところ、スクショのインスタンスは現在 **オーナーにより停止(suspended)**
  されています(`x-render-routing: suspend-by-user`)。
- 常時稼働させたい場合は有料プラン、または VPS(Docker)を推奨。

### その他のホスティング
- **VPS + Docker**: `docker build -t uv-proxy . && docker run -p 8080:8080 uv-proxy`
  の前に Caddy / nginx で TLS ターミネーション(HTTPS 必須のため)。
- Railway / Fly.io / Northflank など `PORT` を渡せる Node ランタイムなら同様。
- ⚠️ Cloudflare Pages / Netlify などの**静的ホスティングだけは不可**。
  Wisp サーバー(Node プロセス)が必要なため。

---

## 5. カスタマイズ

- **パス(prefix)変更**: `public/uv/uv.config.js` の `prefix`。
  ※ prefix は SW のスコープ(`/uv/` 配下)内に収めること。
- **URL の見た目**: codec を `Ultraviolet.codec.base32.encode/decode` にすると
  URL が base32 文字列になります(スクショ風の xor は `xor.encode`)。
- **UI 差し替え**: `public/` 配下だけ自由に差し替え可能。
  公式フロントエンド [Ultraviolet-Static](https://github.com/titaniumnetwork-dev/Ultraviolet-Static)
  のデザインを流用するのも手。
- **検索テンプレート**: `public/app.js` の `searchEngine`。
- **タブで開く / about:blank 表示**: コミュニティ由来の定番機能。
  `window.open(frame.src)` に置き換えるだけで別タブ化できます。

---

## 6. 付録: スクショ世代(UV v2 + Bare サーバー)の構成

参考まで。2023〜2024年頃の構成は Wisp ではなく **Bare サーバー**でした。

```js
// uv.config.js (v2)
self.__uv$config = {
  prefix: "/service/",
  bare: "/bare/",                       // ← v2 は Bare サーバーを指定
  encodeUrl: Ultraviolet.codec.xor.encode,
  decodeUrl: Ultraviolet.codec.xor.decode,
  handler: "/uv/uv.handler.js",
  bundle: "/uv/uv.bundle.js",
  config: "/uv/uv.config.js",
  sw: "/uv/uv.sw.js",
};

// サーバー側 (v2)
import { createBareServer } from "@tomphttp/bare-server-node";
const bare = createBareServer("/bare/");
server.on("request", (req, res) => {
  if (bare.shouldRoute(req)) bare.routeRequest(req, res); else app(req, res);
});
server.on("upgrade", (req, socket, head) => {
  if (bare.shouldRoute(req)) bare.routeUpgrade(req, socket, head); else socket.end();
});
```

スクショのエラーページ(`Code: SyntaxError / Unexpected token '<'`)は、
この Bare/Wisp エンドポイントが HTML(ゲートウェイのエラーページ)を返したときの
典型的な症状です。

---

## 7. 注意事項(必ず読んでください)

- **利用側**: 学校・職場・組織のフィルタ回避は利用規約違反になり得ます。
  判断は自己責任で。公開プロキシ経由で**資格情報・決済情報を入力しない**こと
  (通信は運用者のサーバーを経由します)。
- **運用側**: 全トラフィックが自サーバー経由になります。
  - ログ扱い・プライバシー方針を明示する
  - 中継 abuse(スパム・フィッシング転送)対策として
    wisp-js の `wisp.options.hostname_blacklist / hostname_whitelist` を検討する
  - 違法コンテンツ中継への対応窓口(DMCA 等)を準備する
- **ライセンス**: UV 周辺パッケージは MIT / GPL-3.0 などが混在します。
  フォーク・再配布時は各パッケージの LICENSE を確認してください。
- UV は現在、後継プロジェクト **Scramjet** へ移行中です
  (github.com/titaniumnetwork-dev)。新規開発はそちらも検討を。

---

## 8. 参考リンク

- Ultraviolet 本体: https://github.com/titaniumnetwork-dev/Ultraviolet
- 公式デプロイ例: https://github.com/titaniumnetwork-dev/Ultraviolet-App
- フロントエンド例: https://github.com/titaniumnetwork-dev/Ultraviolet-Static
- BareMux: https://github.com/MercuryWorkshop/bare-mux
- Epoxy: https://github.com/MercuryWorkshop/epoxy-transport
- Wisp プロトコル: https://github.com/MercuryWorkshop/wisp-protocol
- wisp-js: https://www.npmjs.com/package/@mercuryworkshop/wisp-js
