"""Evidence upload helpers shared by the verifier sub-agents.

Uploads are best-effort: a missing Storage bucket must never change a
verdict, so failures are swallowed (logged to stderr) and the result simply
carries no evidence path.
"""
from __future__ import annotations

import json
import sys

from agent.schemas import VerificationContext


def try_upload(ctx: VerificationContext, filename: str, data: bytes,
               content_type: str) -> str:
    try:
        return ctx.upload_evidence(filename, data, content_type)
    except Exception as exc:
        print(f"evidence upload failed for {filename}: {exc}", file=sys.stderr)
        return ""


def try_upload_json(ctx: VerificationContext, filename: str, payload: dict) -> str:
    body = json.dumps(payload, indent=2, default=str).encode()
    return try_upload(ctx, filename, body, "application/json")
