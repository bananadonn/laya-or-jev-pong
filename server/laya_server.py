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
import threading
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

# agent.predict() is a blocking, non-reentrant CPU/GPU call. A client that
# aborts past its act-deadline (shield.ts) only cancels the fetch on its
# end - this process has no way to interrupt a predict() already in
# progress, so if callers kept retrying every ~150ms while a single predict()
# call is genuinely slower than that (very possible on CPU-only hardware -
# see docs/INTEGRATION.md), abandoned calls would pile up concurrently and
# exhaust memory. Rather than queue unboundedly, reject a request outright
# if one is already in flight: the caller gets a fast, honest 503 instead of
# silently stacking work the shield has already given up on.
_predict_lock = threading.Lock()


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
    # ngrok-skip-browser-warning is a no-op here (this server isn't behind
    # ngrok) but layaClient.ts sends it on every request regardless of
    # target, so it must be allowed or the preflight fails and even local
    # requests get CORS-blocked before they reach this server at all.
    allow_headers=["content-type", "ngrok-skip-browser-warning"],
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
    if not _predict_lock.acquire(blocking=False):
        raise HTTPException(status_code=503, detail="a decide request is already in flight")
    try:
        result = _agent.predict(req.state, req.questions)
    finally:
        _predict_lock.release()
    return {"model": CHECKPOINT_SUBFOLDER, "answers": result["answers"]}
