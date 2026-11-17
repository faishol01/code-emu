#!/usr/bin/env python3
"""Serve this folder for local use, with the headers cpp.wasm's interactive mode needs.

Usage: python3 serve.py [port]    (default port 8000)
"""
import http.server
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".js": "text/javascript",
    }

    def end_headers(self):
        # Cross-origin isolation: lets the page use SharedArrayBuffer, which
        # interactive mode needs to pause the program while you type.
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()


os.chdir(os.path.dirname(os.path.abspath(__file__)))
print(f"cpp.wasm running at http://localhost:{PORT}/  (Ctrl+C to stop)")
http.server.ThreadingHTTPServer(("", PORT), Handler).serve_forever()
