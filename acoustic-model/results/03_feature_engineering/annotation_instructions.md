# Pause annotation: instructions

Purpose: give the pause detector a human reference, so its settings can be checked, and adjusted if needed, against real pauses before any class result exists (PLAN.md 3.2).
The agreement is scored per band (short 80-180 ms, long over 180 ms) and again on noise-degraded copies of the same clips.

## Setup

- The 10 clips are in `data/annotation/` as `ann_01.wav` to `ann_10.wav`: 60 s each, cut 10 s after the start of each trimmed recording, from the training portion only, 5 per class, in shuffled order. Some were chosen because they have noisy backgrounds.
- The key linking clip IDs to recordings and classes is `annotation_key.local.csv`. **Don't open it until every clip is annotated**, so the annotation stays blind to class.
- Use Audacity with headphones. Zoom in on the waveform (and switch to the spectrogram view where the waveform is unclear) to place boundaries.

## Marking pauses

1. Open `ann_XX.wav` and add a label track (Tracks > Add New > Label Track).
2. For every **silent pause of about 80 ms or longer** inside the clip, select the silent stretch and add a label (Ctrl+B). The text can be anything, e.g. `p`.
   - A pause is a stretch with no speech from anyone, including breaths you judge to be part of a pause. Place the start where the speech energy ends and the end where it begins again.
   - Don't mark the closure of a stop consonant inside a word (the brief silence in "a**pp**le"); those aren't pauses.
   - Mark a pause even if the next speech is someone else's.
   - Skip anything you're unsure is 80 ms or longer. The scoring drops marks shorter than 80 ms anyway.
3. Export with File > Export > Export Labels as `ann_XX.txt` into `data/annotation/`, one file per clip, keeping the same number.

When all 10 label files are there, tell the agent. It runs `scripts/03c_validate_detector.py`, reports precision and recall overall, per band and under added noise, and proposes any setting changes, which are made only against these marks.
