FROM python:3.12-slim

# PYTHONUNBUFFERED=1 so a killed process still leaves its log lines.
# MALLOC_ARENA_MAX=2 cuts glibc arena bloat under 4 OMP threads.
ENV HF_HOME=/models \
    HF_HUB_OFFLINE=1 \
    PYTHONUNBUFFERED=1 \
    MALLOC_ARENA_MAX=2

WORKDIR /app

# LANDMINE: on Linux, pip install laya pulls the CUDA torch (>2 GB of nvidia
# libs). Install CPU torch first so laya's torch>=2.0.0 is already satisfied.
# transformers pinned to 4.x: v5 forces fp32 params in from_config
# (torch_dtype deprecated), which defeats the bf16 memory fit below;
# laya 0.3.4 targets the 4.x API.
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch==2.14.0 && \
    pip install --no-cache-dir laya==0.3.4 transformers==4.57.6 fastapi==0.141.1 uvicorn==0.53.0

# Bake weights BEFORE copying the shim so the weights layer caches across
# shim edits. (Build needs hub access; runtime stays offline via HF_HUB_OFFLINE.)
RUN HF_HUB_OFFLINE=0 python -c "import laya; laya.load('convaiinnovations/laya', subfolder='multilingual')"

COPY shim.py smoke.py ./
COPY test/request.json ./test/request.json

# No ports published and nothing is written at runtime; run unprivileged.
USER nobody

EXPOSE 8000
CMD ["uvicorn", "shim:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
