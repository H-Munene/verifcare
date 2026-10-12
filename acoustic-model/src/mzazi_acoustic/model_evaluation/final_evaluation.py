"""Stage 5.2: the only use of the test set (PLAN.md 5.2).

This is the one module the test-set guard allows to load test rows (guards.FINAL_EVALUATION_MODULE).
After the evaluation, a marker file is written; loading the test set again then raises, so "the
test set is used exactly once" is enforced by code.
"""

import json
from datetime import datetime

import numpy as np

from mzazi_acoustic.common import config, guards
from mzazi_acoustic.model_training import metrics
from mzazi_acoustic.model_training.weights import person_weights

MARKER = config.EVALUATION_RESULTS / "test_set_used.json"
CI_METRICS = ["roc_auc_person", "pr_auc_person", "brier_person", "sensitivity_person", "specificity_person",
              "precision_person", "f1_person", "accuracy_person"]


def load_test_rows(matrix, marker=MARKER):
    if marker.exists():
        raise RuntimeError(f"The test set was already used ({marker.read_text(encoding='utf-8')}); it may be used once.")
    rows = guards.load_rows(matrix, include_test=True)
    return rows[rows["split"] == "test"].reset_index(drop=True)


def mark_used(info, marker=MARKER):
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(json.dumps({"used_at": datetime.now().isoformat(timespec="seconds"), **info}, indent=2),
                      encoding="utf-8")


def threshold_metrics(y, p, w, threshold):
    """Sensitivity, specificity, precision, accuracy and F1 when flagging p >= threshold, weighted by w."""
    y, p, w = np.asarray(y), np.asarray(p, float), np.asarray(w, float)
    flagged = p >= threshold
    tp, fn = w[(y == 1) & flagged].sum(), w[(y == 1) & ~flagged].sum()
    tn, fp = w[(y == 0) & ~flagged].sum(), w[(y == 0) & flagged].sum()
    sensitivity = tp / (tp + fn) if tp + fn else np.nan
    precision = tp / (tp + fp) if tp + fp else np.nan
    return {"sensitivity": sensitivity, "specificity": tn / (tn + fp) if tn + fp else np.nan,
            "precision": precision, "accuracy": (tp + tn) / w.sum(),
            "f1": 2 * precision * sensitivity / (precision + sensitivity) if tp else 0.0}


def all_metrics(y, p, subject_ids, threshold):
    """metrics.evaluate (threshold-free and Youden) plus the frozen-threshold metrics, person and clip."""
    result = metrics.evaluate(y, p, subject_ids)
    for suffix, w in [("person", person_weights(np.asarray(subject_ids))), ("clip", np.ones(len(y)))]:
        result |= {f"{k}_{suffix}": v for k, v in threshold_metrics(y, p, w, threshold).items()}
    return result


def bootstrap_ci(y, p, subject_ids, threshold, n_boot, rng, keys=CI_METRICS):
    """95 % CIs by resampling PEOPLE with replacement (PLAN.md 5.2 step 3).

    A person drawn twice counts as two people, so their clips get distinct ids per copy. Resamples
    with only one class are skipped and counted. Returns {metric: (low, high)} and the number used.
    """
    y, p, subject_ids = np.asarray(y), np.asarray(p, float), np.asarray(subject_ids)
    people = np.unique(subject_ids)
    index_of = {s: np.flatnonzero(subject_ids == s) for s in people}
    draws = {k: [] for k in keys}
    for _ in range(n_boot):
        chosen = rng.choice(people, size=len(people), replace=True)
        idx = np.concatenate([index_of[s] for s in chosen])
        ids = np.concatenate([[f"{s}#{i}"] * len(index_of[s]) for i, s in enumerate(chosen)])
        if len(np.unique(y[idx])) < 2:
            continue
        values = all_metrics(y[idx], p[idx], ids, threshold)
        for k in keys:
            draws[k].append(values[k])
    used = len(draws[keys[0]])
    return {k: (float(np.nanpercentile(v, 2.5)), float(np.nanpercentile(v, 97.5))) for k, v in draws.items()}, used
