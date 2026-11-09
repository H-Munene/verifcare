"""SV1: extract LibriSpeech and write its data card. Development data only.

Speaker names in SPEAKERS.TXT are deliberately not read into any output.
"""

import tarfile

import pandas as pd
import soundfile as sf

from mzazi_acoustic.common import config

OUT = config.SV_DEV_RESULTS
ARCHIVES = config.LIBRISPEECH_DIR.parent


def extract():
    for subset in config.LIBRISPEECH_SUBSETS:
        if not (config.LIBRISPEECH_DIR / subset).exists():
            with tarfile.open(ARCHIVES / f"{subset}.tar.gz") as archive:
                archive.extractall(ARCHIVES, filter="data")


def speaker_sex():
    sex = {}
    for line in (config.LIBRISPEECH_DIR / "SPEAKERS.TXT").read_text(encoding="utf-8").splitlines():
        if line.startswith(";") or "|" not in line:
            continue
        fields = [field.strip() for field in line.split("|")]
        sex[fields[0]] = fields[1]
    return sex


def manifest():
    sex = speaker_sex()
    rows = []
    for subset in config.LIBRISPEECH_SUBSETS:
        for path in sorted((config.LIBRISPEECH_DIR / subset).rglob("*.flac")):
            info = sf.info(path)
            speaker, chapter = path.parts[-3], path.parts[-2]
            rows.append({"utterance": path.stem, "speaker": speaker, "chapter": chapter, "subset": subset,
                         "sex": sex[speaker], "seconds": info.frames / info.samplerate,
                         "sample_rate": info.samplerate, "path": str(path.relative_to(config.LIBRISPEECH_DIR))})
    return pd.DataFrame(rows)


def main():
    extract()
    config.SV_DATA_DIR.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    table = manifest()
    table.to_csv(config.SV_DATA_DIR / "librispeech_manifest.csv", index=False)
    per_speaker = table.groupby("speaker").agg(sex=("sex", "first"), chapters=("chapter", "nunique"),
                                               minutes=("seconds", lambda s: s.sum() / 60))
    summary = table.groupby("subset").agg(speakers=("speaker", "nunique"), chapters=("chapter", "nunique"),
                                          utterances=("utterance", "count"), hours=("seconds", lambda s: s.sum() / 3600))
    lines = ["# SV1 data card: LibriSpeech", "", "**Development data only. Judges no target.**", "",
             "English audiobook reading, clean conditions, CC BY 4.0. Chapter ID stands in for a recording.", "",
             summary.round(2).to_markdown(), "",
             f"Speakers: {per_speaker.shape[0]} ({(per_speaker['sex'] == 'F').sum()} female, {(per_speaker['sex'] == 'M').sum()} male).",
             f"Speakers with two or more chapters: {(per_speaker['chapters'] >= 2).sum()}.",
             f"Sample rates: {sorted(table['sample_rate'].unique().tolist())}.",
             f"Zero-length files: {(table['seconds'] <= 0).sum()}.", ""]
    (OUT / "01_data.md").write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
