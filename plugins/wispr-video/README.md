# Wispr Video

A voice-first video editor that runs on your Mac as a Claude Code mod.

- **Record**: camera with a teleprompter that follows your voice (it moves on after a line's last word, or on
  Space / →, never on a timer). Screen capture is its own track: record it at the same time or later.
- **Edit**: a timeline with layout, b-roll, titles, sound, screen and camera tracks. Drag to move, drag edges
  to trim, S to split, ⌫ to delete. A transcript you can click to seek and select to cut.
- **Captions**: word-timed from an on-device transcript (whisper.cpp), with the spoken word and your
  keywords highlighted. Fix a word by double-clicking it.
- **Say the edit**: type or dictate in the box under the preview, or ask Claude Code. Claude reads the
  project (a JSON edit list) and sends ops through the `wispr-video` MCP tools; the editor updates live.
- **Export**: 9:16, 4:5, 16:9 (and 1:1) with ffmpeg, captions burned in.

## Try it

```sh
claude --plugin-url https://sameep.ai/wispr-editor/wispr-video.zip
```

Then `/video`, or ask "open Wispr Video". The editor runs at http://127.0.0.1:4380 and keeps projects in
`~/WisprVideo/<project>/` (`project.json`, `media/`, `exports/`).

From a checkout: `claude --plugin-dir path/to/wispr-video`, or run the editor alone with `bin/wispr-video`.

Needs macOS, Python 3, `ffmpeg`, `swiftc` (Xcode Command Line Tools, used to draw captions), and
`whisper-cpp` with a model (`brew install ffmpeg whisper-cpp`; the `video_setup` tool can fetch
`ggml-base.en`). Voice-follow in the teleprompter uses Chrome's speech recognition.

## Tools (MCP)

`video_open`, `video_projects`, `video_new`, `video_get`, `video_edit`, `video_find`, `video_still`,
`video_import`, `video_transcribe`, `video_undo`, `video_export`, `video_setup`. The ops `video_edit` takes are
listed in its description (cut, cut_silences, split, layout, overlay, text, add_clip, update_clip,
delete_clip, captions, keywords, replace_word, set, add_track).

## Layout

| Path | What |
| --- | --- |
| `server/engine.py` | project model, edit ops, transcription, ffmpeg render |
| `server/server.py` | editor server and API, live updates over SSE, the in-app "ask Claude" (`claude -p`) |
| `server/mcp.py` | stdio MCP server for Claude Code |
| `server/capgen.swift` | CoreText caption and title renderer (compiled on first export) |
| `app/` | the editor UI |
| `skills/`, `commands/` | the `wispr-video` skill and `/video` |
