#!/usr/bin/env python3
"""Static server for development.

Two differences from `python3 -m http.server`:

1. It forbids caching. The plain version lets browsers hold on to stale ES
   modules, which turns editing a module into "why is my change not there?"
   every single time.

2. It accepts a PUT into `calibration/`, so the page can drop a rendered
   stimulus straight next to the capture it is about to be compared with
   instead of going through the downloads folder. Development only — the
   published site is static and the page falls back to a download there.
"""

import argparse
import http.server
import os
import re
import posixpath

# Renders land here and nowhere else.
SAVE_DIR = 'calibration'
SAFE_NAME = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.wav$')
MAX_BYTES = 256 * 1024 * 1024


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        if '200' not in fmt % args:
            super().log_message(fmt, *args)

    def do_PUT(self):
        """Save a WAV into calibration/. Local, dev-only, and deliberately narrow."""
        # Bound to localhost by default, but check anyway rather than relying
        # on how it happened to be started.
        if self.client_address[0] not in ('127.0.0.1', '::1'):
            return self.send_error(403, 'local requests only')

        parts = posixpath.normpath(self.path.lstrip('/')).split('/')
        if len(parts) != 2 or parts[0] != SAVE_DIR or not SAFE_NAME.match(parts[1]):
            return self.send_error(403, f'only {SAVE_DIR}/<name>.wav')

        try:
            length = int(self.headers.get('Content-Length', 0))
        except ValueError:
            return self.send_error(400, 'bad Content-Length')
        if length <= 0 or length > MAX_BYTES:
            return self.send_error(413, 'bad length')

        target = os.path.join(self.directory, SAVE_DIR, parts[1])
        os.makedirs(os.path.dirname(target), exist_ok=True)
        remaining = length
        with open(target, 'wb') as f:
            while remaining > 0:
                chunk = self.rfile.read(min(1 << 20, remaining))
                if not chunk:
                    break
                f.write(chunk)
                remaining -= len(chunk)

        body = f'{SAVE_DIR}/{parts[1]}'.encode()
        self.send_response(201)
        self.send_header('Content-Type', 'text/plain')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        super().log_message('"PUT %s" 201 %d bytes', self.path, length)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('port', nargs='?', type=int, default=8795)
    ap.add_argument('--directory', default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    args = ap.parse_args()

    os.chdir(args.directory)
    server = http.server.ThreadingHTTPServer(('127.0.0.1', args.port), NoCacheHandler)
    print(f'amp: serving {args.directory} on http://localhost:{args.port}')
    server.serve_forever()


if __name__ == '__main__':
    main()
