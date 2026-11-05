---
name: wispr-video
description: Edit videos by voice in Wispr Video. Use when the user asks to make, record, cut, caption, re-layout or export a video ("cut the pauses", "put the screen full when I show the site", "captions bigger", "make it 4:5", "add the challenge page over line 2"), mentions their take, teleprompter or the Wispr Video editor, or wants a talking-head + screen recording turned into a Reel, LinkedIn or YouTube video.
---

# Wispr Video

A local, voice-first video editor. The project is a JSON edit list in `~/WisprVideo/<id>/project.json`;
the editor window (http://127.0.0.1:4380) updates live whenever you change it with the tools.

## The model

- **Tracks** (top draws over bottom): `layout` (segments that set the layout), `overlay` (b-roll images and
  clips with a `box` in 0–1 canvas units), `screen` (screen recordings), `cam` (the talking head; its audio
  is the voice and its words are the captions).
- **Clips**: `{id, src, at, in, out}`, where `at` is the timeline second and `in`/`out` are source seconds. Layout
  clips use `{at, dur, mode}`.
- **Layouts**: `cam`, `screen`, `pip` (screen with a camera bubble), `split`, `auto` (pip if there's a screen clip).
- **Captions** come from the word-level transcript of the camera clips, chunked `words` at a time; the word
  being spoken uses `active`, `keywords` use `keyword` (and an italic serif if `serifKeywords`).

## Making a video from scratch (Claude drives)

When the user wants a video, you write the script, set it up and do the edit. They only talk:
draft the script in their voice (short spoken lines, a hook first), `video_new` with it, then `video_open` with
`mode: "record"`. After each take lands (the camera clip is transcribed automatically), do the edit pass below.

## How to edit

1. `video_get` first. It lists clip ids, each script line's timeline range, and the transcript as
   `time word` pairs. Use those times; don't guess.
2. To place something "over line 2" or "when I say X", use the line ranges from `video_get` or `video_find`.
3. Apply everything in one `video_edit` call with a `note`. Ripple cuts (`cut`, `cut_silences`,
   `delete_clip` with ripple) shift everything after them, so order several cuts **latest first**.
4. Look at a frame with `video_still` after visual changes (layout, overlays, captions), and fix what's off.
5. Reply with one short sentence about what changed. Export only when asked (`video_export`, ~1–3 s per
   second of video); give the file path.

Common requests:

| They say | Ops |
| --- | --- |
| "cut the pauses / ums" | `{"op":"cut_silences"}` (tune `min_gap`, `keep`) |
| "cut 'so basically'" | `video_find`, then `{"op":"cut","start":…,"end":…}` |
| "show the site full while I talk about it" | `{"op":"layout","mode":"screen","start":…,"end":…}` |
| "put X over line 2" | `{"op":"overlay","src":<source id>,"start":…,"end":…,"box":{"x":0.08,"y":0.12,"w":0.84,"h":0.46},"fit":"contain","radius":0.05}` |
| "captions bigger / higher / one word at a time" | `{"op":"captions","size":0.06}` / `"y":0.6` / `"words":1` |
| "highlight Wispr and 2,000" | `{"op":"keywords","add":["Wispr","2,000"]}` |
| "it says Whisper, it's Wispr" | `{"op":"replace_word","find":"Whisper","replace":"Wispr"}` |
| "make it 4:5" | `{"op":"set","path":"aspect","value":"4:5"}` |
| "bubble top-left, smaller" | `{"op":"set","path":"pip.corner","value":"tl"}`, `{"op":"set","path":"pip.size","value":0.26}` |

New media from disk: `video_import` with `role` `screen` (a screen recording), `media` (b-roll; pass `at`) or
`cam` (another talking-head take, transcribed automatically).

If transcription fails for lack of a model, run `video_setup` (with `download: true` after asking the user;
it fetches a 142 MB speech model).
