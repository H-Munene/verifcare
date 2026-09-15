import numpy as np

from acoustic_model.channel_quality import compute

_SAMPLE_RATE_HZ = 22050


def _sine(duration_seconds=2.0, freq_hz=220, amplitude=0.5, sample_rate=_SAMPLE_RATE_HZ):
    n_samples = int(duration_seconds * sample_rate)
    t = np.arange(n_samples) / sample_rate
    return amplitude * np.sin(2 * np.pi * freq_hz * t)


def test_added_noise_raises_the_noise_floor():
    rng = np.random.default_rng(0)
    clean = _sine()
    noisy = clean + rng.normal(scale=0.05, size=clean.shape)

    clean_proxies = compute(clean.astype(np.float32), _SAMPLE_RATE_HZ)
    noisy_proxies = compute(noisy.astype(np.float32), _SAMPLE_RATE_HZ)

    assert noisy_proxies.noise_floor_db > clean_proxies.noise_floor_db


def test_white_noise_has_wider_spectral_bandwidth_than_a_pure_tone():
    rng = np.random.default_rng(0)
    tone = _sine()
    white_noise = rng.normal(scale=0.2, size=tone.shape).astype(np.float32)

    tone_proxies = compute(tone.astype(np.float32), _SAMPLE_RATE_HZ)
    noise_proxies = compute(white_noise, _SAMPLE_RATE_HZ)

    assert noise_proxies.spectral_bandwidth_hz > tone_proxies.spectral_bandwidth_hz


def test_compute_handles_stereo_input_by_averaging_channels():
    mono = _sine().astype(np.float32)
    stereo = np.stack([mono, mono])

    mono_proxies = compute(mono, _SAMPLE_RATE_HZ)
    stereo_proxies = compute(stereo, _SAMPLE_RATE_HZ)

    assert abs(mono_proxies.noise_floor_db - stereo_proxies.noise_floor_db) < 0.5
