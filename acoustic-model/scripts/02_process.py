"""Stage 2 - Data processing, part 1: audio standardisation and dataset membership (PLAN.md Stage 2).

For every raw recording: 16 kHz mono, trim edge silence (pause-detector rule), apply the 30 s
minimum, keep at most 90 s. Then assign each clip one role, applying the exclusions in this order:
  1. under_30s      - fewer than 30 s after trimming
  2. age            - not wholly aged 55+ (D6 option A), including unknown ages
  3. trajectory     - dementia 10-15 years before onset (D7): Stage 5 trajectory analysis only
  otherwise         - training_pool: the data the split, folds and models will use

Processed audio (float32 WAV, so no second quantisation) is written for training_pool and
trajectory clips only. The split and folds are NOT made here yet: they wait for decision D1.
"""

import pandas as pd
import soundfile as sf

from mzazi_acoustic.common import config, raw_data
from mzazi_acoustic.common.audio import read_mono
from mzazi_acoustic.data_processing import eligibility, standardise

OUT = config.PROCESSING_RESULTS
FORMAT_COLUMNS = ["container", "codec", "sample_rate", "channels"]


def assign_roles(table):
    role = pd.Series("training_pool", index=table.index)
    role[eligibility.trajectory_only(table)] = "trajectory"
    role[~eligibility.primary_dataset(table)] = "excluded_age"
    role[~table["meets_minimum"]] = "excluded_under_30s"
    table["role"] = role
    in_pool = role == "training_pool"
    # Subsets for the pre-registered 5.2 sensitivity analyses (evaluated on test clips only, later).
    table["sensitivity_over_70"] = in_pool & eligibility.over_70_sensitivity(table)
    table["sensitivity_near_onset"] = in_pool & eligibility.near_onset_only(table)
    return table


def group_of(row):
    """Timing bucket for dementia clips, age band for controls: the groups exclusions are reported by."""
    if row.label == 1:
        names = {"0": "after onset", "5": "0-5 y before", "10": "5-10 y before", "15": "10-15 y before"}
        return names.get(str(row.bucket), f"unknown suffix {row.bucket}")
    return {"1": "<55", "2": "55-70", "3": ">70"}[str(row.bucket)]


def exclusion_tables(table):
    table = table.assign(group=table.apply(group_of, axis=1), cls=table["label"].map(config.LABEL_NAMES))
    clips = pd.crosstab([table["cls"], table["group"]], table["role"], margins=True, margins_name="total")
    people = (table.groupby(["cls", "group", "role"])["subject_id"].nunique().unstack(fill_value=0))
    people["total"] = table.groupby(["cls", "group"])["subject_id"].nunique()
    return clips, people


def to_markdown(frame):
    frame = frame.reset_index()
    lines = ["| " + " | ".join(str(c) for c in frame.columns) + " |", "|" + "---|" * len(frame.columns)]
    lines += ["| " + " | ".join(str(v) for v in row) + " |" for row in frame.itertuples(index=False)]
    return lines


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    config.PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    raw_data.verify()

    manifest = pd.read_csv(config.COLLECTION_RESULTS / "file_manifest.csv")
    ages = pd.read_csv(config.COLLECTION_RESULTS / "age_at_recording.csv")
    lookup = pd.read_csv(config.COLLECTION_RESULTS / "file_lookup.local.csv").set_index("file_id")["rel_path"]
    table = manifest[["file_id", *FORMAT_COLUMNS, "duration_s"]].rename(
        columns={c: f"original_{c}" for c in FORMAT_COLUMNS} | {"duration_s": "raw_s"})
    table = ages.merge(table, on="file_id")

    # Age eligibility is known before any audio is read, so each clip can be written as soon as it
    # passes the 30 s minimum, instead of holding every waveform in memory.
    passes_age = eligibility.primary_dataset(table)
    trimmed = []
    for i, row in enumerate(table.itertuples(), start=1):
        y, sr = read_mono(config.DATASET_DIR / lookup[row.file_id])
        kept, trimmed_seconds = standardise.trim_and_truncate(standardise.to_16k_mono(y, sr), config.TARGET_SAMPLE_RATE)
        trimmed.append(trimmed_seconds)
        if passes_age.iloc[i - 1] and trimmed_seconds >= config.MIN_DURATION_SECONDS:
            sf.write(config.PROCESSED_DIR / f"{row.file_id}.wav", kept, config.TARGET_SAMPLE_RATE, subtype="FLOAT")
        if i % 50 == 0:
            print(f"  standardised {i}/{len(table)}")
    table["trimmed_s"] = [round(t, 3) for t in trimmed]
    table["kept_s"] = table["trimmed_s"].clip(upper=config.MAX_DURATION_SECONDS)
    table["meets_minimum"] = table["trimmed_s"] >= config.MIN_DURATION_SECONDS
    table = assign_roles(table)
    written = {p.stem for p in config.PROCESSED_DIR.glob("*.wav")}
    expected = set(table.loc[table["role"].isin(["training_pool", "trajectory"]), "file_id"])
    if not expected <= written:
        raise RuntimeError(f"{len(expected - written)} processed files missing")
    table.to_csv(OUT / "processing_report.csv", index=False)

    clips, people = exclusion_tables(table)
    pool = table[table["role"] == "training_pool"]
    lines = ["# Stage 2 (part 1) - Standardisation and dataset membership", "",
             "Generated by `scripts/02_process.py`. Exclusions apply in order: under 30 s after trimming, then not "
             "wholly aged 55+ (D6), then dementia 10-15 years before onset moved to the trajectory analysis (D7). "
             "No split or folds yet (waiting for D1).", "",
             "## Clips by class and timing/age band", "", *to_markdown(clips), "",
             "## People by class and timing/age band", "",
             "A person is counted in every cell they have a clip in, so rows don't add up to unique people.", "",
             *to_markdown(people), "",
             "## Training pool", ""]
    for label, name in config.LABEL_NAMES.items():
        part = pool[pool["label"] == label]
        lines.append(f"- {name}: {len(part)} clips, {part['subject_id'].nunique()} people, "
                     f"kept duration median {part['kept_s'].median():.1f} s")
    share = (pool.drop_duplicates("subject_id")["label"] == 1).mean()
    lines += [f"- Dementia share: {share:.1%} of people, {(pool['label'] == 1).mean():.1%} of clips.",
              f"- Pre-registered 5.2 sensitivity subsets within the pool: over 70 = {int(pool['sensitivity_over_70'].sum())} clips; "
              f"near onset (dementia 0-5 y) = {int(pool['sensitivity_near_onset'].sum())} clips.",
              f"- Trajectory-only clips (dementia 10-15 y before onset): {int((table['role'] == 'trajectory').sum())}.", ""]
    for name, reason in [("under 30 s", "excluded_under_30s"), ("age", "excluded_age")]:
        for label, cls in config.LABEL_NAMES.items():
            of_class = table[table["label"] == label]
            gone = of_class.groupby("subject_id")["role"].apply(lambda r: (r == reason).all()).sum()
            lines.append(f"- People losing every clip to the {name} rule, {cls}: {gone} of {of_class['subject_id'].nunique()}")
    (OUT / "summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
