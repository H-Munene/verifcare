"""The blinded sample of clips the developer hand-annotates to validate the pause detector (PLAN.md 3.2).

Pre-registered rules:
- only training-portion clips (the caller passes them through guards.load_rows), so no test audio
  is heard before Stage 5;
- eligible if at least ANNOTATION_MIN_TRIMMED_SECONDS long, so the fixed 60 s segment starting
  10 s in fits inside the kept audio;
- 5 clips per class (ANNOTATION_FILES / 2), at most one per subject;
- ANNOTATION_NOISY_PER_CLASS of each class's 5 drawn from clips where the noise guard is active,
  when enough exist (any shortfall is recorded, then filled from the other clips);
- shuffled, with neutral ids ann_01..ann_10, so an id says nothing about the class.
"""

import numpy as np
import pandas as pd
import soundfile as sf

from mzazi_acoustic.common import config

PER_CLASS = config.ANNOTATION_FILES // 2


def _one_per_subject(frame, rng):
    """One randomly chosen clip for each subject in frame."""
    order = rng.permutation(len(frame))
    return frame.iloc[order].drop_duplicates("subject_id")


def draw_annotation_sample(candidates, seed=config.SEED):
    """Returns (sample, shortfall). sample has ann_id, file_id, subject_id, label, trimmed_s,
    noise_guard_active; shortfall maps label -> how many noisy clips were missing from the quota."""
    rng = np.random.default_rng(seed)
    eligible = candidates[candidates["trimmed_s"] >= config.ANNOTATION_MIN_TRIMMED_SECONDS]
    picked, shortfall = [], {}
    for label in sorted(eligible["label"].unique()):
        pool = _one_per_subject(eligible[eligible["label"] == label], rng)
        noisy = pool[pool["noise_guard_active"]]
        take_noisy = noisy.iloc[:config.ANNOTATION_NOISY_PER_CLASS]
        shortfall[label] = config.ANNOTATION_NOISY_PER_CLASS - len(take_noisy)
        rest = pool.drop(take_noisy.index).iloc[:PER_CLASS - len(take_noisy)]
        chosen = pd.concat([take_noisy, rest])
        if len(chosen) < PER_CLASS:
            raise ValueError(f"only {len(chosen)} eligible subjects for label {label}; need {PER_CLASS}")
        picked.append(chosen)
    sample = pd.concat(picked)
    sample = sample.iloc[rng.permutation(len(sample))].reset_index(drop=True)
    sample.insert(0, "ann_id", [f"ann_{i + 1:02d}" for i in range(len(sample))])
    columns = ["ann_id", "file_id", "subject_id", "label", "trimmed_s", "noise_guard_active"]
    return sample[columns], shortfall


def export_segments(sample, processed_dir, dest_dir):
    """Write the fixed segment [offset, offset + 60 s) of each processed clip as <ann_id>.wav.

    Returns the key (ann_id -> file_id, label, segment bounds), which must stay closed while
    annotating.
    """
    dest_dir.mkdir(parents=True, exist_ok=True)
    start_s = config.ANNOTATION_SEGMENT_OFFSET_SECONDS
    end_s = start_s + config.ANNOTATION_SEGMENT_SECONDS
    for row in sample.itertuples():
        y, sr = sf.read(processed_dir / f"{row.file_id}.wav", dtype="float32")
        sf.write(dest_dir / f"{row.ann_id}.wav", y[int(start_s * sr):int(end_s * sr)], sr, subtype="FLOAT")
    key = sample.copy()
    key["segment_start_s"], key["segment_end_s"] = start_s, end_s
    return key
