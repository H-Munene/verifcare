"""SV1: choose and download the AfriVoices-KE recordings this module uses, and write the data card.

Only the recordings the pipeline reads are kept, as 16 kHz mono FLAC under the git-ignored data folder.
Each parquet block holds a few speakers' recordings and can only be read whole (about 390 MB), so every
needed block is streamed and everything else in it discarded: tens of GB read, a few GB kept.
Resumable: finished blocks are logged and skipped. Speaker IDs and file names never reach results/.

Run in venv-speaker, logged in to Hugging Face (`hf auth login`) with access to the four repos.
"""

import io
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import librosa
import numpy as np
import pandas as pd
import pyarrow.parquet as pq
import soundfile as sf
from huggingface_hub import HfFileSystem, hf_hub_download

from mzazi_acoustic.common import config
from mzazi_acoustic.speaker_verification import afrivoices

DATA = config.SV_DATA_DIR / "afrivoices"
AUDIO = config.AFRIVOICES_DIR / "audio"
META = config.AFRIVOICES_DIR / "metadata"
OUT = config.SV_RESULTS / "afrivoices"
LOG = DATA / "download_log.csv"
BLOCKS = DATA / "blocks.csv"  # cached index of the blocks to download; delete it if the selection changes
DONE = DATA / "blocks_done.txt"
WORKERS = 3  # parallel block downloads
SILENT_DB = -55.0  # a recording quieter than this overall is flagged as near-silent


def read_csv(path, columns):
    """The CSVs mix commas and tabs, and a few text columns we don't read hold bytes that aren't UTF-8."""
    header = pd.read_csv(path, nrows=0, sep=None, engine="python", encoding_errors="replace").columns
    return pd.read_csv(path, sep=None, engine="python", encoding_errors="replace",
                       usecols=[c for c in columns if c in header])


def metadata_file(language, split, name):
    repo, revision = config.AFRIVOICES_REPOS[language]
    return hf_hub_download(repo, f"{split}/{config.AFRIVOICES_TYPE}/files/{name}", repo_type="dataset",
                           revision=revision, local_dir=META / language)


def recordings():
    """Every approved recording of the chosen speakers: all of dev and dev_test, and train's oldest group."""
    frames = []
    for language in config.AFRIVOICES_REPOS:
        for split in (*config.AFRIVOICES_SPLITS, config.AFRIVOICES_OLDER_SPLIT):
            meta = read_csv(metadata_file(language, split, "meta.csv"), ["recorder_uuid", "gender", "ownerAge"])
            meta = meta.drop_duplicates("recorder_uuid")
            older = split == config.AFRIVOICES_OLDER_SPLIT
            if older:
                meta = meta[meta["ownerAge"] == config.AFRIVOICES_OLDER_AGE]
            files = read_csv(metadata_file(language, split, "transcripts.csv"),
                             ["mediaPathId", "recorder_uuid", "duration", "decision"])
            if "decision" in files:
                files = files[files["decision"] == "approved"]
            files = files.merge(meta, on="recorder_uuid")
            filename = files["mediaPathId"].str.split("/").str[-1]
            frames.append(pd.DataFrame({
                "language": language, "split": split, "group": "older" if older else "main",
                "speaker": files["recorder_uuid"].to_numpy(), "sex": files["gender"].map(afrivoices.SEX).fillna("U").to_numpy(),
                "age": files["ownerAge"].to_numpy(), "filename": filename.to_numpy(),
                "utterance": filename.str.replace(r"\.\w+$", "", regex=True).to_numpy(),
                "chapter": afrivoices.recording_day(filename), "listed_seconds": files["duration"].to_numpy()}))
    table = pd.concat(frames, ignore_index=True)
    shared = table.groupby("speaker")["split"].nunique()
    if (shared > 1).any():
        raise ValueError(f"{int((shared > 1).sum())} speakers appear in more than one split")
    duplicates = int(table.duplicated(["language", "filename"]).sum())
    return table.drop_duplicates(["language", "filename"]).reset_index(drop=True), duplicates


def index_file(fs, language, path, names, speakers):
    """The row groups of one parquet file holding a wanted recording. Footer statistics rule most out cheaply."""
    found = []
    with fs.open(path, block_size=2 ** 20) as handle:
        parquet = pq.ParquetFile(handle)
        # The stored column, not the Arrow field: `audio` is a struct stored as two columns, which shifts the rest.
        first = parquet.metadata.row_group(0)
        speaker_column = next(j for j in range(first.num_columns) if first.column(j).path_in_schema == "recorder_uuid")
        for i in range(parquet.metadata.num_row_groups):
            stats = parquet.metadata.row_group(i).column(speaker_column).statistics
            if stats is not None and stats.has_min_max and not any(stats.min <= s <= stats.max for s in speakers):
                continue
            if set(parquet.read_row_group(i, columns=["filename"]).column(0).to_pylist()) & names:
                found.append((language, path, i, parquet.metadata.row_group(i).total_byte_size))
    return found


def blocks(fs, wanted):
    """Every (language, file, row group, bytes) holding a wanted recording, cached for a resumed run."""
    if BLOCKS.exists():
        return list(pd.read_csv(BLOCKS).itertuples(index=False, name=None))
    jobs = []
    for (language, split), group in wanted.groupby(["language", "split"]):
        repo, revision = config.AFRIVOICES_REPOS[language]
        paths = sorted(fs.glob(f"datasets/{repo}@{revision}/{split}/{config.AFRIVOICES_TYPE}/audios/*.parquet"))
        jobs += [(language, path, set(group["filename"]), sorted(set(group["speaker"]))) for path in paths]
    found = []
    with ThreadPoolExecutor(WORKERS * 2) as pool:
        for count, result in enumerate(as_completed([pool.submit(index_file, fs, *job) for job in jobs]), 1):
            found += result.result()
            if count % 25 == 0 or count == len(jobs):
                print(f"indexed {count}/{len(jobs)} files: {len(found)} blocks hold wanted recordings", flush=True)
    found.sort()
    pd.DataFrame(found, columns=["language", "path", "row_group", "bytes"]).to_csv(BLOCKS, index=False)
    return found


def fetch(fs, language, path, row_group, names):
    """Download one block and keep only the wanted recordings, as 16 kHz mono FLAC. Returns their log rows."""
    rows = []
    with fs.open(path, block_size=2 ** 20) as handle:
        table = pq.ParquetFile(handle).read_row_group(row_group, columns=["filename", "audio"])
    filenames = table.column("filename").to_pylist()
    for index in (i for i, filename in enumerate(filenames) if filename in names):
        filename, audio = filenames[index], table.column("audio")[index].as_py()
        row = {"language": language, "filename": filename}
        try:
            y, sr = sf.read(io.BytesIO(audio["bytes"]), dtype="float32", always_2d=True)
            mono = y.mean(axis=1)
            resampled = np.clip(librosa.resample(mono, orig_sr=sr, target_sr=config.SV_SAMPLE_RATE), -1.0, 1.0)
            target = AUDIO / language / f"{filename.rsplit('.', 1)[0]}.flac"
            target.parent.mkdir(parents=True, exist_ok=True)
            sf.write(target, resampled, config.SV_SAMPLE_RATE, subtype="PCM_16")
            level = 20 * np.log10(max(float(np.sqrt(np.mean(mono ** 2))), 1e-10))
            row.update(ok=True, source_rate=sr, channels=y.shape[1], seconds=len(resampled) / config.SV_SAMPLE_RATE,
                       level_db=round(level, 1))
        except Exception as error:  # a corrupt file is logged and counted in the data card, not fatal
            row.update(ok=False, error=type(error).__name__)
        rows.append(row)
    return rows


def download(fs, wanted):
    found = blocks(fs, wanted)
    done = set(DONE.read_text(encoding="utf-8").splitlines()) if DONE.exists() else set()
    todo = [block for block in found if f"{block[1]}#{block[2]}" not in done]
    total = sum(block[3] for block in todo)
    print(f"{len(found)} blocks hold wanted recordings; {len(todo)} left, about {total / 1e9:.1f} GB", flush=True)
    names = wanted.groupby("language")["filename"].apply(set).to_dict()
    started, read = time.perf_counter(), 0
    with ThreadPoolExecutor(WORKERS) as pool:
        futures = {pool.submit(fetch, fs, language, path, i, names[language]): (path, i, size)
                   for language, path, i, size in todo}
        for count, future in enumerate(as_completed(futures), 1):
            path, i, size = futures[future]
            rows = future.result()
            pd.DataFrame(rows).to_csv(LOG, mode="a", header=not LOG.exists(), index=False)
            with DONE.open("a", encoding="utf-8") as handle:
                handle.write(f"{path}#{i}\n")
            read += size
            rate = read / (time.perf_counter() - started)
            print(f"{count}/{len(todo)} blocks, {read / 1e9:.1f} GB, {rate / 1e6:.1f} MB/s, "
                  f"about {(total - read) / rate / 60:.0f} min left", flush=True)


def counts(table):
    keys = ["group", "language"]
    sexes = (table.drop_duplicates("speaker").groupby(keys)["sex"].value_counts().unstack(fill_value=0)
             .rename(columns={"F": "female", "M": "male", "U": "sex unknown"}))
    totals = table.groupby(keys).agg(speakers=("speaker", "nunique"), recordings=("filename", "count"),
                                     hours=("listed_seconds", lambda s: round(s.sum() / 3600, 1)))
    return totals.join(sexes)


def data_card(table, kept, log, duplicates):
    days = table.groupby("speaker")["chapter"].nunique()
    ages = table.drop_duplicates("speaker").groupby(["group", "age"]).size().unstack(fill_value=0)
    ok = log[log["ok"]]
    lines = [
        "# SV1 data card: AfriVoices-KE", "",
        "Kenyan-language spontaneous (unscripted) speech recorded on contributors' smartphones.",
        "Access and terms accepted by the developer on 2026-11-12. Revisions are pinned in `config.AFRIVOICES_REPOS`.",
        "Counts only: no speaker IDs or file names are written here.", "",
        "## All approved recordings of the chosen speakers", "",
        "`main` is every speaker in `dev` and `dev_test`. `older` is the 51+ age band from `train`.", "",
        counts(table).to_markdown(), "", "Age bands (speakers):", "", ages.to_markdown(), "",
        f"Recording days per speaker: median {days.median():.0f}, and {int((days >= 2).sum())} of {len(days)} speakers recorded on two or more days.",
        f"Duplicate file names removed: {duplicates}.", "",
        "## Kept for this module", "",
        f"Per speaker, up to {config.AFRIVOICES_KEEP_SECONDS:.0f} s from each of their two days with the most audio.", "",
        counts(kept).to_markdown(), "",
        "## Download checks", "",
        f"Recordings decoded: {len(ok)} of {len(log)}. Failed: {int((~log['ok']).sum())}.",
        f"Source sample rates (recordings): {ok['source_rate'].value_counts().sort_index().to_dict()}.",
        f"Source channels (recordings): {ok['channels'].value_counts().sort_index().to_dict()}.",
        f"Near-silent recordings (overall level below {SILENT_DB:g} dB): {int((ok['level_db'] < SILENT_DB).sum())}.",
        f"Kept audio: {ok['seconds'].sum() / 3600:.1f} hours, stored as 16 kHz mono FLAC.", "",
        "## Limitations", "",
        "- Speakers are mostly 18 to 40. The `older` group is small, and none of this stands in for elderly or impaired voices.",
        "- No Swahili or English. Somali is in the corpus but this account has no access to it.",
        "- A day is the closest thing to a session. Whether a speaker used the same phone on every day isn't recorded.",
        "- Approved recordings only, as judged by the dataset's own review. Scripted repos have no review column.", ""]
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "01_data.md").write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))


def main():
    DATA.mkdir(parents=True, exist_ok=True)
    table, duplicates = recordings()
    kept = afrivoices.keep_recordings(table)
    print(f"{table['speaker'].nunique()} speakers, {len(table)} recordings; keeping {len(kept)}", flush=True)
    download(HfFileSystem(), kept)
    if not LOG.exists():
        raise SystemExit(f"Nothing was downloaded. If the selection changed, delete {BLOCKS} and run again.")

    log = pd.read_csv(LOG).drop_duplicates(["language", "filename"], keep="last")
    ok = log[log["ok"]][["language", "filename", "seconds"]]
    manifest = kept.merge(ok, on=["language", "filename"])
    manifest = manifest.assign(subset=manifest["language"] + "/" + manifest["split"], sample_rate=config.SV_SAMPLE_RATE,
                               path=manifest["language"] + "/" + manifest["utterance"] + ".flac")
    manifest[["utterance", "speaker", "chapter", "subset", "sex", "seconds", "sample_rate", "path",
              "language", "group", "age"]].to_csv(DATA / "manifest.csv", index=False)
    missing = len(kept) - len(manifest)
    print(f"manifest: {len(manifest)} recordings; {missing} wanted recordings missing or failed", flush=True)
    data_card(table, kept, log, duplicates)


if __name__ == "__main__":
    main()
