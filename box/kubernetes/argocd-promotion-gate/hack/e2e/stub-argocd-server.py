#!/usr/bin/env python3
"""Stand-in for the one Argo CD endpoint the gate calls.

Only managed-resources matters, because that is where the images a pending sync
would deploy come from. Everything else about Argo CD is irrelevant to the tag
comparison, so faking this one route keeps the test honest without an install.

The desired tag is whatever DESIRED_TAG says, so a run can flip between a match
and a mismatch without touching the fixtures.
"""

import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

PORT = int(os.environ.get("PORT", "18081"))
TOKEN = os.environ.get("TOKEN", "stub-token")
REPOSITORY = os.environ.get("REPOSITORY", "ghcr.io/stefanprodan/podinfo")
DESIRED_TAG = os.environ.get("DESIRED_TAG", "6.7.0")


def deployment(image):
    return {
        "apiVersion": "apps/v1",
        "kind": "Deployment",
        "metadata": {"name": "podinfo"},
        "spec": {"template": {"spec": {"containers": [{"name": "podinfo", "image": image}]}}},
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        parsed = urlparse(self.path)
        if "/managed-resources" not in parsed.path:
            self.send_error(404, "only managed-resources is stubbed")
            return

        # The gate must send its bearer token. A stub that accepts anything
        # would hide a broken credential path.
        if self.headers.get("Authorization") != f"Bearer {TOKEN}":
            self.send_error(401, "missing or wrong bearer token")
            return

        kind = parse_qs(parsed.query).get("kind", [""])[0]
        items = []
        if kind == "Deployment":
            items = [{"targetState": json.dumps(deployment(f"{REPOSITORY}:{DESIRED_TAG}"))}]

        body = json.dumps({"items": items}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


if __name__ == "__main__":
    print(f"stub argocd api on :{PORT} serving {REPOSITORY}:{DESIRED_TAG}", flush=True)
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
