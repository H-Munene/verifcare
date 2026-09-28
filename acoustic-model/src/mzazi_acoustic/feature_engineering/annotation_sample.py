"""The blinded sample of clips the developer hand-annotates to validate the pause detector (PLAN.md 3.2).

Pre-registered rules:
- only training-portion clips (the caller passes them through guards.load_rows), so no test audio
  is heard before Stage 5;
- eligible if at least ANNOTATION_MIN_TRIMMED_SECONDS long, so the fixed 60 s segment starting
  10 s in fits inside the kept audio;
- 5 clips per class (ANNOTATION_FILES / 2), at most one per subject;
- ANNOTATION_NOISY_PER_CLASS of each class's 5 are "noisy": first clips where the noise guard is
  active; if too few, the quota is completed with the clips with the highest Stage 1 noise-floor
  estimate (developer, 2026-09-28). How each noisy clip was chosen is recorded;
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
    """Returns (sample, shortfall).

    candidates needs file_id, subject_id, label, trimmed_s, noise_guard_active and noise_floor_dbfs
    (Stage 1). sample adds `picked_as`: 'noise_guard', 'noise_floor_fallback' or 'other'. shortfall
    maps label -> how many noisy clips had to come from the noise-floor fallback.
    """
    rng = np.random.default_rng(seed)
    eligible = candidates[candidates["trimmed_s"] >= config.ANNOTATION_MIN_TRIMMED_SECONDS]
    picked, shortfall = [], {}
    for label in sorted(eligible["label"].unique()):
        pool = _one_per_subject(eligible[eligible["label"] == label], rng)
        guard = pool[pool["noise_guard_active"]].iloc[:config.ANNOTATION_NOISY_PER_CLASS].assign(picked_as="noise_guard")
        missing = config.ANNOTATION_NOISY_PER_CLASS - len(guard)
        fallback = (pool.drop(guard.index).sort_values("noise_floor_dbfs", ascending=False)
                    .iloc[:missing].assign(picked_as="noise_floor_fallback"))
        shortfall[label] = missing
        taken = pd.concat([guard, fallback])
        rest = pool.drop(taken.index).iloc[:PER_CLASS - len(taken)].assign(picked_as="other")
        chosen = pd.concat([taken, rest])
        if len(chosen) < PER_CLASS:
            raise ValueError(f"only {len(chosen)} eligible subjects for label {label}; need {PER_CLASS}")
        picked.append(chosen)
    sample = pd.concat(picked)
    sample = sample.iloc[rng.permutation(len(sample))].reset_index(drop=True)
    sample.insert(0, "ann_id", [f"ann_{i + 1:02d}" for i in range(len(sample))])
    columns = ["ann_id", "file_id", "subject_id", "label", "trimmed_s", "noise_guard_active",
               "noise_floor_dbfs", "picked_as"]
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
