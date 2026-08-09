# Verifier sub-agent modules live here (owned by track #3).
#
# Each module must expose:
#
#     def verify_items(items: list[ChecklistItem], ctx: VerificationContext) -> list[ItemResult]
#
# with one ItemResult per input item, in the same order. See agent/schemas.py
# for the types and agent/orchestrator.py for how modules are dispatched.
# Module names must match the ChecklistItem.sub_agent values:
#   frontend_verifier.py, backend_verifier.py, image_verifier.py
