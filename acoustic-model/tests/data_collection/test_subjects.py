import hashlib

from mzazi_acoustic.data_collection import subjects


def test_name_variants_normalise_to_the_same_person():
    variants = ["Jesse Jackson", "jessejackson", "JESSE  JACKSON", "Jessé-Jackson", " Jesse.Jackson "]
    assert {subjects.normalise_name(v) for v in variants} == {"jessejackson"}


def test_subject_id_is_stable_and_depends_on_the_salt():
    first = subjects.make_subject_id("bbking", "salt-one")
    assert first == subjects.make_subject_id("bbking", "salt-one")
    assert first != subjects.make_subject_id("bbking", "salt-two")
    # Not a plain hash of the name, which anyone could recompute from a list of public names.
    assert first[1:] != hashlib.sha256(b"bbking").hexdigest()[:8]


def test_salt_file_is_created_once_and_reused(tmp_path):
    salt_file = tmp_path / "salt.txt"
    assert subjects.load_or_create_salt(salt_file) == subjects.load_or_create_salt(salt_file)


def test_near_duplicates_are_flagged_but_unrelated_names_are_not():
    pairs = subjects.near_duplicate_pairs(["jimmycalderwood", "jimycalderwood", "iannholm", "estellegetty"])
    flagged = {(a, b) for a, b, _ in pairs}
    assert flagged == {("jimmycalderwood", "jimycalderwood")}


def test_name_in_filename():
    assert subjects.name_in_filename("AbeBurrows_5.wav") == "abeburrows"
    assert subjects.name_in_filename("aileenhernandez_5_1.wav") == "aileenhernandez"
    assert subjects.name_in_filename("alanramsey10.wav") == "alanramsey"
