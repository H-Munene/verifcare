"""Decision D1: prepare the full blinded listening audit of every pool and trajectory clip.

The listener hears exactly what the model will: the processed audio (16 kHz mono, edge-trimmed,
at most 90 s), exported as 16-bit PCM so any player opens it. Session 1 holds every clip once;
session 2 holds a random 10 % again under new ids, to be re-rated in a later session so the
listener's own agreement can be measured. The key is local and must stay closed until both
sessions are done. Re-running never overwrites the sheets or the key, so answers and blinding survive.
"""

import sys

import pandas as pd
import soundfile as sf

from mzazi_acoustic.common import config
from mzazi_acoustic.data_collection import listening_audit

OUT = config.COLLECTION_RESULTS
KEY = OUT / "full_audit_key.local.csv"


def main():
    if KEY.exists():
        sys.exit(f"{KEY.name} already exists: the audit is prepared. Delete it deliberately to redraw.")
    report = pd.read_csv(config.PROCESSING_RESULTS / "processing_report.csv")
    clips = report[report["role"].isin(["training_pool", "trajectory"])]
    session1, session2 = listening_audit.draw_full_audit(clips, config.FULL_AUDIT_REPEAT_SHARE, config.SEED + 1)

    for name, session in [("session1", session1), ("session2", session2)]:
        folder = config.FULL_AUDIT_DIR / name
        folder.mkdir(parents=True, exist_ok=True)
        for row in session.itertuples():
            y, sr = sf.read(config.PROCESSED_DIR / f"{row.file_id}.wav", dtype="float32")
            sf.write(folder / f"{row.audit_id}.wav", y, sr, subtype="PCM_16")
        sheet = pd.DataFrame(columns=listening_audit.FULL_AUDIT_COLUMNS)
        sheet["audit_id"] = session["audit_id"]
        sheet.to_csv(OUT / f"full_audit_{name}.csv", index=False)

    key = pd.concat([session1.assign(session=1), session2.assign(session=2)], ignore_index=True)
    key.to_csv(KEY, index=False)
    print(f"Session 1: {len(session1)} clips, session 2: {len(session2)} repeats -> {config.FULL_AUDIT_DIR}")


if __name__ == "__main__":
    main()
