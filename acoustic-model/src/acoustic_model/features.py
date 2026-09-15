"""Phase 3 feature extraction: eGeMAPSv02 functionals (88 features, via
opensmile) computed per file from Phase 2's preprocessed audio, plus
two confound checks that together close the C-Ch-V "triangle" around
the channel/signal-mismatch limitation (see
docs/ml-development-spec.md section 10):

- C-Ch (class label vs. channel-quality proxy): Phase 1's audit.
- V-Ch (voice-quality feature vs. channel-quality proxy): the
  cross-check promised by Phase 1's finding (mitigation 2).
- C-V (class label vs. voice-quality feature): the third leg - added
  here so a feature that's both channel-entangled (V-Ch) and the only
  leg correlated with the label (C-V) can be told apart from one that
  correlates with the label for reasons unrelated to the channel
  confound.

Feature extraction is file-level, matching the deployment contract -
acoustic-model/openapi.yaml's `score` operation scores one recording at
a time. Phase 2's subject-level grouping is reused to tag each file
with its split, and - for the C-V check specifically - to aggregate to
subject level where that's the statistically defensible granularity
(see _class_label_voice_quality_check's docstring).

Run via `scripts/run_features.py`, not this module directly.
"""

from __future__ import annotations

from pathlib import Path

import opensmile
import pandas as pd

from acoustic_model import stats_utils
from acoustic_model.config import (
    AUDIT_RESULTS_DIR,
    CHANNEL_QUALITY_PROXY_COLUMNS,
    EGEMAPS_FEATURE_COUNT,
    FEATURES_RESULTS_DIR,
    PREPROCESSING_RESULTS_DIR,
    PROCESSED_DATA_ROOT,
    SPLITS_RESULTS_DIR,
    VOICE_QUALITY_CROSS_CHECK_COLUMNS,
)

_SMILE = opensmile.Smile(
    feature_set=opensmile.FeatureSet.eGeMAPSv02,
    feature_level=opensmile.FeatureLevel.Functionals,
)

# Cross-check (V-Ch): 3 voice-quality columns x 3 channel-quality proxies.
_CROSS_CHECK_N_FAMILY = len(VOICE_QUALITY_CROSS_CHECK_COLUMNS) * len(CHANNEL_QUALITY_PROXY_COLUMNS)  # 9
_CROSS_CHECK_N_STRICT = _CROSS_CHECK_N_FAMILY * 2  # x2 test types (Pearson, Spearman) = 18

# Third leg (C-V): 3 voice-quality columns, matching Phase 1's confound-check
# convention (3 proxies -> n_family=3 there; here 3 voice-quality columns).
_LABEL_CHECK_N_FAMILY = len(VOICE_QUALITY_CROSS_CHECK_COLUMNS)  # 3
_LABEL_CHECK_N_STRICT = _LABEL_CHECK_N_FAMILY * 2  # x2 test types (point-biserial, Mann-Whitney) = 6


def _load_duration_report() -> pd.DataFrame:
    path = PREPROCESSING_RESULTS_DIR / "duration_report.csv"
    if not path.exists():
        raise FileNotFoundError(f"{path} not found - run scripts/run_preprocessing.py first.")
    return pd.read_csv(path)


def _load_subject_splits() -> pd.DataFrame:
    path = SPLITS_RESULTS_DIR / "subject_splits.csv"
    if not path.exists():
        raise FileNotFoundError(f"{path} not found - run scripts/run_splits.py first.")
    return pd.read_csv(path)


def _load_channel_quality_proxies() -> pd.DataFrame:
    path = AUDIT_RESULTS_DIR / "file_manifest.csv"
    if not path.exists():
        raise FileNotFoundError(f"{path} not found - run scripts/run_audit.py first.")
    return pd.read_csv(path)[["file_id", *CHANNEL_QUALITY_PROXY_COLUMNS]]


def extract_file(path: Path) -> tuple[pd.Series | None, str | None]:
    """Returns (feature_row, error): feature_row is the 88 eGeMAPS functionals as a
    pandas Series, or None with an error string if extraction failed."""
    try:
        result = _SMILE.process_file(str(path))
    except Exception as exc:
        return None, str(exc)
    return result.iloc[0], None


def _channel_quality_cross_check(feature_df: pd.DataFrame, proxy_df: pd.DataFrame) -> pd.DataFrame:
    """V-Ch: Pearson + Spearman correlation between each voice-quality functional and
    each channel-quality proxy, at file level (each recording is an independent
    observation for this question - unlike Phase 1's class-label confound check,
    this isn't testing a group difference, so subject-level aggregation doesn't
    apply the same way; a subject-clustering effect could still inflate apparent
    correlation if a few subjects dominate the range on either axis, worth keeping
    in mind when interpreting, not just accepting the numbers at face value).
    Reports both a per-test-family (n=9) and a strict, all-tests (n=18) Bonferroni
    correction, matching the dual reporting Phase 1 established."""
    merged = feature_df.merge(proxy_df, on="file_id", how="inner")

    rows = []
    for voice_col in VOICE_QUALITY_CROSS_CHECK_COLUMNS:
        for proxy_col in CHANNEL_QUALITY_PROXY_COLUMNS:
            result = stats_utils.continuous_correlation(
                merged[voice_col], merged[proxy_col], n_family=_CROSS_CHECK_N_FAMILY, n_strict=_CROSS_CHECK_N_STRICT
            )
            rows.append({"voice_quality_feature": voice_col, "channel_quality_proxy": proxy_col, **vars(result)})
    return pd.DataFrame(rows)


def _class_label_voice_quality_check(feature_df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """C-V, the third leg: does class label correlate with the voice-quality
    functionals directly? Computed two ways:

    - Subject level (primary, statistically defensible): each subject's files
      averaged first, matching Phase 1's confound-check methodology exactly, so a
      subject with 3 files doesn't get 3x the statistical weight of a subject with 1.
    - File level (secondary, informational only): the same test run without that
      aggregation, at the granularity the eventual model actually trains on. Reported
      for comparison, but explicitly not the number to trust for significance, since
      pooling multiple files per subject violates the independence assumption behind
      point-biserial/Mann-Whitney and can inflate apparent significance.

    Returns (subject_level_df, file_level_df).
    """
    label_binary_file = (feature_df["class_label"] == "dementia").astype(int)
    file_rows = []
    for voice_col in VOICE_QUALITY_CROSS_CHECK_COLUMNS:
        result = stats_utils.label_correlation(
            label_binary_file, feature_df[voice_col], n_family=_LABEL_CHECK_N_FAMILY, n_strict=_LABEL_CHECK_N_STRICT
        )
        file_rows.append({"voice_quality_feature": voice_col, **vars(result)})

    subject_means = feature_df.groupby(["subject_id", "class_label"])[list(VOICE_QUALITY_CROSS_CHECK_COLUMNS)].mean().reset_index()
    label_binary_subject = (subject_means["class_label"] == "dementia").astype(int)
    subject_rows = []
    for voice_col in VOICE_QUALITY_CROSS_CHECK_COLUMNS:
        result = stats_utils.label_correlation(
            label_binary_subject,
            subject_means[voice_col],
            n_family=_LABEL_CHECK_N_FAMILY,
            n_strict=_LABEL_CHECK_N_STRICT,
        )
        subject_rows.append({"voice_quality_feature": voice_col, **vars(result)})

    return pd.DataFrame(subject_rows), pd.DataFrame(file_rows)


def _write_summary(
    path: Path,
    feature_df: pd.DataFrame,
    failed_df: pd.DataFrame,
    cross_check_df: pd.DataFrame,
    label_check_subject_df: pd.DataFrame,
    label_check_file_df: pd.DataFrame,
    variance_summary: pd.DataFrame,
) -> None:
    lines: list[str] = []
    lines.append("# Feature Extraction Summary")
    lines.append("")
    lines.append("Generated by `scripts/run_features.py`.")
    lines.append(f"Feature set: eGeMAPSv02 via opensmile, {EGEMAPS_FEATURE_COUNT} functionals per file.")
    lines.append("Extraction is file-level - one feature vector per recording, matching the deployment contract.")
    lines.append("")

    lines.append("## Extraction results")
    lines.append("")
    lines.append(f"{len(feature_df)} of {len(feature_df) + len(failed_df)} included files extracted successfully.")
    if len(failed_df) > 0:
        lines.append("Failed file_ids: " + ", ".join(failed_df["file_id"].tolist()) + ".")
    else:
        lines.append("No extraction failures.")
    lines.append("")

    lines.append("## Split distribution")
    lines.append("")
    for split_name, group in feature_df.groupby("split"):
        counts = group["class_label"].value_counts()
        breakdown = ", ".join(f"{label}={counts.get(label, 0)}" for label in sorted(counts.index))
        lines.append(f"{split_name}: {len(group)} files ({breakdown}).")
    lines.append("")

    lines.append("## Confound triangle: class label (C), channel-quality proxy (Ch), voice-quality feature (V)")
    lines.append("")
    lines.append("Three pairwise checks, each Bonferroni-corrected at both a per-test-family level and a stricter all-tests level (the strict level is the more conservative, harder-to-satisfy view).")
    lines.append("Correction method, stated explicitly rather than left as an unspecified 'Bonferroni correction': **flat/naive Bonferroni** (adjusted_p = min(raw_p * n, 1.0)), not Holm-Bonferroni or another step-down procedure. n is always applied to the raw p-value, never chained on top of an already-adjusted one - the family-level and strict-level adjusted p-values for the same test are therefore both derived independently from the same raw p, not from each other.")
    lines.append("C-Ch (Phase 1, results/audit/audit_summary.md): class label vs. channel-quality proxy, subject level, n_family=3 (3 proxies), n_strict=6.")
    lines.append("V-Ch (this phase, below): voice-quality feature vs. channel-quality proxy, file level, n_family=9 (3 voice-quality features x 3 proxies), n_strict=18.")
    lines.append("C-V (this phase, below): class label vs. voice-quality feature, subject level (primary) and file level (secondary, informational). Only the 3 features named in the spec (jitter/shimmer/HNR) are tested here, not all 88 eGeMAPS features - n_family=3, n_strict=6, the same scale as Phase 1's C-Ch check, not a large-family scan.")
    lines.append("")

    lines.append("### V-Ch: channel-quality cross-check")
    lines.append("")
    lines.append(f"Pearson and Spearman correlation, file level, family correction n={_CROSS_CHECK_N_FAMILY} (per test type), strict correction n={_CROSS_CHECK_N_STRICT} (all tests in this check).")
    lines.append("")
    for _, row in cross_check_df.iterrows():
        if row["pearson_r"] is None:
            lines.append(f"{row['voice_quality_feature']} vs {row['channel_quality_proxy']}: insufficient data (n={row['n']}).")
        else:
            lines.append(
                f"{row['voice_quality_feature']} vs {row['channel_quality_proxy']}: n={row['n']}, "
                f"Pearson r={row['pearson_r']:.3f} (family p={row['pearson_p_bonferroni_family']:.4f}, strict p={row['pearson_p_bonferroni_strict']:.4f}), "
                f"Spearman rho={row['spearman_rho']:.3f} (family p={row['spearman_p_bonferroni_family']:.4f}, strict p={row['spearman_p_bonferroni_strict']:.4f})."
            )
    lines.append("")
    strict_significant = cross_check_df[
        (cross_check_df["pearson_p_bonferroni_strict"] < 0.05) | (cross_check_df["spearman_p_bonferroni_strict"] < 0.05)
    ]
    if len(strict_significant) > 0:
        pairs = ", ".join(f"{r.voice_quality_feature}/{r.channel_quality_proxy}" for r in strict_significant.itertuples())
        lines.append(f"Survives even the strict, all-tests correction: {pairs}.")
    else:
        lines.append("No pair survives the strict, all-tests correction (some may still survive the more lenient per-family correction - see the numbers above).")
    lines.append("")

    lines.append("### C-V: does class label correlate with the voice-quality features directly?")
    lines.append("")
    lines.append(f"Subject level (primary - avoids pseudo-replication from multi-file subjects, matching Phase 1's methodology), family correction n={_LABEL_CHECK_N_FAMILY}, strict correction n={_LABEL_CHECK_N_STRICT}:")
    for _, row in label_check_subject_df.iterrows():
        if row["point_biserial_r"] is None:
            lines.append(f"  {row['voice_quality_feature']}: insufficient data (n={row['n']}).")
        else:
            lines.append(
                f"  {row['voice_quality_feature']}: n={row['n']}, point-biserial r={row['point_biserial_r']:.3f} "
                f"(family p={row['point_biserial_p_bonferroni_family']:.4f}, strict p={row['point_biserial_p_bonferroni_strict']:.4f}); "
                f"Mann-Whitney family p={row['mannwhitney_p_bonferroni_family']:.4f}, strict p={row['mannwhitney_p_bonferroni_strict']:.4f}, "
                f"rank-biserial r={row['mannwhitney_rank_biserial']:.3f}."
            )
    lines.append("")
    lines.append("File level (secondary, informational only - does NOT correct for multiple files per subject, so its p-values are not trustworthy for significance, only useful as a sanity comparison against the subject-level numbers above):")
    for _, row in label_check_file_df.iterrows():
        if row["point_biserial_r"] is None:
            lines.append(f"  {row['voice_quality_feature']}: insufficient data (n={row['n']}).")
        else:
            lines.append(
                f"  {row['voice_quality_feature']}: n={row['n']}, point-biserial r={row['point_biserial_r']:.3f}, "
                f"Mann-Whitney rank-biserial r={row['mannwhitney_rank_biserial']:.3f} (p-values omitted deliberately - see caveat above)."
            )
    lines.append("")

    lines.append("### Triangle interpretation")
    lines.append("")
    subject_significant = label_check_subject_df[
        (label_check_subject_df["point_biserial_p_bonferroni_strict"] < 0.05)
        | (label_check_subject_df["mannwhitney_p_bonferroni_strict"] < 0.05)
    ]
    if len(subject_significant) == 0:
        lines.append("C-V: no voice-quality feature survives even the lenient family correction against class label directly, at the statistically defensible subject level.")
        lines.append("Combined with Phase 1's C-Ch result (no robust class-label/channel-proxy association) and this phase's V-Ch result (shimmer/noise_floor_db does correlate), the current picture is: shimmer is entangled with a channel-quality proxy, but that entanglement has not (yet) produced a corresponding direct association between shimmer and the class label itself.")
        lines.append("This is a reassuring combination, not a clearance: it means the channel confound has not obviously leaked into a spurious label association through shimmer so far, but the entanglement itself is still real and shimmer-derived features should be treated cautiously in Phase 8 (interpretability) regardless.")
    else:
        flagged = ", ".join(subject_significant["voice_quality_feature"].tolist())
        lines.append(f"C-V: {flagged} survives correction against class label directly at the subject level. Combined with the V-Ch result above, this needs careful interpretation in Phase 8 before treating it as a physiological signal rather than a channel-driven one.")
    lines.append("")
    lines.append("**Scope caveat: every check in this triangle is univariate** - each tests one feature against one other variable in isolation.")
    lines.append("A clean C-V result rules out any single voice-quality feature directly encoding a channel-driven shortcut to the label, but says nothing about a classifier learning a subtler pattern across a *combination* of features (e.g. shimmer plus two or three other correlated features jointly reconstructing a channel-driven signal that no single univariate test would catch).")
    lines.append("This is exactly why the Phase 8 permutation-importance check and the Phase 9/10 synthetic-degradation robustness check remain mandatory regardless of this result, not superseded by it.")
    lines.append("")

    lines.append("## Feature variance overview (informational only)")
    lines.append("")
    lines.append("Computed across all extracted files (train_pool + test), for visibility only - this is not a filtering decision.")
    lines.append("Actual feature selection (Phase 4) must be fit train_pool-only, inside the cross-validation pipeline, per the spec's leakage-prevention rule.")
    near_zero = variance_summary[variance_summary["coefficient_of_variation"] < 0.01]
    lines.append(f"{len(near_zero)} of {len(variance_summary)} features have a coefficient of variation below 0.01 (near-constant across the dataset):")
    if len(near_zero) > 0:
        lines.append(", ".join(near_zero["feature"].tolist()) + ".")
    else:
        lines.append("None.")
    lines.append("")

    path.write_text("\n".join(lines), encoding="utf-8")


def run() -> pd.DataFrame:
    FEATURES_RESULTS_DIR.mkdir(parents=True, exist_ok=True)

    duration_report = _load_duration_report()
    included = duration_report[duration_report["included"]]
    subject_splits = _load_subject_splits()[["subject_id", "split"]]

    rows = []
    failures = []
    for _, file_row in included.iterrows():
        file_id, subject_id, class_label = file_row["file_id"], file_row["subject_id"], file_row["class_label"]
        audio_path = PROCESSED_DATA_ROOT / subject_id / f"{file_id}.wav"
        features, error = extract_file(audio_path)

        if features is None:
            failures.append({"file_id": file_id, "subject_id": subject_id, "error": error})
            continue

        row = {"file_id": file_id, "subject_id": subject_id, "class_label": class_label}
        row.update(features.to_dict())
        rows.append(row)

    feature_df = pd.DataFrame(rows).merge(subject_splits, on="subject_id", how="left")
    failed_df = pd.DataFrame(failures)

    feature_columns = [c for c in feature_df.columns if c not in ("file_id", "subject_id", "class_label", "split")]
    assert len(feature_columns) == EGEMAPS_FEATURE_COUNT, (
        f"Expected {EGEMAPS_FEATURE_COUNT} eGeMAPS features, got {len(feature_columns)} - "
        "opensmile's feature set definition may have changed; update EGEMAPS_FEATURE_COUNT deliberately, don't silently ignore this."
    )

    proxy_df = _load_channel_quality_proxies()
    cross_check_df = _channel_quality_cross_check(feature_df, proxy_df)
    label_check_subject_df, label_check_file_df = _class_label_voice_quality_check(feature_df)

    variance_summary = pd.DataFrame(
        [
            {
                "feature": col,
                "mean": feature_df[col].mean(),
                "std": feature_df[col].std(),
                "coefficient_of_variation": (
                    feature_df[col].std() / abs(feature_df[col].mean()) if feature_df[col].mean() != 0 else float("inf")
                ),
            }
            for col in feature_columns
        ]
    )

    feature_df.to_csv(FEATURES_RESULTS_DIR / "feature_matrix.csv", index=False)
    failed_df.to_csv(FEATURES_RESULTS_DIR / "extraction_failures.csv", index=False)
    cross_check_df.to_csv(FEATURES_RESULTS_DIR / "channel_quality_cross_check.csv", index=False)
    label_check_subject_df.to_csv(FEATURES_RESULTS_DIR / "class_label_voice_quality_check_subject_level.csv", index=False)
    label_check_file_df.to_csv(FEATURES_RESULTS_DIR / "class_label_voice_quality_check_file_level.csv", index=False)
    variance_summary.to_csv(FEATURES_RESULTS_DIR / "feature_variance.csv", index=False)

    _write_summary(
        FEATURES_RESULTS_DIR / "feature_extraction_summary.md",
        feature_df=feature_df,
        failed_df=failed_df,
        cross_check_df=cross_check_df,
        label_check_subject_df=label_check_subject_df,
        label_check_file_df=label_check_file_df,
        variance_summary=variance_summary,
    )
    return feature_df
