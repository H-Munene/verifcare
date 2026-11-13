"""AfriVoices-KE: a recording's day, and which recordings to keep. The download is in scripts/sv_01_collect_afrivoices.py."""

import pandas as pd

from mzazi_acoustic.common import config

SEX = {"MALE": "M", "FEMALE": "F"}  # anything else, such as "Unknown" or "OTHER", becomes "U"


def recording_day(names, timezone=config.AFRIVOICES_TIMEZONE):
    """The local day of each recording, from the millisecond timestamp that ends its file name.

    The day is what counts as one recording session, so enrolment and test can come from different days.
    """
    millis = pd.to_numeric(pd.Series(names).str.extract(r"_(\d{13})\.\w+$")[0])
    if millis.isna().any():
        raise ValueError(f"{int(millis.isna().sum())} file names have no millisecond timestamp")
    return pd.to_datetime(millis, unit="ms", utc=True).dt.tz_convert(timezone).dt.strftime("%Y-%m-%d").to_numpy()


def keep_recordings(table, keep_seconds=config.AFRIVOICES_KEEP_SECONDS):
    """Per speaker, the two days with the most audio, and from each the first recordings up to keep_seconds.

    "First" is by file name, the order scripts/sv_02_process.py reads them in. A recording is kept if the
    day's total before it is still short of keep_seconds, so a day can end a little over.
    """
    kept = []
    for _, own in table.groupby("speaker"):
        days = own.groupby("chapter")["listed_seconds"].sum().sort_values(ascending=False, kind="stable").index[:2]
        for day in days:
            rows = own[own["chapter"] == day].sort_values("utterance")
            before = rows["listed_seconds"].cumsum() - rows["listed_seconds"]
            kept.append(rows[before < keep_seconds])
    return pd.concat(kept).reset_index(drop=True)
