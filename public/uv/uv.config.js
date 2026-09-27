// UV の設定ファイル (ブラウザー側で読み込まれます)
self.__uv$config = {
  // プロキシ済み URL が置かれるパス (この配下が Service Worker の制御範囲)
  prefix: "/uv/service/",
  // URL の難読化コーデック (xor / base32 が利用可能)
  encodeUrl: Ultraviolet.codec.xor.encode,
  decodeUrl: Ultraviolet.codec.xor.decode,
  handler: "/uv/uv.handler.js",
  client: "/uv/uv.client.js",
  bundle: "/uv/uv.bundle.js",
  config: "/uv/uv.config.js",
  sw: "/uv/uv.sw.js",
};
