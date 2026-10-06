#!/usr/bin/env python3
"""Local signature verifier. This does not bypass the host network policy."""
import argparse
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path


def verify(key, body, signature):
    if not signature.isascii() or len(signature) != 71:
        return False
    expected = "sha256=" + hmac.new(key, b"pirs-commit-v1\n" + body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    key = bytes.fromhex(json.loads(args.config.read_text())["key"])
    assert len(key) == 32

    class Receiver(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            self.connection.settimeout(2)
            try:
                size = int(self.headers.get("content-length", "-1"))
                if self.path != "/notice" or not 0 < size <= 16384:
                    raise ValueError("invalid request")
                body = self.rfile.read(size)
                if len(body) != size or not verify(key, body, self.headers.get("x-pirs-signature", "")):
                    raise ValueError("invalid signature")
                notice = json.loads(body)
                # Only print receipt metadata, never keys or record data.
                print(json.dumps({"verified": True, "seq": notice["seq"], "rev": notice["rev"]}), flush=True)
                self.send_response(204)
            except (ValueError, KeyError, OSError):
                self.send_response(400)
            self.end_headers()

    print(json.dumps({"local_receiver": "127.0.0.1", "port": args.port}), flush=True)
    HTTPServer(("127.0.0.1", args.port), Receiver).serve_forever()


if __name__ == "__main__":
    main()
