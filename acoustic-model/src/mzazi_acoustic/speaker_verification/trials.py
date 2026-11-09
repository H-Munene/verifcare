"""Evaluation only: speaker splits, leakage guards, trial lists and simulated visits."""

import json
from datetime import datetime

import numpy as np
import pandas as pd

from mzazi_acoustic.common import config
from mzazi_acoustic.speaker_verification import decide

MIN_TURN_SECONDS = 0.5
TURN_RMS = 0.05


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
    """Divide speakers into calibration and holdout, keeping the same mix of sex and eligibility in each."""
    rng = np.random.default_rng(seed)
    result = speakers.copy()
    result["split"] = "holdout"
    for _, group in result.groupby(["sex", "eligible"]):
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

    Each row says who is enrolled (caregiver, dependant) and who actually speaks (first, second).
    A stranger matches the sex of the person they replace, and second is None for a caregiver alone.
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
            (pair, "caregiver_alone", caregiver, dependant, caregiver, None),
            (pair, "different_dependant", caregiver, dependant, caregiver, stranger(dependant, people)),
            (pair, "different_caregiver", caregiver, dependant, stranger(caregiver, people), dependant),
        ]
    return pd.DataFrame(rows, columns=["pair", "scenario", "caregiver", "dependant", "first", "second"])


def compose_visit(first, second, second_share, rng, overlap_seconds=0.0, sr=config.SV_SAMPLE_RATE,
                  seconds=config.SV_VISIT_SECONDS):
    """A simulated visit from speech-only pools, alternating turns.

    Returns (audio, turns), where each turn is (0 for first or 1 for second, start, end) in samples.
    `second` is None for one person speaking alone.
    """
    samples = lambda value: round(value * sr)
    total = samples(seconds)
    audio = np.zeros(total, dtype=np.float32)
    speech = samples(seconds * config.SV_VISIT_SPEECH_SHARE)
    pools = [np.asarray(first, dtype=np.float32), None if second is None else np.asarray(second, dtype=np.float32)]
    budget = [speech, 0] if second is None else [speech - samples(seconds * config.SV_VISIT_SPEECH_SHARE * second_share),
                                                 samples(seconds * config.SV_VISIT_SPEECH_SHARE * second_share)]
    levels = 10 ** (rng.uniform(-config.SV_LEVEL_DB, config.SV_LEVEL_DB, 2) / 20)
    cursors, turns = [0, 0], []
    who, position = 0, 0
    minimum = samples(MIN_TURN_SECONDS)
    while position < total and max(budget) >= minimum:
        if budget[who] < minimum:
            who = 1 - who
        length = min(int(rng.integers(samples(config.SV_TURN_SECONDS[0]), samples(config.SV_TURN_SECONDS[1]) + 1)),
                     budget[who], total - position)
        pool = pools[who]
        clip = pool[(cursors[who] + np.arange(length)) % len(pool)]
        rms = float(np.sqrt(np.mean(clip ** 2)))
        audio[position:position + length] += clip * (TURN_RMS / max(rms, 1e-9)) * levels[who]
        turns.append((who, position, position + length))
        budget[who] -= length
        cursors[who] += length
        position += length
        other = 1 - who
        if second is not None and budget[other] >= minimum:
            who = other
            position = max(0, position - samples(overlap_seconds)) if overlap_seconds else position
        if not overlap_seconds or second is None:
            position += int(rng.integers(samples(config.SV_GAP_SECONDS[0]), samples(config.SV_GAP_SECONDS[1]) + 1))
    return np.clip(audio, -1.0, 1.0), turns
