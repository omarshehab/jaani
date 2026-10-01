"""Local mock government portal for the Section 15 compatibility checks (tests only, 127.0.0.1).

  /<slug>/views/info-officers   an RTI page from tests/fixtures (image URLs rewritten to /img/...)
  /img/<name>.jpg               a real JPEG (> 2 KB) for every image
  /slow/views/info-officers     answers after SLOW_SECONDS
  /redirect/views/info-officers 302 to /redirect/ (a homepage without RTI content)
"""
import io
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image

FX = Path(__file__).resolve().parents[1] / 'tests' / 'fixtures'
IMG_RE = re.compile(r'https://objectstorage\.[^"\']+?/([^/"\']+)\.(?:jpe?g|png)')
SLOW_SECONDS = 150


def _jpeg(seed):
    img = Image.new('RGB', (160, 200), color=(seed * 37 % 255, seed * 91 % 255, seed * 53 % 255))
    for x in range(0, 160, 7):
        for y in range(0, 200, 5):
            img.putpixel((x, y), ((x * seed) % 255, (y * 3) % 255, (x + y) % 255))
    b = io.BytesIO()
    img.save(b, format='JPEG', quality=92)
    return b.getvalue()


class Portal:
    def __init__(self, pages):
        """pages: {slug: html}. Use 'fixture:<name>' to load tests/fixtures/html/<name>.html."""
        self.pages = {}
        for slug, html in pages.items():
            if html.startswith('fixture:'):
                name = html.split(':', 1)[1]
                p = FX / 'live' / f'{name}.html' if (FX / 'live' / f'{name}.html').exists() else FX / 'html' / f'{name}.html'
                html = p.read_text(encoding='utf-8')
            self.pages[slug] = html
        self.hits = []
        self.server = None

    def url(self, slug):
        return f'http://127.0.0.1:{self.server.server_port}/{slug}/views/info-officers'

    def start(self):
        portal = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, body=b'', ctype='text/html; charset=utf-8', headers=None):
                self.send_response(code)
                self.send_header('content-type', ctype)
                self.send_header('content-length', str(len(body)))
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                self.end_headers()
                if self.command != 'HEAD':
                    self.wfile.write(body)

            def do_HEAD(self):
                self.do_GET()

            def do_GET(self):
                portal.hits.append(self.path)
                path = self.path.split('?')[0]
                base = f'http://127.0.0.1:{portal.server.server_port}'
                if path.startswith('/img/'):
                    name = path[5:].rsplit('.', 1)[0]
                    if name.startswith('missing'):
                        return self._send(404, b'no')
                    return self._send(200, _jpeg(sum(map(ord, name)) % 97 + 3), 'image/jpeg')
                if path == '/robots.txt':
                    return self._send(404, b'')
                m = re.match(r'^/([^/]+)(/views/info-officers|/?)$', path)
                if not m:
                    return self._send(404, b'<html><body>404</body></html>')
                slug, rest = m.group(1), m.group(2)
                if slug == 'redirect' and rest.startswith('/views'):
                    return self._send(302, b'', headers={'location': f'{base}/redirect/'})
                if rest in ('', '/'):
                    return self._send(200, b'<html><body><h1>Home</h1><p>Welcome</p></body></html>')
                if slug == 'slow':
                    time.sleep(SLOW_SECONDS)
                html = portal.pages.get(slug)
                if html is None:
                    return self._send(404, b'<html><body>404</body></html>')
                html = IMG_RE.sub(lambda mm: f'{base}/img/{slug}-{mm.group(1)}.jpg', html)
                return self._send(200, html.encode('utf-8'))

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self

    def stop(self):
        if self.server:
            self.server.shutdown()
