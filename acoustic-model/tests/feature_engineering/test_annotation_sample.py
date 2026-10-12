"""The pre-registered rules of the pause-annotation sample (PLAN.md 3.2), on synthetic candidates."""

import numpy as np
import pandas as pd
import pytest
import soundfile as sf

from mzazi_acoustic.common import config
from mzazi_acoustic.feature_engineering import annotation_sample as ann


def candidates(noisy_per_class=(4, 4), n_subjects=12):
    rows = []
    for label in (0, 1):
        for s in range(n_subjects):
            for c in range(2):  # two clips per subject, so "one per subject" is actually tested
                rows.append({"file_id": f"L{label}S{s}f{c}", "subject_id": f"L{label}S{s}", "label": label,
                             "trimmed_s": 80.0, "noise_guard_active": s < noisy_per_class[label],
                             "noise_floor_dbfs": -60.0 + s})  # higher subject index = noisier
    frame = pd.DataFrame(rows)
    frame.loc[frame["subject_id"].str.endswith("S11"), "trimmed_s"] = 40.0  # too short to be eligible
    return frame


def test_five_per_class_one_per_subject_eligible_only():
    sample, _ = ann.draw_annotation_sample(candidates(), seed=1)
    assert len(sample) == 10
    assert sample["label"].value_counts().to_dict() == {0: 5, 1: 5}
    assert sample["subject_id"].is_unique
    assert (sample["trimmed_s"] >= config.ANNOTATION_MIN_TRIMMED_SECONDS).all()


def test_noisy_quota_and_shortfall():
    sample, shortfall = ann.draw_annotation_sample(candidates(noisy_per_class=(4, 1)), seed=1)
    noisy = sample.groupby("label")["noise_guard_active"].sum().to_dict()
    assert noisy == {0: config.ANNOTATION_NOISY_PER_CLASS, 1: 1}
    assert shortfall == {0: 0, 1: config.ANNOTATION_NOISY_PER_CLASS - 1}


def test_shortfall_is_filled_with_the_highest_noise_floor_clips():
    sample, _ = ann.draw_annotation_sample(candidates(noisy_per_class=(4, 1)), seed=1)
    class1 = sample[sample["label"] == 1]
    fallback = class1[class1["picked_as"] == "noise_floor_fallback"]
    assert len(fallback) == config.ANNOTATION_NOISY_PER_CLASS - 1
    # Subject 11 is too short to be eligible, so the noisiest eligible one is subject 10.
    assert set(fallback["subject_id"]) == {"L1S10"}
    assert (class1["picked_as"] == "noise_guard").sum() == 1


def test_reproducible_and_ids_carry_no_label():
    first, _ = ann.draw_annotation_sample(candidates(), seed=7)
    second, _ = ann.draw_annotation_sample(candidates(), seed=7)
    assert first.equals(second)
    assert list(first["ann_id"]) == [f"ann_{i:02d}" for i in range(1, 11)]
    # Shuffled: the classes are not simply in two blocks of five.
    assert list(first["label"]) not in ([0] * 5 + [1] * 5, [1] * 5 + [0] * 5)


def test_too_few_subjects_is_an_error_not_a_smaller_sample():
    with pytest.raises(ValueError):
        ann.draw_annotation_sample(candidates(n_subjects=4), seed=1)


def test_export_writes_exactly_the_60_second_segment(tmp_path):
    sr = config.TARGET_SAMPLE_RATE
    processed = tmp_path / "processed"
    processed.mkdir()
    sample = pd.DataFrame({"ann_id": ["ann_01"], "file_id": ["X"], "subject_id": ["S"], "label": [1],
                           "trimmed_s": [80.0], "noise_guard_active": [False]})
    ramp = np.arange(80 * sr, dtype=np.float32) / sr  # value = time in seconds, so the cut is checkable
    sf.write(processed / "X.wav", ramp, sr, subtype="FLOAT")
    key = ann.export_segments(sample, processed, tmp_path / "out")
    clip, clip_sr = sf.read(tmp_path / "out" / "ann_01.wav", dtype="float32")
    assert len(clip) == 60 * sr and clip_sr == sr
    assert clip[0] == pytest.approx(10.0)
    assert key.loc[0, "segment_start_s"] == 10.0 and key.loc[0, "segment_end_s"] == 70.0
