"""SV3: voiceprints, trial scores and window scores for every simulated visit. Development data only.

Everything is cached under the git-ignored data folder, so an interrupted run resumes. These are
voiceprints: delete data/speaker_verification once results are final.
"""

import json
import time

import numpy as np
import pandas as pd

from mzazi_acoustic.common import config, degradation
from mzazi_acoustic.speaker_verification import embed, enrol, segment, trials
from mzazi_acoustic.speaker_verification.vad import Vad

OUT = config.SV_DEV_RESULTS
DATA = config.SV_DATA_DIR
POOLS = DATA / "speech"
VISITS = DATA / "visit_scores"
SR = config.SV_SAMPLE_RATE


def pool(speaker, kind):
    return np.load(POOLS / f"{speaker}_{kind}.npy").astype(np.float32) / 32767


def seconds(y, value):
    return y[:round(value * SR)]


def trial_scores(speakers, embedder):
    """Same-person and different-person scores for E1 and B0 at each test length, clean audio."""
    usable = speakers[speakers["eligible"]].reset_index(drop=True)
    index = {speaker: i for i, speaker in enumerate(usable["speaker"])}
    enrolled = np.stack([enrol.voiceprint_from_speech(pool(s, "enrol"), embedder) for s in usable["speaker"]])
    enrolled_b0 = np.stack([embed.mfcc_statistics(seconds(pool(s, "enrol"), config.SV_ENROL_SECONDS))
                            for s in usable["speaker"]])
    list_ = trials.verification_trials(usable)
    enrol_i, test_i = list_["enrol"].map(index).to_numpy(), list_["test"].map(index).to_numpy()
    frames = []
    for length in config.SV_TEST_SECONDS:
        clips = [seconds(pool(s, "test"), length) for s in usable["speaker"]]
        e1 = np.stack([embedder.embed(clip) for clip in clips])
        b0 = np.stack([embed.mfcc_statistics(clip) for clip in clips])
        frames.append(list_.assign(test_seconds=length, e1=(enrolled[enrol_i] * e1[test_i]).sum(axis=1),
                                   b0=(enrolled_b0[enrol_i] * b0[test_i]).sum(axis=1)))
    return pd.concat(frames, ignore_index=True)


def conditioned(y, noise, snr, rng):
    return y if noise is None else np.asarray(degradation.degrade(y, SR, noise, snr, rng)[0], dtype=np.float32)


def visit_scores(split, plan, condition, condition_index, embedder, vad):
    """Window scores for one condition's visits. Each visit's randomness depends only on its identity."""
    name, noise, snr, share, enrol_seconds, overlap = condition
    target = VISITS / f"{split}_{name}.npz"
    if target.exists():
        return None
    enrolled = {}
    timings, caregiver_scores, dependant_scores, lengths = [], [], [], []

    def voiceprint(speaker):
        if speaker not in enrolled:
            rng = np.random.default_rng([config.SEED, int(speaker), condition_index])
            enrolled[speaker] = embedder.embed(conditioned(seconds(pool(speaker, "enrol"), enrol_seconds), noise, snr, rng))
        return enrolled[speaker]

    for visit_number, row in enumerate(plan.itertuples()):
        rng = np.random.default_rng([config.SEED, condition_index, int(row.pair), visit_number])
        second = None if pd.isna(row.second) else pool(str(int(row.second)), "test")
        audio, _ = trials.compose_visit(pool(str(int(row.first)), "test"), second, share, rng, overlap_seconds=overlap)
        audio = conditioned(audio, noise, snr, rng)
        started = time.perf_counter()
        mask = vad.speech_mask(audio)
        caregiver, dependant = segment.score_windows(audio, mask, embedder, voiceprint(str(int(row.caregiver))),
                                                     voiceprint(str(int(row.dependant))))
        timings.append(time.perf_counter() - started)
        caregiver_scores.append(caregiver)
        dependant_scores.append(dependant)
        lengths.append(len(caregiver))
    VISITS.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(target, caregiver=np.concatenate(caregiver_scores), dependant=np.concatenate(dependant_scores),
                        lengths=np.array(lengths), seconds_per_visit=np.array(timings))
    return float(np.median(timings))


def main():
    speakers = pd.read_csv(DATA / "librispeech_speakers.csv", dtype={"speaker": str})
    plan = pd.read_csv(DATA / "librispeech_visits.csv")
    embedder = embed.Embedder()
    vad = Vad()
    OUT.mkdir(parents=True, exist_ok=True)

    target = DATA / "trial_scores.csv"
    if not target.exists():
        frames = [trial_scores(group, embedder).assign(split=split) for split, group in speakers.groupby("split")]
        pd.concat(frames, ignore_index=True).to_csv(target, index=False)

    timing = {}
    conditions = {"calibration": [config.SV_PRIMARY_CONDITION],
                  "holdout": [config.SV_PRIMARY_CONDITION, *config.SV_VARIANT_CONDITIONS]}
    for split, wanted in conditions.items():
        for condition in wanted:
            index = [config.SV_PRIMARY_CONDITION, *config.SV_VARIANT_CONDITIONS].index(condition)
            result = visit_scores(split, plan[plan["split"] == split], condition, index, embedder, vad)
            print(split, condition[0], result, flush=True)
            if result is not None:
                timing[f"{split}/{condition[0]}"] = result
    if timing:
        (OUT / "03_timing.json").write_text(json.dumps(timing, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
