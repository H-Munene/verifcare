"""Charts of the speaker verification results, with a CSV of each chart's numbers.

Run after sv_05_evaluate.py, in the main venv, which has matplotlib.
"""

import json

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from scipy.stats import norm
from sklearn.metrics import roc_curve

from mzazi_acoustic.common import config
from mzazi_acoustic.speaker_verification import decide, metrics, visits_io
from sv_05_evaluate import DEVELOPMENT, frozen_rule, visit_outcomes

OUT = config.SV_DATASET_RESULTS / "figures"
LENGTH = config.SV_TRIAL_REPORT_SECONDS
SURFACE, INK, SECONDARY, MUTED, GRID, AXIS = "#fcfcfb", "#0b0b0b", "#52514e", "#898781", "#e1e0d9", "#c3c2b7"
BLUE, ORANGE = "#2a78d6", "#eb6834"
NOTE = ("LibriSpeech (English audiobooks), development data only. Says nothing about Mzazi Care users." if DEVELOPMENT else
        "AfriVoices-KE test speakers (Dholuo, Kalenjin, Kikuyu, Maasai), scored once. Simulated visits, simulated noise.")
SCENARIO_LABELS = {decide.GENUINE: "Both present\n(wrongly rejected)", "caregiver_alone": "Caregiver alone\n(wrongly accepted)",
                   "different_dependant": "Different dependant\n(wrongly accepted)",
                   "different_caregiver": "Different caregiver\n(wrongly accepted)"}
CONDITION_LABELS = {"primary": "Primary setting", "clean": "Clean audio", "enrol_10s": "10 s enrolment",
                    "clip_5s": "5 s of speech per recording", "clip_20s": "20 s recordings"}

ABOUT = ("**Development data only.** LibriSpeech is English audiobook reading in clean conditions.\n"
         "These charts show how the pipeline behaves. They say nothing about Kenyan languages, phones in homes, older voices or real conversations, and judge no target.\n"
         if DEVELOPMENT else
         "**AfriVoices-KE test speakers, scored once** with the rule frozen at SV4 (`06_threshold_tradeoff` uses calibration speakers).\n"
         "Kenyan-language smartphone speech, mostly from people aged 18 to 40. `05_evaluation.md` holds the verdict against the targets.\n")

GUIDE = """# Speaker verification figures

""" + ABOUT + """Each PNG has a CSV of the same name holding its numbers.

| Figure | What it shows |
|---|---|
| `01_score_distributions` | How separate same-person and different-person similarity scores are, for ECAPA-TDNN and the MFCC baseline |
| `02_det_curve` | The trade-off between false accepts and false rejects. Lower left is better |
| `03_error_by_speech_length` | Equal error rate at 3, 5, 10 and 30 seconds of speech |
| `04_visit_errors_by_scenario` | How often simulated visits were decided wrongly, for each fraud scenario |
| `05_robustness_by_condition` | The same errors under noise, shorter enrolment, and shorter or longer recordings |
| `06_threshold_tradeoff` | How the two kinds of error move with the match threshold, on calibration speakers |
| `07_recording_scores` | Each recording's similarity to the voice it claims, in each kind of visit |

Each visit is two recordings, the caregiver's then the dependant's, cut from single-speaker audio, not recorded on a visit.
Replay is not tested here.
"""

plt.rcParams.update({
    "font.family": "sans-serif", "font.sans-serif": ["Segoe UI", "DejaVu Sans"], "font.size": 10,
    "figure.facecolor": SURFACE, "axes.facecolor": SURFACE, "savefig.facecolor": SURFACE,
    "axes.edgecolor": AXIS, "axes.linewidth": 0.8, "axes.labelcolor": SECONDARY, "axes.grid": True,
    "axes.axisbelow": True, "axes.spines.top": False, "axes.spines.right": False,
    "grid.color": GRID, "grid.linewidth": 0.8, "xtick.color": MUTED, "ytick.color": MUTED,
    "xtick.labelcolor": SECONDARY, "ytick.labelcolor": SECONDARY, "xtick.major.size": 0, "ytick.major.size": 0,
    "legend.frameon": False, "legend.labelcolor": SECONDARY,
})


def figure(title, width=8.0, height=4.6, panels=1, sharey=False, left=0.08, right=0.97, bottom=0.14):
    fig, axes = plt.subplots(1, panels, figsize=(width, height), sharey=sharey, squeeze=False)
    fig.subplots_adjust(top=0.80, left=left, right=right, bottom=bottom, wspace=0.28)
    fig.text(0.02, 0.945, title, fontsize=13.5, fontweight="semibold", color=INK)
    fig.text(0.02, 0.885, NOTE, fontsize=9.5, color=SECONDARY)
    return fig, axes[0]


def save(fig, name, table):
    fig.savefig(OUT / f"{name}.png", dpi=200)
    plt.close(fig)
    table.to_csv(OUT / f"{name}.csv", index=False)


def percent_axis(axis):
    axis.set_major_formatter(matplotlib.ticker.PercentFormatter(1.0, decimals=0))


def rate_axis(ax, upper):
    """A horizontal rate axis with room for the end labels, and no tick above 100 %."""
    limit = min(upper, 1.0)
    ax.set_xlim(0, limit * 1.28)
    ticks = matplotlib.ticker.MaxNLocator(nbins=5, steps=[1, 2, 2.5, 5, 10]).tick_values(0, limit)
    ax.set_xticks([tick for tick in ticks if 0 <= tick <= limit + 1e-9])
    percent_axis(ax.xaxis)


def score_distributions(scores):
    data = scores[scores["test_seconds"] == LENGTH]
    fig, axes = figure("How far apart same-person and different-person scores are", panels=2, sharey=True)
    rows = []
    for ax, model, name in zip(axes, ("e1", "b0"), ("ECAPA-TDNN (main model)", "MFCC baseline")):
        bins = np.linspace(data[model].min(), data[model].max(), 41)
        for label, colour, text in ((0, ORANGE, "Different people"), (1, BLUE, "Same person")):
            values = data.loc[data["label"] == label, model]
            share = np.histogram(values, bins=bins)[0] / len(values)
            ax.stairs(share, bins, fill=True, color=colour, alpha=0.10, linewidth=0)
            ax.stairs(share, bins, color=colour, linewidth=2, label=text)
            rows += [{"model": model, "trial": text, "bin_start": b, "share": s} for b, s in zip(bins, share)]
        threshold = metrics.equal_error_rate(data["label"], data[model])[1]
        ax.axvline(threshold, color=SECONDARY, linewidth=1)
        low, high = ax.get_xlim()
        on_right = (threshold - low) / (high - low) > 0.6
        ax.annotate("Equal error\nthreshold", (threshold, ax.get_ylim()[1]), xytext=(-5 if on_right else 5, -4), textcoords="offset points",
                    va="top", ha="right" if on_right else "left", fontsize=8.5, color=SECONDARY)
        ax.set_title(name, loc="left", fontsize=10.5, color=INK)
        ax.set_xlabel("Cosine similarity, 30 s clean audio")
        percent_axis(ax.yaxis)
    axes[0].set_ylabel("Share of trials")
    axes[0].legend(loc="upper left", bbox_to_anchor=(0, 0.92))
    save(fig, "01_score_distributions", pd.DataFrame(rows))


def det_curve(scores):
    data = scores[scores["test_seconds"] == LENGTH]
    ticks = np.array([0.002, 0.01, 0.05, 0.1, 0.2, 0.4])
    fig, axes = figure("Trade-off between false accepts and false rejects (DET curve)", width=6.6, height=5.6, left=0.12, bottom=0.11)
    ax = axes[0]
    rows = []
    for model, colour, name in (("e1", BLUE, "ECAPA-TDNN (main model)"), ("b0", ORANGE, "MFCC baseline")):
        false_accept, hit, _ = roc_curve(data["label"], data[model])
        miss = 1 - hit
        ax.plot(norm.ppf(np.clip(false_accept, 1e-3, 0.5)), norm.ppf(np.clip(miss, 1e-3, 0.5)), color=colour, linewidth=2, label=name)
        rows += [{"model": model, "false_accept": a, "false_reject": m} for a, m in zip(false_accept, miss)]
    limit = norm.ppf([0.001, 0.5])
    ax.plot(limit, limit, color=AXIS, linewidth=1)
    ax.text(norm.ppf(0.28), norm.ppf(0.34), "Equal errors", fontsize=8.5, color=MUTED, rotation=45, ha="center", va="center")
    ax.set_xlim(limit), ax.set_ylim(limit)
    labels = [f"{t * 100:g}%" for t in ticks]
    ax.set_xticks(norm.ppf(ticks), labels), ax.set_yticks(norm.ppf(ticks), labels)
    ax.set_xlabel("False accept rate"), ax.set_ylabel("False reject rate")
    ax.legend(loc="lower left")
    save(fig, "02_det_curve", pd.DataFrame(rows))


def eer_by_length(scores):
    fig, axes = figure("Error rate at different amounts of speech")
    ax = axes[0]
    rows = []
    lengths = sorted(scores["test_seconds"].unique())
    positions = np.arange(len(lengths))
    for model, colour, name, offset in (("e1", BLUE, "ECAPA-TDNN (main model)", -0.04), ("b0", ORANGE, "MFCC baseline", 0.04)):
        values, lows, highs = [], [], []
        for length in lengths:
            group = scores[scores["test_seconds"] == length]
            eer = metrics.equal_error_rate(group["label"], group[model])[0]
            low, high = metrics.eer_ci(group["label"], group[model], group["enrol"])
            values.append(eer), lows.append(low), highs.append(high)
            rows.append({"model": model, "test_seconds": length, "eer": eer, "ci_low": low, "ci_high": high})
        x = positions + offset
        ax.fill_between(x, lows, highs, color=colour, alpha=0.10, linewidth=0)
        ax.plot(x, values, color=colour, linewidth=2, marker="o", markersize=7, markeredgecolor=SURFACE, markeredgewidth=2, label=name)
        ax.annotate(f"{values[-1] * 100:.1f}%", (x[-1], values[-1]), xytext=(9, 0), textcoords="offset points", va="center", color=INK)
    ax.set_xticks(positions, [f"{length:g} s" for length in lengths])
    ax.set_xlim(-0.2, len(lengths) - 0.6)
    ax.set_ylim(bottom=0)
    ax.set_xlabel("Seconds of speech tested, 30 s enrolment, clean audio")
    ax.set_ylabel("Equal error rate")
    percent_axis(ax.yaxis)
    ax.grid(axis="x", visible=False)
    ax.legend(loc="upper right")
    save(fig, "03_error_by_speech_length", pd.DataFrame(rows))


def visit_errors(outcomes):
    fig, axes = figure("Simulated visits: how often each case was decided wrongly", left=0.24, right=0.93)
    ax = axes[0]
    rows = []
    for scenario in decide.SCENARIOS:
        group = outcomes[outcomes["scenario"] == scenario]
        error = ~group["passed"] if scenario == decide.GENUINE else group["passed"]
        low, high = metrics.rate_ci(error, group["pair"])
        rows.append({"scenario": scenario, "errors": int(error.sum()), "visits": len(group), "rate": float(error.mean()),
                     "ci_low": low, "ci_high": high})
    table = pd.DataFrame(rows)
    y = np.arange(len(table))[::-1]
    ax.barh(y, table["rate"], height=0.42, color=BLUE)
    ax.hlines(y, table["ci_low"], table["ci_high"], color=INK, linewidth=1.2)
    upper = max(table["ci_high"].max(), 0.05) * 1.3
    for position, row in zip(y, table.itertuples()):
        ax.text(row.ci_high + upper * 0.015, position, f"{row.rate * 100:.1f}% ({row.errors} of {row.visits})", va="center", color=INK)
    ax.set_yticks(y, [SCENARIO_LABELS[s] for s in table["scenario"]])
    rate_axis(ax, upper)
    ax.grid(axis="y", visible=False)
    ax.set_xlabel("Error rate, with 95% interval resampling visit pairs")
    save(fig, "04_visit_errors_by_scenario", table)


def robustness(all_outcomes):
    fig, axes = figure("How the visit decision holds up under harder conditions", width=9.0, height=4.8, panels=2, sharey=True, left=0.21, right=0.96)
    rows = []
    for name, outcomes in all_outcomes.items():
        genuine = outcomes[outcomes["scenario"] == decide.GENUINE]
        fraud = outcomes[outcomes["scenario"] != decide.GENUINE]
        worst_name = fraud.groupby("scenario")["passed"].mean().idxmax()
        worst = fraud[fraud["scenario"] == worst_name]
        for measure, events, pairs in (("false_reject", ~genuine["passed"], genuine["pair"]), ("worst_false_accept", worst["passed"], worst["pair"])):
            low, high = metrics.rate_ci(events, pairs)
            rows.append({"condition": name, "measure": measure, "rate": float(events.mean()), "ci_low": low, "ci_high": high,
                         "scenario": decide.GENUINE if measure == "false_reject" else worst_name})
    table = pd.DataFrame(rows)
    conditions = list(all_outcomes)
    y = np.arange(len(conditions))[::-1]
    upper = max(table["ci_high"].max(), 0.05) * 1.3
    for ax, measure, title in zip(axes, ("false_reject", "worst_false_accept"), ("Genuine visits wrongly rejected", "Highest false accept of the fraud cases")):
        part = table[table["measure"] == measure].set_index("condition").loc[conditions]
        ax.barh(y, part["rate"], height=0.42, color=BLUE)
        ax.hlines(y, part["ci_low"], part["ci_high"], color=INK, linewidth=1.2)
        for position, row in zip(y, part.itertuples()):
            ax.text(row.ci_high + upper * 0.02, position, f"{row.rate * 100:.1f}%", va="center", color=INK)
        ax.set_title(title, loc="left", fontsize=10.5, color=INK)
        rate_axis(ax, upper)
        ax.grid(axis="y", visible=False)
        ax.set_xlabel("Rate, with 95% interval")
    axes[0].set_yticks(y, [CONDITION_LABELS[c] for c in conditions])
    save(fig, "05_robustness_by_condition", table)


def threshold_tradeoff(calibration, rule):
    rows = []
    for threshold in config.SV_THRESHOLD_GRID:
        rates = decide.error_rates(calibration, threshold)
        rows.append({"threshold": threshold, "false_reject": rates["false_reject"], "worst_false_accept": max(rates["false_accept"].values())})
    table = pd.DataFrame(rows)
    fig, axes = figure("Choosing the match threshold on calibration speakers")
    ax = axes[0]
    for column, colour, name in (("false_reject", BLUE, "Genuine visits wrongly rejected"), ("worst_false_accept", ORANGE, "Highest false accept of the fraud cases")):
        ax.plot(table["threshold"], table[column], color=colour, linewidth=2, label=name)
    ax.axvline(rule["threshold"], color=SECONDARY, linewidth=1)
    on_right = rule["threshold"] > np.mean(config.SV_THRESHOLD_GRID)
    ax.annotate(f"Chosen: {rule['threshold']:g}", (rule["threshold"], 0.5), xycoords=("data", "axes fraction"), xytext=(-6 if on_right else 6, 0),
                textcoords="offset points", ha="right" if on_right else "left", va="center", color=INK)
    ax.set_ylim(0, 1.02)
    ax.set_xlabel("Cosine threshold that both recordings must reach")
    ax.set_ylabel("Share of visits")
    percent_axis(ax.yaxis)
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, 1.13), ncols=2)
    save(fig, "06_threshold_tradeoff", table)


def recording_scores(outcomes, rule):
    """Each recording's score against the voice it claims, by scenario. A fraud shows up as one low score."""
    fig, axes = figure("How well each recording matched the voice it claims", panels=2, sharey=True, left=0.24)
    rows = []
    y = np.arange(len(decide.SCENARIOS))[::-1]
    for ax, role, title in zip(axes, ("caregiver", "dependant"), ("Caregiver's recording", "Dependant's recording")):
        for position, scenario in zip(y, decide.SCENARIOS):
            values = outcomes.loc[outcomes["scenario"] == scenario, f"{role}_score"].dropna().to_numpy()
            jitter = np.random.default_rng(config.SEED).uniform(-0.12, 0.12, len(values))
            ax.scatter(values, position + jitter, s=14, color=BLUE, alpha=0.55, linewidths=0)
            rows += [{"scenario": scenario, "recording": role, "score": value} for value in values]
        ax.axvline(rule["threshold"], color=SECONDARY, linewidth=1)
        ax.set_title(title, loc="left", fontsize=10.5, color=INK)
        ax.set_xlabel(f"Cosine similarity (line: threshold {rule['threshold']:g})")
        ax.grid(axis="y", visible=False)
    axes[0].set_yticks(y, [SCENARIO_LABELS[s].split("\n")[0] for s in decide.SCENARIOS])
    save(fig, "07_recording_scores", pd.DataFrame(rows))


def require_gate():
    """Real test speakers are looked at only after sv_05 has claimed the test set, so nothing gets round it."""
    if not DEVELOPMENT and not config.SV_TEST_MARKER.exists():
        raise SystemExit("Run sv_05_evaluate.py first: it scores the test speakers once and claims the test set")


def main():
    require_gate()
    OUT.mkdir(parents=True, exist_ok=True)
    rule = frozen_rule()
    plan = pd.read_csv(config.SV_DATASET_DIR / "visits.csv")
    scores = pd.read_csv(config.SV_DATASET_DIR / "trial_scores.csv")
    scores = scores[scores["split"] == "holdout"]
    conditions = [config.SV_PRIMARY_CONDITION, *config.SV_VARIANT_CONDITIONS]
    outcomes = {c[0]: visit_outcomes(visits_io.load("holdout", c[0], plan), rule) for c in conditions}

    score_distributions(scores)
    det_curve(scores)
    eer_by_length(scores)
    visit_errors(outcomes["primary"])
    robustness(outcomes)
    threshold_tradeoff(visits_io.load("calibration", "primary", plan), rule)
    recording_scores(outcomes["primary"], rule)
    (OUT / "README.md").write_text(GUIDE, encoding="utf-8")
    print("wrote", OUT)


if __name__ == "__main__":
    main()
