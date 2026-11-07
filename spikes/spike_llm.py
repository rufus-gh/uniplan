"""Spike: compare Gemini (free tier) vs local Ollama models on UniPlan's real extraction task.

Uses synthetic announcements with known answers, so no personal data is sent anywhere.
Usage:  uv run spike_llm.py [ollama_model ...]     (default: every local model >= 3B that is pulled)
"""
import json
import os
import sys
import time
from typing import Literal

import ollama
from pydantic import BaseModel

from common import save, secret


class ClassChange(BaseModel):
    course_code: str
    activity: str  # e.g. "Lecture", "Tutorial 03"
    original_date: str | None  # YYYY-MM-DD
    change: Literal["cancelled", "moved", "room_change", "online", "none"]
    new_date: str | None
    new_start_time: str | None  # HH:MM 24h
    new_location: str | None


class Deadline(BaseModel):
    title: str
    due_date: str  # YYYY-MM-DD
    due_time: str | None  # HH:MM 24h


class Extraction(BaseModel):
    category: Literal["announcement", "assignment", "mark_release", "class_change", "exam_info", "discussion", "noise"]
    importance: int  # 0-3
    deadlines: list[Deadline]
    class_changes: list[ClassChange]


SYSTEM = ("You extract structured facts from university course messages for a student's planner. "
          "Today is Wednesday 2026-11-04 (Australia/Sydney). Resolve relative dates to YYYY-MM-DD. "
          "importance: 0 noise, 1 FYI, 2 affects plans, 3 urgent/assessment-critical. Only report facts stated.")

CASES = [
    {"text": "COMP2310: Hi all, due to the public holiday there will be NO lecture this Friday. "
             "Instead the lecture will run Monday 9 Nov at 2pm in Manning Clark Hall.",
     "expect": {"category": "class_change", "change": "moved", "new_date": "2026-11-09", "new_start_time": "14:00", "min_imp": 2}},
    {"text": "MATH1014 Assignment 4 has been released on Canvas. It is due next Thursday at 11:59pm. Late penalties apply.",
     "expect": {"category": "assignment", "due_date": "2026-11-12", "due_time": "23:59", "min_imp": 2}},
    {"text": "ECON1101 Tutorial 05 (Thurs 10am) will be held online via Zoom this week only because the room is flooded.",
     "expect": {"category": "class_change", "change": "online", "min_imp": 2}},
    {"text": "Reminder: the library cafe has new opening hours. Enjoy the sunshine everyone!",
     "expect": {"category": "noise", "max_imp": 0}},
    {"text": "Marks for the COMP2310 mid-semester exam have now been released on Gradescope. Regrade requests close in 7 days.",
     "expect": {"category": "mark_release", "min_imp": 2}},
    {"text": "STAT2001 final exam: 18 November, 9:15am, Melville Hall. 3 hours + 15 min reading. One double-sided A4 page of notes permitted.",
     "expect": {"category": "exam_info", "min_imp": 3}},
    {"text": "Ed thread (staff-endorsed): Q: Is the A3 extension to Sunday official? A: Yes, A3 for COMP1110 is now due Sunday 8 Nov at 5pm.",
     "expect": {"category": "assignment", "due_date": "2026-11-08", "due_time": "17:00", "min_imp": 3}},
    {"text": "PHYS1101 Lab 7 in room 2.02 is moving to room 1.14 from next week onwards.",
     "expect": {"category": "class_change", "change": "room_change", "min_imp": 2}},
]


def score(out: Extraction, exp: dict) -> float:
    checks = [out.category == exp["category"]]
    if "min_imp" in exp:
        checks.append(out.importance >= exp["min_imp"])
    if "max_imp" in exp:
        checks.append(out.importance <= exp["max_imp"])
    if "due_date" in exp:
        checks.append(any(d.due_date == exp["due_date"] and d.due_time == exp["due_time"] for d in out.deadlines))
    if "change" in exp:
        cc = [c for c in out.class_changes if c.change == exp["change"]]
        checks.append(bool(cc))
        if cc and "new_date" in exp:
            checks.append(cc[0].new_date == exp["new_date"] and cc[0].new_start_time == exp["new_start_time"])
    return sum(checks) / len(checks)


def run_ollama(model: str, text: str) -> Extraction:
    r = ollama.chat(model=model, format=Extraction.model_json_schema(), options={"temperature": 0},
                    messages=[{"role": "system", "content": SYSTEM}, {"role": "user", "content": text}])
    return Extraction.model_validate_json(r.message.content)


# Verified 2026-11-05: ListModels returns models with zero free quota (e.g. gemini-omni-*), so pick explicitly.
GEMINI_MODELS = os.environ.get("GEMINI_BENCH_MODELS", "gemini-flash-latest,gemini-3.8-flash,gemini-flash-lite-latest").split(",")


def gemini_runners():
    key = secret("gemini_api_key", required=False)
    if not key:
        print("Gemini key not set - skipping Gemini")
        return {}
    from google import genai
    client = genai.Client(api_key=key)

    def make(model):
        def run(text: str) -> Extraction:
            r = client.models.generate_content(model=model, contents=text, config={
                "system_instruction": SYSTEM, "temperature": 0,
                "response_mime_type": "application/json", "response_schema": Extraction})
            time.sleep(4)  # stay well under free-tier RPM
            return Extraction.model_validate_json(r.text)
        return run
    return {m: make(m) for m in GEMINI_MODELS}


def bench(name, fn):
    scores, times, errors = [], [], []
    for case in CASES:
        t = time.time()
        try:
            out = fn(case["text"])
            scores.append(score(out, case["expect"]))
        except Exception as e:  # noqa: BLE001
            scores.append(0.0)
            errors.append(f"{type(e).__name__}: {str(e)[:160]}")
        times.append(time.time() - t)
    res = {"accuracy": round(sum(scores) / len(scores), 3), "per_case": [round(s, 2) for s in scores],
           "avg_seconds": round(sum(times) / len(times), 2), "errors": errors}
    print(f"{name:32} accuracy={res['accuracy']:.0%}  avg={res['avg_seconds']}s  errors={len(errors)}")
    return res


results = {}
for gm, grun in gemini_runners().items():
    results[f"gemini:{gm}"] = bench(f"gemini:{gm}", grun)

models = sys.argv[1:] or [m.model for m in ollama.list().models
                          if not any(t in m.model for t in ("1b", "1.5b", "coder", "vl"))]
for m in models:
    results[f"ollama:{m}"] = bench(f"ollama:{m}", lambda text, m=m: run_ollama(m, text))

save("llm", results)
print(json.dumps({k: v["accuracy"] for k, v in results.items()}, indent=2))
