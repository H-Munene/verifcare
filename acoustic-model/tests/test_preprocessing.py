import numpy as np
import pytest
import soundfile as sf

from acoustic_model import preprocessing
from acoustic_model.config import MIN_USABLE_DURATION_SECONDS, TARGET_SAMPLE_RATE_HZ

_SAMPLE_RATE_HZ = 44100


def _write_wav_with_silence_padding(path, tone_seconds=5.0, silence_seconds=2.0):
    n_tone = int(tone_seconds * _SAMPLE_RATE_HZ)
    n_silence = int(silence_seconds * _SAMPLE_RATE_HZ)
    tone = 0.3 * np.sin(2 * np.pi * 220 * np.arange(n_tone) / _SAMPLE_RATE_HZ)
    silence = np.zeros(n_silence, dtype=np.float32)
    waveform = np.concatenate([silence, tone, silence]).astype(np.float32)
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), waveform, _SAMPLE_RATE_HZ, subtype="PCM_16")


def _write_short_wav(path, tone_seconds):
    n = int(tone_seconds * _SAMPLE_RATE_HZ)
    tone = 0.3 * np.sin(2 * np.pi * 220 * np.arange(n) / _SAMPLE_RATE_HZ)
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), tone.astype(np.float32), _SAMPLE_RATE_HZ, subtype="PCM_16")


def test_process_file_trims_silence_and_resamples(tmp_path):
    source = tmp_path / "source.wav"
    output = tmp_path / "out" / "processed.wav"
    _write_wav_with_silence_padding(source, tone_seconds=5.0, silence_seconds=2.0)

    result = preprocessing.process_file(source, output)

    assert result.included
    assert result.error is None
    assert result.raw_duration_seconds > result.post_trim_duration_seconds
    assert result.post_trim_duration_seconds == pytest.approx(5.0, abs=0.2)
    assert result.silence_trimmed_seconds == pytest.approx(4.0, abs=0.2)

    assert output.exists()
    written_waveform, written_sr = sf.read(str(output))
    assert written_sr == TARGET_SAMPLE_RATE_HZ


def test_process_file_excludes_audio_below_minimum_duration(tmp_path):
    source = tmp_path / "short.wav"
    output = tmp_path / "out" / "short.wav"
    too_short = max(MIN_USABLE_DURATION_SECONDS - 1.0, 0.5)
    _write_short_wav(source, tone_seconds=too_short)

    result = preprocessing.process_file(source, output)

    assert not result.included
    assert result.exclusion_reason == "post_trim_duration_below_threshold"
    assert not output.exists()


def test_process_file_handles_unreadable_file(tmp_path):
    source = tmp_path / "not_audio.wav"
    output = tmp_path / "out" / "not_audio.wav"
    source.write_bytes(b"garbage, not a wav file")

    result = preprocessing.process_file(source, output)

    assert not result.included
    assert result.exclusion_reason == "unreadable"
    assert result.error is not None
    assert not output.exists()
