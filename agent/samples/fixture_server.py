"""A stand-in deliverable, so the verifiers can be built and tested standalone.

This is the "fixed sample deliverable" the four-way split calls for: it lets task
3 be developed and proven before the Planner, the orchestrator or any Gravv code
exists. It serves both shapes a verifier cares about -- a JSON API and static
HTML pages -- from one throwaway server on an ephemeral port.

Nothing here ships to production; it exists for `agent/tests` and for
`python -m agent.run_subagent --demo`.
"""

from __future__ import annotations

import io
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

PAGES_DIR = os.path.join(os.path.dirname(__file__), "frontend")


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # -- helpers --------------------------------------------------------------

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Powered-By", "gigsflow-fixture")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, payload: Any) -> None:
        self._send(status, json.dumps(payload).encode(), "application/json")

    def _page(self, name: str) -> None:
        path = os.path.join(PAGES_DIR, name)
        if not os.path.isfile(path):
            self._send(404, b"not found", "text/plain")
            return
        with open(path, "rb") as handle:
            self._send(200, handle.read(), "text/html; charset=utf-8")

    def log_message(self, *args: Any) -> None:  # silence per-request stderr noise
        return

    # -- routes ---------------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler naming
        path = self.path.split("?")[0]

        if path == "/health":
            self._json(200, {"status": "ok", "version": "1.0.0", "uptime_seconds": 42})
        elif path == "/users":
            self._json(
                200,
                {
                    "users": [
                        {"id": 1, "name": "Ada", "roles": ["admin", "owner"]},
                        {"id": 2, "name": "Grace", "roles": ["member"]},
                    ],
                    "total": 2,
                },
            )
        elif path == "/slow":
            time.sleep(0.6)
            self._json(200, {"status": "eventually"})
        elif path == "/not-json":
            self._send(200, b"plain text, not JSON at all", "text/plain")
        elif path == "/missing":
            self._json(404, {"error": "not found"})
        elif path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "/health")
            self.send_header("Content-Length", "0")
            self.end_headers()
        elif path.startswith("/pages/"):
            self._page(os.path.basename(path))
        elif path.startswith("/image/"):
            self._image(os.path.basename(path))
        else:
            self._json(404, {"error": "no such route"})

    def _image(self, name: str) -> None:
        """Generate sample image deliverables on the fly, so no binaries live in git."""
        from PIL import Image  # imported lazily: only the test fixture needs Pillow

        specs = {
            "ok.png": ((800, 600), "PNG", "image/png", (32, 64, 128)),
            "small.png": ((100, 80), "PNG", "image/png", (200, 30, 30)),
            "photo.jpg": ((400, 300), "JPEG", "image/jpeg", (240, 200, 120)),
        }
        if name == "not-an-image":
            self._send(200, b"this is definitely not an image", "text/plain")
            return
        if name not in specs:
            self._json(404, {"error": "no such image"})
            return

        size, fmt, content_type, colour = specs[name]
        buffer = io.BytesIO()
        Image.new("RGB", size, colour).save(buffer, format=fmt)
        self._send(200, buffer.getvalue(), content_type)

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            payload = {"_raw": raw.decode("utf-8", errors="replace")}

        if self.path.split("?")[0] == "/echo":
            self._json(201, {"received": payload, "created": True})
        else:
            self._json(404, {"error": "no such route"})


def start_fixture_server() -> tuple[str, Callable[[], None]]:
    """Start the fixture on an ephemeral port. Returns (base_url, shutdown)."""
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    host, port = server.server_address[:2]
    base_url = f"http://{host}:{port}"

    def shutdown() -> None:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    return base_url, shutdown
