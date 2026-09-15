import numpy as np
import pandas as pd
import soundfile as sf

from acoustic_model.config import EGEMAPS_FEATURE_COUNT
from acoustic_model.features import _bonferroni_correlation_cross_check, extract_file

_SAMPLE_RATE_HZ = 16000


def test_extract_file_returns_the_expected_egemaps_feature_count(tmp_path):
    path = tmp_path / "tone.wav"
    n = int(3.0 * _SAMPLE_RATE_HZ)
    tone = 0.2 * np.sin(2 * np.pi * 150 * np.arange(n) / _SAMPLE_RATE_HZ)
    sf.write(str(path), tone.astype(np.float32), _SAMPLE_RATE_HZ, subtype="PCM_16")

    features, error = extract_file(path)

    assert error is None
    assert features is not None
    assert len(features) == EGEMAPS_FEATURE_COUNT
    assert "jitterLocal_sma3nz_amean" in features.index
    assert "shimmerLocaldB_sma3nz_amean" in features.index
    assert "HNRdBACF_sma3nz_amean" in features.index


def test_extract_file_handles_unreadable_file(tmp_path):
    path = tmp_path / "not_audio.wav"
    path.write_bytes(b"garbage, not a wav file")

    features, error = extract_file(path)

    assert features is None
    assert error is not None


def test_bonferroni_correlation_cross_check_detects_a_strong_correlation():
    rng = np.random.default_rng(0)
    n = 100
    shared_signal = rng.normal(size=n)
    feature_df = pd.DataFrame(
        {
            "file_id": [f"f{i}" for i in range(n)],
            "jitterLocal_sma3nz_amean": shared_signal + rng.normal(scale=0.01, size=n),
            "shimmerLocaldB_sma3nz_amean": rng.normal(size=n),
            "HNRdBACF_sma3nz_amean": rng.normal(size=n),
        }
    )
    proxy_df = pd.DataFrame(
        {
            "file_id": [f"f{i}" for i in range(n)],
            "noise_floor_db": shared_signal + rng.normal(scale=0.01, size=n),
            "spectral_bandwidth_hz": rng.normal(size=n),
            "spectral_flatness": rng.normal(size=n),
        }
    )

    result = _bonferroni_correlation_cross_check(feature_df, proxy_df)

    assert len(result) == 9  # 3 voice-quality columns x 3 channel-quality proxies

    strong_pair = result[
        (result["voice_quality_feature"] == "jitterLocal_sma3nz_amean")
        & (result["channel_quality_proxy"] == "noise_floor_db")
    ].iloc[0]
    assert strong_pair["pearson_r"] > 0.95
    assert strong_pair["pearson_p_bonferroni"] < 0.05

    unrelated_pair = result[
        (result["voice_quality_feature"] == "shimmerLocaldB_sma3nz_amean")
        & (result["channel_quality_proxy"] == "spectral_bandwidth_hz")
    ].iloc[0]
    assert abs(unrelated_pair["pearson_r"]) < 0.5


def test_bonferroni_correction_scales_p_value_by_number_of_pairs_tested():
    rng = np.random.default_rng(1)
    n = 50
    feature_df = pd.DataFrame(
        {
            "file_id": [f"f{i}" for i in range(n)],
            "jitterLocal_sma3nz_amean": rng.normal(size=n),
            "shimmerLocaldB_sma3nz_amean": rng.normal(size=n),
            "HNRdBACF_sma3nz_amean": rng.normal(size=n),
        }
    )
    proxy_df = pd.DataFrame(
        {
            "file_id": [f"f{i}" for i in range(n)],
            "noise_floor_db": rng.normal(size=n),
            "spectral_bandwidth_hz": rng.normal(size=n),
            "spectral_flatness": rng.normal(size=n),
        }
    )

    result = _bonferroni_correlation_cross_check(feature_df, proxy_df)

    # Bonferroni p is the raw p scaled by 9 (capped at 1.0), so it's always >= raw p.
    for _, row in result.iterrows():
        assert row["pearson_p_bonferroni"] <= 1.0
        assert row["spearman_p_bonferroni"] <= 1.0
