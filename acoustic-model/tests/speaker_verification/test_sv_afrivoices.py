"""AfriVoices-KE: recording days and the recordings kept, which decide what counts as a separate session."""

import pandas as pd
import pytest

from mzazi_acoustic.speaker_verification import afrivoices, trials


def test_the_day_is_the_local_day_of_the_millisecond_timestamp():
    # 2025-03-18 22:30 UTC is already 2025-03-19 in Nairobi (UTC+3).
    names = ["abc_18Mar2025223000GMT_1742337000000.wav", "x9y_5Mar2025080000GMT_1741161600000.wav"]
    assert list(afrivoices.recording_day(names)) == ["2025-03-19", "2025-03-05"]


def test_a_name_without_a_timestamp_is_refused():
    with pytest.raises(ValueError):
        afrivoices.recording_day(["no_timestamp.wav"])


def recordings():
    rows = [("a", "d1", f"a1_{i}", 40) for i in range(4)] + [("a", "d2", f"a2_{i}", 50) for i in range(3)]
    rows += [("a", "d3", "a3_0", 30)] + [("b", "d1", "b1_0", 100)]
    return pd.DataFrame(rows, columns=["speaker", "chapter", "utterance", "listed_seconds"])


def test_only_the_two_fullest_days_are_kept_up_to_the_limit():
    kept = afrivoices.keep_recordings(recordings(), keep_seconds=90)
    a = kept[kept["speaker"] == "a"]
    assert set(a["chapter"]) == {"d1", "d2"}
    # The day's total before each kept recording is under 90 s, so 40 + 40 + 40 and 50 + 50.
    assert list(a.loc[a["chapter"] == "d1", "utterance"]) == ["a1_0", "a1_1", "a1_2"]
    assert list(a.loc[a["chapter"] == "d2", "utterance"]) == ["a2_0", "a2_1"]


def test_a_speaker_with_one_day_keeps_that_day():
    kept = afrivoices.keep_recordings(recordings(), keep_seconds=90)
    assert list(kept.loc[kept["speaker"] == "b", "utterance"]) == ["b1_0"]


def test_the_split_puts_each_language_on_both_sides():
    n = 48
    speakers = pd.DataFrame({"speaker": [f"s{i}" for i in range(n)], "sex": ["F" if i % 2 else "M" for i in range(n)],
                             "language": ["Dholuo" if i < n // 2 else "Maasai" for i in range(n)], "eligible": True,
                             "enrol_recording": [f"s{i}_a" for i in range(n)], "test_recording": [f"s{i}_b" for i in range(n)]})
    split = trials.speaker_split(speakers)
    assert (split.groupby("language")["split"].nunique() == 2).all()
