import numpy as np
import pandas as pd
import soundfile as sf

from acoustic_model.config import EGEMAPS_FEATURE_COUNT
from acoustic_model.features import (
    _channel_quality_cross_check,
    _class_label_voice_quality_check,
    _correlation_matrix,
    _missing_value_report,
    extract_file,
)

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


def _synthetic_feature_df(n=100, seed=0, shared_signal=None):
    rng = np.random.default_rng(seed)
    if shared_signal is None:
        shared_signal = rng.normal(size=n)
    return shared_signal, pd.DataFrame(
        {
            "file_id": [f"f{i}" for i in range(n)],
            "jitterLocal_sma3nz_amean": shared_signal + rng.normal(scale=0.01, size=n),
            "shimmerLocaldB_sma3nz_amean": rng.normal(size=n),
            "HNRdBACF_sma3nz_amean": rng.normal(size=n),
        }
    )


def test_channel_quality_cross_check_detects_a_strong_correlation():
    rng = np.random.default_rng(0)
    n = 100
    shared_signal, feature_df = _synthetic_feature_df(n=n, seed=0)
    proxy_df = pd.DataFrame(
        {
            "file_id": [f"f{i}" for i in range(n)],
            "noise_floor_db": shared_signal + rng.normal(scale=0.01, size=n),
            "spectral_bandwidth_hz": rng.normal(size=n),
            "spectral_flatness": rng.normal(size=n),
        }
    )

    result = _channel_quality_cross_check(feature_df, proxy_df)

    assert len(result) == 9  # 3 voice-quality columns x 3 channel-quality proxies

    strong_pair = result[
        (result["voice_quality_feature"] == "jitterLocal_sma3nz_amean")
        & (result["channel_quality_proxy"] == "noise_floor_db")
    ].iloc[0]
    assert strong_pair["pearson_r"] > 0.95
    assert strong_pair["pearson_p_bonferroni_family"] < 0.05
    assert strong_pair["pearson_p_bonferroni_strict"] < 0.05

    unrelated_pair = result[
        (result["voice_quality_feature"] == "shimmerLocaldB_sma3nz_amean")
        & (result["channel_quality_proxy"] == "spectral_bandwidth_hz")
    ].iloc[0]
    assert abs(unrelated_pair["pearson_r"]) < 0.5


def test_channel_quality_cross_check_strict_correction_is_never_looser_than_family():
    _, feature_df = _synthetic_feature_df(n=50, seed=1)
    rng = np.random.default_rng(1)
    proxy_df = pd.DataFrame(
        {
            "file_id": feature_df["file_id"],
            "noise_floor_db": rng.normal(size=50),
            "spectral_bandwidth_hz": rng.normal(size=50),
            "spectral_flatness": rng.normal(size=50),
        }
    )

    result = _channel_quality_cross_check(feature_df, proxy_df)

    for _, row in result.iterrows():
        assert row["pearson_p_bonferroni_strict"] >= row["pearson_p_bonferroni_family"]
        assert row["spearman_p_bonferroni_strict"] >= row["spearman_p_bonferroni_family"]


def test_class_label_voice_quality_check_subject_level_avoids_pseudo_replication():
    # Two subjects, each with 3 identical-valued files - a naive file-level test
    # would see n=6, but the subject-level check must collapse this to n=2.
    feature_df = pd.DataFrame(
        {
            "file_id": [f"f{i}" for i in range(6)],
            "subject_id": ["subj_A"] * 3 + ["subj_B"] * 3,
            "class_label": ["dementia"] * 3 + ["no_dementia"] * 3,
            "jitterLocal_sma3nz_amean": [5.0] * 3 + [1.0] * 3,
            "shimmerLocaldB_sma3nz_amean": [0.0] * 6,
            "HNRdBACF_sma3nz_amean": [0.0] * 6,
        }
    )

    subject_df, file_df = _class_label_voice_quality_check(feature_df)

    jitter_subject = subject_df[subject_df["voice_quality_feature"] == "jitterLocal_sma3nz_amean"].iloc[0]
    jitter_file = file_df[file_df["voice_quality_feature"] == "jitterLocal_sma3nz_amean"].iloc[0]
    assert jitter_subject["n"] == 2
    assert jitter_file["n"] == 6


def test_missing_value_report_flags_nan_and_voicing_dependent_zeros():
    feature_df = pd.DataFrame(
        {
            "jitterLocal_sma3nz_amean": [0.01, 0.02, np.nan],
            "shimmerLocaldB_sma3nz_amean": [0.0, 1.0, 2.0],  # a voicing-dependent zero
            "some_other_feature": [1.0, 2.0, 3.0],
        }
    )

    report = _missing_value_report(feature_df, list(feature_df.columns))

    jitter_row = report[report["feature"] == "jitterLocal_sma3nz_amean"].iloc[0]
    shimmer_row = report[report["feature"] == "shimmerLocaldB_sma3nz_amean"].iloc[0]
    other_row = report[report["feature"] == "some_other_feature"].iloc[0]

    assert jitter_row["nan_count"] == 1
    assert shimmer_row["exact_zero_count"] == 1
    assert pd.isna(other_row["exact_zero_count"])  # not a voicing-dependent column, not checked


def test_correlation_matrix_flags_high_correlation_pairs():
    n = 50
    x = np.linspace(0, 1, n)
    feature_df = pd.DataFrame(
        {
            "feature_a": x,
            "feature_b": x * 2 + 0.001,  # near-perfectly correlated with feature_a
            "feature_c": np.random.default_rng(0).normal(size=n),  # unrelated
        }
    )

    _, high_pairs = _correlation_matrix(feature_df, list(feature_df.columns))

    flagged = set(zip(high_pairs["feature_a"], high_pairs["feature_b"]))
    assert ("feature_a", "feature_b") in flagged
    assert not any("feature_c" in pair for pair in flagged)
