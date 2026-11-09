"""SV2: speech pools, speaker split and visit plan. Development data only."""

import numpy as np
import pandas as pd
import soundfile as sf

from mzazi_acoustic.common import config
from mzazi_acoustic.speaker_verification import trials
from mzazi_acoustic.speaker_verification.vad import Vad

OUT = config.SV_DEV_RESULTS
DATA = config.SV_DATA_DIR
POOLS = DATA / "speech"
# More raw audio than the speech needed, because silence is removed afterwards.
RAW_ALLOWANCE = 1.3
ENROL_RAW = config.SV_ENROL_SECONDS * RAW_ALLOWANCE
TEST_RAW = config.SV_TRIAL_TEST_POOL_SECONDS * RAW_ALLOWANCE


def choose_recordings(manifest):
    """Each speaker's two longest chapters: enrolment from the first, test audio from the second."""
    rows = []
    for speaker, group in manifest.groupby("speaker"):
        chapters = group.groupby("chapter")["seconds"].sum().sort_values(ascending=False, kind="stable")
        eligible = len(chapters) >= 2 and chapters.iloc[0] >= ENROL_RAW and chapters.iloc[1] >= TEST_RAW
        enrol = chapters.index[0]
        test = chapters.index[1] if eligible else chapters.index[0]
        rows.append({"speaker": speaker, "sex": group["sex"].iloc[0], "eligible": eligible,
                     "enrol_recording": f"{speaker}_{enrol}", "test_recording": f"{speaker}_{test}",
                     "enrol_chapter": enrol, "test_chapter": test})
    return pd.DataFrame(rows)


def speech_pool(paths, seconds, vad):
    """Speech only, read utterance by utterance until there is enough."""
    pieces, have = [], 0
    needed = round(seconds * config.SV_SAMPLE_RATE)
    for path in paths:
        y, _ = sf.read(config.LIBRISPEECH_DIR / path, dtype="float32")
        speech = y[vad.speech_mask(y)]
        pieces.append(speech)
        have += len(speech)
        if have >= needed:
            break
    return np.concatenate(pieces)[:needed]


def save_pool(name, pool):
    np.save(POOLS / f"{name}.npy", (pool * 32767).astype(np.int16))


def main():
    manifest = pd.read_csv(DATA / "librispeech_manifest.csv", dtype={"speaker": str, "chapter": str})
    POOLS.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    table = choose_recordings(manifest)
    trials.assert_no_locked_people(table["speaker"], trials.locked_people())
    trials.assert_different_recordings(table)
    table = trials.speaker_split(table)

    vad = Vad()
    usable_pool = []
    for row in table.itertuples():
        own = manifest[manifest["speaker"] == row.speaker]
        test_paths = own.loc[own["chapter"] == row.test_chapter, "path"].sort_values()
        target = f"{row.speaker}_test.npy"
        if not (POOLS / target).exists():
            save_pool(f"{row.speaker}_test", speech_pool(test_paths, config.SV_TRIAL_TEST_POOL_SECONDS, vad))
        if row.eligible and not (POOLS / f"{row.speaker}_enrol.npy").exists():
            enrol_paths = own.loc[own["chapter"] == row.enrol_chapter, "path"].sort_values()
            save_pool(f"{row.speaker}_enrol", speech_pool(enrol_paths, config.SV_ENROL_SECONDS, vad))
        usable_pool.append(len(np.load(POOLS / target, mmap_mode="r")) / config.SV_SAMPLE_RATE)
    table["test_pool_seconds"] = usable_pool
    # Someone whose speech ran short can't supply the longest test segment, so they only act as a stranger.
    table["eligible"] &= table["test_pool_seconds"] >= config.SV_TEST_SECONDS[-1]
    table = table[table["test_pool_seconds"] >= config.SV_TEST_SECONDS[-1] / 2].reset_index(drop=True)
    table.to_csv(DATA / "librispeech_speakers.csv", index=False)

    plans = []
    for split, group in table.groupby("split"):
        plan = trials.plan_visits(group)
        plan = plan[plan["pair"] < config.SV_DEV_MAX_PAIRS]
        plan.insert(0, "split", split)
        plans.append(plan)
    plan = pd.concat(plans, ignore_index=True)
    plan.to_csv(DATA / "librispeech_visits.csv", index=False)

    counts = table.groupby(["split", "sex"]).agg(speakers=("speaker", "count"), eligible=("eligible", "sum"))
    visits = plan.groupby(["split", "scenario"]).size().unstack()
    lines = ["# SV2 processing: LibriSpeech", "", "**Development data only. Judges no target.**", "",
             counts.to_markdown(), "", "Simulated visits per condition:", "", visits.to_markdown(), "",
             "Enrolment and test audio come from different chapters, checked by `assert_different_recordings`.",
             "Speakers who are not eligible act only as strangers.", ""]
    (OUT / "02_processing.md").write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
