"""The pre-registered D5 threshold: lowest threshold with >= 90 % person-weighted specificity, median over repeats."""

import numpy as np
import pandas as pd
import pytest

from mzazi_acoustic.model_evaluation import threshold as th


def test_lowest_threshold_reaching_the_target_specificity():
    # 10 controls (one clip each) with probabilities 0.0..0.9, and 2 dementia clips.
    p = list(np.arange(10) / 10) + [0.95, 0.5]
    y = [0] * 10 + [1, 1]
    subjects = [f"c{i}" for i in range(10)] + ["d1", "d2"]
    t = th.threshold_for_specificity(y, p, subjects, target=0.9)
    # 9 of 10 controls must be below t, so t = 0.9 (the control at 0.9 is flagged, the rest aren't).
    assert t == pytest.approx(0.9)
    assert th.person_weighted_specificity(y, p, subjects, t) >= 0.9


def test_specificity_is_person_weighted():
    # One control person with 4 high-scoring clips counts once, not four times.
    p = [0.9, 0.9, 0.9, 0.9, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]
    y = [0] * 10
    subjects = ["many"] * 4 + [f"c{i}" for i in range(6)]
    # Below 0.9: 6 of 7 people -> person-weighted specificity 6/7, not clip-level 6/10.
    assert th.person_weighted_specificity(y, p, subjects, 0.5) == pytest.approx(6 / 7)


def test_frozen_threshold_is_the_median_over_repeats():
    rows = []
    for repeat, shift in enumerate([0.0, 0.1, 0.2, 0.3, 0.4]):
        for i in range(10):
            rows.append({"repeat": repeat, "label": 0, "subject_id": f"c{i}", "probability": i / 20 + shift})
        rows.append({"repeat": repeat, "label": 1, "subject_id": "d", "probability": 0.99})
    frozen, per_repeat = th.frozen_threshold(pd.DataFrame(rows), target=0.9)
    assert len(per_repeat) == 5
    assert frozen == pytest.approx(np.median(list(per_repeat.values())))
    assert frozen == pytest.approx(per_repeat[2])
