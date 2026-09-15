from acoustic_model.subject_names import (
    assign_subject_ids,
    canonicalize,
    dedup_key,
    find_unflagged_near_duplicates,
)


def test_canonicalize_applies_known_corrections():
    assert canonicalize("Chuck norris") == "Chuck Norris"
    assert canonicalize("Ronan O_Rahilly") == "Ronan O'Rahilly"


def test_canonicalize_normalizes_whitespace_for_unknown_names():
    assert canonicalize("  Al   Pacino  ") == "Al Pacino"


def test_canonicalize_leaves_unrecognized_names_unchanged():
    assert canonicalize("Al Pacino") == "Al Pacino"


def test_dedup_key_is_case_insensitive():
    assert dedup_key("Robert De Niro") == dedup_key("robert de niro")


def test_assign_subject_ids_merges_case_variants():
    identities = assign_subject_ids(["Robert De Niro", "robert de niro", "Al Pacino"])
    assert len({identity.subject_id for identity in identities.values()}) == 2
    assert identities[dedup_key("Robert De Niro")].subject_id == identities[dedup_key("robert de niro")].subject_id


def test_assign_subject_ids_is_stable_across_calls():
    names = ["Al Pacino", "Robert De Niro", "Morgan Freeman"]
    first = assign_subject_ids(names)
    second = assign_subject_ids(list(reversed(names)))
    for key in first:
        assert first[key].subject_id == second[key].subject_id


def test_find_unflagged_near_duplicates_flags_close_distinct_names():
    names = ["Robert Vaughn", "Robert Vaugn", "Al Pacino"]
    flagged = find_unflagged_near_duplicates(names, cutoff=0.85)
    flagged_pairs = {frozenset((a, b)) for a, b, _ in flagged}
    assert frozenset(("Robert Vaughn", "Robert Vaugn")) in flagged_pairs


def test_find_unflagged_near_duplicates_ignores_exact_case_variants():
    names = ["Al Pacino", "al pacino"]
    flagged = find_unflagged_near_duplicates(names)
    assert flagged == []
