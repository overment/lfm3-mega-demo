"""Start the demo: uv run python -m app [--port 8642] [--model ...]"""

import argparse
import os

import uvicorn

from .media import require_ffmpeg
from .server import create_app


def main():
    parser = argparse.ArgumentParser(description="LFM3-Omni-2B demo on MLX")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.environ.get("LFM3_PORT", 8642)))
    parser.add_argument(
        "--model",
        default=os.environ.get("LFM3_MODEL", "LiquidAI/LFM3-Omni-2B-MLX-8bit"),
        help="Hugging Face repo or local folder (MLX weights with audio_tokenizer/)",
    )
    args = parser.parse_args()
    require_ffmpeg()
    print(f"LFM3-Omni demo: http://{args.host}:{args.port}  (model {args.model})", flush=True)
    uvicorn.run(create_app(args.model), host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
