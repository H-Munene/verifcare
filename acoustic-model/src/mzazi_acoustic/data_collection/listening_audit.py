"""Blinded sample for the human listening audit (PLAN.md Stage 1 step 10, decision D1).

The listener must not know each recording's class, so the copies get neutral names (audit_01.wav,
...) in shuffled order. The key linking audit IDs to files and labels goes to a *.local.csv file
that is git-ignored and that the listener should not open until the audit is done.
"""

import shutil

import numpy as np
import pandas as pd

AUDIT_COLUMNS = [
    "audit_id",
    "other_voices",  # yes/no: anyone besides the target speaker (interviewer, audience)
    "overlapping_speech",  # yes/no: two people talking at once
    "music",  # yes/no
    "laughter",  # yes/no
    "applause",  # yes/no
    "background_noise",  # none / mild / strong
    "target_speech_share",  # rough share of speaking time that is the target person: <25%, 25-50%, 50-75%, >75%
    "notes",
]


def draw_sample(files, per_class, seed):
    """per_class recordings from each label, at most one per subject, in shuffled order.

    One recording per subject spreads the sample over as many people as possible.
    Input needs columns file_id, subject_id, label. Returns audit_id, file_id, subject_id, label.
    """
    rng = np.random.default_rng(seed)
    picked = []
    for label in sorted(files["label"].unique()):
        in_class = files[files["label"] == label]
        subjects = rng.choice(in_class["subject_id"].unique(), size=per_class, replace=False)
        for subject in subjects:
            options = in_class[in_class["subject_id"] == subject]
            picked.append(options.iloc[rng.integers(len(options))])
    sample = pd.DataFrame(picked)[["file_id", "subject_id", "label"]]
    sample = sample.iloc[rng.permutation(len(sample))].reset_index(drop=True)
    sample.insert(0, "audit_id", [f"audit_{i + 1:02d}" for i in range(len(sample))])
    return sample


def export(sample, source_paths, dest_dir):
    """Copy each sampled file to dest_dir/<audit_id>.<ext>. source_paths maps file_id -> Path."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    for row in sample.itertuples():
        source = source_paths[row.file_id]
        shutil.copy2(source, dest_dir / f"{row.audit_id}{source.suffix}")


def blank_template(sample):
    """The sheet the listener fills in: audit IDs only, no labels."""
    template = pd.DataFrame(columns=AUDIT_COLUMNS)
    template["audit_id"] = sample["audit_id"]
    return template
