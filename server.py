"""ローカル編集用サーバー（Python 標準ライブラリのみ）

    python server.py            # http://localhost:8000 を開く
    python server.py 8080       # ポート指定

このサーバー経由でアクセスしたときだけ編集機能が有効になります。
docs/ フォルダは GitHub Pages で公開され、そちらは閲覧専用になります。
編集後は画面の「公開サイトへアップロード」ボタン（または publish.bat）で反映します。
"""
import http.server
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from datetime import datetime

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(BASE, "docs")
DATA = os.path.join(ROOT, "data", "events.json")
HOST = "127.0.0.1"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
ALLOWED_HOSTS = {f"localhost:{PORT}", f"127.0.0.1:{PORT}"}


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def validate(data):
    if not isinstance(data, dict) or not isinstance(data.get("events"), list):
        raise ValueError("events が配列ではありません")
    for e in data["events"]:
        if not isinstance(e.get("id"), str) or not isinstance(e.get("name"), str):
            raise ValueError("イベントの id / name が不正です")
        if not _num(e.get("defaultRadius")) or e["defaultRadius"] <= 0:
            raise ValueError(f"イベント「{e['name']}」の defaultRadius が不正です")
        if not isinstance(e.get("spots"), list):
            raise ValueError(f"イベント「{e['name']}」の spots が配列ではありません")
        for s in e["spots"]:
            if not isinstance(s.get("id"), str) or not isinstance(s.get("name"), str):
                raise ValueError("スポットの id / name が不正です")
            if not (_num(s.get("lat")) and -90 <= s["lat"] <= 90 and
                    _num(s.get("lng")) and -180 <= s["lng"] <= 180):
                raise ValueError(f"スポット「{s['name']}」の座標が不正です")
            if not _num(s.get("radius")) or s["radius"] <= 0:
                raise ValueError(f"スポット「{s['name']}」の radius が不正です")


# ---------- GitHub Pages へのアップロード（git commit & push） ----------
class PublishError(Exception):
    pass


PUBLISH_LOCK = threading.Lock()


def git(*args, check=True):
    try:
        r = subprocess.run(
            ["git", "-c", "core.quotepath=false", *args], cwd=BASE,
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120,
        )
    except FileNotFoundError:
        raise PublishError("git が見つかりません")
    except subprocess.TimeoutExpired:
        raise PublishError(f"git {args[0]} がタイムアウトしました")
    if check and r.returncode != 0:
        raise PublishError(f"git {args[0]} に失敗しました:\n{(r.stderr or r.stdout).strip()}")
    return r.stdout.strip()


def pages_url():
    """origin の URL から https://<user>.github.io/<repo>/ を組み立てる"""
    url = git("remote", "get-url", "origin", check=False)
    m = re.search(r"github\.com[:/]([^/]+)/([^/]+?)(?:\.git)?$", url)
    return f"https://{m.group(1).lower()}.github.io/{m.group(2)}/" if m else None


def publish_status():
    if not os.path.isdir(os.path.join(BASE, ".git")):
        return {"available": False, "reason": "git リポジトリが未設定です"}
    pending = bool(git("status", "--porcelain", "--", "docs", check=False))
    # まだ push していないコミットがあるか
    ahead = git("rev-list", "--count", "@{u}..HEAD", check=False)
    return {"available": True, "pending": pending or (ahead.isdigit() and int(ahead) > 0),
            "url": pages_url()}


def publish():
    if not PUBLISH_LOCK.acquire(blocking=False):
        raise PublishError("アップロード処理が実行中です")
    try:
        git("add", "--", "docs")
        committed = False
        if git("diff", "--cached", "--name-only", check=False):
            git("commit", "-m", f"データ更新 {datetime.now():%Y-%m-%d %H:%M}")
            committed = True
        git("push", "origin", "HEAD")
        return {"ok": True, "committed": committed, "url": pages_url()}
    finally:
        PUBLISH_LOCK.release()


# ---------- Google マップ短縮リンクの展開 ----------
SHORT_HOSTS = {"maps.app.goo.gl", "goo.gl", "g.co"}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def resolve_short_url(url):
    """短縮リンクのリダイレクトを辿り、Google 側の最終 URL を返す（本文は取得しない）"""
    opener = urllib.request.build_opener(_NoRedirect)
    for _ in range(5):
        u = urllib.parse.urlsplit(url)
        if u.scheme not in ("http", "https") or u.hostname not in SHORT_HOSTS:
            return url
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "Mozilla/5.0"})
        try:
            opener.open(req, timeout=10)
            return url  # リダイレクトしなかった
        except urllib.error.HTTPError as e:
            loc = e.headers.get("Location")
            if e.code not in (301, 302, 303, 307, 308) or not loc:
                raise ValueError(f"短縮リンクを展開できませんでした (HTTP {e.code})")
            url = urllib.parse.urljoin(url, loc)
        except (urllib.error.URLError, TimeoutError) as e:
            raise ValueError(f"短縮リンクを展開できませんでした: {e}")
    return url


class Handler(http.server.SimpleHTTPRequestHandler):
    # Windows のレジストリ次第で .js が text/plain になるのを防ぐ
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "application/javascript",
        ".json": "application/json",
        ".css": "text/css",
        ".html": "text/html; charset=utf-8",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _host_ok(self):
        # DNS リバインディング対策: Host ヘッダーがローカルのものだけ許可
        return self.headers.get("Host", "") in ALLOWED_HOSTS

    def _origin_ok(self):
        # 他サイトからの POST（CSRF）対策: Origin があればローカルのものだけ許可し、
        # JSON 指定を必須にしてブラウザのプリフライト（このサーバーは応答しない）を強制する
        origin = self.headers.get("Origin")
        if origin and origin.split("://", 1)[-1] not in ALLOWED_HOSTS:
            return False
        return self.headers.get("Content-Type", "").startswith("application/json")

    def do_GET(self):
        path = self.path.split("?")[0]
        if path.startswith("/api/") and not self._host_ok():
            return self._json(403, {"error": "forbidden"})
        if path == "/api/status":
            return self._json(200, {"edit": True})
        if path == "/api/publish":
            return self._json(200, publish_status())
        super().do_GET()

    def do_POST(self):
        if self.path not in ("/api/publish", "/api/resolve-url"):
            return self._json(404, {"error": "not found"})
        if not (self._host_ok() and self._origin_ok()):
            return self._json(403, {"error": "forbidden"})
        if self.path == "/api/resolve-url":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                url = json.loads(self.rfile.read(length).decode("utf-8")).get("url", "")
                if urllib.parse.urlsplit(url).hostname not in SHORT_HOSTS:
                    raise ValueError("対応していない短縮リンクです")
                return self._json(200, {"url": resolve_short_url(url)})
            except (ValueError, AttributeError) as ex:
                return self._json(400, {"error": str(ex)})
        try:
            self._json(200, publish())
        except PublishError as ex:
            self._json(500, {"error": str(ex)})

    def do_PUT(self):
        if self.path != "/api/data":
            return self._json(404, {"error": "not found"})
        if not self._host_ok():
            return self._json(403, {"error": "forbidden"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            data = json.loads(self.rfile.read(length).decode("utf-8"))
            validate(data)
        except (ValueError, UnicodeDecodeError) as ex:
            return self._json(400, {"error": str(ex)})

        os.makedirs(os.path.dirname(DATA), exist_ok=True)
        if os.path.exists(DATA):
            shutil.copyfile(DATA, DATA + ".bak")
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(DATA), suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp, DATA)
        self._json(200, {"ok": True})


def main():
    url = f"http://localhost:{PORT}/"
    with http.server.ThreadingHTTPServer((HOST, PORT), Handler) as httpd:
        print(f"編集モードで起動しました: {url}  (Ctrl+C で終了)")
        webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n終了します")


if __name__ == "__main__":
    main()
