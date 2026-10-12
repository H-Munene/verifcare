# Listening audit: instructions

Purpose: find out how often the recordings contain anything other than the target person speaking.
Pause features measured on a recording with another speaker partly measure the conversation, not the person, so this result drives decision D1 (PLAN.md decisions table).

## Setup

- The 20 recordings are in `data/listening_audit/` as `audit_01.wav` to `audit_20.wav`: 10 per class, one per person, in shuffled order.
- The key linking audit IDs to recordings and labels is `listening_audit_key.local.csv`. **Don't open it until every row below is filled in**, so your judgements stay blind to class.
- Listen with headphones, to the whole recording.

## Fill in `listening_audit.csv`, one row per audit ID

| Column | Values | What counts |
|---|---|---|
| `other_voices` | yes / no | Anyone other than the target speaker: interviewer questions, audience, a narrator, a second guest. The target speaker is whoever talks most. |
| `overlapping_speech` | yes / no | Two people audible at the same time, including short backchannels ("mm-hm") over the target speaker. |
| `music` | yes / no | Any music: intro, outro or background. |
| `laughter` | yes / no | Laughter from anyone. |
| `applause` | yes / no | Applause or cheering. |
| `background_noise` | none / mild / strong | Steady noise (hum, room, crowd, wind). Mild = noticeable but speech is easy to follow; strong = it masks parts of the speech. |
| `target_speech_share` | <25% / 25-50% / 50-75% / >75% | Rough share of the talking time that is the target speaker. |
| `notes` | free text | Anything else (e.g. "phone-quality audio", "speech is dubbed/translated", "two target-like speakers"). |

When done, tell the agent. It joins your answers to the key and summarises the result by class for D1.
