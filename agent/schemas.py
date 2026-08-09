"""Shared data contracts for the verification agent stack.

Used by the planner (checklist generation), the orchestrator (dispatch and
aggregation), and the verifier sub-agents in agent/subagents/. Sub-agents
receive deliverable content strictly as data fields inside these structures —
never concatenated into an instruction prompt.

Enums and row shapes mirror supabase/migrations/0001_init.sql exactly — the
DB check constraints are the source of truth. In the database an item's check
is stored as a single `assertion` jsonb ({"type": ..., ...params}); in Python
we split that into item_type + params, with to_db_row()/from_db_row() at the
boundary.
"""
from __future__ import annotations

import uuid
from enum import Enum
from typing import Any

import httpx
from pydantic import BaseModel, Field


class ItemType(str, Enum):
    # frontend_verifier (Playwright)
    PAGE_LOADS = "page_loads"          # params: {"path"?: str}
    ELEMENT_EXISTS = "element_exists"  # params: {"selector": str, "path"?: str}
    TEXT_PRESENT = "text_present"      # params: {"text": str, "path"?: str}
    CONSOLE_CLEAN = "console_clean"    # params: {"path"?: str}
    # backend_verifier (HTTP)
    HTTP_STATUS = "http_status"        # params: {"path": str, "method"?: str, "expected_status": int}
    JSON_FIELD = "json_field"          # params: {"path": str, "json_path": str, "expected": Any}
    # image_verifier (Groq vision)
    VISION_PROMPT = "vision_prompt"    # params: {"prompt": str}  — must be answerable yes/no


TYPE_TO_SUBAGENT: dict[ItemType, str] = {
    ItemType.PAGE_LOADS: "frontend_verifier",
    ItemType.ELEMENT_EXISTS: "frontend_verifier",
    ItemType.TEXT_PRESENT: "frontend_verifier",
    ItemType.CONSOLE_CLEAN: "frontend_verifier",
    ItemType.HTTP_STATUS: "backend_verifier",
    ItemType.JSON_FIELD: "backend_verifier",
    ItemType.VISION_PROMPT: "image_verifier",
}

# Which item types the planner may emit for each deliverable type
# (deals.deliverable_type: 'frontend' | 'backend' | 'image').
DELIVERABLE_ITEM_TYPES: dict[str, list[ItemType]] = {
    "frontend": [ItemType.PAGE_LOADS, ItemType.ELEMENT_EXISTS,
                 ItemType.TEXT_PRESENT, ItemType.CONSOLE_CLEAN],
    "backend": [ItemType.HTTP_STATUS, ItemType.JSON_FIELD],
    "image": [ItemType.VISION_PROMPT],
}

# Params that must be present for an item to be executable.
REQUIRED_PARAMS: dict[ItemType, list[str]] = {
    ItemType.PAGE_LOADS: [],
    ItemType.ELEMENT_EXISTS: ["selector"],
    ItemType.TEXT_PRESENT: ["text"],
    ItemType.CONSOLE_CLEAN: [],
    ItemType.HTTP_STATUS: ["path", "expected_status"],
    ItemType.JSON_FIELD: ["path", "json_path", "expected"],
    ItemType.VISION_PROMPT: ["prompt"],
}


class Requirement(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    description: str
    acceptance_criteria: list[str] = []


class ChecklistItem(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    requirement_id: str = ""
    sub_agent: str = ""  # always derived from item_type by our table, never LLM-chosen
    item_type: ItemType
    params: dict[str, Any] = {}
    label: str
    sort_order: int = 0

    @property
    def assertion(self) -> dict[str, Any]:
        return {"type": self.item_type.value, **self.params}

    def to_db_row(self, contract_id: str) -> dict[str, Any]:
        """Row for checklist_items — used by the contract-confirm route."""
        return {
            "id": self.id,
            "contract_id": contract_id,
            "requirement_id": self.requirement_id,
            "label": self.label,
            "sub_agent": self.sub_agent,
            "assertion": self.assertion,
            "sort_order": self.sort_order,
        }

    @classmethod
    def from_db_row(cls, row: dict[str, Any]) -> "ChecklistItem":
        assertion = dict(row.get("assertion") or {})
        item_type = ItemType(assertion.pop("type"))
        return cls(
            id=row["id"],
            requirement_id=row.get("requirement_id") or "",
            sub_agent=row["sub_agent"],
            item_type=item_type,
            params=assertion,
            label=row.get("label") or "",
            sort_order=row.get("sort_order") or 0,
        )


class PlanResult(BaseModel):
    requirements: list[Requirement]
    ambiguity_warnings: list[str]
    checklist: list[ChecklistItem]


class Verdict(str, Enum):
    """verification_results.verdict check constraint."""
    PASS = "pass"
    FAIL = "fail"
    ERROR = "error"
    NEEDS_HUMAN_REVIEW = "needs_human_review"


class OverallVerdict(str, Enum):
    """verification_runs.overall_verdict check constraint."""
    PASS = "pass"
    FAIL = "fail"
    PASS_WITH_WARNINGS = "pass_with_warnings"
    NEEDS_HUMAN_REVIEW = "needs_human_review"
    ERROR = "error"


class ItemResult(BaseModel):
    checklist_item_id: str
    verdict: Verdict
    detail: str = ""
    # Supabase Storage object path from ctx.upload_evidence(); the UI renders
    # it via a signed URL. Maps to verification_results.evidence_storage_path.
    evidence_storage_path: str = ""


class VerificationContext(BaseModel):
    """Everything a sub-agent needs to execute checks and store evidence."""

    run_id: str
    deal_id: str
    deliverable_url: str
    supabase_url: str
    supabase_service_key: str
    evidence_bucket: str = "verification-evidence"

    def upload_evidence(self, filename: str, data: bytes,
                        content_type: str = "application/octet-stream") -> str:
        """Upload bytes to Supabase Storage; returns the object path."""
        path = f"{self.deal_id}/{self.run_id}/{filename}"
        resp = httpx.post(
            f"{self.supabase_url}/storage/v1/object/{self.evidence_bucket}/{path}",
            headers={
                "Authorization": f"Bearer {self.supabase_service_key}",
                "Content-Type": content_type,
                "x-upsert": "true",
            },
            content=data,
            timeout=30,
        )
        resp.raise_for_status()
        return path


def aggregate_verdict(results: list[ItemResult],
                      had_warnings: bool = False) -> OverallVerdict:
    if not results:
        return OverallVerdict.ERROR
    verdicts = {r.verdict for r in results}
    if Verdict.FAIL in verdicts:
        return OverallVerdict.FAIL
    if verdicts == {Verdict.PASS}:
        return (OverallVerdict.PASS_WITH_WARNINGS if had_warnings
                else OverallVerdict.PASS)
    # some items errored or need a human, but nothing outright failed
    return OverallVerdict.NEEDS_HUMAN_REVIEW
