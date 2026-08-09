"""Result contract between the verifier sub-agents and the orchestrator.

The sub-agents never write to the database and never talk to Gravv. They take a
locked checklist plus a deliverable URL, and hand back a typed result per item.
Persisting those results (and uploading evidence to Supabase Storage) is the
orchestrator's job, so the verifiers stay runnable standalone with no Supabase
credentials in the environment.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class Verdict(str, Enum):
    """Mirrors the check constraint on verification_results.verdict."""

    PASS = "pass"
    FAIL = "fail"
    ERROR = "error"
    NEEDS_HUMAN_REVIEW = "needs_human_review"


#: Verdicts that mean "the check ran and the deliverable did not satisfy it".
#: Anything else means we could not get a trustworthy answer.
CONCLUSIVE = {Verdict.PASS, Verdict.FAIL}


@dataclass
class Evidence:
    """An artifact backing a verdict, shown to the client in the review UI.

    `local_path` is relative to the run's evidence directory; the orchestrator
    uploads it to the `verification-evidence` bucket and rewrites the path to
    `{deal_id}/{run_id}/{checklist_item_id}/{filename}`.
    """

    kind: str  # screenshot | http_exchange | console_log | image_meta | vision_response
    media_type: str  # image/png | application/json | text/plain
    local_path: str | None = None
    inline: Any = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "media_type": self.media_type,
            "local_path": self.local_path,
            "inline": self.inline,
        }


@dataclass
class VerificationResult:
    """One checklist item, checked."""

    checklist_item_id: str
    verdict: Verdict
    detail: str
    evidence: list[Evidence] = field(default_factory=list)
    duration_ms: int = 0

    @property
    def primary_evidence_path(self) -> str | None:
        """The single path that lands in verification_results.evidence_storage_path."""
        for item in self.evidence:
            if item.local_path:
                return item.local_path
        return None

    def to_row(self, run_id: str) -> dict[str, Any]:
        """Shape the orchestrator inserts into verification_results."""
        return {
            "run_id": run_id,
            "checklist_item_id": self.checklist_item_id,
            "verdict": self.verdict.value,
            "detail": self.detail,
            "evidence_storage_path": self.primary_evidence_path,
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "checklist_item_id": self.checklist_item_id,
            "verdict": self.verdict.value,
            "detail": self.detail,
            "duration_ms": self.duration_ms,
            "evidence": [e.to_dict() for e in self.evidence],
        }


@dataclass
class ChecklistItem:
    """A row of checklist_items, locked at contract confirmation time.

    `assertion` stays a raw dict here; each sub-agent parses it against its own
    assertion schema so a backend assertion routed to the frontend verifier is
    rejected rather than half-understood.
    """

    id: str
    requirement_id: str
    label: str
    sub_agent: str
    assertion: dict[str, Any]
    sort_order: int = 0

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> ChecklistItem:
        return cls(
            id=str(row["id"]),
            requirement_id=row["requirement_id"],
            label=row["label"],
            sub_agent=row["sub_agent"],
            assertion=row["assertion"],
            sort_order=row.get("sort_order", 0),
        )


@dataclass
class DeliverableContext:
    """Everything a sub-agent is allowed to know about the run.

    Deliberately narrow: no deal id, no amount, no party identities, no Gravv
    handles. A verifier cannot reference money even by accident.
    """

    deliverable_url: str
    evidence_dir: str
    run_id: str = "local"
