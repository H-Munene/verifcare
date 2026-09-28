import numpy as np
import pandas as pd

from mzazi_acoustic.data_collection import age_metadata as am

NAN = np.nan


def test_bucket_of_reads_the_number_before_an_optional_part_index():
    assert am.bucket_of("aileenhernandez_5_2.wav") == "5"
    assert am.bucket_of("DavidSoul_3.wav") == "3"
    assert am.bucket_of("CharmianCarr_15.wav") == "15"
    assert am.bucket_of("nonumber.wav") is None


def test_dementia_age_ranges_per_bucket():
    # born 1930, onset 2010, died 2016
    assert am.dementia_age_range("0", 1930, 2010, 2016, 2021) == (80, 86)
    assert am.dementia_age_range("5", 1930, 2010, 2016, 2021) == (75, 80)
    assert am.dementia_age_range("15", 1930, 2010, 2016, 2021) == (65, 70)
    assert am.dementia_age_range("0", 1930, 2010, None, 2021) == (80, 91)  # still alive
    assert np.isnan(am.dementia_age_range("5", 1930, None, 2016, 2021)[0])  # no onset year


def test_control_bands_hold_with_or_without_a_birth_year():
    assert am.age_band(*am.control_age_range("3", None, None, 2021)) == ">70"
    assert am.age_band(*am.control_age_range("3", 1930, 2019, 2021)) == ">70"
    assert am.age_band(*am.control_age_range("1", None, None, 2021)) == "<55"
    assert am.age_band(*am.control_age_range("2", None, None, 2021)) == "55-70"


def test_ranges_crossing_a_boundary_straddle():
    assert am.age_band(52, 57) == "straddles"
    assert am.age_band(NAN, NAN) == "unknown"


def test_suffix_order_evidence_prefers_the_ordering_that_fits():
    sheet = pd.DataFrame({"name": ["Ann A", "Bob B"],
                          "age less than 55": ["url", "url"],
                          "age above 55 less than 70": ["url", None],
                          "age above 70": [None, "url"]})
    files = pd.DataFrame({"label": [0, 0, 0, 0],
                          "person_folder": ["Ann A", "Ann A", "Bob B", "Bob B"],
                          "filename": ["AnnA_1.wav", "AnnA_2.wav", "BobB_1.wav", "BobB_3.wav"]})
    best = am.control_suffix_order_evidence(files, sheet).iloc[0]
    assert (best.suffix_1, best.suffix_2, best.suffix_3) == ("<55", "55-70", ">70")
    assert best.exact_match == 2
