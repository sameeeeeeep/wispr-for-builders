# Wispr Wish (made for Wispr)

Say it with Wispr Flow, and it happens. Unofficial; not affiliated with Wispr.

**Conversions** act on the Finder selection, but only when it is on screen: Finder is in front, or the
selected file sits in a Finder window you can see. (Finder remembers a selection for days, even with no
window open, so an off-screen selection is offered on the card, never assumed.) If nothing is selected,
they use the file wispr-file just found, or offer your newest matching files as a numbered card. New files
are saved next to the originals, and nothing is ever overwritten. If a request can't run ("that file can't
become a PDF"), the reason shows as a toast.

| say | does |
| --- | --- |
| "make this a PDF" | images go into one PDF (sips + macOS's PDF join); docx/rtf/md/txt/html become a PDF via headless Chrome |
| "turn these PNGs into WebP" | uses cwebp, or ffmpeg with libwebp, or else Chrome's own WebP encoder |
| "resize these to 1200px", "half size" | sips |
| "compress this video for WhatsApp" | ffmpeg H.264, 720p max, under 15 MB and never bigger than the original |
| "turn this into a gif under 5 megs" | ffmpeg with a two-pass palette; shrinks until it fits |
| "extract the audio as mp3" | ffmpeg |
| "transcribe this audio" / "... into subtitles" | ffmpeg, then whisper-cli (ggml base.en), or python whisper as a fallback |
| "make this a word doc" / "as text" | textutil (and PDFKit for PDF to text) |
| "... and delete the originals" | asks first on a card; originals go to the Trash, which you can undo |

**Mini apps** open in a small window:

- "a timer for 25 min", "pomodoro", "a timer for my tea 4 minutes": a built-in timer that opens instantly ("set a timer" with no time asks how long)
- "split 2400 rupees between 3 people with 10% tip": a built-in bill splitter
- "a QR for this link": a built-in, offline QR code for the URL on your clipboard, or else the front Chrome/Safari tab (only a link; other clipboard text is never encoded)
- anything else ("a dice roller", "a metronome at 90 bpm"): `claude -p` writes a one-file HTML app.
  It is cached in `~/.wispr-wish/apps/`, so asking again opens it instantly.

The mod never opens the microphone. Your words arrive as text that Wispr types into the bridge's
ask field, into `/wish`, or onto the command line.

## Install

```sh
claude --plugin-dir ~/Documents/Projects/relay/packages/wispr-wish     # this session
~/Documents/Projects/relay/packages/wispr-wish/bin/wispr-wish install  # or just the stable path + bridge handlers
```

`install` links `~/.wispr-wish/bin/wispr-wish` and registers it with Wispr Bridge for the `convert`,
`wish.run` and `ask` intents. `ask` is included because the router files "a timer for 25 min" and "split this bill"
under it. Under `ask`, wish only takes the instant built-in apps (timer, split, QR) and never a question ("what's the
best QR library", "how do I convert a docx in python" get answered, not run). Everything else gets the bridge's
built-in behaviour unchanged:
`claude -p` runs in the project folder for wish.run, and a two-line Haiku answer appears as a toast for ask.
`wispr-wish uninstall` removes all three handlers.

## Use

```sh
wispr-wish "make this a PDF"                 # Finder selection
wispr-wish "turn these into webp" a.png b.png
wispr-wish "a timer for 25 min"
wispr-wish ask                               # floating field: dictate, then Enter
wispr-wish parse "compress this for whatsapp"  # how it was understood, with no side effects
```

In Claude Code: `/wish make this a PDF`, `/wish ask`, `/wish test`, `/wish doctor`.

Through the bridge: `wispr-bridge ask` sends a dictated request to the router, which calls
`wispr-wish handle '<intent>'`.

Environment variables: `WISPR_WISH_MODEL` (the app builder, default sonnet), `WISPR_WISH_FRESH=1` (rebuild a
cached app), `WISPR_WISH_RESULT_CARD=0` (no "open it?" card), `WISPR_WISH_QUIET=1` (tests: no cards
or windows), `WISPR_WISH_WHISPER_MODEL` (path to a ggml model).
