"""SV3: voiceprints, trial scores and both clip scores for every simulated visit, for config.SV_DATASET.

Everything is cached under the git-ignored data folder, so an interrupted run resumes. These are
voiceprints: delete data/speaker_verification once results are final.
"""

import json
import time
import zlib

import numpy as np
import pandas as pd

from mzazi_acoustic.common import config, degradation
from mzazi_acoustic.speaker_verification import embed, enrol, metrics, trials, verify
from mzazi_acoustic.speaker_verification.vad import Vad

OUT = config.SV_DATASET_RESULTS
DATA = config.SV_DATASET_DIR
POOLS = DATA / "speech"
VISITS = DATA / "visit_scores"
SR = config.SV_SAMPLE_RATE


PEOPLE = ("caregiver", "dependant", "first", "second")


def speaker_seed(speaker):
    """A stable number per speaker, since AfriVoices IDs aren't numbers."""
    return zlib.crc32(str(speaker).encode())


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
    """Both clip scores for one condition's visits. Each visit's randomness depends only on its identity.

    The caregiver's recording is checked against the enrolled caregiver and the dependant's against
    the enrolled dependant, through the same VAD-then-embed path a real recording would take.
    """
    name, noise, snr, clip_seconds, enrol_seconds = condition
    target = VISITS / f"{split}_{name}.npz"
    if target.exists():
        return None
    enrolled = {}
    timings, scores = [], {"caregiver": [], "caregiver_speech": [], "dependant": [], "dependant_speech": []}

    def voiceprint(speaker):
        if speaker not in enrolled:
            rng = np.random.default_rng([config.SEED, speaker_seed(speaker), condition_index])
            enrolled[speaker] = embedder.embed(conditioned(seconds(pool(speaker, "enrol"), enrol_seconds), noise, snr, rng))
        return enrolled[speaker]

    for visit_number, row in enumerate(plan.itertuples()):
        rng = np.random.default_rng([config.SEED, condition_index, int(row.pair), visit_number])
        recordings = (("caregiver", row.first, row.caregiver), ("dependant", row.second, row.dependant))
        clips = [conditioned(trials.clip_from_pool(pool(speaker, "test"), slot, clip_seconds), noise, snr, rng)
                 for slot, (_, speaker, _) in enumerate(recordings)]
        started = time.perf_counter()
        for (role, _, claimed), clip in zip(recordings, clips):
            score, speech = verify.score_clip(clip, vad, embedder, voiceprint(claimed))
            scores[role].append(score)
            scores[f"{role}_speech"].append(speech)
        timings.append(time.perf_counter() - started)
    VISITS.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(target, **{key: np.array(values) for key, values in scores.items()},
                        seconds_per_visit=np.array(timings))
    return float(np.median(timings))


def embeddings_report(scores, holdout_open):
    """03_embeddings.md for Gate 3: E1 against B0 on calibration speakers only."""
    calibration = scores[scores["split"] == "calibration"]
    rows = []
    for length, group in calibration.groupby("test_seconds"):
        row = {"test seconds": f"{length:g}", "target trials": int(group["label"].sum()),
               "impostor trials": int((group["label"] == 0).sum())}
        for model in ("e1", "b0"):
            row[f"{model.upper()} EER"] = f"{metrics.equal_error_rate(group['label'], group[model])[0]:.3f}"
            row[f"{model.upper()} minDCF"] = f"{metrics.min_dcf(group['label'], group[model]):.3f}"
        rows.append(row)
    lines = [f"# SV3 voiceprints: {config.SV_DATASET}", "",
             "Calibration speakers only. Clean audio, enrolment from a different day to the test audio.", "",
             pd.DataFrame(rows).to_markdown(index=False), "",
             f"E1 is `{config.SV_MODEL_NAME}` at revision `{config.SV_MODEL_REVISION[:8]}`, frozen. B0 is MFCC statistics.",
             "Test speakers: " + ("scored." if holdout_open else "not scored. They wait until SV4 freezes the rule."), ""]
    (OUT / "03_embeddings.md").write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))


def main():
    speakers = pd.read_csv(DATA / "speakers.csv", dtype={"speaker": str})
    plan = pd.read_csv(DATA / "visits.csv", dtype={column: str for column in PEOPLE})
    embedder = embed.Embedder()
    vad = Vad()
    OUT.mkdir(parents=True, exist_ok=True)

    # Real test speakers are scored only once SV4's rule is frozen in config.py, so no test score exists before then.
    holdout_open = config.SV_DATASET in config.SV_DEV_DATASETS or config.SV_FROZEN_RULE is not None
    splits = ["calibration", "holdout"] if holdout_open else ["calibration"]

    target = DATA / "trial_scores.csv"
    done = pd.read_csv(target) if target.exists() else pd.DataFrame({"split": []})
    frames = [done] + [trial_scores(speakers[speakers["split"] == split], embedder).assign(split=split)
                       for split in splits if split not in set(done["split"])]
    if len(frames) > 1:
        pd.concat(frames, ignore_index=True).to_csv(target, index=False)
    embeddings_report(pd.read_csv(target), holdout_open)

    timing = {}
    conditions = {"calibration": [config.SV_PRIMARY_CONDITION],
                  "holdout": [config.SV_PRIMARY_CONDITION, *config.SV_VARIANT_CONDITIONS]}
    for split, wanted in conditions.items():
        if split not in splits:
            continue
        for condition in wanted:
            index = [config.SV_PRIMARY_CONDITION, *config.SV_VARIANT_CONDITIONS].index(condition)
            result = visit_scores(split, plan[plan["split"] == split], condition, index, embedder, vad)
            print(split, condition[0], result, flush=True)
            if result is not None:
                timing[f"{split}/{condition[0]}"] = result
    if timing:  # merged, so scoring the test speakers later keeps the calibration timings
        path = OUT / "03_timing.json"
        earlier = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        path.write_text(json.dumps({**earlier, **timing}, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
