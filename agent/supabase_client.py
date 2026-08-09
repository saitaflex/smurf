"""Minimal Supabase REST helper for agent code running outside Next.js.

Uses the service-role key (passed in as env at sandbox dispatch time), so RLS
is bypassed — same trust model as the API routes.
"""

import os

import httpx

SUPABASE_URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

_HEADERS = {
    "apikey": SERVICE_ROLE_KEY,
    "Authorization": f"Bearer {SERVICE_ROLE_KEY}",
    "Content-Type": "application/json",
}


def select_one(table: str, filters: dict[str, str]) -> dict | None:
    params = {k: f"eq.{v}" for k, v in filters.items()}
    params["limit"] = "1"
    resp = httpx.get(f"{SUPABASE_URL}/rest/v1/{table}", headers=_HEADERS, params=params)
    resp.raise_for_status()
    rows = resp.json()
    return rows[0] if rows else None


def update(table: str, filters: dict[str, str], values: dict) -> None:
    params = {k: f"eq.{v}" for k, v in filters.items()}
    resp = httpx.patch(f"{SUPABASE_URL}/rest/v1/{table}", headers=_HEADERS, params=params, json=values)
    resp.raise_for_status()


def insert(table: str, row: dict) -> None:
    resp = httpx.post(f"{SUPABASE_URL}/rest/v1/{table}", headers=_HEADERS, json=row)
    resp.raise_for_status()
