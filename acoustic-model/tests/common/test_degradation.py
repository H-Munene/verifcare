import numpy as np
import pytest

from mzazi_acoustic.common import degradation

SR = 16_000


@pytest.mark.parametrize("noise_type", ["white", "pink"])
@pytest.mark.parametrize("snr_db", [20.0, 10.0])
def test_snr_after_filtering_hits_the_target(noise_type, snr_db):
    rng = np.random.default_rng(1)
    t = np.arange(3 * SR) / SR
    speech = 0.3 * np.sin(2 * np.pi * 200 * t) * (np.sin(2 * np.pi * 1.5 * t) > 0)  # tone with gaps
    degraded, reported = degradation.degrade(speech, SR, noise_type, snr_db, rng)

    # Measure independently: the added noise is whatever differs from the filtered clean signal.
    clean = degradation.bandpass(speech, SR)
    measured = 10 * np.log10(degradation.power(clean) / degradation.power(degraded - clean))
    assert measured == pytest.approx(snr_db, abs=0.01)
    assert reported == pytest.approx(snr_db, abs=0.01)


def test_pink_noise_has_more_low_frequency_power_than_white():
    rng = np.random.default_rng(2)
    pink, white = degradation.pink_noise(SR * 4, rng), degradation.white_noise(SR * 4, rng)

    def low_share(x):
        spectrum = np.abs(np.fft.rfft(x)) ** 2
        freqs = np.fft.rfftfreq(len(x), 1 / SR)
        return spectrum[freqs < 500].sum() / spectrum.sum()

    assert low_share(pink) > 5 * low_share(white)


def test_conditions_cover_bandpass_alone_and_every_noise_snr_pair():
    names = [name for name, _, _ in degradation.conditions()]
    assert names[0] == "bandpass" and len(names) == 5
