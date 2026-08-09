"""Image verifier — Groq vision yes/no assertions against a submitted image.

Item type handled (see agent/schemas.py):
- vision_prompt: {"prompt"}  — phrased so "yes" means the requirement is met

Verdict mapping is mechanical: yes -> pass, no -> fail, unclear (or
unparseable model output) -> needs_human_review. The model never decides
anything beyond the single yes/no question it is asked.
"""
from __future__ import annotations

import httpx

from agent.schemas import ChecklistItem, ItemResult, ItemType, Verdict, VerificationContext
from agent.tools.evidence import try_upload_json
from agent.tools.groq_vision_tools import ask_yes_no

_VERDICTS = {
    "yes": Verdict.PASS,
    "no": Verdict.FAIL,
    "unclear": Verdict.NEEDS_HUMAN_REVIEW,
}


def verify_items(items: list[ChecklistItem],
                 ctx: VerificationContext) -> list[ItemResult]:
    results: list[ItemResult] = []
    for item in items:
        if item.item_type != ItemType.VISION_PROMPT:
            results.append(ItemResult(
                checklist_item_id=item.id, verdict=Verdict.ERROR,
                detail=f"image_verifier cannot handle item_type {item.item_type.value!r}"))
            continue
        try:
            answer = ask_yes_no(ctx.deliverable_url, str(item.params["prompt"]))
            evidence = try_upload_json(ctx, f"item-{item.id}.json", {
                "question": item.params["prompt"],
                "image_url": ctx.deliverable_url,
                **answer,
            })
            results.append(ItemResult(
                checklist_item_id=item.id,
                verdict=_VERDICTS[answer["answer"]],
                detail=answer["reason"] or f"model answered {answer['answer']!r}",
                evidence_storage_path=evidence,
            ))
        except httpx.HTTPError as exc:
            results.append(ItemResult(
                checklist_item_id=item.id, verdict=Verdict.FAIL,
                detail=f"could not fetch deliverable image: {exc.__class__.__name__}: {exc}"))
        except Exception as exc:  # one bad item must not sink the group
            results.append(ItemResult(
                checklist_item_id=item.id, verdict=Verdict.ERROR,
                detail=f"{exc.__class__.__name__}: {exc}"))
    return results
