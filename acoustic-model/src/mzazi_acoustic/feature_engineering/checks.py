"""Stage 3.3 checks before any modelling (PLAN.md 3.3), as pure functions on DataFrames.

Every function expects training-portion rows only; the caller gets them via guards.load_rows.
Feature order is config.MODEL_FEATURES order: wherever a rule keeps one feature over another,
the one listed first in PLAN.md 3.1 wins.

Tables carry file_id, subject_id, label and one column per feature. Per-subject checks average a
person's clips first, so people with more clips don't count more (PLAN.md principles).
"""

import numpy as np
import pandas as pd
from scipy import stats as sps

from mzazi_acoustic.common import config, stats

PROXIES = ["noise_floor_dbfs", "bandwidth_hz", "noise_flatness"]
CIRCULAR_PROXY_NOTE = ("reported only: the noise proxies are measured on each file's quietest frames, "
                       "which are mostly pauses, so pause features correlate with them by construction")


def per_subject(table, columns):
    """Mean of each column per subject, plus the subject's label."""
    means = table.groupby("subject_id")[columns].mean()
    return means.join(table.groupby("subject_id")["label"].first())


# ---------------------------------------------------------------- step 1: completeness

def completeness(table, features=config.MODEL_FEATURES):
    rows = []
    for feature in features:
        values = pd.to_numeric(table[feature], errors="coerce")
        bad = values.isna() | np.isinf(values)
        rows.append({"feature": feature, "n_nan": int(values.isna().sum()), "n_inf": int(np.isinf(values).sum()),
                     "file_ids": ";".join(table.loc[bad, "file_id"])})
    return pd.DataFrame(rows)


# ---------------------------------------------------------------- step 2: redundancy and dependency

def redundancy(table, features=config.MODEL_FEATURES, threshold=config.REDUNDANCY_ABS_R):
    """Pairwise |r| >= threshold: keep the earlier-listed feature. Returns (kept, dropped_pairs).

    A feature is only compared with features already kept, so a feature that was itself dropped
    can't knock out a later one.
    """
    corr = table[features].corr(method="pearson")
    kept, dropped = [], []
    for feature in features:
        partner = next((k for k in kept if abs(corr.loc[k, feature]) >= threshold), None)
        if partner is None:
            kept.append(feature)
        else:
            dropped.append({"kept": partner, "dropped": feature, "r": round(float(corr.loc[partner, feature]), 4)})
    return kept, pd.DataFrame(dropped, columns=["kept", "dropped", "r"])


def standardised(table, features):
    x = table[features].replace([np.inf, -np.inf], np.nan).dropna().to_numpy(dtype=float)
    std = x.std(axis=0)
    # A constant column is its own exact dependency (it equals a multiple of the intercept);
    # leaving it at zero after centring makes the rank step reject it.
    return (x - x.mean(axis=0)) / np.where(std > 0, std, 1.0)


def matrix_rank(z, tolerance=config.RANK_RELATIVE_TOLERANCE):
    if z.shape[1] == 0:
        return 0
    singular = np.linalg.svd(z, compute_uv=False)
    return int((singular > tolerance * singular.max()).sum()) if singular.max() > 0 else 0


def dependency(table, features):
    """Exact multi-feature linear dependencies, removed by the "listed first wins" rule.

    Greedy forward pass in listed order: a feature is kept only if adding it raises the rank of
    the standardised matrix of the features kept so far. A rejected feature is (numerically) a
    linear combination of earlier-listed kept features, so in every exact dependency the
    latest-listed member is the one dropped, and the result has full rank. Centring means a
    dependency with a constant term (a = b + c + 5) is caught too.
    Returns (kept, table of every feature with its outcome, VIF table for the kept features).
    """
    z = standardised(table, features)
    kept, rows = [], []
    for feature in features:
        candidate = kept + [feature]
        columns = [features.index(f) for f in candidate]
        if matrix_rank(z[:, columns]) == len(candidate):
            kept.append(feature)
            rows.append({"feature": feature, "kept": True, "reason": ""})
        else:
            rows.append({"feature": feature, "kept": False,
                         "reason": "exact linear combination of earlier-listed kept features"})
    rank = matrix_rank(z)
    outcome = pd.DataFrame(rows).assign(rank_before=rank, n_features_before=len(features))
    return kept, outcome, vif(table, kept)


def vif(table, features):
    """VIF_j = 1 / (1 - R^2_j) = the j-th diagonal of the inverse correlation matrix. Reported only."""
    z = standardised(table, features)
    inverse = np.linalg.inv(np.corrcoef(z, rowvar=False)) if len(features) > 1 else np.ones((1, 1))
    values = np.diag(inverse)
    return pd.DataFrame({"feature": features, "vif": np.round(values, 3),
                         "above_report_threshold": values > config.VIF_REPORT_THRESHOLD})


# ---------------------------------------------------------------- step 3: channel confound

def channel_confound(table, features, proxies=PROXIES):
    """Each feature vs each channel proxy, per subject, Spearman, Bonferroni across all pairs.

    Spearman, not Pearson: the proxies are heavily skewed (noise flatness spans orders of
    magnitude, Stage 1) and pause statistics are skewed too, and a confound only has to be
    monotonic, not linear, to leak into a model.
    Only family B features can be removed (PLAN.md 3.1); family A gets the circularity note.
    """
    subjects = per_subject(table, list(features) + list(proxies))
    rows = []
    for feature in features:
        for proxy in proxies:
            pair = subjects[[feature, proxy]].dropna()
            rho, p = sps.spearmanr(pair[feature], pair[proxy])
            rows.append({"feature": feature, "proxy": proxy, "n_subjects": len(pair),
                         "spearman_rho": float(rho), "p": float(p)})
    result = pd.DataFrame(rows)
    result["p_bonferroni"] = stats.bonferroni(result["p"])
    significant = result["p_bonferroni"] < config.ALPHA
    family_b = result["feature"].isin(config.FAMILY_B_FEATURES)
    result["remove"] = significant & family_b
    result["note"] = np.where(family_b, "", CIRCULAR_PROXY_NOTE)
    return result.round({"spearman_rho": 4, "p": 6, "p_bonferroni": 6})


# ---------------------------------------------------------------- step 4: degradation

def degradation_shift(clean, degraded_by_condition, features):
    """Per-recording relative change from clean, (degraded - clean) / |clean|, summarised per feature.

    Recordings whose clean value is 0 have no defined relative change; they are left out and counted.
    """
    rows = []
    for condition, degraded in degraded_by_condition.items():
        merged = clean[["file_id", *features]].merge(degraded[["file_id", *features]], on="file_id",
                                                     suffixes=("_clean", "_degraded"), validate="one_to_one")
        for feature in features:
            c, d = merged[f"{feature}_clean"], merged[f"{feature}_degraded"]
            usable = c.notna() & d.notna() & (c != 0)
            change = (d[usable] - c[usable]) / c[usable].abs()
            rows.append({"condition": condition, "feature": feature, "n": int(usable.sum()),
                         "n_zero_clean_excluded": int((c == 0).sum()),
                         "median_relative_change": change.median(),
                         "q1": change.quantile(0.25), "q3": change.quantile(0.75)})
    return pd.DataFrame(rows)


def relative_pair_differences(values):
    """|x_i - x_j| / ((|x_i| + |x_j|) / 2) for every pair; pairs where both are 0 are skipped."""
    values = [v for v in values if pd.notna(v)]
    out = []
    for i in range(len(values)):
        for j in range(i + 1, len(values)):
            scale = (abs(values[i]) + abs(values[j])) / 2
            if scale > 0:
                out.append(abs(values[i] - values[j]) / scale)
    return out


def within_person_benchmark(table, features, minimum=config.MIN_SUBJECTS_FOR_WITHIN_SUBJECT_BENCHMARK):
    """The pre-registered cascade (PLAN.md 3.3 step 4). Returns (benchmark per feature, level).

    Level 1: same-age-band pairs, if at least `minimum` subjects have such a pair.
    Level 2: all of a subject's pairs, if at least `minimum` subjects have 2+ clips.
    Level 3: no benchmark (NaN); the flag rule then falls back to 10 %.
    `table` needs subject_id and age_band.
    """
    same_band = table.groupby(["subject_id", "age_band"]).filter(lambda g: len(g) >= 2)
    multi = table.groupby("subject_id").filter(lambda g: len(g) >= 2)
    if same_band["subject_id"].nunique() >= minimum:
        level, groups = 1, same_band.groupby(["subject_id", "age_band"])
    elif multi["subject_id"].nunique() >= minimum:
        level, groups = 2, multi.groupby("subject_id")
    else:
        return pd.DataFrame({"feature": features, "benchmark": np.nan, "n_subjects": 0}), 3

    rows = []
    for feature in features:
        per_subject_values = {}
        for key, group in groups:
            subject = key[0] if isinstance(key, tuple) else key
            per_subject_values.setdefault(subject, []).extend(relative_pair_differences(group[feature].tolist()))
        medians = [np.median(v) for v in per_subject_values.values() if v]
        rows.append({"feature": feature, "benchmark": float(np.median(medians)) if medians else np.nan,
                     "n_subjects": len(medians)})
    return pd.DataFrame(rows), level


def degradation_flags(shift, benchmark, features=config.FAMILY_A_FEATURES, condition="bandpass",
                      cap=config.FALLBACK_SHIFT_TOLERANCE):
    """Flag (never remove) a family A feature whose |median shift| under bandpass alone exceeds
    min(its within-person benchmark, 10 %), or 10 % when there is no benchmark."""
    mild = shift[(shift["condition"] == condition) & shift["feature"].isin(features)]
    merged = mild.merge(benchmark[["feature", "benchmark"]], on="feature", how="left")
    merged["tolerance"] = np.where(merged["benchmark"].notna(), np.minimum(merged["benchmark"], cap), cap)
    merged["flagged"] = merged["median_relative_change"].abs() > merged["tolerance"]
    return merged[["feature", "median_relative_change", "benchmark", "tolerance", "flagged"]]


# ---------------------------------------------------------------- step 5: duration dependence

def duration_dependence(table, features, duration="trimmed_s", threshold=config.DURATION_DEPENDENCE_ABS_R):
    subjects = per_subject(table, list(features) + [duration])
    rows = []
    for feature in features:
        pair = subjects[[feature, duration]].dropna()
        r, p = sps.pearsonr(pair[feature], pair[duration])
        rows.append({"feature": feature, "n_subjects": len(pair), "r": round(float(r), 4), "p": float(p),
                     "flagged": abs(r) > threshold})
    return pd.DataFrame(rows)


# ---------------------------------------------------------------- steps 6-7: class differences, direction

def class_differences(table, features):
    """Per-subject descriptives and Mann-Whitney per feature. Descriptive only: nothing is removed."""
    subjects = per_subject(table, list(features))
    rows = []
    for feature in features:
        dementia = subjects.loc[subjects["label"] == 1, feature].dropna()
        control = subjects.loc[subjects["label"] == 0, feature].dropna()
        u, p, rbc = stats.mann_whitney(dementia, control)
        rows.append({"feature": feature,
                     "dementia_mean": dementia.mean(), "dementia_sd": dementia.std(), "dementia_median": dementia.median(),
                     "control_mean": control.mean(), "control_sd": control.std(), "control_median": control.median(),
                     "n_dementia": len(dementia), "n_control": len(control),
                     "mann_whitney_u": u, "p": p, "rank_biserial": rbc})
    return pd.DataFrame(rows)


def direction_check(differences, expected=config.EXPECTED_DIRECTION):
    rows = []
    for feature, direction in expected.items():
        row = differences[differences["feature"] == feature]
        if row.empty:
            continue
        dementia, control = row["dementia_median"].iloc[0], row["control_median"].iloc[0]
        observed = "higher" if dementia > control else "lower" if dementia < control else "equal"
        rows.append({"feature": feature, "expected": direction, "observed": observed,
                     "agrees": observed == direction})
    return pd.DataFrame(rows)


# ---------------------------------------------------------------- the list for Checkpoint 3

def final_feature_list(redundancy_dropped, dependency_outcome, confound, features=config.MODEL_FEATURES):
    reasons = {}
    for row in redundancy_dropped.itertuples():
        reasons.setdefault(row.dropped, f"redundant with {row.kept} (r = {row.r})")
    for row in dependency_outcome[~dependency_outcome["kept"]].itertuples():
        reasons.setdefault(row.feature, row.reason)
    for feature, group in confound[confound["remove"]].groupby("feature"):
        reasons.setdefault(feature, "channel confound with " + ", ".join(group["proxy"]))
    return pd.DataFrame({"feature": features, "kept": [f not in reasons for f in features],
                         "reason": [reasons.get(f, "") for f in features]})
