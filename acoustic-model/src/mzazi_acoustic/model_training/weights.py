"""Sample weights (decision D2, PLAN.md Stage 2 step 8 and the Stage 4 calibration note).

Training: each clip weighs 1 / (its person's clip count), so every person counts equally, then the
classes are scaled to equal total weight. Calibration and person-weighted metrics: 1 / clip count
only, so the calibrated probability keeps the dataset's own class balance instead of a forced 50 %.
Counts come from the rows passed in, so inside a fold they are that fold's counts.
"""

import numpy as np
import pandas as pd


def person_weights(subject_ids):
    ids = pd.Series(np.asarray(subject_ids))
    return (1.0 / ids.map(ids.value_counts())).to_numpy(dtype=float, copy=True)  # writable (pandas 3 CoW)


def training_weights(subject_ids, labels):
    weights = person_weights(subject_ids)
    labels = np.asarray(labels)
    target = weights.sum() / 2  # each class gets half the total weight
    for label in (0, 1):
        in_class = labels == label
        weights[in_class] *= target / weights[in_class].sum()
    return weights
