"""Phase 3 feature extraction: eGeMAPSv02 functionals (88 features, via
opensmile) computed per file from Phase 2's preprocessed audio, plus
the channel-quality cross-check promised by Phase 1's confound finding
(see docs/ml-development-spec.md section 10, mitigation 2).

Feature extraction is file-level, matching the deployment contract -
acoustic-model/openapi.yaml's `score` operation scores one recording at
a time. Phase 2's subject-level grouping is reused only to tag each
file with its split (train_pool/test/excluded), never to aggregate
features across a subject's files - that would blur the granularity
the deployed model actually operates at.

Run via `scripts/run_features.py`, not this module directly.
"""

from __future__ import annotations

from pathlib import Path

import opensmile
import pandas as pd
from scipy import stats

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


def _bonferroni_correlation_cross_check(feature_df: pd.DataFrame, proxy_df: pd.DataFrame) -> pd.DataFrame:
    """Pearson + Spearman correlation between each voice-quality functional and each
    channel-quality proxy, at file level (each recording is an independent
    observation for this question - unlike Phase 1's class-label confound check,
    this isn't testing a group difference, so subject-level aggregation doesn't
    apply the same way; a subject-clustering effect could still inflate apparent
    correlation if a few subjects dominate the range on either axis, worth keeping
    in mind when interpreting, not just accepting the numbers at face value).
    Bonferroni-corrected across all 3x3=9 pairs tested, per test family (Pearson,
    Spearman), matching the correction approach used in Phase 1."""
    merged = feature_df.merge(proxy_df, on="file_id", how="inner")
    n_pairs = len(VOICE_QUALITY_CROSS_CHECK_COLUMNS) * len(CHANNEL_QUALITY_PROXY_COLUMNS)

    rows = []
    for voice_col in VOICE_QUALITY_CROSS_CHECK_COLUMNS:
        for proxy_col in CHANNEL_QUALITY_PROXY_COLUMNS:
            valid = merged[[voice_col, proxy_col]].dropna()
            if len(valid) < 3:
                rows.append(
                    {
                        "voice_quality_feature": voice_col,
                        "channel_quality_proxy": proxy_col,
                        "n": len(valid),
                        "pearson_r": None,
                        "pearson_p_bonferroni": None,
                        "spearman_rho": None,
                        "spearman_p_bonferroni": None,
                    }
                )
                continue

            pearson_r, pearson_p = stats.pearsonr(valid[voice_col], valid[proxy_col])
            spearman_rho, spearman_p = stats.spearmanr(valid[voice_col], valid[proxy_col])
            rows.append(
                {
                    "voice_quality_feature": voice_col,
                    "channel_quality_proxy": proxy_col,
                    "n": len(valid),
                    "pearson_r": float(pearson_r),
                    "pearson_p_bonferroni": float(min(pearson_p * n_pairs, 1.0)),
                    "spearman_rho": float(spearman_rho),
                    "spearman_p_bonferroni": float(min(spearman_p * n_pairs, 1.0)),
                }
            )
    return pd.DataFrame(rows)


def _write_summary(
    path: Path,
    feature_df: pd.DataFrame,
    failed_df: pd.DataFrame,
    cross_check_df: pd.DataFrame,
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

    lines.append("## Channel-quality cross-check (Phase 1 mitigation 2)")
    lines.append("")
    lines.append("Pearson and Spearman correlation between each of the three voice-quality functionals named in the spec and each of the three Phase 1 channel-quality proxies, at file level, Bonferroni-corrected across all 9 pairs tested per test family.")
    lines.append("Tests whether the voice-quality features themselves are entangled with recording-channel quality, not just whether class label is (that was Phase 1's check).")
    lines.append("")
    for _, row in cross_check_df.iterrows():
        if row["pearson_r"] is None:
            lines.append(f"{row['voice_quality_feature']} vs {row['channel_quality_proxy']}: insufficient data (n={row['n']}).")
        else:
            lines.append(
                f"{row['voice_quality_feature']} vs {row['channel_quality_proxy']}: n={row['n']}, "
                f"Pearson r={row['pearson_r']:.3f} (Bonferroni p={row['pearson_p_bonferroni']:.4f}), "
                f"Spearman rho={row['spearman_rho']:.3f} (Bonferroni p={row['spearman_p_bonferroni']:.4f})."
            )
    lines.append("")
    significant = cross_check_df[
        (cross_check_df["pearson_p_bonferroni"] < 0.05) | (cross_check_df["spearman_p_bonferroni"] < 0.05)
    ]
    if len(significant) > 0:
        pairs = ", ".join(f"{r.voice_quality_feature}/{r.channel_quality_proxy}" for r in significant.itertuples())
        lines.append(f"After Bonferroni correction, {len(significant)} pair(s) remain significant: {pairs}. Needs human interpretation before these features are trusted uncritically in modeling.")
    else:
        lines.append("After Bonferroni correction, no pair is significant: no evidence the voice-quality features themselves are entangled with the Phase 1 channel-quality proxies.")
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
    cross_check_df = _bonferroni_correlation_cross_check(feature_df, proxy_df)

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
    variance_summary.to_csv(FEATURES_RESULTS_DIR / "feature_variance.csv", index=False)

    _write_summary(
        FEATURES_RESULTS_DIR / "feature_extraction_summary.md",
        feature_df=feature_df,
        failed_df=failed_df,
        cross_check_df=cross_check_df,
        variance_summary=variance_summary,
    )
    return feature_df
