"""Image verifier: deterministic checks run for real, model-backed checks run
against a stubbed vision call so the suite needs no API key and no network."""

from __future__ import annotations

from typing import Callable

import pytest

from agent.subagents import image_verifier
from agent.tools.groq_vision_tools import VisionAnswer, VisionUnavailableError
from agent.verification_types import Verdict

SUB = "image_verifier"


def _stub_vision(monkeypatch: pytest.MonkeyPatch, answer: VisionAnswer) -> None:
    monkeypatch.setattr(
        image_verifier, "ask_image", lambda data, media_type, question: answer
    )


# --- deterministic checks ----------------------------------------------------


def test_dimensions_pass_and_fail(
    fixture_server: str, make_ctx: Callable, make_item: Callable
) -> None:
    item = make_item(
        SUB, {"type": "image_dimensions", "min_width": 640, "min_height": 480}
    )
    assert (
        image_verifier.run([item], make_ctx(f"{fixture_server}/image/ok.png"))[0].verdict
        is Verdict.PASS
    )

    item2 = make_item(
        SUB, {"type": "image_dimensions", "min_width": 640, "min_height": 480}
    )
    result = image_verifier.run([item2], make_ctx(f"{fixture_server}/image/small.png"))[0]
    assert result.verdict is Verdict.FAIL
    assert "100px" in result.detail and "80px" in result.detail


def test_exact_dimensions(
    fixture_server: str, make_ctx: Callable, make_item: Callable
) -> None:
    item = make_item(
        SUB, {"type": "image_dimensions", "exact_width": 800, "exact_height": 600}
    )
    assert (
        image_verifier.run([item], make_ctx(f"{fixture_server}/image/ok.png"))[0].verdict
        is Verdict.PASS
    )


def test_format_check(
    fixture_server: str, make_ctx: Callable, make_item: Callable
) -> None:
    png_ok = make_item(SUB, {"type": "image_format", "allowed": ["png"]})
    assert (
        image_verifier.run([png_ok], make_ctx(f"{fixture_server}/image/ok.png"))[0].verdict
        is Verdict.PASS
    )

    png_only = make_item(SUB, {"type": "image_format", "allowed": ["png"]})
    result = image_verifier.run([png_only], make_ctx(f"{fixture_server}/image/photo.jpg"))[0]
    assert result.verdict is Verdict.FAIL
    assert "jpeg" in result.detail


def test_non_image_deliverable_errors_every_item(
    fixture_server: str, make_ctx: Callable, make_item: Callable
) -> None:
    items = [
        make_item(SUB, {"type": "image_format", "allowed": ["png"]}),
        make_item(SUB, {"type": "image_dimensions", "min_width": 10}),
    ]
    results = image_verifier.run(items, make_ctx(f"{fixture_server}/image/not-an-image"))

    assert all(r.verdict is Verdict.ERROR for r in results)
    assert "not a decodable image" in results[0].detail


def test_image_is_saved_as_evidence(
    fixture_server: str, make_ctx: Callable, make_item: Callable
) -> None:
    import os

    item = make_item(SUB, {"type": "image_dimensions", "min_width": 10})
    result = image_verifier.run([item], make_ctx(f"{fixture_server}/image/ok.png"))[0]

    assert result.primary_evidence_path and os.path.exists(result.primary_evidence_path)
    meta = [e for e in result.evidence if e.kind == "image_meta"][0]
    assert meta.inline["width"] == 800 and meta.inline["format"] == "png"


# --- model-backed checks -----------------------------------------------------


def test_vision_answer_matching_expectation_passes(
    fixture_server: str, make_ctx: Callable, make_item: Callable, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stub_vision(monkeypatch, VisionAnswer("yes", 0.95, "the logo is centred"))
    item = make_item(
        SUB, {"type": "vision_prompt", "prompt": "Is the logo centred?", "expect": "yes"}
    )
    result = image_verifier.run([item], make_ctx(f"{fixture_server}/image/ok.png"))[0]

    assert result.verdict is Verdict.PASS


def test_vision_answer_contradicting_expectation_fails(
    fixture_server: str, make_ctx: Callable, make_item: Callable, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stub_vision(monkeypatch, VisionAnswer("no", 0.9, "the background is white, not transparent"))
    item = make_item(
        SUB,
        {"type": "vision_prompt", "prompt": "Is the background transparent?", "expect": "yes"},
    )
    result = image_verifier.run([item], make_ctx(f"{fixture_server}/image/ok.png"))[0]

    assert result.verdict is Verdict.FAIL


def test_low_confidence_escalates_to_human_review(
    fixture_server: str, make_ctx: Callable, make_item: Callable, monkeypatch: pytest.MonkeyPatch
) -> None:
    """We would rather hand the client an explicit hand-off than a coin flip."""
    _stub_vision(monkeypatch, VisionAnswer("yes", 0.31, "hard to tell at this resolution"))
    item = make_item(SUB, {"type": "vision_prompt", "prompt": "Is the logo centred?"})
    result = image_verifier.run([item], make_ctx(f"{fixture_server}/image/ok.png"))[0]

    assert result.verdict is Verdict.NEEDS_HUMAN_REVIEW
    assert "could not answer confidently" in result.detail


def test_unclear_answer_escalates_to_human_review(
    fixture_server: str, make_ctx: Callable, make_item: Callable, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stub_vision(monkeypatch, VisionAnswer("unclear", 1.0, "the image is too small to read"))
    item = make_item(SUB, {"type": "vision_text_present", "text": "Acme"})
    result = image_verifier.run([item], make_ctx(f"{fixture_server}/image/ok.png"))[0]

    assert result.verdict is Verdict.NEEDS_HUMAN_REVIEW


def test_vision_outage_is_an_error_not_a_fail(
    fixture_server: str, make_ctx: Callable, make_item: Callable, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A missing API key must never look like the freelancer failing a check."""

    def explode(*args: object, **kwargs: object) -> VisionAnswer:
        raise VisionUnavailableError("GROQ_API_KEY is not set")

    monkeypatch.setattr(image_verifier, "ask_image", explode)
    item = make_item(SUB, {"type": "vision_prompt", "prompt": "Is the logo centred?"})
    result = image_verifier.run([item], make_ctx(f"{fixture_server}/image/ok.png"))[0]

    assert result.verdict is Verdict.ERROR


def test_deterministic_and_model_checks_share_one_download(
    fixture_server: str, make_ctx: Callable, make_item: Callable, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Every assertion in a run judges the same bytes."""
    seen: list[bytes] = []

    def record(data: bytes, media_type: str, question: str) -> VisionAnswer:
        seen.append(data)
        return VisionAnswer("yes", 0.9, "ok")

    monkeypatch.setattr(image_verifier, "ask_image", record)
    items = [
        make_item(SUB, {"type": "image_dimensions", "min_width": 10}),
        make_item(SUB, {"type": "vision_prompt", "prompt": "Q1"}),
        make_item(SUB, {"type": "vision_prompt", "prompt": "Q2"}),
    ]
    image_verifier.run(items, make_ctx(f"{fixture_server}/image/ok.png"))

    assert len(seen) == 2 and seen[0] is seen[1]
