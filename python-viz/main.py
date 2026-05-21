"""
Sprout Python Visualisation Service
────────────────────────────────────
POST /generate   → generate an interactive visualisation for a topic
GET  /health     → liveness check

Environment variables (set in Render dashboard):
  ANTHROPIC_API_KEY   — server-side Anthropic key (required)
  ALLOWED_ORIGIN      — CORS origin, defaults to * (lock down in production)
"""

import os
import re

import anthropic
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from executor import run_code
from prompts import SYSTEM, build_prompt

# ── App setup ─────────────────────────────────────────────────────────────────

app = FastAPI(title="Sprout Viz", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.getenv("ALLOWED_ORIGIN", "*")],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

# ── Schemas ───────────────────────────────────────────────────────────────────

class GenerateRequest(BaseModel):
    topic:   str
    content: str | None = None   # source text (optional for PDF-only docs)
    api_key: str | None = None   # optional — falls back to ANTHROPIC_API_KEY env var


class GenerateResponse(BaseModel):
    title:   str
    concept: str
    html:    str


# ── Helpers ───────────────────────────────────────────────────────────────────

def extract_metadata(code: str, topic: str) -> tuple[str, str]:
    """Pull # TITLE: and # CONCEPT: from the first 5 lines of the script."""
    title   = topic
    concept = f"Interactive visualisation of {topic}"
    for line in code.splitlines()[:5]:
        if line.startswith("# TITLE:"):
            title   = line.replace("# TITLE:", "").strip()
        elif line.startswith("# CONCEPT:"):
            concept = line.replace("# CONCEPT:", "").strip()
    return title, concept


def strip_fences(code: str) -> str:
    """Remove markdown code fences if Claude accidentally included them."""
    code = re.sub(r"^```[a-z]*\n?", "", code.strip())
    code = re.sub(r"\n?```$",       "", code.strip())
    return code.strip()


def get_client(request_key: str | None = None) -> anthropic.Anthropic:
    key = request_key or os.getenv("ANTHROPIC_API_KEY")
    if not key:
        raise HTTPException(status_code=500, detail="No API key — set ANTHROPIC_API_KEY or pass api_key in request")
    return anthropic.Anthropic(api_key=key)


# ── Route ─────────────────────────────────────────────────────────────────────

@app.post("/generate", response_model=GenerateResponse)
async def generate(req: GenerateRequest):
    client = get_client(req.api_key)
    user_prompt = build_prompt(req.topic, req.content)

    # ── First attempt ──────────────────────────────────────────────────────
    response = client.messages.create(
        model="claude-3-5-sonnet-20241022",
        max_tokens=4000,
        system=SYSTEM,
        messages=[{"role": "user", "content": user_prompt}],
    )
    code = strip_fences(response.content[0].text)
    title, concept = extract_metadata(code, req.topic)

    result = await run_code(code)

    # ── Auto-retry with error feedback ─────────────────────────────────────
    if result["error"]:
        retry = client.messages.create(
            model="claude-3-5-sonnet-20241022",
            max_tokens=4000,
            system=SYSTEM,
            messages=[
                {"role": "user",      "content": user_prompt},
                {"role": "assistant", "content": code},
                {
                    "role": "user",
                    "content": (
                        f"That code produced this error:\n\n{result['error']}\n\n"
                        "Fix it and return only the corrected Python script."
                    ),
                },
            ],
        )
        fixed_code = strip_fences(retry.content[0].text)
        title, concept = extract_metadata(fixed_code, req.topic)
        result = await run_code(fixed_code)

    if not result.get("html"):
        raise HTTPException(
            status_code=500,
            detail=result.get("error", "Visualisation generation failed"),
        )

    return GenerateResponse(title=title, concept=concept, html=result["html"])


# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok"}


# ── Temporary debug (remove after confirming env vars) ────────────────────────
@app.get("/debug/env")
def debug_env():
    """Returns env var NAMES only (not values) so we can see what Railway injects."""
    keys = sorted(os.environ.keys())
    has_key = bool(os.getenv("ANTHROPIC_API_KEY"))
    return {"env_keys": keys, "has_anthropic_key": has_key}
