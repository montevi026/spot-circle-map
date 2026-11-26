// サービスワーカー: アプリとしてのインストールと、スマホの通知欄への通知に使う。
// このサイトのファイルは「ネットワーク優先・失敗したらキャッシュ」で返す
// （常に最新のデータを使い、電波が無いときだけ前回の内容を表示する）。
const CACHE = 'scm-v2';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // 他サイト（地図タイル・検索）とローカル編集用 API は素通し
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  e.respondWith(
    // ブラウザの HTTP キャッシュ（GitHub Pages は 10 分）を使わず、毎回サーバーに更新を確認する
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => (cs[0] ? cs[0].focus() : self.clients.openWindow('./'))));
});
