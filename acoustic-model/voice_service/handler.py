"""The voice Lambda (2026-11-13): enrolment voiceprints and visit-recording checks, for the API.

Invoked only by the API Lambda (backend/src/voiceService.ts). It reads audio from the visit-audio
bucket and voiceprints from their own bucket itself, so neither passes through the API. It reuses
the evaluated pipeline unchanged: Silero VAD, the frozen ECAPA-TDNN at its pinned revision, and the
rule frozen at SV4 (config.SV_FROZEN_RULE). Nothing here trains.

Modes:
  enrol  {audioKey, voiceprintKey} -> {enrolled, speechSeconds, modelRevision}; deletes the audio
  verify {audioKey, voiceprintKey} -> {result, score, speechSeconds, threshold, modelRevision}
  remove {voiceprintKey}           -> {}
"""

import io
import math
import os
import subprocess
import tempfile

import boto3
import numpy as np
from imageio_ffmpeg import get_ffmpeg_exe

from mzazi_acoustic.common import config
from mzazi_acoustic.speaker_verification import decide, embed, enrol, verify
from mzazi_acoustic.speaker_verification.vad import Vad

AUDIO_BUCKET = os.environ["VISIT_AUDIO_BUCKET_NAME"]
VOICEPRINT_BUCKET = os.environ["VOICEPRINT_BUCKET_NAME"]
MODEL_DIR = os.environ.get("MODEL_DIR", os.path.join(os.path.dirname(__file__), "model"))
RULE = config.SV_FROZEN_RULE
# An enrolment needs most of its ~30 s to be speech, so the voiceprint is as good as those evaluated.
MIN_ENROL_SPEECH_SECONDS = 20.0

# Loaded once per container: this is the cold start.
s3 = boto3.client("s3")
embedder = embed.Embedder(local_dir=MODEL_DIR)
vad = Vad()


def decode(data: bytes) -> np.ndarray:
    """Any format the phones upload (AAC in m4a) to 16 kHz mono float32.

    From a file, not a pipe: an m4a usually keeps its index at the end, which ffmpeg can't seek to
    on a pipe. /tmp is the only writable place in Lambda.
    """
    with tempfile.NamedTemporaryFile(dir="/tmp", suffix=".audio") as source:
        source.write(data)
        source.flush()
        done = subprocess.run(
            [get_ffmpeg_exe(), "-v", "error", "-i", source.name, "-ac", "1",
             "-ar", str(config.SV_SAMPLE_RATE), "-f", "f32le", "pipe:1"],
            capture_output=True, check=True, timeout=30)
    y = np.frombuffer(done.stdout, dtype=np.float32).copy()
    if len(y) == 0:
        raise ValueError("the recording decoded to no audio")
    return y


def speech_of(y: np.ndarray) -> np.ndarray:
    return y[vad.speech_mask(y)]


def voiceprint_of(y: np.ndarray):
    """(voiceprint or None, seconds of speech). None when there's too little speech to enrol."""
    speech = speech_of(y)
    seconds = len(speech) / config.SV_SAMPLE_RATE
    if seconds < MIN_ENROL_SPEECH_SECONDS:
        return None, seconds
    return enrol.voiceprint_from_speech(speech, embedder), seconds


def check(y: np.ndarray, voiceprint: np.ndarray) -> dict:
    """One recording against one voiceprint, by the frozen rule."""
    score, seconds = verify.score_clip(y, vad, embedder, voiceprint, min_speech=RULE["min_clip_speech_seconds"])
    result = decide.check_clip(score, seconds, RULE["threshold"], min_speech=RULE["min_clip_speech_seconds"])
    return {"result": result, "score": None if math.isnan(score) else round(score, 4),
            "speechSeconds": round(seconds, 2), "threshold": RULE["threshold"],
            "modelRevision": config.SV_MODEL_REVISION}


def read(bucket: str, key: str) -> bytes:
    return s3.get_object(Bucket=bucket, Key=key)["Body"].read()


def handler(event, _context):
    mode = event["mode"]
    if mode == "verify":
        voiceprint = np.load(io.BytesIO(read(VOICEPRINT_BUCKET, event["voiceprintKey"])))
        return check(decode(read(AUDIO_BUCKET, event["audioKey"])), voiceprint)
    if mode == "enrol":
        try:
            voiceprint, seconds = voiceprint_of(decode(read(AUDIO_BUCKET, event["audioKey"])))
        finally:
            # Enrolment audio is never kept, whether or not it made a voiceprint.
            s3.delete_object(Bucket=AUDIO_BUCKET, Key=event["audioKey"])
        if voiceprint is None:
            return {"enrolled": False, "speechSeconds": round(seconds, 2)}
        buffer = io.BytesIO()
        np.save(buffer, voiceprint.astype(np.float32))
        s3.put_object(Bucket=VOICEPRINT_BUCKET, Key=event["voiceprintKey"], Body=buffer.getvalue())
        return {"enrolled": True, "speechSeconds": round(seconds, 2), "modelRevision": config.SV_MODEL_REVISION}
    if mode == "remove":
        s3.delete_object(Bucket=VOICEPRINT_BUCKET, Key=event["voiceprintKey"])
        return {}
    raise ValueError(f"unknown mode {mode!r}")
