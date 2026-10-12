"""Blinded sample for the human listening audit (PLAN.md Stage 1 step 10, decision D1).

The listener must not know each recording's class, so the copies get neutral names (audit_01.wav,
...) in shuffled order. The key linking audit IDs to files and labels goes to a *.local.csv file
that is git-ignored and that the listener should not open until the audit is done.
"""

import shutil

import numpy as np
import pandas as pd
from scipy.stats import fisher_exact
from sklearn.metrics import cohen_kappa_score

AUDIT_COLUMNS = [
    "audit_id",
    "other_voices",  # yes/no: anyone besides the target speaker (interviewer, audience)
    "overlapping_speech",  # yes/no: two people talking at once
    "music",  # yes/no
    "laughter",  # yes/no
    "applause",  # yes/no
    "background_noise",  # none / mild / strong
    "target_speech_share",  # rough share of speaking time that is the target person: <25%, 25-50%, 50-75%, >75%
    "notes",
]


def draw_sample(files, per_class, seed):
    """per_class recordings from each label, at most one per subject, in shuffled order.

    One recording per subject spreads the sample over as many people as possible.
    Input needs columns file_id, subject_id, label. Returns audit_id, file_id, subject_id, label.
    """
    rng = np.random.default_rng(seed)
    picked = []
    for label in sorted(files["label"].unique()):
        in_class = files[files["label"] == label]
        subjects = rng.choice(in_class["subject_id"].unique(), size=per_class, replace=False)
        for subject in subjects:
            options = in_class[in_class["subject_id"] == subject]
            picked.append(options.iloc[rng.integers(len(options))])
    sample = pd.DataFrame(picked)[["file_id", "subject_id", "label"]]
    sample = sample.iloc[rng.permutation(len(sample))].reset_index(drop=True)
    sample.insert(0, "audit_id", [f"audit_{i + 1:02d}" for i in range(len(sample))])
    return sample


def export(sample, source_paths, dest_dir):
    """Copy each sampled file to dest_dir/<audit_id>.<ext>. source_paths maps file_id -> Path."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    for row in sample.itertuples():
        source = source_paths[row.file_id]
        shutil.copy2(source, dest_dir / f"{row.audit_id}{source.suffix}")


def blank_template(sample):
    """The sheet the listener fills in: audit IDs only, no labels."""
    template = pd.DataFrame(columns=AUDIT_COLUMNS)
    template["audit_id"] = sample["audit_id"]
    return template


# full audit (decision D1)

# The full audit adds one column: whether the listener recognised who is speaking. Recognising a
# public figure can reveal their diagnosis, so it records where blinding may have failed.
FULL_AUDIT_COLUMNS = AUDIT_COLUMNS[:-1] + ["recognised_speaker", "notes"]
YES_NO_COLUMNS = ["other_voices", "overlapping_speech", "music", "laughter", "applause", "recognised_speaker"]


def draw_full_audit(clips, repeat_share, seed):
    """Session 1: every clip once, shuffled, ids aud_001... Session 2: a random repeat_share of the
    same clips, reshuffled, ids rep_01..., for the listener to re-rate in a later session.

    The ids carry no information about class or about which session-1 clip a repeat matches.
    Returns (session1, session2), each with audit_id, file_id, subject_id, label, role.
    """
    rng = np.random.default_rng(seed)
    columns = ["file_id", "subject_id", "label", "role"]
    session1 = clips[columns].iloc[rng.permutation(len(clips))].reset_index(drop=True)
    session1.insert(0, "audit_id", [f"aud_{i + 1:03d}" for i in range(len(session1))])
    n_repeat = max(1, round(repeat_share * len(clips)))
    session2 = clips[columns].iloc[rng.choice(len(clips), size=n_repeat, replace=False)].reset_index(drop=True)
    session2.insert(0, "audit_id", [f"rep_{i + 1:02d}" for i in range(len(session2))])
    return session1, session2


def people_with_other_voices(audited):
    """One row per pool person: whether ANY of their audited clips has another voice, and whether
    they keep at least one single-speaker clip (so they would survive option c)."""
    pool = audited[audited["role"] == "training_pool"]
    return pool.groupby("subject_id").agg(
        label=("label", "first"),
        any_other_voice=("other_voices", lambda v: (v == "yes").any()),
        has_single_speaker_clip=("other_voices", lambda v: (v == "no").any()),
    ).reset_index()


def d1_decision(people, alpha, gap, min_dementia_people):
    """The pre-registered D1 rule. Returns a dict with the rates, the test, and the decision.

    Choose (c) if the per-class share of people with another voice differs clearly (Fisher p < alpha
    or a gap above `gap`); (c) is only viable if it leaves at least min_dementia_people dementia
    people. Otherwise (a), with the single-speaker sensitivity analysis.
    """
    table = [[int(people.loc[people.label == lab, "any_other_voice"].sum()),
              int((~people.loc[people.label == lab, "any_other_voice"]).sum())] for lab in (1, 0)]
    _, p = fisher_exact(table)
    rate_dementia = table[0][0] / sum(table[0])
    rate_control = table[1][0] / sum(table[1])
    differs = p < alpha or abs(rate_dementia - rate_control) > gap
    dementia_left = int(people.loc[people.label == 1, "has_single_speaker_clip"].sum())
    viable = dementia_left >= min_dementia_people
    if differs and viable:
        decision = "c"
    else:
        decision = "a"
    return {"rate_dementia": rate_dementia, "rate_control": rate_control, "gap": rate_dementia - rate_control,
            "fisher_p": p, "differs_clearly": differs, "dementia_people_left_under_c": dementia_left,
            "c_viable": viable, "decision": decision,
            "reason": ("per-class rates differ clearly and (c) is viable" if decision == "c"
                       else "rates differ clearly but (c) would leave too few dementia people" if differs
                       else "per-class rates don't differ clearly")}


def agreement(first, second, columns=YES_NO_COLUMNS):
    """Listener agreement between two passes over the same clips (joined on file_id beforehand):
    per yes/no column, percent agreement and Cohen's kappa."""
    rows = []
    for column in columns:
        a, b = first[column].astype(str), second[column].astype(str)
        same = (a == b).mean()
        # Kappa is undefined when both passes use a single category throughout; report agreement only.
        kappa = cohen_kappa_score(a, b) if len(set(a) | set(b)) > 1 else np.nan
        rows.append({"column": column, "n_clips": len(a), "percent_agreement": round(100 * same, 1),
                     "cohens_kappa": round(kappa, 3) if pd.notna(kappa) else np.nan})
    return pd.DataFrame(rows)
