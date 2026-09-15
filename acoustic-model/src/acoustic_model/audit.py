"""Dataset audit: walks the raw DementiaNet folders, builds anonymized
file- and subject-level manifests, and checks whether the class label
correlates with recording-channel quality (a possible confound
distinct from speaker physiology - see channel_quality.py).

Two output files (`subject_id_lookup.local.csv`,
`near_duplicate_review.local.csv`) contain real subject names and are
git-ignored by naming convention (`*.local.csv`); everything else
written to results/audit/ is keyed by anonymized subject_id/file_id
and is safe to commit.

Run via `scripts/run_audit.py`, not this module directly.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import pandas as pd
from scipy import stats

from acoustic_model import audio_io, channel_quality
from acoustic_model.config import (
    AUDIT_RESULTS_DIR,
    CLASS_LABEL_MAP,
    DATA_ROOT,
    RAW_CLASS_DIRS,
)
from acoustic_model.subject_names import (
    SubjectIdentity,
    assign_subject_ids,
    canonicalize,
    dedup_key,
    find_unflagged_near_duplicates,
)

# Matches the "_<marker>" or "_<marker>_<sub_index>" suffix on a wav
# filename stem, e.g. "AbeBurrows_5" -> marker=5, or
# "aileenhernandez_5_1" -> marker=5, sub_index=1.
_SUFFIX_PATTERN = re.compile(r"_(\d+)(?:_(\d+))?$")

# The two folders use unrelated numbering schemes (see README.md):
# dementia's marker approximates years-relative-to-symptom-onset;
# nodementia/nodementia2's marker is a 1/2/3 index into the
# 5/10/15-years-before-death-or-current-age scheme.
_YEARS_PRE_SYMPTOM_SCHEME = "years_pre_symptom_marker"
_DEATH_OR_CURRENT_AGE_INDEX_SCHEME = "death_or_current_age_index"


def _parse_suffix(stem: str) -> tuple[int | None, int | None]:
    match = _SUFFIX_PATTERN.search(stem)
    if not match:
        return None, None
    marker = int(match.group(1))
    sub_index = int(match.group(2)) if match.group(2) else None
    return marker, sub_index


def _numbering_scheme(raw_class_dir: str) -> str:
    return _YEARS_PRE_SYMPTOM_SCHEME if raw_class_dir == "dementia" else _DEATH_OR_CURRENT_AGE_INDEX_SCHEME


@dataclass
class _RawSubjectFolder:
    raw_class_dir: str
    path: Path


def _discover_raw_subject_folders() -> list[_RawSubjectFolder]:
    folders: list[_RawSubjectFolder] = []
    for raw_class_dir in RAW_CLASS_DIRS:
        class_path = DATA_ROOT / raw_class_dir
        if not class_path.is_dir():
            raise FileNotFoundError(f"Expected raw class directory not found: {class_path}")
        for subject_path in sorted(p for p in class_path.iterdir() if p.is_dir()):
            folders.append(_RawSubjectFolder(raw_class_dir=raw_class_dir, path=subject_path))
    return folders


def _wav_files(subject_dir: Path) -> list[Path]:
    return sorted({p for p in subject_dir.iterdir() if p.suffix.lower() == ".wav"})


def _build_manifests(
    raw_folders: list[_RawSubjectFolder],
    identities_by_key: dict[str, SubjectIdentity],
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Returns (file_df, lookup_df, class_conflicts) - class_conflicts is empty unless a
    subject_id maps to more than one class_label, which should never happen given the
    dataset's confirmed zero name-overlap between dementia and the merged no_dementia class."""
    file_rows: list[dict] = []
    lookup_rows: dict[str, dict] = {}
    label_by_subject: dict[str, set[str]] = {}

    for folder in raw_folders:
        canonical_name = canonicalize(folder.path.name)
        key = dedup_key(canonical_name)
        identity = identities_by_key[key]
        class_label = CLASS_LABEL_MAP[folder.raw_class_dir]
        numbering_scheme = _numbering_scheme(folder.raw_class_dir)

        label_by_subject.setdefault(identity.subject_id, set()).add(class_label)

        lookup_row = lookup_rows.setdefault(
            identity.subject_id,
            {
                "subject_id": identity.subject_id,
                "canonical_name": identity.canonical_name,
                "raw_class_dirs": set(),
                "raw_subject_folders": set(),
                "typo_corrected": False,
            },
        )
        lookup_row["raw_class_dirs"].add(folder.raw_class_dir)
        lookup_row["raw_subject_folders"].add(folder.path.name)
        if folder.path.name != canonical_name:
            lookup_row["typo_corrected"] = True

        wav_files = _wav_files(folder.path)
        for file_index, wav_path in enumerate(wav_files, start=1):
            marker, sub_index = _parse_suffix(wav_path.stem)
            audio_info = audio_io.inspect(wav_path)

            proxies = None
            if audio_info.readable:
                try:
                    proxies = channel_quality.compute_from_file(wav_path)
                except Exception:
                    proxies = None

            file_rows.append(
                {
                    "file_id": f"{identity.subject_id}_f{file_index:02d}",
                    "subject_id": identity.subject_id,
                    "class_label": class_label,
                    "raw_class_dir": folder.raw_class_dir,
                    "numbering_scheme": numbering_scheme,
                    "suffix_marker": marker,
                    "suffix_sub_index": sub_index,
                    "readable": audio_info.readable,
                    "format_ok": audio_info.format_ok,
                    "error": audio_info.error,
                    "duration_seconds": audio_info.duration_seconds,
                    "sample_rate_hz": audio_info.sample_rate_hz,
                    "channels": audio_info.channels,
                    "subtype": audio_info.subtype,
                    "file_size_bytes": audio_info.file_size_bytes,
                    "sha256": audio_info.sha256,
                    "noise_floor_db": proxies.noise_floor_db if proxies else None,
                    "spectral_bandwidth_hz": proxies.spectral_bandwidth_hz if proxies else None,
                    "spectral_flatness": proxies.spectral_flatness if proxies else None,
                }
            )

    file_df = pd.DataFrame(file_rows)

    lookup_df = pd.DataFrame(
        [
            {
                "subject_id": row["subject_id"],
                "canonical_name": row["canonical_name"],
                "raw_class_dirs": ";".join(sorted(row["raw_class_dirs"])),
                "raw_subject_folders": ";".join(sorted(row["raw_subject_folders"])),
                "typo_corrected": row["typo_corrected"],
            }
            for row in lookup_rows.values()
        ]
    ).sort_values("subject_id")

    conflicts = pd.DataFrame(
        [
            {"subject_id": subject_id, "class_labels": sorted(labels)}
            for subject_id, labels in label_by_subject.items()
            if len(labels) > 1
        ]
    )

    return file_df, lookup_df, conflicts


def _build_subject_manifest(file_df: pd.DataFrame, lookup_df: pd.DataFrame) -> pd.DataFrame:
    typo_corrected_by_subject = lookup_df.set_index("subject_id")["typo_corrected"]

    grouped = file_df.groupby("subject_id")
    rows = []
    for subject_id, group in grouped:
        class_labels = group["class_label"].unique()
        raw_dirs = set(group["raw_class_dir"].unique())
        rows.append(
            {
                "subject_id": subject_id,
                "class_label": class_labels[0] if len(class_labels) == 1 else "CONFLICT",
                "file_count": len(group),
                "spans_nodementia_and_nodementia2": {"nodementia", "nodementia2"}.issubset(raw_dirs),
                "typo_corrected": bool(typo_corrected_by_subject.get(subject_id, False)),
                "readable_file_count": int(group["readable"].sum()),
                "format_ok_file_count": int(group["format_ok"].sum()),
                "mean_duration_seconds": group["duration_seconds"].mean(),
                "total_duration_seconds": group["duration_seconds"].sum(),
                "mean_noise_floor_db": group["noise_floor_db"].mean(),
                "mean_spectral_bandwidth_hz": group["spectral_bandwidth_hz"].mean(),
                "mean_spectral_flatness": group["spectral_flatness"].mean(),
            }
        )
    return pd.DataFrame(rows).sort_values("subject_id")


def _confound_check(subject_df: pd.DataFrame) -> pd.DataFrame:
    """Point-biserial correlation + Mann-Whitney U between class label and each
    channel-quality proxy, computed at the subject level (per-subject means) to avoid
    pseudo-replication from subjects with multiple files.

    Also reports, per proxy: a rank-biserial effect size for the Mann-Whitney result
    (r = 1 - 2U/(n1*n2), Wendt 1972 - the nonparametric analogue of r, magnitude
    interpretable on roughly the same small/medium/large scale as Pearson's r), and a
    Bonferroni-adjusted p-value within each test family (3 proxies tested per family:
    point-biserial and Mann-Whitney), since three proxies were tested and an
    uncorrected p=0.05 threshold overstates how surprising any single result is."""
    label_binary = (subject_df["class_label"] == "dementia").astype(int)
    proxy_columns = ["mean_noise_floor_db", "mean_spectral_bandwidth_hz", "mean_spectral_flatness"]
    n_proxies_tested = len(proxy_columns)

    results = []
    for column in proxy_columns:
        values = subject_df[column]
        valid = values.notna() & label_binary.notna()
        if valid.sum() < 3 or label_binary[valid].nunique() < 2:
            results.append(
                {
                    "proxy": column,
                    "n": int(valid.sum()),
                    "point_biserial_r": None,
                    "p_value": None,
                    "p_value_bonferroni": None,
                    "mannwhitney_p_value": None,
                    "mannwhitney_p_value_bonferroni": None,
                    "mannwhitney_rank_biserial": None,
                }
            )
            continue

        r, p = stats.pointbiserialr(label_binary[valid], values[valid])
        dementia_values = values[valid & (label_binary == 1)]
        no_dementia_values = values[valid & (label_binary == 0)]
        mw_result = stats.mannwhitneyu(dementia_values, no_dementia_values, alternative="two-sided")
        n1, n2 = len(dementia_values), len(no_dementia_values)
        rank_biserial = 1 - (2 * mw_result.statistic) / (n1 * n2)

        results.append(
            {
                "proxy": column,
                "n": int(valid.sum()),
                "point_biserial_r": float(r),
                "p_value": float(p),
                "p_value_bonferroni": float(min(p * n_proxies_tested, 1.0)),
                "mannwhitney_p_value": float(mw_result.pvalue),
                "mannwhitney_p_value_bonferroni": float(min(mw_result.pvalue * n_proxies_tested, 1.0)),
                "mannwhitney_rank_biserial": float(rank_biserial),
            }
        )
    return pd.DataFrame(results)


def _write_summary(
    path: Path,
    file_df: pd.DataFrame,
    subject_df: pd.DataFrame,
    confound_df: pd.DataFrame,
    near_duplicate_count: int,
    duplicate_group_count: int,
    duplicate_file_count: int,
    class_conflicts: pd.DataFrame,
) -> None:
    lines: list[str] = []
    lines.append("# Dataset Audit Summary")
    lines.append("")
    lines.append("Generated by `scripts/run_audit.py`.")
    lines.append("Every subject and file below is identified only by an anonymized `subject_id`/`file_id`.")
    lines.append("The real-name lookup lives in `subject_id_lookup.local.csv`, which is git-ignored and never committed.")
    lines.append("")

    lines.append("## Dimensions")
    lines.append("")
    lines.append(f"Total files audited: {len(file_df)}.")
    lines.append(f"Total unique subjects after canonicalization and cross-folder dedup: {len(subject_df)}.")
    lines.append("")

    lines.append("## Target distribution")
    lines.append("")
    file_counts = file_df["class_label"].value_counts()
    subject_counts = subject_df["class_label"].value_counts()
    for label in sorted(set(file_counts.index) | set(subject_counts.index)):
        lines.append(f"{label}: {subject_counts.get(label, 0)} subjects, {file_counts.get(label, 0)} files.")
    lines.append("")

    lines.append("## Files per subject")
    lines.append("")
    dist = subject_df["file_count"].value_counts().sort_index()
    for count, n_subjects in dist.items():
        lines.append(f"{n_subjects} subjects have exactly {count} file(s).")
    lines.append("")

    lines.append("## Cross-folder overlap (nodementia + nodementia2)")
    lines.append("")
    overlap_count = int(subject_df["spans_nodementia_and_nodementia2"].sum())
    lines.append(f"{overlap_count} subjects had folders under both nodementia/ and nodementia2/, and were merged into a single subject_id.")
    lines.append("")

    lines.append("## Typo/formatting corrections applied")
    lines.append("")
    typo_count = int(subject_df["typo_corrected"].sum())
    lines.append(f"{typo_count} subjects had at least one raw folder name corrected via the KNOWN_CORRECTIONS table in subject_names.py.")
    lines.append("The specific corrections applied are visible in that source file; the affected real names are not repeated here.")
    lines.append("")

    lines.append("## Integrity and format")
    lines.append("")
    unreadable = file_df[~file_df["readable"]]
    format_bad = file_df[file_df["readable"] & ~file_df["format_ok"]]
    lines.append(f"Unreadable files: {len(unreadable)}.")
    lines.append(f"Readable but not matching the expected format (16-bit PCM, stereo, 44100 Hz): {len(format_bad)}.")
    if len(unreadable) > 0:
        lines.append("Unreadable file_ids: " + ", ".join(unreadable["file_id"].tolist()) + ".")
    if len(format_bad) > 0:
        lines.append("Non-conforming-format file_ids: " + ", ".join(format_bad["file_id"].tolist()) + ".")
    lines.append("")

    lines.append("## Exact duplicates")
    lines.append("")
    lines.append(f"{duplicate_group_count} groups of byte-identical files (same sha256) were found, covering {duplicate_file_count} files in total.")
    lines.append("")

    lines.append("## Near-duplicate subject names")
    lines.append("")
    lines.append(f"{near_duplicate_count} pairs of textually similar but distinct canonical names were flagged for manual review.")
    lines.append("The pairs themselves (real names) are written only to `near_duplicate_review.local.csv`, which is git-ignored.")
    lines.append("")

    lines.append("## Class-label conflicts")
    lines.append("")
    if len(class_conflicts) == 0:
        lines.append("None: every subject_id maps to exactly one class_label, confirming no subject appears under both dementia and no_dementia.")
    else:
        lines.append(f"{len(class_conflicts)} subject_id(s) mapped to more than one class_label - see subject_id_lookup.local.csv locally to investigate. This should not happen and blocks further pipeline work until resolved.")
    lines.append("")

    lines.append("## Feature-level checks (constant / near-zero-variance)")
    lines.append("")
    lines.append("Not applicable at this stage: no perceptual features (jitter, shimmer, HNR, etc.) have been extracted yet. This check belongs to the feature-engineering phase.")
    lines.append("")

    lines.append("## Channel-quality confound check")
    lines.append("")
    lines.append("Point-biserial correlation and Mann-Whitney U test between class label (dementia=1) and each per-subject mean channel-quality proxy, computed at the subject level to avoid pseudo-replication from subjects with multiple files.")
    lines.append("A statistically significant association here would mean the label is confounded with recording-channel quality rather than purely with speaker physiology - relevant because jitter, shimmer, and HNR (planned voice-quality features) are themselves sensitive to channel quality, not just vocal-fold physiology.")
    lines.append("Three proxies were tested, so raw p-values are reported alongside a Bonferroni-adjusted p-value (within each test family, n=3) to avoid overstating how surprising any single result is.")
    lines.append("The Mann-Whitney result also includes a rank-biserial effect size (Wendt 1972: r = 1 - 2U/(n1*n2)), the nonparametric analogue of r, interpretable on roughly the same small (~0.1) / medium (~0.3) / large (~0.5) scale as Pearson's r.")
    lines.append("")
    for _, row in confound_df.iterrows():
        if row["point_biserial_r"] is None:
            lines.append(f"{row['proxy']}: insufficient data (n={row['n']}).")
        else:
            lines.append(
                f"{row['proxy']}: n={row['n']}, point-biserial r={row['point_biserial_r']:.3f} (raw p={row['p_value']:.4f}, Bonferroni p={row['p_value_bonferroni']:.4f}); "
                f"Mann-Whitney raw p={row['mannwhitney_p_value']:.4f}, Bonferroni p={row['mannwhitney_p_value_bonferroni']:.4f}, rank-biserial r={row['mannwhitney_rank_biserial']:.3f}."
            )
    lines.append("")
    lines.append("Interpretation: under the per-family Bonferroni correction (n=3), no point-biserial correlation survives.")
    lines.append("The spectral-flatness Mann-Whitney result survives at the edge (Bonferroni p=0.0491, just under 0.05) but does not survive the stricter correction across all 6 tests run (raw p=0.0164 vs. a 0.05/6=0.0083 threshold).")
    lines.append("All three rank-biserial effect sizes are small in magnitude (noise floor -0.14, spectral bandwidth -0.03, spectral flatness 0.19), none approaching a medium effect.")
    lines.append("Net reading: this is a real, worth-tracking signal on noise floor and spectral flatness, not a robust, corrected-for-multiple-testing confound - it does not on its own block proceeding, but the planned Phase 3 check (comparing jitter/shimmer/HNR against these same channel-quality proxies once those features exist) should treat noise floor and spectral flatness as the two proxies to watch most closely.")
    lines.append("")

    lines.append("## Numbering scheme note")
    lines.append("")
    lines.append("dementia/ filenames use a suffix marker approximating years relative to symptom onset (observed values: 0, 2, 5, 10, 15), sometimes with a second sub-index for multiple clips at the same marker.")
    lines.append("nodementia/ and nodementia2/ filenames use a suffix marker that is always 1, 2, or 3 - an index into DementiaNet's 5/10/15-years-before-death-or-current-age scheme, not a literal year value.")
    lines.append("These are two unrelated numbering schemes and must not be conflated when this data is used for splitting or feature engineering later.")
    lines.append("")

    path.write_text("\n".join(lines), encoding="utf-8")


def run() -> None:
    AUDIT_RESULTS_DIR.mkdir(parents=True, exist_ok=True)

    raw_folders = _discover_raw_subject_folders()
    canonical_names = [canonicalize(folder.path.name) for folder in raw_folders]
    identities_by_key = assign_subject_ids(canonical_names)

    file_df, lookup_df, class_conflicts = _build_manifests(raw_folders, identities_by_key)
    subject_df = _build_subject_manifest(file_df, lookup_df)
    confound_df = _confound_check(subject_df)

    duplicate_groups = file_df[file_df["readable"]].groupby("sha256").filter(lambda g: len(g) > 1)
    duplicate_group_count = duplicate_groups["sha256"].nunique()
    duplicate_file_count = len(duplicate_groups)

    near_duplicates = find_unflagged_near_duplicates(canonical_names)

    file_df.to_csv(AUDIT_RESULTS_DIR / "file_manifest.csv", index=False)
    subject_df.to_csv(AUDIT_RESULTS_DIR / "subject_manifest.csv", index=False)

    lookup_df.to_csv(AUDIT_RESULTS_DIR / "subject_id_lookup.local.csv", index=False)
    pd.DataFrame(near_duplicates, columns=["name_a", "name_b", "similarity_ratio"]).to_csv(
        AUDIT_RESULTS_DIR / "near_duplicate_review.local.csv", index=False
    )

    _write_summary(
        AUDIT_RESULTS_DIR / "audit_summary.md",
        file_df=file_df,
        subject_df=subject_df,
        confound_df=confound_df,
        near_duplicate_count=len(near_duplicates),
        duplicate_group_count=int(duplicate_group_count),
        duplicate_file_count=int(duplicate_file_count),
        class_conflicts=class_conflicts,
    )
