"""Assertion schemas -- the contract between the Planner and the verifiers.

The Planner (task 2) emits `checklist_items.assertion` as JSON. These models are
the authoritative definition of what it may emit: anything outside them is
rejected at parse time with an `error` verdict rather than being interpreted
loosely.

Two properties matter here and are enforced, not merely intended:

1. `extra="forbid"` -- an assertion carrying unexpected keys is refused. A
   checklist item can therefore never smuggle a free-text field that some later
   code path might feed to a model as instructions.
2. Separate unions per sub-agent -- a `http_status` assertion routed to the
   frontend verifier fails to parse instead of being half-executed.

Every field is a machine-checkable value (selector, status code, pixel count).
The one natural-language field in the whole schema is `vision_prompt.prompt`,
and it reaches the model as a data field of a structured request, never as a
system instruction.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError


class _Assertion(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


# --- frontend ----------------------------------------------------------------


class PageLoads(_Assertion):
    """The deliverable URL responds and finishes loading."""

    type: Literal["page_loads"]
    max_load_ms: int = Field(default=10_000, gt=0, le=120_000)
    expected_status: int = Field(default=200, ge=100, le=599)


class ElementExists(_Assertion):
    """A CSS selector matches at least `min_count` nodes."""

    type: Literal["element_exists"]
    selector: str = Field(min_length=1, max_length=512)
    min_count: int = Field(default=1, ge=1, le=1000)


class TextPresent(_Assertion):
    """Literal text appears in the rendered page."""

    type: Literal["text_present"]
    text: str = Field(min_length=1, max_length=2000)
    case_sensitive: bool = False


class ElementTextMatches(_Assertion):
    """The text of the first node matching `selector` matches `expected_text`."""

    type: Literal["element_text_matches"]
    selector: str = Field(min_length=1, max_length=512)
    expected_text: str = Field(min_length=1, max_length=2000)
    match: Literal["exact", "contains", "regex"] = "contains"
    case_sensitive: bool = False


class NoConsoleErrors(_Assertion):
    """No console errors or uncaught page exceptions during the page load."""

    type: Literal["no_console_errors"]
    allow_patterns: list[str] = Field(default_factory=list, max_length=20)


FrontendAssertion = Annotated[
    Union[PageLoads, ElementExists, TextPresent, ElementTextMatches, NoConsoleErrors],
    Field(discriminator="type"),
]


# --- backend -----------------------------------------------------------------


class _HttpCall(_Assertion):
    """Shared request shape. `path` is always relative to the deliverable URL."""

    path: str = Field(default="/", max_length=2048)
    method: Literal["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] = "GET"
    request_body: dict[str, Any] | None = None
    headers: dict[str, str] = Field(default_factory=dict)


class HttpStatus(_HttpCall):
    type: Literal["http_status"]
    expected_status: int = Field(ge=100, le=599)


class JsonFieldEquals(_HttpCall):
    """A dotted field path in the JSON response equals an exact value."""

    type: Literal["json_field_equals"]
    field_path: str = Field(min_length=1, max_length=512)
    expected: Any = None


class JsonFieldExists(_HttpCall):
    type: Literal["json_field_exists"]
    field_path: str = Field(min_length=1, max_length=512)


class JsonShape(_HttpCall):
    """The response carries every named field path."""

    type: Literal["json_shape"]
    required_fields: list[str] = Field(min_length=1, max_length=50)


class ResponseTimeUnder(_HttpCall):
    type: Literal["response_time_under"]
    max_ms: int = Field(gt=0, le=120_000)


class HeaderPresent(_HttpCall):
    type: Literal["header_present"]
    header: str = Field(min_length=1, max_length=128)
    expected_value: str | None = Field(default=None, max_length=1024)


BackendAssertion = Annotated[
    Union[
        HttpStatus,
        JsonFieldEquals,
        JsonFieldExists,
        JsonShape,
        ResponseTimeUnder,
        HeaderPresent,
    ],
    Field(discriminator="type"),
]


# --- image -------------------------------------------------------------------


class ImageDimensions(_Assertion):
    """Deterministic pixel check -- no model involved."""

    type: Literal["image_dimensions"]
    min_width: int | None = Field(default=None, gt=0, le=100_000)
    min_height: int | None = Field(default=None, gt=0, le=100_000)
    exact_width: int | None = Field(default=None, gt=0, le=100_000)
    exact_height: int | None = Field(default=None, gt=0, le=100_000)


class ImageFormat(_Assertion):
    type: Literal["image_format"]
    allowed: list[Literal["png", "jpeg", "webp", "gif"]] = Field(min_length=1)


class VisionPrompt(_Assertion):
    """A closed yes/no question about the image, answered by the vision model.

    `expect` fixes what a passing answer is, so the model's job is to answer a
    question, never to decide an outcome.
    """

    type: Literal["vision_prompt"]
    prompt: str = Field(min_length=1, max_length=1000)
    expect: Literal["yes", "no"] = "yes"


class VisionTextPresent(_Assertion):
    """Specific text is legible in the image (OCR via the vision model)."""

    type: Literal["vision_text_present"]
    text: str = Field(min_length=1, max_length=500)


ImageAssertion = Annotated[
    Union[ImageDimensions, ImageFormat, VisionPrompt, VisionTextPresent],
    Field(discriminator="type"),
]


# --- parsing -----------------------------------------------------------------

_ADAPTERS: dict[str, TypeAdapter] = {
    "frontend_verifier": TypeAdapter(FrontendAssertion),
    "backend_verifier": TypeAdapter(BackendAssertion),
    "image_verifier": TypeAdapter(ImageAssertion),
}


class AssertionParseError(Exception):
    """The checklist item is not a valid assertion for this sub-agent."""


def parse_assertion(sub_agent: str, raw: Any) -> Any:
    """Parse `raw` against the schema for `sub_agent`, or raise."""
    adapter = _ADAPTERS.get(sub_agent)
    if adapter is None:
        raise AssertionParseError(f"unknown sub_agent {sub_agent!r}")
    if not isinstance(raw, dict):
        raise AssertionParseError("assertion must be a JSON object")
    try:
        return adapter.validate_python(raw)
    except ValidationError as exc:
        first = exc.errors()[0]
        location = ".".join(str(p) for p in first["loc"]) or "assertion"
        raise AssertionParseError(f"{location}: {first['msg']}") from exc


def supported_types(sub_agent: str) -> list[str]:
    """Assertion type names a sub-agent accepts -- used by the Planner and docs."""
    adapter = _ADAPTERS.get(sub_agent)
    if adapter is None:
        return []
    schema = adapter.json_schema()
    names = []
    for model in schema.get("$defs", {}).values():
        literal = model.get("properties", {}).get("type", {})
        if "const" in literal:
            names.append(literal["const"])
    return sorted(names)
