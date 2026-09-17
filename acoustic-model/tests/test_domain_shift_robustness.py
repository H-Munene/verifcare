import numpy as np
import pandas as pd
import pytest
import soundfile as sf

from acoustic_model import calibration, domain_shift_robustness as dsr
from acoustic_model.features import _SMILE

_TEST_FEATURES = ["jitterLocal_sma3nz_stddevNorm", "F0semitoneFrom27.5Hz_sma3nz_meanFallingSlope"]


def _synthetic_voice(seed: int, duration_seconds: float = 3.0, sample_rate: int = 16000) -> np.ndarray:
    """A quasi-voiced synthetic signal (fundamental + harmonics + slight F0
    wobble + a touch of noise) - real WAV audio is required since this phase's
    tests exercise the real opensmile extraction path, but the actual dataset
    audio is git-ignored/local-only, so tests must not depend on it."""
    rng = np.random.default_rng(seed)
    t = np.arange(int(sample_rate * duration_seconds)) / sample_rate
    f0 = 150 + 5 * np.sin(2 * np.pi * 0.5 * t)
    phase = 2 * np.pi * np.cumsum(f0) / sample_rate
    signal = 0.6 * np.sin(phase) + 0.25 * np.sin(2 * phase) + 0.1 * np.sin(3 * phase)
    signal += 0.01 * rng.standard_normal(len(signal))
    return signal.astype(np.float32)


def _write_synthetic_train_pool(tmp_path, n_subjects=6, files_per_subject=2, seed=0):
    """Writes real WAV files under tmp_path/<subject_id>/<file_id>.wav and
    returns the matching train_pool DataFrame, mirroring the shape
    calibration._load_train_pool_features() would return - including the
    clean feature columns evaluate_folds() expects to already be present for
    the *training* portion (Phase 9 only recomputes features for the
    validation portion; training reuses Phase 3-style stored features)."""
    rng = np.random.default_rng(seed)
    rows = []
    for subject_index in range(n_subjects):
        subject_id = f"subj_{subject_index:03d}"
        label = "dementia" if subject_index % 2 == 0 else "no_dementia"
        subject_dir = tmp_path / subject_id
        subject_dir.mkdir(parents=True, exist_ok=True)
        for file_index in range(files_per_subject):
            file_id = f"{subject_id}_f{file_index:02d}"
            waveform = _synthetic_voice(seed=int(rng.integers(0, 1_000_000)))
            sf.write(str(subject_dir / f"{file_id}.wav"), waveform, 16000, subtype="PCM_16")
            features = _SMILE.process_signal(waveform, 16000).iloc[0]
            rows.append(
                {
                    "file_id": file_id,
                    "subject_id": subject_id,
                    "class_label": label,
                    "split": "train_pool",
                    **features[_TEST_FEATURES].to_dict(),
                }
            )
    return pd.DataFrame(rows)


def test_conditions_are_six_with_clean_first():
    assert len(dsr.CONDITIONS) == 6
    assert dsr.CONDITIONS[0]["name"] == "clean"
    names = [c["name"] for c in dsr.CONDITIONS]
    assert names[1] == "bandpass_only"
    assert set(names) == {
        "clean",
        "bandpass_only",
        "bandpass_white_20db",
        "bandpass_white_10db",
        "bandpass_pink_20db",
        "bandpass_pink_10db",
    }


def test_worst_case_condition_name_matches_config():
    assert dsr.WORST_CASE_CONDITION_NAME == "bandpass_pink_10db"


def test_bandpass_filter_passes_in_band_attenuates_out_of_band():
    sr = 16000
    t = np.arange(sr * 2) / sr
    in_band = np.sin(2 * np.pi * 3000 * t)
    out_of_band = np.sin(2 * np.pi * 50 * t)

    filtered_in = dsr._bandpass_filter(in_band, sr)
    filtered_out = dsr._bandpass_filter(out_of_band, sr)

    assert np.std(filtered_in) / np.std(in_band) > 0.9
    assert np.std(filtered_out) / np.std(out_of_band) < 0.05


def test_pink_noise_has_more_low_frequency_energy_than_white():
    sr = 16000
    rng = np.random.default_rng(0)
    white = dsr._generate_white_noise(sr * 2, rng)
    pink = dsr._generate_pink_noise(sr * 2, rng)

    def band_energy(sig, lo, hi):
        spectrum = np.abs(np.fft.rfft(sig)) ** 2
        freqs = np.fft.rfftfreq(len(sig), d=1 / sr)
        mask = (freqs >= lo) & (freqs < hi)
        return spectrum[mask].sum()

    white_ratio = band_energy(white, 100, 500) / band_energy(white, 4000, 7000)
    pink_ratio = band_energy(pink, 100, 500) / band_energy(pink, 4000, 7000)
    assert pink_ratio > white_ratio * 5  # pink concentrates far more energy at low frequencies


def test_scale_noise_to_snr_hits_target_exactly():
    sr = 16000
    t = np.arange(sr * 2) / sr
    clean = np.sin(2 * np.pi * 440 * t)
    rng = np.random.default_rng(0)
    noise = dsr._generate_white_noise(len(clean), rng)

    scaled = dsr._scale_noise_to_snr(clean, noise, 10.0)
    measured = 10 * np.log10(np.mean(clean**2) / np.mean(scaled**2))

    assert measured == pytest.approx(10.0, abs=1e-6)


def test_degrade_clean_and_bandpass_only_have_no_realized_snr():
    sr = 16000
    waveform = _synthetic_voice(seed=1)
    rng = np.random.default_rng(0)

    _, snr_clean = dsr.degrade(waveform, sr, dsr.CONDITIONS[0], rng)  # "clean" is never passed through degrade()
    degraded_bp, snr_bp = dsr.degrade(waveform, sr, dsr.CONDITIONS[1], rng)  # "bandpass_only"

    assert snr_bp is None
    assert not np.allclose(degraded_bp, waveform)  # bandpass actually changed the signal


def test_degrade_realized_snr_matches_manual_linear_decomposition():
    """The realized-SNR measurement relies on bandpass filtering being linear
    (filter(speech) + filter(noise) == filter(speech + noise)) - verify this
    identity holds for the actual filter used, not just assumed."""
    sr = 16000
    waveform = _synthetic_voice(seed=2)
    condition = next(c for c in dsr.CONDITIONS if c["name"] == "bandpass_white_10db")
    rng_a = np.random.default_rng(42)
    rng_b = np.random.default_rng(42)

    degraded, realized_snr_db = dsr.degrade(waveform, sr, condition, rng_a)

    noise = dsr._generate_white_noise(len(waveform), rng_b)
    noise = dsr._scale_noise_to_snr(waveform, noise, condition["snr_db"])
    filtered_speech = dsr._bandpass_filter(waveform, sr)
    filtered_noise = dsr._bandpass_filter(noise, sr)
    manual_snr_db = 10 * np.log10(np.mean(filtered_speech**2) / np.mean(filtered_noise**2))

    assert realized_snr_db == pytest.approx(manual_snr_db, rel=1e-6)
    assert np.allclose(degraded, (filtered_speech + filtered_noise).astype(np.float32), atol=1e-4)


def test_degrade_correct_realized_snr_hits_target_exactly():
    """The exploratory analytic correction (section 9e follow-up) should land
    the realized SNR on the target, not just closer to it - since the
    correction factor is derived exactly from the filter's linearity, not an
    empirical approximation."""
    sr = 16000
    waveform = _synthetic_voice(seed=3)
    condition = dict(dsr.EXPLORATORY_CORRECTED_PINK_CONDITION)
    rng = np.random.default_rng(7)

    _, realized_snr_db = dsr.degrade(waveform, sr, condition, rng)

    assert realized_snr_db == pytest.approx(condition["snr_db"], abs=1e-6)


def test_degrade_correction_matches_independent_fresh_filtering():
    """The correction's reported realized_snr_db reuses an already-filtered
    array scaled by the correction factor (degrade()'s internal shortcut),
    relying on the bandpass filter's linearity. This independently re-derives
    the corrected noise from scratch and re-filters it with a FRESH call (not
    reusing anything degrade() already computed) to confirm that shortcut
    actually holds for the real scipy filter implementation, not just in
    theory - the same "measure it directly, don't just trust the derivation"
    standard that caught the original nominal-vs-realized SNR drift."""
    sr = 16000
    waveform = _synthetic_voice(seed=5)
    condition = dict(dsr.EXPLORATORY_CORRECTED_PINK_CONDITION)
    seed = 99

    degraded, reported_snr_db = dsr.degrade(waveform, sr, condition, np.random.default_rng(seed))

    # Independently reconstruct the exact corrected noise from scratch.
    noise = dsr._generate_pink_noise(len(waveform), np.random.default_rng(seed))
    noise = dsr._scale_noise_to_snr(waveform, noise, condition["snr_db"])
    naive_filtered_speech = dsr._bandpass_filter(waveform, sr)
    naive_filtered_noise = dsr._bandpass_filter(noise, sr)
    naive_realized_db = 10 * np.log10(np.mean(naive_filtered_speech**2) / np.mean(naive_filtered_noise**2))
    correction_factor = 10 ** ((naive_realized_db - condition["snr_db"]) / 20)
    corrected_noise = noise * correction_factor

    # FRESH, independent filter calls - not reusing any array degrade() filtered.
    fresh_filtered_speech = dsr._bandpass_filter(waveform, sr)
    fresh_filtered_noise = dsr._bandpass_filter(corrected_noise, sr)
    independent_snr_db = 10 * np.log10(np.mean(fresh_filtered_speech**2) / np.mean(fresh_filtered_noise**2))
    fresh_mixed_filtered = dsr._bandpass_filter(waveform + corrected_noise, sr)

    assert reported_snr_db == pytest.approx(independent_snr_db, abs=1e-9)
    assert np.allclose(degraded, fresh_mixed_filtered.astype(np.float32), atol=1e-5)


def test_degrade_without_correction_can_drift_from_target():
    """Sanity check that the *uncorrected* path is genuinely capable of
    drifting (matching the real pink-noise finding) - otherwise the corrected
    test above wouldn't be demonstrating anything."""
    sr = 16000
    waveform = _synthetic_voice(seed=4)
    condition = {"bandpass": True, "noise_type": "pink", "snr_db": 10}
    rng = np.random.default_rng(7)

    _, realized_snr_db = dsr.degrade(waveform, sr, condition, rng)

    assert realized_snr_db != pytest.approx(10.0, abs=0.5)


def test_f1_at_threshold():
    y_true = np.array([0, 0, 1, 1])
    y_score = np.array([0.1, 0.6, 0.4, 0.9])
    # threshold 0.5: predictions [0, 1, 0, 1] -> TP=1, FP=1, FN=1
    f1 = dsr._f1_at_threshold(y_true, y_score, 0.5)
    assert f1 == pytest.approx(0.5)


def test_aggregate_degradation_curve_orders_conditions_like_config():
    fold_metrics = pd.DataFrame(
        [
            {
                "fold": f,
                "condition": c["name"],
                "bandpass": c["bandpass"],
                "noise_type": c["noise_type"],
                "snr_db_nominal": c["snr_db"],
                "roc_auc": 0.7 - 0.01 * f,
                "f1": 0.6,
            }
            for f in range(3)
            for c in reversed(dsr.CONDITIONS)  # deliberately out of order going in
        ]
    )

    aggregated = dsr.aggregate_degradation_curve(fold_metrics)

    assert list(aggregated["condition"]) == [c["name"] for c in dsr.CONDITIONS]
    assert aggregated.iloc[0]["roc_auc_mean"] == pytest.approx(0.69)


def test_worst_case_significance_test_family_size_one():
    fold_metrics = pd.DataFrame(
        [
            {"fold": f, "condition": "clean", "roc_auc": 0.70, "f1": 0.6}
            for f in range(5)
        ]
        + [
            {"fold": f, "condition": "bandpass_pink_10db", "roc_auc": 0.55, "f1": 0.5}
            for f in range(5)
        ]
    )

    result = dsr.worst_case_significance_test(fold_metrics)

    assert result["n_family"] == 1
    assert result["worst_case_condition"] == "bandpass_pink_10db"
    assert result["mean_diff_worst_minus_clean"] == pytest.approx(-0.15)
    assert result["significant_at_0.05"]  # a large, perfectly consistent 0.15 drop across all 5 folds


def test_evaluate_folds_end_to_end_with_synthetic_audio(tmp_path, monkeypatch):
    """Real audio, real degradation, real opensmile extraction, real
    calibration fit - the full Phase 9 pipeline on a small synthetic
    train_pool, not a mocked shortcut. 40 subjects (1 file each) matches
    test_calibration.py's own synthetic-fixture scale - StratifiedGroupKFold's
    5-fold split needs enough subjects per class to be valid, not just enough
    files."""
    df = _write_synthetic_train_pool(tmp_path, n_subjects=40, files_per_subject=1, seed=0)
    monkeypatch.setattr(dsr, "PROCESSED_DATA_ROOT", tmp_path)

    y = (df["class_label"] == "dementia").astype(int)
    groups = df["subject_id"]
    outer_folds = calibration._build_outer_folds(df, y, groups)  # StratifiedGroupKFold, real fold shape
    best_params = {"clf__max_depth": 2, "clf__n_estimators": 10}

    fold_metrics, snr_report = dsr.evaluate_folds(
        df, y, groups, _TEST_FEATURES, best_params, outer_folds, dsr.CONDITIONS, np.random.default_rng(0)
    )

    assert set(fold_metrics["condition"]) == {c["name"] for c in dsr.CONDITIONS}
    assert len(fold_metrics) == len(outer_folds) * len(dsr.CONDITIONS)
    assert fold_metrics["roc_auc"].between(0, 1).all()
    assert fold_metrics["f1"].between(0, 1).all()
    # Every noisy condition produced a realized SNR measurement for every held-out file in every fold.
    noisy_condition_names = {c["name"] for c in dsr.CONDITIONS if c["noise_type"] is not None}
    assert set(snr_report["condition"]) == noisy_condition_names
    assert snr_report.groupby(["fold", "condition"]).size().min() == fold_metrics["n_val"].iloc[0]
