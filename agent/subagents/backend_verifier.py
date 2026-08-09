"""Backend verifier — literal HTTP assertions against the deliverable API.

Item types handled (see agent/schemas.py):
- http_status: {"path", "method"?, "expected_status"}
- json_field:  {"path", "json_path", "expected"}

No judgment calls: a check is the observed value versus the locked expected
value, nothing else. Response content is captured as evidence data only.
"""
from __future__ import annotations

import json

import httpx

from agent.schemas import ChecklistItem, ItemResult, ItemType, Verdict, VerificationContext
from agent.tools.evidence import try_upload_json
from agent.tools import http_tools


def _check_http_status(item: ChecklistItem, ctx: VerificationContext) -> ItemResult:
    url = http_tools.resolve_url(ctx.deliverable_url, str(item.params["path"]))
    method = str(item.params.get("method", "GET"))
    expected = int(item.params["expected_status"])

    try:
        resp = http_tools.fetch(url, method=method)
    except httpx.HTTPError as exc:
        return ItemResult(
            checklist_item_id=item.id,
            verdict=Verdict.FAIL,
            detail=f"{method} {url} unreachable: {exc.__class__.__name__}: {exc}",
        )

    evidence = try_upload_json(ctx, f"item-{item.id}.json",
                               http_tools.response_summary(resp))
    verdict = Verdict.PASS if resp.status_code == expected else Verdict.FAIL
    return ItemResult(
        checklist_item_id=item.id,
        verdict=verdict,
        detail=f"{method} {url} returned {resp.status_code}, expected {expected}",
        evidence_storage_path=evidence,
    )


def _check_json_field(item: ChecklistItem, ctx: VerificationContext) -> ItemResult:
    url = http_tools.resolve_url(ctx.deliverable_url, str(item.params["path"]))
    json_path = str(item.params["json_path"])
    expected = item.params["expected"]

    try:
        resp = http_tools.fetch(url)
    except httpx.HTTPError as exc:
        return ItemResult(
            checklist_item_id=item.id,
            verdict=Verdict.FAIL,
            detail=f"GET {url} unreachable: {exc.__class__.__name__}: {exc}",
        )

    evidence = try_upload_json(ctx, f"item-{item.id}.json",
                               http_tools.response_summary(resp))
    try:
        data = resp.json()
    except json.JSONDecodeError:
        return ItemResult(
            checklist_item_id=item.id,
            verdict=Verdict.FAIL,
            detail=f"GET {url} did not return valid JSON (status {resp.status_code})",
            evidence_storage_path=evidence,
        )

    found, actual = http_tools.json_path_get(data, json_path)
    if not found:
        detail = f"field '{json_path}' not present in response from {url}"
        verdict = Verdict.FAIL
    elif http_tools.values_equal(actual, expected):
        detail = f"field '{json_path}' == {expected!r}"
        verdict = Verdict.PASS
    else:
        detail = f"field '{json_path}' is {actual!r}, expected {expected!r}"
        verdict = Verdict.FAIL
    return ItemResult(checklist_item_id=item.id, verdict=verdict, detail=detail,
                      evidence_storage_path=evidence)


_CHECKS = {
    ItemType.HTTP_STATUS: _check_http_status,
    ItemType.JSON_FIELD: _check_json_field,
}


def verify_items(items: list[ChecklistItem],
                 ctx: VerificationContext) -> list[ItemResult]:
    results: list[ItemResult] = []
    for item in items:
        check = _CHECKS.get(item.item_type)
        if check is None:
            results.append(ItemResult(
                checklist_item_id=item.id, verdict=Verdict.ERROR,
                detail=f"backend_verifier cannot handle item_type {item.item_type.value!r}"))
            continue
        try:
            results.append(check(item, ctx))
        except Exception as exc:  # one bad item must not sink the group
            results.append(ItemResult(
                checklist_item_id=item.id, verdict=Verdict.ERROR,
                detail=f"{exc.__class__.__name__}: {exc}"))
    return results
