"""LLM access: Gemini free tier (model chain) with retries, falling back to local Ollama.

Phase 0 findings: free-tier Flash models sometimes return 503 (overloaded); some listed models have zero
free quota. So models are configured explicitly (GEMINI_MODELS) and tried in order, then Ollama.
"""
from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timedelta
from typing import TypeVar

from pydantic import BaseModel
from sqlmodel import func, select

from .config import Settings, settings
from .db import LLMCall, session, utcnow

log = logging.getLogger("uniplan.llm")
T = TypeVar("T", bound=BaseModel)


class LLMUnavailable(Exception):
    pass


class LLM:
    def __init__(self, cfg: Settings | None = None):
        self.cfg = cfg or settings()
        self._lock = threading.Lock()
        self._last_call = 0.0
        self._client = None
        self._dead_models: set[str] = set()  # models that hit hard quota / don't exist
        self._cooldown: dict[str, float] = {}  # model -> time until which we skip it (overloaded)
        self._strikes: dict[str, int] = {}

    # ---------- bookkeeping ----------
    def _record(self, provider, model, ok, purpose, error=""):
        with session() as s:
            s.add(LLMCall(provider=provider, model=model, ok=ok, purpose=purpose, error=error[:300]))
            s.commit()

    def gemini_calls_today(self) -> int:
        start = utcnow() - timedelta(hours=24)
        with session() as s:
            return s.exec(select(func.count()).select_from(LLMCall).where(
                LLMCall.provider == "gemini", LLMCall.at >= start)).one()

    def _gemini(self):
        if not self.cfg.gemini_api_key:
            return None
        if self._client is None:
            from google import genai
            self._client = genai.Client(api_key=self.cfg.gemini_api_key, http_options={"timeout": 90_000})
        return self._client

    def _throttle(self):
        with self._lock:
            wait = self.cfg.gemini_min_interval - (time.time() - self._last_call)
            if wait > 0:
                time.sleep(wait)
            self._last_call = time.time()

    # ---------- public ----------
    def generate(self, prompt: str, system: str, schema: type[T] | None = None, purpose: str = "") -> tuple[T | str, str]:
        """Returns (parsed result or text, 'provider:model')."""
        client = self._gemini()
        if client and self.gemini_calls_today() < self.cfg.gemini_daily_cap:
            for model in self.cfg.gemini_models:
                if model in self._dead_models or self._cooldown.get(model, 0) > time.time():
                    continue
                for attempt in range(2):
                    self._throttle()
                    try:
                        config = {"system_instruction": system, "temperature": 0}
                        if schema:
                            config |= {"response_mime_type": "application/json", "response_schema": schema}
                        r = client.models.generate_content(model=model, contents=prompt, config=config)
                        out = schema.model_validate_json(r.text) if schema else (r.text or "")
                        self._record("gemini", model, True, purpose)
                        self._strikes[model] = 0
                        return out, f"gemini:{model}"
                    except Exception as e:  # noqa: BLE001
                        msg = str(e)
                        self._record("gemini", model, False, purpose, msg)
                        code = getattr(e, "code", None)
                        if code == 429 or "RESOURCE_EXHAUSTED" in msg:
                            if "PerDay" in msg or "per day" in msg.lower() or attempt == 1:
                                self._cooldown[model] = time.time() + 3600
                                break
                            time.sleep(15)
                        elif code in (500, 502, 503, 504) or "UNAVAILABLE" in msg or "INTERNAL" in msg or "timed out" in msg.lower():
                            if attempt == 1:
                                # circuit breaker: an overloaded model is skipped for a while instead of retried per item
                                self._strikes[model] = self._strikes.get(model, 0) + 1
                                self._cooldown[model] = time.time() + 300 * self._strikes[model]
                            else:
                                time.sleep(3)
                        elif code == 404:
                            self._dead_models.add(model)
                            break
                        else:  # validation / bad request: don't hammer, try next model
                            log.warning("gemini %s error: %s", model, msg[:200])
                            break
        return self._ollama(prompt, system, schema, purpose)

    def _ollama(self, prompt, system, schema, purpose):
        import ollama

        try:
            client = ollama.Client(host=self.cfg.ollama_host, timeout=180)
            r = client.chat(model=self.cfg.ollama_model, options={"temperature": 0},
                            format=schema.model_json_schema() if schema else None,
                            messages=[{"role": "system", "content": system}, {"role": "user", "content": prompt}])
            content = r.message.content
            out = schema.model_validate_json(content) if schema else content
            self._record("ollama", self.cfg.ollama_model, True, purpose)
            return out, f"ollama:{self.cfg.ollama_model}"
        except Exception as e:  # noqa: BLE001
            self._record("ollama", self.cfg.ollama_model, False, purpose, str(e))
            raise LLMUnavailable(f"Gemini and Ollama both failed: {e}") from e

    def ollama_ok(self) -> bool:
        import ollama
        try:
            names = [m.model for m in ollama.Client(host=self.cfg.ollama_host).list().models]
            return self.cfg.ollama_model in names
        except Exception:  # noqa: BLE001
            return False


_llm: LLM | None = None


def get_llm() -> LLM:
    global _llm
    if _llm is None:
        _llm = LLM()
    return _llm


def today_local(cfg: Settings | None = None) -> datetime:
    cfg = cfg or settings()
    return datetime.now(cfg.tz)
