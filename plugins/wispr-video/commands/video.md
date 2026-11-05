---
description: Make a video with Wispr Video. Claude writes the script, you record to a teleprompter that follows your voice, Claude does the edit.
argument-hint: "[what the video is about, or an edit to make]"
---
Use the wispr-video tools. Claude drives the whole video; the user only talks.

**If $ARGUMENTS describes a video to make** (a topic, a launch, a demo):
1. Draft the script in their voice: short spoken lines, a hook in the first line, one idea per paragraph, 30–90 s
   unless they say otherwise. Show it in a few lines and take one round of changes if they want.
2. `video_new` with a title, the aspect (9:16 for Reels/Shorts, 4:5 for feed, 16:9 for YouTube/LinkedIn) and
   the script, then `video_open` with `mode: "record"`. Tell them in one line: press Record; the prompt follows
   their voice; Space or → also moves on.
3. When they say the take is done, `video_get`, then one `video_edit` pass: `cut_silences`, keywords for the
   names and numbers, and layouts if there's a screen track. Check one frame with `video_still`, then say what you
   did in one sentence and offer to export.

**If $ARGUMENTS is an edit** ("cut the pauses", "captions bigger"): follow the wispr-video skill (`video_get`,
then `video_edit`, then `video_still`).

**With no arguments:** `video_open`, and ask in one line what the video is about.
