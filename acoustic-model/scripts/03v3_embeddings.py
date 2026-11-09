"""v3 Stage 3: frozen XLS-R embeddings and the C1 features (PLAN.md v3.2, v3.4).

Reads training-portion and trajectory clips only. Unlike v2's 03_features.py, test-split clips are
never read: the test set was used in v2 and stays locked, and this script refuses them itself.

Writes one cached array per clip and variant to data/embeddings/<variant>/<file_id>.npy (resumable:
existing files are skipped), plus results/03v3_embeddings/:
  embedding_index.csv   one row per clip and variant: windows, seconds of audio, seconds to embed
  c1_features.csv       v2's feature function on the same clips (comparator C1)

    python scripts/03v3_embeddings.py --time 5   # time 5 training clips, print the encoder revision
    python scripts/03v3_embeddings.py            # everything (needs config.ENCODER_REVISION pinned)
"""

import argparse
import sys
import time
import zlib

import numpy as np
import pandas as pd
import soundfile as sf
from huggingface_hub import HfApi

from mzazi_acoustic.common import config, degradation, guards
from mzazi_acoustic.embeddings import xlsr
from mzazi_acoustic.feature_engineering.features import extract_features

OUT = config.EMBEDDING_RESULTS


def clips():
    """Training-portion rows (through the guard) plus trajectory rows. Never a test-split row."""
    splits = pd.read_csv(guards.SPLITS_FILE)
    training = guards.load_rows(splits[["file_id", "subject_id", "label"]])
    trajectory = splits.loc[splits["role"] == "trajectory", ["file_id", "subject_id", "label"]]
    test_ids = set(splits.loc[splits["split"] == "test", "file_id"])
    trajectory = trajectory[~trajectory["file_id"].isin(test_ids)]  # a trajectory clip of a test person
    rows = pd.concat([training.assign(role="training_pool"), trajectory.assign(role="trajectory")],
                     ignore_index=True)[["file_id", "subject_id", "label", "role"]]
    assert not set(rows["file_id"]) & test_ids, "a test-split clip reached the v3 extraction"
    return rows


def variants(row, y, sr):
    """(variant name, audio) pairs for one clip. C3 and C5 are training-portion only."""
    yield "clean", y
    if row.role != "training_pool":
        return
    audio, _ = xlsr.pause_audio(y, sr)
    yield "pause_only", audio
    rng = np.random.default_rng([config.SEED, zlib.crc32(row.file_id.encode())])  # v2's per-file seeding
    for name, noise_type, snr in config.V3_ROBUSTNESS_CONDITIONS:
        degraded, _ = degradation.degrade(y, sr, noise_type, snr, rng)
        yield name, degraded.astype(np.float32)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--time", type=int, metavar="N", help="time N training clips, then stop")
    args = parser.parse_args()
    if not args.time and config.ENCODER_REVISION is None:
        sys.exit("Pin config.ENCODER_REVISION first (run with --time to print it).")

    rows = clips()
    if args.time:
        rows = rows[rows["role"] == "training_pool"].head(args.time)
    # The pinned commit, or (for --time, before pinning) the current one: either way the exact
    # commit is what gets loaded and printed.
    revision = config.ENCODER_REVISION or HfApi().model_info(config.ENCODER_NAME).sha
    model, extractor = xlsr.load_encoder(revision=revision)
    print(f"Encoder {config.ENCODER_NAME} at revision {revision}")

    OUT.mkdir(parents=True, exist_ok=True)
    index, c1 = [], []
    for i, row in enumerate(rows.itertuples(), start=1):
        y, sr = sf.read(config.PROCESSED_DIR / f"{row.file_id}.wav", dtype="float32")
        if not args.time:
            c1.append({"file_id": row.file_id, **extract_features(y, sr)})
        for variant, audio in variants(row, y, sr):
            path = xlsr.cache_path(variant, row.file_id)
            seconds = len(audio) / sr
            entry = {"file_id": row.file_id, "variant": variant, "audio_seconds": seconds,
                     "n_windows": len(xlsr.windows(len(audio), sr))}
            if path.exists() and not args.time:
                index.append({**entry, "embed_seconds": np.nan, "embedded": True})
                continue
            if variant == "pause_only" and seconds < config.PAUSE_ONLY_MIN_SECONDS:
                index.append({**entry, "embed_seconds": 0.0, "embedded": False})  # imputed in the fold
                continue
            started = time.perf_counter()
            vector = xlsr.embed(audio, sr, model, extractor)
            elapsed = time.perf_counter() - started
            if not args.time:
                path.parent.mkdir(parents=True, exist_ok=True)
                # Write then rename, so a run stopped mid-save never leaves a partial file that a
                # resumed run would mistake for a finished one.
                partial = path.with_name(path.stem + ".partial.npy")
                np.save(partial, vector)
                partial.replace(path)
            index.append({**entry, "embed_seconds": elapsed, "embedded": True})
        print(f"  {i}/{len(rows)} {row.file_id}")

    index = pd.DataFrame(index)
    if args.time:
        clean = index[index["variant"] == "clean"]
        per_audio_second = index["embed_seconds"].sum() / index["audio_seconds"].sum()
        print(index.round(2).to_string(index=False))
        print(f"\n{per_audio_second:.3f} s of compute per second of audio "
              f"(clean clips average {clean['audio_seconds'].mean():.1f} s).")
        all_rows = clips()
        estimate = per_audio_second * 85 * (len(all_rows) + 3 * (all_rows["role"] == "training_pool").sum())
        print(f"Rough full-run estimate (85 s per variant, 3 extra variants per training clip): "
              f"{estimate / 3600:.1f} h")
        return
    index.to_csv(OUT / "embedding_index.csv", index=False)
    pd.DataFrame(c1).to_csv(OUT / "c1_features.csv", index=False)
    print(f"Wrote {len(index)} index rows and {len(c1)} C1 feature rows.")


if __name__ == "__main__":
    main()
