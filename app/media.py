"""Turn uploads into files the model reads: PNG images, 16 kHz mono WAV, H.264 MP4."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import time
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import soundfile as sf
from PIL import Image, ImageOps

MAX_VIDEO_SECONDS = 60  # 2 fps sampling; about 230 prompt tokens per second of video
MAX_CLIP_SECONDS = 120  # spoken questions and voice messages
MAX_TRANSCRIBE_SECONDS = 30 * 60
MAX_IMAGE_SIDE = 2560


class MediaError(ValueError):
    pass


@dataclass
class Media:
    id: str
    kind: str  # image | audio | video
    name: str
    path: str
    url: str
    duration: float | None = None
    width: int | None = None
    height: int | None = None
    soundtrack: str | None = None  # 16 kHz WAV of a video's audio track
    trimmed: bool = False

    def public(self) -> dict:
        data = asdict(self)
        data.pop("path")
        data.pop("soundtrack")
        data["has_soundtrack"] = self.soundtrack is not None
        data["soundtrack_url"] = _url(Path(self.soundtrack)) if self.soundtrack else None
        return data


def ffmpeg(*args: str):
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise MediaError(result.stderr.strip().splitlines()[-1] if result.stderr else "ffmpeg failed")


def probe(path: Path) -> dict:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(path)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise MediaError("This file is not an image, audio or video file.")
    return json.loads(result.stdout or "{}")


def ingest(source: Path, name: str, folder: Path, purpose: str = "") -> Media:
    """Normalize one upload. ``purpose`` "transcribe" allows long audio."""
    media_id = uuid.uuid4().hex[:12]
    stem = folder / media_id
    safe_name = re.sub(r"[^\w.\- ]+", "_", name)[:80] or "file"

    image = _open_image(source)
    if image is not None:
        image = ImageOps.exif_transpose(image).convert("RGB")
        image.thumbnail((MAX_IMAGE_SIDE, MAX_IMAGE_SIDE))
        path = stem.with_suffix(".png")
        image.save(path)
        return Media(media_id, "image", safe_name, str(path), _url(path), width=image.width, height=image.height)

    info = probe(source)
    streams = info.get("streams", [])
    has_video = any(
        s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic")
        for s in streams
    )
    has_audio = any(s.get("codec_type") == "audio" for s in streams)
    duration = _duration(info)

    if has_video:
        path = stem.with_suffix(".mp4")
        trimmed = duration is not None and duration > MAX_VIDEO_SECONDS + 0.5
        ffmpeg(
            "-i", str(source), "-t", str(MAX_VIDEO_SECONDS), "-an",
            "-vf", "scale='min(1280,iw)':-2", "-c:v", "libx264", "-preset", "veryfast",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(path),
        )
        soundtrack = None
        if has_audio:
            soundtrack_path = stem.with_name(f"{media_id}-sound.wav")
            ffmpeg("-i", str(source), "-t", str(MAX_VIDEO_SECONDS), "-vn", "-ac", "1", "-ar", "16000", str(soundtrack_path))
            if sf.info(str(soundtrack_path)).duration > 0.2:
                soundtrack = str(soundtrack_path)
        out = probe(path)
        stream = next(s for s in out["streams"] if s.get("codec_type") == "video")
        return Media(
            media_id, "video", safe_name, str(path), _url(path),
            duration=_duration(out), width=stream.get("width"), height=stream.get("height"),
            soundtrack=soundtrack, trimmed=trimmed,
        )

    if has_audio:
        limit = MAX_TRANSCRIBE_SECONDS if purpose == "transcribe" else MAX_CLIP_SECONDS
        path = stem.with_suffix(".wav")
        ffmpeg("-i", str(source), "-t", str(limit), "-vn", "-ac", "1", "-ar", "16000", str(path))
        length = sf.info(str(path)).duration
        if length < 0.2:
            path.unlink(missing_ok=True)
            raise MediaError("The recording is empty.")
        trimmed = duration is not None and duration > limit + 0.5
        return Media(media_id, "audio", safe_name, str(path), _url(path), duration=round(length, 2), trimmed=trimmed)

    raise MediaError("This file has no image, audio or video stream.")


def _open_image(path: Path) -> Image.Image | None:
    try:
        image = Image.open(path)
        if getattr(image, "n_frames", 1) > 1:  # animated GIF or WebP: treat as video
            return None
        image.load()
        return image
    except Exception:
        return None


def _duration(info: dict) -> float | None:
    try:
        return round(float(info["format"]["duration"]), 2)
    except (KeyError, TypeError, ValueError):
        return None


def _url(path: Path) -> str:
    return f"/media/{path.name}"


def split_audio(path: str, folder: Path, target: float = 30.0, search: float = 6.0) -> list[str]:
    """Cut long audio at the quietest point near every ``target`` seconds.
    One pass over long audio drops words, so the app transcribes in parts."""
    wave, rate = sf.read(path, dtype="float32")
    if len(wave) <= (target + search / 2) * rate:
        return [path]
    hop = int(0.02 * rate)
    usable = len(wave) // hop * hop
    energy = np.sqrt(np.mean(wave[:usable].reshape(-1, hop) ** 2, axis=1))  # one value per 20 ms
    cuts, position = [0], 0
    while len(wave) - position > (target + search / 2) * rate:
        low = (position + int((target - search) * rate)) // hop
        high = (position + int(target * rate)) // hop
        cut = (low + int(np.argmin(energy[low:high]))) * hop
        cuts.append(cut)
        position = cut
    cuts.append(len(wave))
    parts = []
    stem = Path(path).stem
    for index, (start, end) in enumerate(zip(cuts, cuts[1:])):
        part = folder / f"{stem}-part{index:03d}.wav"
        sf.write(part, wave[start:end], rate)
        parts.append(str(part))
    return parts


def split_text(text: str, limit: int = 280) -> list[str]:
    """Pack sentences into parts of at most ``limit`` characters for TTS."""
    parts: list[str] = []
    for paragraph in re.split(r"\n\s*\n", text.strip()):
        paragraph = " ".join(paragraph.split())
        if not paragraph:
            continue
        sentences = re.split(r"(?<=[.!?…。！？])\s+", paragraph)
        current = ""
        for sentence in sentences:
            for piece in _hard_wrap(sentence, limit):
                if current and len(current) + 1 + len(piece) > limit:
                    parts.append(current)
                    current = piece
                else:
                    current = f"{current} {piece}".strip()
        if current:
            parts.append(current)
    return parts


def _hard_wrap(sentence: str, limit: int) -> list[str]:
    if len(sentence) <= limit:
        return [sentence]
    pieces, current = [], ""
    for word in re.split(r"(?<=[,;:])\s+|\s+", sentence):
        if current and len(current) + 1 + len(word) > limit:
            pieces.append(current)
            current = word
        else:
            current = f"{current} {word}".strip()
    if current:
        pieces.append(current)
    return pieces


def write_wav(wave: np.ndarray, path: Path, rate: int = 24_000) -> str:
    sf.write(path, wave, rate, subtype="PCM_16")
    return _url(path)


def clean_old(folder: Path, hours: float = 24):
    """Remove files the app wrote more than ``hours`` ago."""
    limit = time.time() - hours * 3600
    for path in folder.iterdir():
        if path.is_file() and path.stat().st_mtime < limit:
            path.unlink(missing_ok=True)


def require_ffmpeg():
    for tool in ("ffmpeg", "ffprobe"):
        if shutil.which(tool) is None:
            raise SystemExit(f"{tool} is missing. Install it with: brew install ffmpeg")
