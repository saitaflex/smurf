# Verifier sub-agents (track #3). Each module exposes:
#
#     def verify_items(items: list[ChecklistItem], ctx: VerificationContext) -> list[ItemResult]
#
# with one ItemResult per input item. See agent/schemas.py for the types and
# agent/orchestrator.py for how modules are dispatched by ChecklistItem.sub_agent:
#   frontend_verifier - Playwright page assertions (screenshot evidence)
#   backend_verifier  - literal HTTP status / JSON field checks
#   image_verifier    - Groq vision yes/no against the locked prompt
