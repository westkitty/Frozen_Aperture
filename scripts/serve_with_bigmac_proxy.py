#!/usr/bin/env python3
"""
Frozen Aperture — Local Launcher with Same-Origin Big Mac (DexDiffusion / Hunyuan3D) Proxy

Serves Frozen Aperture (index.html) on http://127.0.0.1:8788 and proxies /dex/*
directly to your Big Mac's DexDiffusion server (default: http://big-mac.local:8787)
so Brave/Chrome can upload character cutouts and download Hunyuan3D .glb meshes
with zero CORS issues and zero modifications to westkitty/Image_Gen.

Usage:
  python3 scripts/serve_with_bigmac_proxy.py
  python3 scripts/serve_with_bigmac_proxy.py --target http://192.168.1.50:8787 --port 8788
"""

import argparse
import http.server
import os
import socketserver
import urllib.error
import urllib.request

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class FrozenApertureProxyHandler(http.server.SimpleHTTPRequestHandler):
    bigmac_target = "http://big-mac.local:8787"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT_DIR, **kwargs)

    def _proxy_to_bigmac(self, method):
        rel = self.path[len("/dex"):] or "/"
        upstream_url = self.bigmac_target.rstrip("/") + rel
        length = int(self.headers.get("Content-Length", "0") or "0")
        body = self.rfile.read(length) if length > 0 else None

        fwd_headers = {}
        for h in ("Content-Type", "Accept"):
            val = self.headers.get(h)
            if val:
                fwd_headers[h] = val

        req = urllib.request.Request(upstream_url, data=body, headers=fwd_headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                data = resp.read()
                self.send_response(resp.status)
                ctype = resp.headers.get("Content-Type", "application/octet-stream")
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.HTTPError as e:
            err_body = e.read()
            self.send_response(e.code)
            self.send_header("Content-Type", e.headers.get("Content-Type", "application/json"))
            self.send_header("Content-Length", str(len(err_body)))
            self.end_headers()
            self.wfile.write(err_body)
        except Exception as e:
            msg = ('{"error":"Big Mac unreachable via proxy","detail":"%s"}' % str(e).replace('"', "'")).encode("utf-8")
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)

    def do_GET(self):
        if self.path.startswith("/dex/"):
            return self._proxy_to_bigmac("GET")
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/dex/"):
            return self._proxy_to_bigmac("POST")
        self.send_error(405, "Method Not Allowed")


def main():
    parser = argparse.ArgumentParser(description="Serve Frozen Aperture with Big Mac Hunyuan3D proxy")
    parser.add_argument("--port", type=int, default=8788, help="Local port (default: 8788)")
    parser.add_argument("--target", default="http://big-mac.local:8787", help="Big Mac DexDiffusion URL")
    args = parser.parse_args()

    FrozenApertureProxyHandler.bigmac_target = args.target.rstrip("/")
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("127.0.0.1", args.port), FrozenApertureProxyHandler) as httpd:
        print(f"Frozen Aperture running at http://127.0.0.1:{args.port}/index.html")
        print(f"Proxying /dex/* -> {FrozenApertureProxyHandler.bigmac_target}/*")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")


if __name__ == "__main__":
    main()
