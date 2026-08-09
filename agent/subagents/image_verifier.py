"""Image verifier -- checks a submitted image against locked assertions.

Deliverable shape: a URL serving an image.

This is the one verifier that uses a model, and it splits its work in two on
purpose:

* `image_dimensions` and `image_format` are answered by Pillow. Asking a vision
  model whether an image is 1920 pixels wide would be slower, cost money, and be
  less reliable than reading the header. Anything a library can decide, a library
  decides.
* `vision_prompt` and `vision_text_present` go to the model, because "does this
  logo appear on a transparent background" has no deterministic implementation.

Where the model is used, an inconclusive or low-confidence answer becomes
`needs_human_review` -- an explicit hand-off to the client, not a coin flip.
"""

from __future__ import annotations

import io
import os
import re
from typing import Any

from PIL import Image, UnidentifiedImageError

from agent.assertions import (
    ImageDimensions,
    ImageFormat,
    VisionPrompt,
    VisionTextPresent,
)
from agent.config import MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS
from agent.subagents.base import all_error, describe_exception, items_for, run_items
from agent.tools.groq_vision_tools import VisionAnswer, ask_image
from agent.tools.http_tools import GuardedHttpClient
from agent.security.url_guard import assert_url_allowed
from agent.verification_types import (
    ChecklistItem,
    DeliverableContext,
    Evidence,
    VerificationResult,
    Verdict,
)

SUB_AGENT = "image_verifier"

# Pillow will refuse to decode beyond this, which is what stops a 400-byte PNG
# that declares 60000x60000 pixels from exhausting sandbox memory on decode.
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS

_FORMAT_ALIASES = {"jpg": "jpeg", "mpo": "jpeg"}


def run(
    items: list[ChecklistItem], ctx: DeliverableContext
) -> list[VerificationResult]:
    """Verify every image checklist item against `ctx.deliverable_url`."""
    mine = items_for(items, SUB_AGENT)
    if not mine:
        return []

    try:
        assert_url_allowed(ctx.deliverable_url)
        with GuardedHttpClient() as client:
            # Downloaded once and reused: every assertion, deterministic and
            # model-backed alike, judges the same bytes.
            data, content_type = client.download(ctx.deliverable_url, MAX_IMAGE_BYTES)
    except Exception as exc:  # noqa: BLE001 - a failed download sinks every item
        return all_error(mine, describe_exception(exc))

    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except (UnidentifiedImageError, OSError) as exc:
        return all_error(
            mine,
            f"the deliverable at {ctx.deliverable_url} is not a decodable image ({exc})",
        )

    saved = _save_evidence_copy(data, image.format, ctx.evidence_dir)
    shared = Evidence(
        kind="image_meta",
        media_type=f"image/{(image.format or 'png').lower()}",
        local_path=saved,
        inline={
            "width": image.width,
            "height": image.height,
            "format": (image.format or "").lower(),
            "mode": image.mode,
            "content_type": content_type,
            "bytes": len(data),
        },
    )

    return run_items(
        mine, SUB_AGENT, _dispatcher(image, data, content_type, shared)
    )


def _save_evidence_copy(data: bytes, fmt: str | None, evidence_dir: str) -> str:
    os.makedirs(evidence_dir, exist_ok=True)
    extension = re.sub(r"[^a-z0-9]", "", (fmt or "png").lower()) or "png"
    path = os.path.join(evidence_dir, f"deliverable.{extension}")
    with open(path, "wb") as handle:
        handle.write(data)
    return path


def _dispatcher(image: Image.Image, data: bytes, content_type: str, shared: Evidence):
    def dispatch(item: ChecklistItem, assertion):
        if isinstance(assertion, ImageDimensions):
            return _dimensions(image, assertion, [shared])
        if isinstance(assertion, ImageFormat):
            return _format(image, assertion, [shared])
        if isinstance(assertion, VisionPrompt):
            return _vision(data, content_type, assertion.prompt, assertion.expect, shared)
        if isinstance(assertion, VisionTextPresent):
            question = (
                f'Is the text "{assertion.text}" clearly visible and legible '
                "somewhere in this image?"
            )
            return _vision(data, content_type, question, "yes", shared)

        raise NotImplementedError(
            f"{SUB_AGENT} has no handler for {type(assertion).__name__}"
        )

    return dispatch


def _dimensions(image: Image.Image, assertion: ImageDimensions, evidence):
    problems: list[str] = []
    if assertion.min_width is not None and image.width < assertion.min_width:
        problems.append(f"width {image.width}px is under the {assertion.min_width}px minimum")
    if assertion.min_height is not None and image.height < assertion.min_height:
        problems.append(
            f"height {image.height}px is under the {assertion.min_height}px minimum"
        )
    if assertion.exact_width is not None and image.width != assertion.exact_width:
        problems.append(f"width is {image.width}px, required exactly {assertion.exact_width}px")
    if assertion.exact_height is not None and image.height != assertion.exact_height:
        problems.append(
            f"height is {image.height}px, required exactly {assertion.exact_height}px"
        )

    if problems:
        return Verdict.FAIL, "; ".join(problems), evidence
    return (
        Verdict.PASS,
        f"image is {image.width}x{image.height}px, satisfying the size requirement",
        evidence,
    )


def _format(image: Image.Image, assertion: ImageFormat, evidence):
    actual = (image.format or "").lower()
    actual = _FORMAT_ALIASES.get(actual, actual)
    if actual in assertion.allowed:
        return Verdict.PASS, f"image format is {actual}, which is allowed", evidence
    return (
        Verdict.FAIL,
        f"image format is {actual or 'unrecognised'}, "
        f"allowed formats are: {', '.join(assertion.allowed)}",
        evidence,
    )


def _vision(
    data: bytes, content_type: str, question: str, expect: str, shared: Evidence
):
    """Ask the model one closed question and map its answer onto a verdict.

    The model returns yes / no / unclear. What counts as passing was fixed by the
    Planner in `expect`, so the model never chooses the outcome -- only the fact.
    """
    answer: VisionAnswer = ask_image(data, content_type or "image/png", question)
    evidence = [
        shared,
        Evidence(
            kind="vision_response",
            media_type="application/json",
            inline=answer.to_evidence(question),
        ),
    ]

    if not answer.is_conclusive:
        return (
            Verdict.NEEDS_HUMAN_REVIEW,
            f"the vision check could not answer confidently "
            f"(answer={answer.answer}, confidence={answer.confidence:.2f}): {answer.reason}",
            evidence,
        )

    verdict = Verdict.PASS if answer.answer == expect else Verdict.FAIL
    return (
        verdict,
        f"asked: {question} -- answered {answer.answer} "
        f"(confidence {answer.confidence:.2f}); expected {expect}. {answer.reason}",
        evidence,
    )
