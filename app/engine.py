"""One worker thread owns LFM3-Omni and runs jobs one at a time.

MLX work stays on that thread. Jobs stream events (text deltas, PCM chunks,
stats) back to the caller through an ``emit`` callback.
"""

from __future__ import annotations

import base64
import platform
import queue
import subprocess
import threading
import time
import traceback
from dataclasses import dataclass, field
from typing import Callable

import mlx.core as mx
import numpy as np

SAMPLE_RATE = 24_000
FRAME_SAMPLES = 1920  # one speech frame is 80 ms at 24 kHz
HOLD_BACK = 2  # the codec can still change the last frames of a prefix
FIRST_CHUNK = 6  # frames before the first PCM chunk (0.48 s)

Emit = Callable[[dict | None], None]


@dataclass
class Job:
    run: Callable[["Engine", Emit, threading.Event], None]
    emit: Emit
    cancel: threading.Event = field(default_factory=threading.Event)


@dataclass
class Result:
    text: str
    audio: np.ndarray
    stats: dict
    cancelled: bool = False


def pcm_event(samples: np.ndarray) -> dict:
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes()
    return {"type": "audio", "pcm": base64.b64encode(pcm).decode("ascii")}


def chip_name() -> str:
    try:
        return subprocess.run(
            ["sysctl", "-n", "machdep.cpu.brand_string"],
            capture_output=True,
            text=True,
            timeout=2,
        ).stdout.strip()
    except Exception:
        return platform.machine()


class Engine:
    def __init__(self, model_id: str):
        self.model_id = model_id
        self.state = "starting"
        self.error: str | None = None
        self.load_seconds: float | None = None
        self.busy = False
        self.chip = chip_name()
        self.model = None
        self.processor = None
        self._jobs: queue.Queue[Job] = queue.Queue()
        self._thread = threading.Thread(target=self._loop, name="lfm3-engine", daemon=True)

    def start(self):
        self._thread.start()

    def submit(self, job: Job) -> int:
        """Queue a job and return how many jobs are ahead of it."""
        ahead = self._jobs.qsize() + (1 if self.busy else 0)
        self._jobs.put(job)
        return ahead

    def status(self) -> dict:
        memory = None
        if self.state == "ready":
            memory = round(mx.get_active_memory() / 1e9, 2)
        return {
            "state": self.state,
            "error": self.error,
            "model": self.model_id,
            "load_seconds": self.load_seconds,
            "busy": self.busy,
            "queued": self._jobs.qsize(),
            "chip": self.chip,
            "memory_gb": memory,
            "mlx": mx.__version__,
        }

    # worker thread

    def _loop(self):
        try:
            self.state = "loading"
            start = time.perf_counter()
            from mlx_vlm import load

            self.model, self.processor = load(self.model_id)
            self._warm_up()
            self.load_seconds = round(time.perf_counter() - start, 1)
            self.state = "ready"
        except Exception as error:
            traceback.print_exc()
            self.state, self.error = "error", str(error)
            return
        while True:
            job = self._jobs.get()
            self.busy = True
            try:
                if not job.cancel.is_set():
                    job.run(self, job.emit, job.cancel)
            except Exception as error:
                traceback.print_exc()
                job.emit({"type": "error", "message": str(error)})
            finally:
                self.busy = False
                mx.clear_cache()
                job.emit(None)

    def _warm_up(self):
        """Compile the speech kernels so the first request is not slow."""
        tts = [
            {"role": "system", "content": "Perform TTS in American English using a female voice."},
            {"role": "user", "content": "Ready."},
        ]
        self.generate(tts, mode="audio", max_tokens=12, emit=lambda event: None)

    # generation

    def render(self, messages: list[dict]) -> str:
        return self.processor.tokenizer.apply_chat_template(
            messages, add_generation_prompt=True, tokenize=False
        )

    def generate(
        self,
        messages: list[dict],
        *,
        mode: str,
        emit: Emit,
        images: list[str] | None = None,
        audio: list[str] | None = None,
        videos: list[str] | None = None,
        max_tokens: int = 1024,
        cancel: threading.Event | None = None,
    ) -> Result:
        """Run one prompt. ``mode`` is "text", "audio" (TTS) or "interleaved"
        (speech chat). Emits text deltas and PCM chunks as they are sampled."""
        from mlx_vlm.generate.common import generation_stream, wired_limit
        from mlx_vlm.utils import prepare_inputs

        model, config = self.model, self.model.config
        tokenizer = self.processor.tokenizer
        codec = model.codec()
        started = time.perf_counter()

        inputs = prepare_inputs(
            self.processor,
            images=images or None,
            audio=audio or None,
            videos=videos or None,
            prompts=self.render(messages),
            add_special_tokens=False,
        )
        input_ids = inputs.pop("input_ids")
        inputs.pop("attention_mask", None)
        prompt_tokens = int(np.asarray(input_ids).size)
        emit({"type": "prompt", "tokens": prompt_tokens})

        text_ids: list[int] = []
        sent = ""
        frames: list[mx.array] = []
        samples_sent = 0
        next_chunk = FIRST_CHUNK
        slots = 0
        first_slot = first_text = first_audio = None
        cancelled = False

        def flush(final: bool):
            nonlocal samples_sent, first_audio
            if not frames:
                return None
            wave = np.asarray(codec.decode(mx.stack(frames, axis=-1)), dtype=np.float32)
            end = len(wave) if final else (len(frames) - HOLD_BACK) * FRAME_SAMPLES
            if end > samples_sent:
                emit(pcm_event(wave[samples_sent:end]))
                samples_sent = end
                if first_audio is None:
                    first_audio = time.perf_counter() - started
            return wave

        with wired_limit(model, [generation_stream]), mx.stream(generation_stream):
            for token, codes in model.stream_slots(
                input_ids,
                generation_mode=mode,
                max_tokens=max_tokens,
                **{**model.audio_sampling, **inputs},
            ):
                slots += 1
                if first_slot is None:
                    first_slot = time.perf_counter() - started
                if cancel is not None and cancel.is_set():
                    cancelled = True
                    break
                if codes is not None:
                    if codes[0].item() == config.audio_eos_code:
                        continue
                    frames.append(codes)
                    if len(frames) - HOLD_BACK >= next_chunk:
                        flush(final=False)
                        # longer replies re-decode a longer prefix; space the chunks out
                        next_chunk = len(frames) - HOLD_BACK + max(10, len(frames) // 8)
                    continue
                if token == config.audio_out_token_id:
                    continue
                text_ids.append(token)
                text = tokenizer.decode(text_ids, skip_special_tokens=True)
                if text.endswith("�") or text == sent:
                    continue
                if text.startswith(sent):
                    emit({"type": "text", "delta": text[len(sent) :]})
                else:
                    emit({"type": "text", "replace": text})
                sent = text
                if first_text is None:
                    first_text = time.perf_counter() - started

            wave = flush(final=True)

        elapsed = time.perf_counter() - started
        speech_seconds = len(frames) * FRAME_SAMPLES / SAMPLE_RATE
        decode_seconds = elapsed - (first_slot or 0)
        stats = {
            "prompt_tokens": prompt_tokens,
            "slots": slots,
            "frames": len(frames),
            "speech_seconds": round(speech_seconds, 2),
            "seconds": round(elapsed, 2),
            "first_slot": _round(first_slot),
            "first_text": _round(first_text),
            "first_audio": _round(first_audio),
            "slots_per_second": round(slots / decode_seconds, 1) if decode_seconds > 0 else None,
            "realtime_factor": round(speech_seconds / elapsed, 1) if speech_seconds else None,
            "peak_memory_gb": round(mx.get_peak_memory() / 1e9, 2),
        }
        audio_out = wave if wave is not None else np.zeros(0, dtype=np.float32)
        return Result(text=sent.strip(), audio=audio_out, stats=stats, cancelled=cancelled)


def _round(value: float | None) -> float | None:
    return None if value is None else round(value, 2)
