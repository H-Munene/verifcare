"""Audio file I/O: format/integrity checks, duration, and exact-duplicate detection."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

import soundfile as sf

from acoustic_model.config import (
    EXPECTED_CHANNELS,
    EXPECTED_SAMPLE_RATE_HZ,
    EXPECTED_SAMPLE_WIDTH_BYTES,
)

# soundfile reports PCM subtype as a string, not a byte width - this
# maps the subtypes we expect to see back to bytes so format checks
# can compare against config.EXPECTED_SAMPLE_WIDTH_BYTES directly.
_SUBTYPE_TO_SAMPLE_WIDTH_BYTES = {
    "PCM_U8": 1,
    "PCM_16": 2,
    "PCM_24": 3,
    "PCM_32": 4,
}


@dataclass
class AudioFileInfo:
    readable: bool
    format_ok: bool
    error: str | None
    duration_seconds: float | None
    sample_rate_hz: int | None
    channels: int | None
    subtype: str | None
    file_size_bytes: int
    sha256: str


def _sha256(path: Path, chunk_size: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()


def inspect(path: Path) -> AudioFileInfo:
    """Read format/integrity metadata for a single audio file without full decoding."""
    file_size_bytes = path.stat().st_size
    sha256 = _sha256(path)
    try:
        info = sf.info(str(path))
    except Exception as exc:  # soundfile raises backend-specific errors on corrupt files
        return AudioFileInfo(
            readable=False,
            format_ok=False,
            error=str(exc),
            duration_seconds=None,
            sample_rate_hz=None,
            channels=None,
            subtype=None,
            file_size_bytes=file_size_bytes,
            sha256=sha256,
        )

    sample_width_bytes = _SUBTYPE_TO_SAMPLE_WIDTH_BYTES.get(info.subtype)
    format_ok = (
        sample_width_bytes == EXPECTED_SAMPLE_WIDTH_BYTES
        and info.channels == EXPECTED_CHANNELS
        and info.samplerate == EXPECTED_SAMPLE_RATE_HZ
    )
    duration_seconds = info.frames / info.samplerate if info.samplerate else None

    return AudioFileInfo(
        readable=True,
        format_ok=format_ok,
        error=None,
        duration_seconds=duration_seconds,
        sample_rate_hz=info.samplerate,
        channels=info.channels,
        subtype=info.subtype,
        file_size_bytes=file_size_bytes,
        sha256=sha256,
    )
