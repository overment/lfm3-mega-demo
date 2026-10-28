"""HTTP API and static UI. Every run streams NDJSON events:

  {"type": "queued", "ahead": n}         jobs ahead of this one
  {"type": "start", ...}                  the job started (ids, part counts)
  {"type": "prompt", "tokens": n}         prompt size of one generation
  {"type": "part", "index": i, "parts": n}  long input: next part
  {"type": "text", "delta": "..."}        more text (or "replace": full text of the part)
  {"type": "audio", "pcm": "<base64>"}    24 kHz mono int16 little-endian PCM
  {"type": "done", ...}                   final text, WAV URL, stats
  {"type": "error", "message": "..."}
"""

from __future__ import annotations

import asyncio
import json
import re
import tempfile
import threading
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import numpy as np
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import prompts
from .engine import SAMPLE_RATE, Engine, Job, pcm_event
from .media import Media, MediaError, clean_old, ingest, split_audio, split_text, write_wav

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
FILES = ROOT / "data" / "files"
MAX_UPLOAD_BYTES = 500 * 1024 * 1024
HISTORY_TURNS = 12  # Talk keeps the last 6 exchanges in the prompt
NAME = re.compile(r"^[a-f0-9]{12}[\w-]*\.(png|wav|mp4)$")


@dataclass
class Turn:
    role: str
    text: str = ""
    audio: str | None = None
    image: str | None = None


class TalkRequest(BaseModel):
    conversation_id: str | None = None
    text: str = Field("", max_length=8000)
    audio_id: str | None = None
    image_id: str | None = None
    speak: bool = True


class LookRequest(BaseModel):
    media_id: str
    question: str = Field("", max_length=4000)
    question_audio_id: str | None = None
    speak: bool = False
    listen: bool = True


class TranscribeRequest(BaseModel):
    audio_id: str
    language: str = "English"
    task: Literal["transcribe", "translate"] = "transcribe"
    target: str = "English"


class SpeakRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=5000)
    locale: str = "American English"
    voice: Literal["female", "male"] = "female"


class ResetRequest(BaseModel):
    conversation_id: str


def create_app(model_id: str) -> FastAPI:
    engine = Engine(model_id)
    media: dict[str, Media] = {}
    conversations: dict[str, list[Turn]] = {}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        FILES.mkdir(parents=True, exist_ok=True)
        clean_old(FILES)
        engine.start()
        yield

    app = FastAPI(title="LFM3-Omni demo", lifespan=lifespan)

    def find(media_id: str | None, *kinds: str) -> Media | None:
        if media_id is None:
            return None
        item = media.get(media_id)
        if item is None:
            raise HTTPException(404, "Unknown file. Upload it again.")
        if kinds and item.kind not in kinds:
            raise HTTPException(400, f"Expected {' or '.join(kinds)}, got {item.kind}.")
        return item

    async def stream(run) -> StreamingResponse:
        if engine.state == "error":
            raise HTTPException(503, f"The model failed to load: {engine.error}")
        loop = asyncio.get_running_loop()
        events: asyncio.Queue = asyncio.Queue()

        def emit(event):
            loop.call_soon_threadsafe(events.put_nowait, event)

        job = Job(run=run, emit=emit)
        ahead = engine.submit(job)
        if ahead or engine.state != "ready":
            events.put_nowait({"type": "queued", "ahead": ahead, "loading": engine.state != "ready"})

        async def body():
            try:
                while (event := await events.get()) is not None:
                    yield json.dumps(event, ensure_ascii=False) + "\n"
            finally:
                job.cancel.set()  # the client left or the run ended

        return StreamingResponse(
            body(),
            media_type="application/x-ndjson",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )

    def save(result_audio: np.ndarray) -> str | None:
        if result_audio.size == 0:
            return None
        return write_wav(result_audio, FILES / f"{uuid.uuid4().hex[:12]}-out.wav")

    @app.get("/api/status")
    def status():
        return {
            **engine.status(),
            "speech_locales": prompts.SPEECH_LOCALES,
            "asr_languages": prompts.ASR_LANGUAGES,
            "text_languages": prompts.TEXT_LANGUAGES,
        }

    @app.post("/api/upload")
    async def upload(file: UploadFile = File(...), purpose: str = Query("")):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "upload"
            size = 0
            with source.open("wb") as out:
                while chunk := await file.read(1 << 20):
                    size += len(chunk)
                    if size > MAX_UPLOAD_BYTES:
                        raise HTTPException(413, "The file is larger than 500 MB.")
                    out.write(chunk)
            try:
                item = await asyncio.to_thread(ingest, source, file.filename or "file", FILES, purpose)
            except MediaError as error:
                raise HTTPException(400, str(error))
        media[item.id] = item
        return item.public()

    @app.get("/media/{name}")
    def serve(name: str):
        path = FILES / name
        if not NAME.match(name) or not path.is_file():
            raise HTTPException(404)
        return FileResponse(path)

    # Talk: spoken or typed chat, answers in speech and text

    @app.post("/api/talk")
    async def talk(request: TalkRequest):
        voice = find(request.audio_id, "audio")
        image = find(request.image_id, "image")
        if not (request.text.strip() or voice or image):
            raise HTTPException(400, "Say or type something.")
        conversation_id = request.conversation_id or uuid.uuid4().hex[:12]
        history = conversations.setdefault(conversation_id, [])
        turn = Turn(
            "user",
            text=request.text.strip(),
            audio=voice.path if voice else None,
            image=image.path if image else None,
        )

        def run(engine: Engine, emit, cancel: threading.Event):
            emit({"type": "start", "conversation_id": conversation_id})
            turns = (history + [turn])[-HISTORY_TURNS - 1 :]
            while turns and turns[0].role != "user":
                turns = turns[1:]
            messages = [{"role": "system", "content": prompts.talk_system(request.speak)}]
            images, audio = [], []
            for item in turns:
                if item.role == "assistant":
                    messages.append({"role": "assistant", "content": item.text or "…"})
                    continue
                content = []
                if item.image:
                    content.append({"type": "image"})
                    images.append(item.image)
                if item.audio:
                    content.append({"type": "audio"})
                    audio.append(item.audio)
                if item.text:
                    content.append({"type": "text", "text": item.text})
                messages.append({"role": "user", "content": content})
            result = engine.generate(
                messages,
                mode="interleaved" if request.speak else "text",
                emit=emit,
                images=images,
                audio=audio,
                max_tokens=2048 if request.speak else 1024,
                cancel=cancel,
            )
            history.extend([turn, Turn("assistant", result.text)])
            emit({
                "type": "done",
                "text": result.text,
                "audio_url": save(result.audio),
                "stats": result.stats,
                "cancelled": result.cancelled,
            })

        return await stream(run)

    @app.post("/api/talk/reset")
    def reset(request: ResetRequest):
        conversations.pop(request.conversation_id, None)
        return {"ok": True}

    # Look: questions about an image or a video

    @app.post("/api/look")
    async def look(request: LookRequest):
        item = find(request.media_id, "image", "video")
        spoken = find(request.question_audio_id, "audio")
        question = request.question.strip()
        if not question and not spoken:
            question = "Describe this image." if item.kind == "image" else "What happens in this video?"
        listen = request.listen and item.soundtrack is not None

        def run(engine: Engine, emit, cancel: threading.Event):
            emit({"type": "start", "question": question})
            content, audio = [{"type": item.kind}], []
            if listen:
                content.append({"type": "audio"})
                audio.append(item.soundtrack)
            if spoken:
                content.append({"type": "audio"})
                audio.append(spoken.path)
            if question:
                content.append({"type": "text", "text": question})
            messages = [
                {"role": "system", "content": prompts.look_system(item.kind, listen, request.speak)},
                {"role": "user", "content": content},
            ]
            result = engine.generate(
                messages,
                mode="interleaved" if request.speak else "text",
                emit=emit,
                images=[item.path] if item.kind == "image" else None,
                videos=[item.path] if item.kind == "video" else None,
                audio=audio,
                max_tokens=2048 if request.speak else 1024,
                cancel=cancel,
            )
            emit({
                "type": "done",
                "text": result.text,
                "audio_url": save(result.audio),
                "stats": result.stats,
                "cancelled": result.cancelled,
            })

        return await stream(run)

    # Transcribe: speech to text, or speech to text in another language

    @app.post("/api/transcribe")
    async def transcribe(request: TranscribeRequest):
        item = find(request.audio_id, "audio", "video")
        source = item.path if item.kind == "audio" else item.soundtrack
        if source is None:
            raise HTTPException(400, "This video has no sound.")
        if request.language not in prompts.ASR_LANGUAGES:
            raise HTTPException(400, f"Unknown language: {request.language}")
        if request.task == "translate" and request.target not in prompts.TEXT_LANGUAGES:
            raise HTTPException(400, f"Unknown language: {request.target}")
        if request.task == "translate":
            system = prompts.translate_system(request.language, request.target)
        else:
            system = prompts.asr_system(request.language)

        def run(engine: Engine, emit, cancel: threading.Event):
            parts = split_audio(source, FILES)
            emit({"type": "start", "parts": len(parts), "duration": item.duration})
            texts, seconds, first_text = [], 0.0, None
            for index, part in enumerate(parts):
                if cancel.is_set():
                    break
                emit({"type": "part", "index": index, "parts": len(parts)})
                messages = [
                    {"role": "system", "content": system},
                    {"role": "user", "content": [{"type": "audio"}]},
                ]
                result = engine.generate(
                    messages, mode="text", emit=emit, audio=[part], max_tokens=1024, cancel=cancel
                )
                texts.append(result.text)
                seconds += result.stats["seconds"]
                if first_text is None:
                    first_text = result.stats["first_text"]
                if part != source:
                    Path(part).unlink(missing_ok=True)
            audio_seconds = item.duration or 0
            emit({
                "type": "done",
                "text": " ".join(t for t in texts if t),
                "cancelled": cancel.is_set(),
                "stats": {
                    "parts": len(parts),
                    "seconds": round(seconds, 2),
                    "first_text": first_text,
                    "audio_seconds": audio_seconds,
                    "speed": round(audio_seconds / seconds, 1) if seconds and audio_seconds else None,
                },
            })

        return await stream(run)

    # Speak: text to speech

    @app.post("/api/speak")
    async def speak(request: SpeakRequest):
        if request.locale not in prompts.SPEECH_LOCALES:
            raise HTTPException(400, f"Unknown locale: {request.locale}")
        parts = split_text(request.text)
        if not parts:
            raise HTTPException(400, "Type some text.")
        system = prompts.tts_system(request.locale, request.voice)

        def run(engine: Engine, emit, cancel: threading.Event):
            emit({"type": "start", "parts": len(parts)})
            pause = np.zeros(int(0.22 * SAMPLE_RATE), dtype=np.float32)
            waves, seconds, first_audio = [], 0.0, None
            for index, part in enumerate(parts):
                if cancel.is_set():
                    break
                emit({"type": "part", "index": index, "parts": len(parts), "text": part})
                if waves:
                    emit(pcm_event(pause))
                    waves.append(pause)
                messages = [
                    {"role": "system", "content": system},
                    {"role": "user", "content": part},
                ]
                result = engine.generate(messages, mode="audio", emit=emit, max_tokens=1536, cancel=cancel)
                waves.append(result.audio)
                seconds += result.stats["seconds"]
                if first_audio is None:
                    first_audio = result.stats["first_audio"]
            wave = np.concatenate(waves) if waves else np.zeros(0, np.float32)
            speech_seconds = round(len(wave) / SAMPLE_RATE, 2)
            emit({
                "type": "done",
                "audio_url": save(wave),
                "cancelled": cancel.is_set(),
                "stats": {
                    "parts": len(parts),
                    "seconds": round(seconds, 2),
                    "first_audio": first_audio,
                    "speech_seconds": speech_seconds,
                    "realtime_factor": round(speech_seconds / seconds, 1) if seconds else None,
                },
            })

        return await stream(run)

    app.mount("/", StaticFiles(directory=WEB, html=True), name="web")
    return app
