# Mzazi Care acoustic cognitive-risk model

Takes one speech recording and returns a calibrated probability in [0, 1] that it shows acoustic signs associated with cognitive decline.
It is a non-diagnostic screening signal, meant to be trended over repeated caregiver visits.

The model uses only **language-independent** features: pausing and timing (primary), plus voice stability (secondary).
These can be measured without knowing the language and have published cross-language evidence, which matters because visits may be in English, Swahili, Kikuyu or Dholuo.
The full method, every pre-registered decision and its reason are in `PLAN.md`.
The chronological record of decisions and progress is `docs/ml-dev-log.md` (local, like the rest of `docs/`).

## Dataset: provenance, licence, labels

- **Source:** DementiaNet, https://github.com/tuul-ai/dementianet (checked 2026-09-28). Audio of public figures, scraped from YouTube interviews and appearances. The repository calls itself a preliminary release and has no version number, date or linked paper.
- **Licence:** MIT, on the repository. The licence covers the repository's contents. It does not obviously grant rights to the underlying YouTube audio, whose copyright stays with its owners. Treat the audio as research-use only, and don't redistribute it.
- **How labels were made:** public reporting, not clinical records. Dementia = public figures with a publicly confirmed dementia diagnosis. No dementia = public figures still alive above 85, or who died after 90, without any signs or diagnosis of dementia.
- **Local layout:** `data/raw/extracted_audio_dataset/{dementia,nodementia,nodementia2}/<person>/<clip>.wav`, as downloaded, never modified. The upstream README doesn't explain why there are two no-dementia folders. 16 people appear in both, and they are treated as one subject each.

Stage 1 measurements (all from `results/01_data_collection/`): 455 WAV files, 215 subjects (84 dementia, 131 no dementia), all readable, no exact duplicates.
Dementia is 39.1 % of subjects but only 28.8 % of recordings, because no-dementia subjects have more clips each.

## Known limitations

1. **Label timing:** labels describe the person, not the recording. A clip may pre-date the onset of dementia.
2. **Age at recording differs by class (decision D6 pending):** controls were selected for reaching 85-90+ without dementia, and their clips were deliberately sampled under 55, at 55-70 and over 70. Dementia clips are mostly over 55. There are no recording dates, only buckets (see `results/01_data_collection/age_summary.md`), so age can't be matched exactly. Both age and sex affect voice and timing.
3. **Speech context:** YouTube interviews, not caregiver-visit conversations. Other voices (interviewers, audiences) are likely; the listening audit measures how often (decision D1).
4. **Recording conditions differ by class:** noise flatness in the quietest frames differs between classes (see `results/01_data_collection/summary.md`). Clips were also cut to whole seconds with a 90 s cap that only dementia clips exceed; Stage 2 truncates every clip to 90 s after trimming, so maximum length no longer differs by class.
5. **Language:** "language-independent" means measurable without knowing the language. Accuracy in Kenyan languages is not validated.

## Deployment requirement

The service needs **at least 30 s of speech after trimming** leading and trailing silence (PLAN.md Stage 2).
Shorter recordings are rejected, because pause statistics aren't reliable on them.

## How to run

Python 3.14.6 (Windows), from this folder:

```
python -m venv venv
venv\Scripts\python -m pip install -r requirements-dev.txt
venv\Scripts\python -m pip install -e .
venv\Scripts\python -m pytest
```

Then one script per stage, in order (each checks `data/raw/` against the Stage 0 freeze before doing anything):

```
venv\Scripts\python scripts\00_freeze_raw_data.py   # once, after placing the dataset in data/raw/
venv\Scripts\python scripts\01_collect.py
venv\Scripts\python scripts\01b_age_at_recording.py  # downloads the DementiaNet metadata sheet to data/ if missing
```

Committed results never contain real names.
Name lookups are written to `*.local.csv` files, which are git-ignored; `tests/data_collection/test_no_names_committed.py` checks this on any machine that has the dataset.
