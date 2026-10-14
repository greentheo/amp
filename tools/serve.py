#!/usr/bin/env python3
"""Static server for development.

Identical to `python3 -m http.server` except that it forbids caching. The
plain version lets browsers hold on to stale ES modules, which turns editing
a module into "why is my change not there?" every single time.
"""

import argparse
import http.server
import os


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        if '200' not in fmt % args:
            super().log_message(fmt, *args)


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
