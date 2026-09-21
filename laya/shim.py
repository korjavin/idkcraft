"""LAYA sidecar shim: serves the JEV System-1 wire shape from local weights.

POST /v1/systemone {model, state, questions} -> {model, answers, usage}.
The bot reads only answers.action.choice and answers.sprint.noul.
No auth: internal compose network only, any Authorization header is ignored.
"""

import logging
import time

import laya
import torch
from fastapi import FastAPI
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


class SystemOneBody(BaseModel):
    model: str = "laya"
    state: str | dict = ""
    questions: dict


@app.get("/health")
def health():
    # uvicorn only listens after the model above has loaded, so
    # healthy == model ready.
    return {"status": "ok"}


@app.post("/v1/systemone")
def systemone(body: SystemOneBody):
    t0 = time.perf_counter()
    result = agent.predict(body.state, body.questions)
    ms = (time.perf_counter() - t0) * 1000
    log.info("systemone model=%s questions=%s elapsed_ms=%.1f",
             body.model, sorted(body.questions), ms)
    return {"model": "laya-multilingual", "answers": result["answers"], "usage": result.get("usage", {})}
