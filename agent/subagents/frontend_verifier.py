"""Frontend verifier — Playwright assertions against the deliverable site.

Item types handled (see agent/schemas.py):
- page_loads:     {"path"?}
- element_exists: {"selector", "path"?}
- text_present:   {"text", "path"?}
- console_clean:  {"path"?}

Each distinct path is loaded once; its full-page screenshot is uploaded once
and shared as evidence by every item checked against that page.
"""
from __future__ import annotations

import re

from agent.schemas import ChecklistItem, ItemResult, ItemType, Verdict, VerificationContext
from agent.tools.evidence import try_upload
from agent.tools.playwright_tools import PageSession, PageState


def _safe_name(path: str) -> str:
    return re.sub(r"[^a-zA-Z0-9._-]+", "_", path or "index") or "index"


def _check(item: ChecklistItem, state: PageState) -> tuple[Verdict, str]:
    if state.load_error:
        return Verdict.FAIL, f"page failed to load ({state.url}): {state.load_error}"

    if item.item_type == ItemType.PAGE_LOADS:
        if state.status is not None and state.status < 400:
            return Verdict.PASS, f"{state.url} loaded with status {state.status}"
        return Verdict.FAIL, f"{state.url} responded with status {state.status}"

    if item.item_type == ItemType.ELEMENT_EXISTS:
        selector = str(item.params["selector"])
        try:
            found = state.page.query_selector(selector) is not None
        except Exception as exc:
            return Verdict.ERROR, f"invalid selector {selector!r}: {exc}"
        return ((Verdict.PASS, f"selector {selector!r} present on {state.url}")
                if found else
                (Verdict.FAIL, f"selector {selector!r} not found on {state.url}"))

    if item.item_type == ItemType.TEXT_PRESENT:
        text = str(item.params["text"])
        body = state.page.inner_text("body")
        if text.lower() in body.lower():
            return Verdict.PASS, f"text {text!r} visible on {state.url}"
        return Verdict.FAIL, f"text {text!r} not found in visible text of {state.url}"

    if item.item_type == ItemType.CONSOLE_CLEAN:
        if not state.console_errors:
            return Verdict.PASS, f"no console errors on {state.url}"
        sample = "; ".join(state.console_errors[:3])
        return (Verdict.FAIL,
                f"{len(state.console_errors)} console error(s) on {state.url}: {sample}")

    return Verdict.ERROR, f"frontend_verifier cannot handle {item.item_type.value!r}"


def verify_items(items: list[ChecklistItem],
                 ctx: VerificationContext) -> list[ItemResult]:
    session = PageSession(ctx.deliverable_url)
    screenshots: dict[str, str] = {}
    results: list[ItemResult] = []
    try:
        for item in items:
            path = str(item.params.get("path", "") or "")
            try:
                state = session.load(path)
                if path not in screenshots:
                    screenshots[path] = (
                        try_upload(ctx, f"page-{_safe_name(path)}.png",
                                   state.screenshot, "image/png")
                        if state.screenshot else "")
                verdict, detail = _check(item, state)
                results.append(ItemResult(
                    checklist_item_id=item.id,
                    verdict=verdict,
                    detail=detail,
                    evidence_storage_path=screenshots.get(path, ""),
                ))
            except Exception as exc:  # one bad item must not sink the group
                results.append(ItemResult(
                    checklist_item_id=item.id, verdict=Verdict.ERROR,
                    detail=f"{exc.__class__.__name__}: {exc}"))
    finally:
        session.close()
    return results
