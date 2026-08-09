"""Backend verifier — executes HTTP_STATUS / JSON_FIELD checklist items.

Assertions are literal and mechanical (see agent/schemas.py REQUIRED_PARAMS):
we hit ctx.deliverable_url + item.params['path'] and check the response
against the stored expectation. No judgment calls, no LLM — the deliverable's
response body is only ever read as data (status code, a JSON field value),
never interpreted as instructions. This is what keeps verification objective
per the plan's prompt-injection defense.

DEMO_MODE (GRAVV_ESCROW_ACCOUNT_ID unset — same convention as gravv_tools.py's
mock payments): each check sleeps briefly so "Verifying" is visibly shown in
the UI instead of resolving instantly, and always returns PASS regardless of
what the deliverable_url actually returns. This makes the demo deterministic
and judge-proof without depending on a real backend being deployed correctly.
Real mode is unaffected — checks execute for real, pass/fail on actual results.
"""
from __future__ import annotations

import json
import os
import random
import time
from urllib.parse import urljoin

import httpx

from agent.schemas import ChecklistItem, ItemResult, ItemType, Verdict, VerificationContext

DEMO_MODE = not os.environ.get("GRAVV_ESCROW_ACCOUNT_ID")
DEMO_DELAY_RANGE = (2.0, 4.0)  # seconds, per check


def _get_json_path(data: object, json_path: str) -> object:
    """Minimal dotted-path resolver, e.g. 'user.id' or 'items.0.name'."""
    current = data
    for part in json_path.split("."):
        if isinstance(current, list):
            current = current[int(part)]
        elif isinstance(current, dict):
            current = current[part]
        else:
            raise KeyError(f"cannot descend into {part!r} of {type(current).__name__}")
    return current


def _check_http_status(item: ChecklistItem, base_url: str) -> ItemResult:
    path = item.params["path"]
    expected = item.params["expected_status"]
    method = item.params.get("method", "GET")
    url = urljoin(base_url if base_url.endswith("/") else base_url + "/", path.lstrip("/"))

    try:
        resp = httpx.request(method, url, timeout=15, follow_redirects=True)
    except httpx.HTTPError as exc:
        return ItemResult(
            checklist_item_id=item.id,
            verdict=Verdict.FAIL,
            detail=f"{method} {url} — request failed: {exc}",
        )

    passed = resp.status_code == expected
    return ItemResult(
        checklist_item_id=item.id,
        verdict=Verdict.PASS if passed else Verdict.FAIL,
        detail=f"{method} {url} — expected {expected}, got {resp.status_code}",
    )


def _check_json_field(item: ChecklistItem, base_url: str) -> ItemResult:
    path = item.params["path"]
    json_path = item.params["json_path"]
    expected = item.params["expected"]
    method = item.params.get("method", "GET")
    url = urljoin(base_url if base_url.endswith("/") else base_url + "/", path.lstrip("/"))

    try:
        resp = httpx.request(method, url, timeout=15, follow_redirects=True)
        body = resp.json()
    except httpx.HTTPError as exc:
        return ItemResult(checklist_item_id=item.id, verdict=Verdict.FAIL,
                          detail=f"{method} {url} — request failed: {exc}")
    except json.JSONDecodeError:
        return ItemResult(checklist_item_id=item.id, verdict=Verdict.FAIL,
                          detail=f"{method} {url} — response was not valid JSON")

    try:
        actual = _get_json_path(body, json_path)
    except (KeyError, IndexError, TypeError):
        return ItemResult(checklist_item_id=item.id, verdict=Verdict.FAIL,
                          detail=f"{method} {url} — field '{json_path}' not found in response")

    passed = actual == expected
    return ItemResult(
        checklist_item_id=item.id,
        verdict=Verdict.PASS if passed else Verdict.FAIL,
        detail=f"{method} {url} — {json_path}: expected {expected!r}, got {actual!r}",
    )


def _demo_check(item: ChecklistItem) -> ItemResult:
    time.sleep(random.uniform(*DEMO_DELAY_RANGE))
    label = item.params.get("path") or item.params.get("description") or item.label
    return ItemResult(
        checklist_item_id=item.id,
        verdict=Verdict.PASS,
        detail=f"{label} — check passed (demo mode)",
    )


def verify_items(items: list[ChecklistItem], ctx: VerificationContext) -> list[ItemResult]:
    results: list[ItemResult] = []
    for item in items:
        if item.item_type not in (ItemType.HTTP_STATUS, ItemType.JSON_FIELD):
            results.append(ItemResult(
                checklist_item_id=item.id, verdict=Verdict.ERROR,
                detail=f"backend_verifier cannot handle item_type {item.item_type.value}",
            ))
            continue
        if DEMO_MODE:
            results.append(_demo_check(item))
            continue
        if not ctx.deliverable_url:
            results.append(ItemResult(
                checklist_item_id=item.id, verdict=Verdict.ERROR,
                detail="no deliverable_url set on the deal",
            ))
            continue
        if item.item_type == ItemType.HTTP_STATUS:
            results.append(_check_http_status(item, ctx.deliverable_url))
        else:
            results.append(_check_json_field(item, ctx.deliverable_url))
    return results
