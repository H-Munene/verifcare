"""Verification metrics, with confidence intervals that resample people rather than trials."""

import numpy as np
from sklearn.metrics import roc_curve

from mzazi_acoustic.common import config


def _miss_and_false_alarm(labels, scores):
    false_alarm, hit, thresholds = roc_curve(labels, scores)
    return 1 - hit, false_alarm, thresholds


def equal_error_rate(labels, scores):
    """The rate at which false accepts and false rejects are equal. Returns (rate, threshold)."""
    miss, false_alarm, thresholds = _miss_and_false_alarm(labels, scores)
    i = int(np.argmin(np.abs(miss - false_alarm)))
    return float((miss[i] + false_alarm[i]) / 2), float(thresholds[i])


def min_dcf(labels, scores, p_target=config.SV_DCF_P_TARGET):
    """Normalised minimum detection cost, the standard companion to EER."""
    miss, false_alarm, _ = _miss_and_false_alarm(labels, scores)
    return float(np.min(miss * p_target + false_alarm * (1 - p_target)) / min(p_target, 1 - p_target))


def _cluster_indices(clusters):
    clusters = np.asarray(clusters)
    return [np.flatnonzero(clusters == cluster) for cluster in np.unique(clusters)]


def bootstrap_ci(statistic, clusters, n=config.SV_BOOTSTRAP_RESAMPLES, seed=config.SEED):
    """95 % interval of statistic(indices), resampling whole clusters (people or pairs)."""
    groups = _cluster_indices(clusters)
    rng = np.random.default_rng(seed)
    values = []
    for _ in range(n):
        chosen = rng.integers(0, len(groups), len(groups))
        value = statistic(np.concatenate([groups[i] for i in chosen]))
        if value is not None:
            values.append(value)
    return float(np.percentile(values, 2.5)), float(np.percentile(values, 97.5))


def eer_ci(labels, scores, clusters, **kwargs):
    labels, scores = np.asarray(labels), np.asarray(scores)

    def statistic(indices):
        if len(np.unique(labels[indices])) < 2:
            return None
        return equal_error_rate(labels[indices], scores[indices])[0]

    return bootstrap_ci(statistic, clusters, **kwargs)


def rate_ci(events, clusters, **kwargs):
    """Interval for the share of true values in events."""
    events = np.asarray(events, dtype=float)
    return bootstrap_ci(lambda indices: float(events[indices].mean()), clusters, **kwargs)
