import numpy as np
import soundfile as sf

from acoustic_model import audio_io
from acoustic_model.config import EXPECTED_CHANNELS, EXPECTED_SAMPLE_RATE_HZ


def _write_wav(path, duration_seconds=1.0, sample_rate=EXPECTED_SAMPLE_RATE_HZ, channels=EXPECTED_CHANNELS):
    n_samples = int(duration_seconds * sample_rate)
    tone = 0.1 * np.sin(2 * np.pi * 440 * np.arange(n_samples) / sample_rate)
    waveform = np.tile(tone[:, None], (1, channels)) if channels > 1 else tone
    sf.write(str(path), waveform, sample_rate, subtype="PCM_16")


def test_inspect_conforming_file(tmp_path):
    path = tmp_path / "conforming.wav"
    _write_wav(path, duration_seconds=2.0)

    info = audio_io.inspect(path)

    assert info.readable
    assert info.format_ok
    assert info.error is None
    assert info.channels == EXPECTED_CHANNELS
    assert info.sample_rate_hz == EXPECTED_SAMPLE_RATE_HZ
    assert info.duration_seconds is not None and abs(info.duration_seconds - 2.0) < 0.01
    assert len(info.sha256) == 64


def test_inspect_flags_non_conforming_sample_rate(tmp_path):
    path = tmp_path / "wrong_rate.wav"
    _write_wav(path, sample_rate=16000)

    info = audio_io.inspect(path)

    assert info.readable
    assert not info.format_ok


def test_inspect_flags_non_conforming_channels(tmp_path):
    path = tmp_path / "mono.wav"
    _write_wav(path, channels=1)

    info = audio_io.inspect(path)

    assert info.readable
    assert not info.format_ok


def test_inspect_handles_unreadable_file(tmp_path):
    path = tmp_path / "not_audio.wav"
    path.write_bytes(b"this is not a wav file")

    info = audio_io.inspect(path)

    assert not info.readable
    assert not info.format_ok
    assert info.error is not None


def test_inspect_same_content_same_hash(tmp_path):
    path_a = tmp_path / "a.wav"
    path_b = tmp_path / "b.wav"
    _write_wav(path_a, duration_seconds=1.0)
    _write_wav(path_b, duration_seconds=1.0)

    assert audio_io.inspect(path_a).sha256 == audio_io.inspect(path_b).sha256
