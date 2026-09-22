"""Small FastAPI wrapper around the `laya` package (CLAUDE.md §6).

Loads the `typed-decisions` checkpoint once at startup and exposes:
  - GET  /health  -> connectivity check for the UI's status indicator
  - POST /decide  -> { state, questions } -> { answers, model }, same
                      response shape layaClient.ts already normalizes
                      Jev's response into.

Run via `npm run dev` (starts this alongside Vite) or directly:
    uvicorn laya_server:app --port ${LAYA_PORT:-8787} --reload
"""

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import laya
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

CHECKPOINT = "convaiinnovations/laya"
CHECKPOINT_SUBFOLDER = "typed-decisions"

_agent = None


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    global _agent
    _agent = laya.load(CHECKPOINT, subfolder=CHECKPOINT_SUBFOLDER)
    yield


app = FastAPI(title="laya-vs-jev-pong: local Laya server", lifespan=lifespan)

# The browser app runs on a different origin (Vite's dev server), so the
# local Laya server needs CORS enabled for it to be reachable from fetch().
_allowed_origin = os.environ.get("LAYA_CORS_ORIGIN", "http://localhost:5173")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[_allowed_origin],
    allow_methods=["GET", "POST"],
    allow_headers=["content-type"],
)


class DecideRequest(BaseModel):
    state: dict[str, Any]
    questions: dict[str, Any]


@app.get("/health")
def health() -> dict[str, Any]:
    return {"status": "ok" if _agent is not None else "loading", "checkpoint": CHECKPOINT_SUBFOLDER}


@app.post("/decide")
def decide(req: DecideRequest) -> dict[str, Any]:
    if _agent is None:
        raise HTTPException(status_code=503, detail="model not loaded yet")
    result = _agent.predict(req.state, req.questions)
    return {"model": CHECKPOINT_SUBFOLDER, "answers": result["answers"]}
