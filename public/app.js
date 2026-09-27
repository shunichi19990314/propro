"use strict";
// フロントエンドのロジック: フォーム送信 → SW 登録 → トランスポート設定 → iframe で開く
const form = document.getElementById("uv-form");
const address = document.getElementById("uv-address");
const error = document.getElementById("uv-error");
const errorCode = document.getElementById("uv-error-code");
const frame = document.getElementById("uv-frame");

// 検索エンジン風テンプレート (入力が URL でないときに使う)
const searchEngine = "https://www.google.com/search?q=%s";

function resolveUrl(input) {
  try {
    // "http://" などが付いていればそのまま、そうでなければ補完
    const url = new URL(input.includes("://") ? input : `https://${input}`);
    return url.href;
  } catch {
    return searchEngine.replace("%s", encodeURIComponent(input));
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.textContent = "";
  errorCode.textContent = "";

  try {
    await registerSW();
  } catch (err) {
    error.textContent = "Service Worker の登録に失敗しました。";
    errorCode.textContent = err.toString();
    return;
  }

  // BareMux 経由でトランスポート (通信経路) を Epoxy/WISP に設定
  const connection = new BareMux.BareMuxConnection("/baremux/worker.js");
  const wispUrl =
    (location.protocol === "https:" ? "wss" : "ws") +
    "://" +
    location.host +
    "/wisp/";
  if ((await connection.getTransport()) !== "/epoxy/index.mjs") {
    await connection.setTransport("/epoxy/index.mjs", [{ wisp: wispUrl }]);
  }

  // プロキシ済み URL = prefix + エンコード済み URL
  frame.src = __uv$config.prefix + __uv$config.encodeUrl(resolveUrl(address.value));
  frame.style.display = "block";
});
