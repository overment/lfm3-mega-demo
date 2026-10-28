# lfm3-mega-demo

Local demo app for LiquidAI LFM3-Omni-2B on MLX. See `README.md`.

- Start: `./run` (port 8642, `127.0.0.1`). Python environment: `uv sync` (Python 3.12, `.venv/`).
- Model: `LiquidAI/LFM3-Omni-2B-MLX-8bit` from the Hugging Face cache. Speech needs its `audio_tokenizer/` folder.
- `mlx-vlm` is pinned to a Git commit in `pyproject.toml`. Before you change `app/engine.py`, read the model code in `.venv/lib/python3.12/site-packages/mlx_vlm/models/lfm3_omni/` and `../lfm3_audio/`.
- All MLX calls run on the engine's worker thread. Do not call the model from request handlers.
- Browser tests: Web Audio and the microphone need a user gesture. An automated page script must run with a user gesture (for example CDP `Runtime.evaluate` with `userGesture: true`).
- `data/` holds uploads and answers. It is not source.
