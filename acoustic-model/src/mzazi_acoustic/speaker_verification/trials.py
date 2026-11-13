"""Evaluation only: speaker splits, leakage guards, trial lists and visit plans."""

import json
from datetime import datetime

import numpy as np
import pandas as pd

from mzazi_acoustic.common import config
from mzazi_acoustic.speaker_verification import decide


def locked_people(splits_file=config.PROCESSING_RESULTS / "splits.csv"):
    """The people in the cognitive model's locked test set, who may not enter this module."""
    splits = pd.read_csv(splits_file)
    return set(splits.loc[splits["split"] == "test", "subject_id"].astype(str))


def assert_no_locked_people(speakers, locked):
    found = set(map(str, speakers)) & set(map(str, locked))
    if found:
        raise ValueError(f"{len(found)} people from the locked test set reached the speaker verification data")


def assert_speaker_disjoint(table):
    """No speaker in more than one split."""
    if table.groupby("speaker")["split"].nunique().max() > 1:
        raise ValueError("a speaker appears in more than one split")


def assert_different_recordings(table):
    """A speaker's enrolment and test audio must come from different recordings."""
    usable = table[table["eligible"]]
    if (usable["enrol_recording"] == usable["test_recording"]).any():
        raise ValueError("a recording is used for both enrolment and test")


def claim_test_set(dataset, marker=config.SV_TEST_MARKER, development=config.SV_DEV_DATASETS):
    """Score-once guard. Development datasets judge nothing, so they never use up the test set."""
    if dataset in development:
        return False
    if marker.exists():
        raise RuntimeError(f"The test set was already used ({marker.read_text(encoding='utf-8')}); it may be used once.")
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(json.dumps({"used_at": datetime.now().isoformat(timespec="seconds"), "dataset": dataset}),
                      encoding="utf-8")
    return True


def speaker_split(speakers, seed=config.SEED, calibration_share=config.SV_CALIBRATION_SHARE):
    """Divide speakers into calibration and holdout, keeping the same mix of language, group, sex and eligibility."""
    rng = np.random.default_rng(seed)
    result = speakers.copy()
    result["split"] = "holdout"
    strata = [column for column in ("language", "group", "sex", "eligible") if column in result]
    for _, group in result.groupby(strata):
        shuffled = rng.permutation(group.index.to_numpy())
        result.loc[shuffled[:round(len(shuffled) * calibration_share)], "split"] = "calibration"
    assert_speaker_disjoint(result)
    return result


def verification_trials(speakers):
    """Every eligible voiceprint against every eligible test recording of the same sex in its split.

    A speaker's own row is a target trial, and uses their test recording, which differs from their
    enrolment recording. Returns (enrol, test, label).
    """
    assert_different_recordings(speakers)
    rows = []
    usable = speakers[speakers["eligible"]]
    for enrol in usable.itertuples():
        for test in usable[usable["sex"] == enrol.sex].itertuples():
            rows.append((enrol.speaker, test.speaker, int(enrol.speaker == test.speaker)))
    return pd.DataFrame(rows, columns=["enrol", "test", "label"])


def plan_visits(speakers, seed=config.SEED):
    """Pair each eligible speaker with one other, so pairs are independent, and plan every scenario.

    Each row says who is enrolled (caregiver, dependant) and who actually speaks in each recording:
    first in the caregiver's, second in the dependant's. A stranger matches the sex of the person they
    replace. A caregiver alone speaks in both, using a different part of their test audio for each.
    """
    assert_different_recordings(speakers)
    rng = np.random.default_rng(seed)
    usable = speakers.loc[speakers["eligible"], "speaker"].to_numpy()
    shuffled = rng.permutation(usable)
    sex = dict(zip(speakers["speaker"], speakers["sex"]))
    rows = []

    def stranger(replaced, exclude):
        pool = speakers[(speakers["sex"] == sex[replaced]) & ~speakers["speaker"].isin(exclude)]["speaker"].to_numpy()
        return rng.choice(pool)

    for pair, (caregiver, dependant) in enumerate(zip(shuffled[::2], shuffled[1::2])):
        people = (caregiver, dependant)
        rows += [
            (pair, decide.GENUINE, caregiver, dependant, caregiver, dependant),
            (pair, "caregiver_alone", caregiver, dependant, caregiver, caregiver),
            (pair, "different_dependant", caregiver, dependant, caregiver, stranger(dependant, people)),
            (pair, "different_caregiver", caregiver, dependant, stranger(caregiver, people), dependant),
        ]
    return pd.DataFrame(rows, columns=["pair", "scenario", "caregiver", "dependant", "first", "second"])



def longest_clip_speech(conditions=(config.SV_PRIMARY_CONDITION, *config.SV_VARIANT_CONDITIONS)):
    return max(condition[3] for condition in conditions)


def clip_from_pool(pool, slot, seconds, sr=config.SV_SAMPLE_RATE):
    """The caregiver's recording (slot 0) or the dependant's (slot 1), from separate parts of one test pool.

    So a caregiver alone never supplies the same audio to both recordings.
    """
    length = round(seconds * sr)
    clip = pool[slot * length:(slot + 1) * length]
    if len(clip) < length:
        raise ValueError(f"the test pool holds {len(pool) / sr:.1f} s, too little for slot {slot} of {seconds} s")
    return clip
