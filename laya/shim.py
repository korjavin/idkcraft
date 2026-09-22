"""LAYA sidecar shim: serves the JEV System-1 wire shape from local weights.

POST /v1/systemone {model, state, questions} -> {model, answers, usage}.
The bot reads only answers.action.choice (fight|follow); the state string carries a leading hard=<reason> word.
No auth: internal compose network only, any Authorization header is ignored.
"""

import logging
import time

import laya
import torch
from fastapi import FastAPI, Response
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, generate_latest
from pydantic import BaseModel

# ponytail: subfolder "typed-decisions" (421M, 1024 ctx) if quality is poor;
# needs LAYA_MEM_LIMIT >= 2500m.
#
# Memory: fp32 params (322M = ~1.3 GB) + torch baseline OOM-killed load
# under the 2g container cap (measured: 4.9 GB peak). Weights ship as fp16,
# so build the encoder in bf16: laya 0.3.4 builds it via
# AutoModel.from_config with no dtype hook, and transformers>=4.57 defaults
# fresh params to fp32 (torch default dtype is ignored), so inject
# dtype=bf16 here. Dtype safety: DecisionModel's own modules (head,
# type_emb, scorer, act_head) are plain constructors, so they stay fp32,
# and h = h + self.type_emb(...) promotes the bf16 encoder output back to
# fp32 right after the encoder (an all-bf16 conversion instead fails at the
# act_head cat — measured). Pinned-shape surgery: re-verify against laya
# source when bumping laya==0.3.4.
from transformers import AutoModel as _AutoModel

_orig_from_config = _AutoModel.from_config


@classmethod
def _bf16_from_config(cls, config, **kwargs):
    kwargs.setdefault("dtype", torch.bfloat16)
    return _orig_from_config(config, **kwargs)


_AutoModel.from_config = _bf16_from_config

agent = laya.load("convaiinnovations/laya", subfolder="multilingual")
assert next(agent.model.encoder.parameters()).dtype is torch.bfloat16, "bf16 patch missed — see comment"

app = FastAPI()
log = logging.getLogger("uvicorn.error")

PREDICT_SECONDS = Histogram(
    "laya_predict_duration_seconds", "agent.predict latency",
    buckets=(0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 5))
ANSWERS = Counter("laya_answers_total", "Answered action choice (error = predict raised)", ["choice"])
SPRINT = Histogram("laya_sprint_noul", "sprint noul probability",
                   buckets=(0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1))


class SystemOneBody(BaseModel):
    model: str = "laya"
    state: str | dict = ""
    questions: dict


@app.get("/health")
def health():
    # uvicorn only listens after the model above has loaded, so
    # healthy == model ready.
    return {"status": "ok"}


@app.get("/metrics")
def metrics():
    # Scraped by the host vmagent (compose label prometheus.scrape=true).
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.post("/v1/systemone")
def systemone(body: SystemOneBody):
    t0 = time.perf_counter()
    try:
        result = agent.predict(body.state, body.questions)
    except Exception:
        ANSWERS.labels("error").inc()
        raise
    elapsed = time.perf_counter() - t0
    PREDICT_SECONDS.observe(elapsed)
    answers = result["answers"]
    ANSWERS.labels(str((answers.get("action") or {}).get("choice"))).inc()
    noul = (answers.get("sprint") or {}).get("noul")
    if isinstance(noul, (int, float)):
        SPRINT.observe(noul)
    ms = elapsed * 1000
    log.info("systemone model=%s questions=%s elapsed_ms=%.1f",
             body.model, sorted(body.questions), ms)
    return {"model": "laya-multilingual", "answers": answers, "usage": result.get("usage", {})}
