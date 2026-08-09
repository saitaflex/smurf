"""
Gravv payment tool wrappers used only by agent/subagents/payments.py.

The platform escrow account (GRAVV_ESCROW_ACCOUNT_ID) requires a Gravv customer
that has cleared KYC first. That review is asynchronous on Gravv's side and has
been observed staying "pending" for an extended period with no API-level way to
force it. Rather than block the rest of the build on that, this module picks a
mock backend when GRAVV_ESCROW_ACCOUNT_ID is unset, and a real one when it's set.
Callers (payments.py) never branch on this themselves -- they just call these
functions.
"""

import os
import time
import uuid
from dataclasses import dataclass, field
from typing import Literal

ESCROW_ACCOUNT_ID = os.environ.get("GRAVV_ESCROW_ACCOUNT_ID")
USE_MOCK = not ESCROW_ACCOUNT_ID


@dataclass
class MoneyMovementResult:
    id: str
    status: Literal["pending", "completed", "failed"]
    client_reference: str
    raw: dict = field(default_factory=dict)


# In-memory store so get_transaction/get_collection can answer consistently
# within a single process run. Not persisted -- mock state resets per process.
_mock_store: dict[str, MoneyMovementResult] = {}


def create_collection(customer_id: str, amount: str, currency: str, client_reference: str, metadata: dict) -> MoneyMovementResult:
    if USE_MOCK:
        result = MoneyMovementResult(
            id=f"mock_collection_{uuid.uuid4()}",
            status="completed",
            client_reference=client_reference,
            raw={"amount": amount, "currency": currency, "customer_id": customer_id, "metadata": metadata},
        )
        _mock_store[result.id] = result
        return result

    # Real path: two-step preview/confirm against the Gravv createCollection tool.
    # Left as a TODO for whoever wires the actual ADK tool call -- the mock above
    # is what unblocks everyone else until GRAVV_ESCROW_ACCOUNT_ID is set.
    raise NotImplementedError("Real Gravv createCollection call not yet wired")


def create_transfer(source_account_id: str, destination_account_id: str, amount: str, client_reference: str) -> MoneyMovementResult:
    if USE_MOCK:
        result = MoneyMovementResult(
            id=f"mock_transfer_{uuid.uuid4()}",
            status="completed",
            client_reference=client_reference,
            raw={"amount": amount, "source": source_account_id, "destination": destination_account_id},
        )
        _mock_store[result.id] = result
        return result

    raise NotImplementedError("Real Gravv createTransfer call not yet wired")


def get_transaction(transaction_id: str) -> MoneyMovementResult:
    if USE_MOCK:
        if transaction_id in _mock_store:
            return _mock_store[transaction_id]
        return MoneyMovementResult(id=transaction_id, status="failed", client_reference="", raw={"error": "not found in mock store"})

    raise NotImplementedError("Real Gravv getTransaction call not yet wired")


def get_collection(collection_id: str) -> MoneyMovementResult:
    if USE_MOCK:
        if collection_id in _mock_store:
            return _mock_store[collection_id]
        return MoneyMovementResult(id=collection_id, status="failed", client_reference="", raw={"error": "not found in mock store"})

    raise NotImplementedError("Real Gravv getCollection call not yet wired")
