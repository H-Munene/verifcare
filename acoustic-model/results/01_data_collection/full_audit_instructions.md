# Full listening audit: instructions (decision D1)

Purpose: measure, for every clip the model will use, whether anyone besides the target speaker is audible.
The first 20-clip audit found another voice in 3 of 6 dementia pool clips but 0 of 7 control pool clips: too few to conclude, but pointing towards a confound.
The decision rule was written down before this audit, so your answers decide D1 mechanically (PLAN.md, decisions table).

## What you are listening to

- `data/listening_audit_full/session1/`: every training-pool and trajectory clip, once, shuffled, as `aud_001.wav` onwards.
- `data/listening_audit_full/session2/`: a random 10 % of the same clips again, under new names (`rep_01.wav` onwards). **Do session 2 in a later sitting, ideally on another day**, without looking back at session 1: it measures how consistent your own judgements are.
- These are exactly what the model hears: 16 kHz, edge silence trimmed, at most 90 s. Judge only what is in these files.
- The key (`full_audit_key.local.csv`) must stay closed until both sessions are done.

## Fill in `full_audit_session1.csv` (and later `full_audit_session2.csv`)

The same columns as the first audit (`listening_audit_instructions.md`), plus one:

| Column | Values | What counts |
|---|---|---|
| `other_voices` | yes / no | Anyone other than the target speaker, including someone else's laughter or backchannel ("mm-hm"). |
| `overlapping_speech` | yes / no | Two people audible at once. If yes, `other_voices` must be yes too. |
| `music`, `laughter`, `applause` | yes / no | As before; laughter from anyone. |
| `background_noise` | none / mild / strong | As before. |
| `target_speech_share` | <25% / 25-50% / 50-75% / >75% | As before. |
| `recognised_speaker` | yes / no | **New.** Yes if you recognise who the speaker is. Recognising a public figure can reveal their diagnosis, so this records where blinding may have failed. Keep rating as normal either way. |
| `notes` | free text | Anything else. |

When session 1 is complete, tell the agent: it runs `scripts/01f_full_audit_decision.py`, which applies the pre-registered D1 rule. Session 2 can follow later; its agreement figures are added when it is complete.
