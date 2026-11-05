# Wispr for Builders · Pack 1

**Wispr is for typing, and typing is for everything.** These are Claude Code mods made for
[Wispr Flow](https://wisprflow.ai) users: you say what you want, and your Mac does it. Seven mods,
one install, all running on your Mac.

> Made for Wispr, unofficial. Built by [Sameep Rehlan](https://sameep.ai); not made, endorsed or
> supported by Wispr. No Wispr logo, no Wispr account access. The mods don't open your microphone:
> they read what Wispr Flow types into a focused field. The one exception is Wispr Video's recorder,
> which uses the mic while you record.

## Install the whole pack

Give this repo to your Claude and say:

```text
Install Wispr for Builders pack 1 from https://github.com/sameeeeeeep/wispr-for-builders
```

Claude clones it, reads [CLAUDE.md](CLAUDE.md) and runs `./install.sh`. Or do it yourself:

```sh
git clone https://github.com/sameeeeeeep/wispr-for-builders && cd wispr-for-builders && ./install.sh
```

Or add it as a Claude Code plugin marketplace and pick mods one at a time:

```text
/plugin marketplace add sameeeeeeep/wispr-for-builders
/plugin install wispr-file@wispr-for-builders
```

Needs macOS 13+, Claude Code, Node 18+ and Wispr Flow. wispr-wish and wispr-video also use
`ffmpeg` and `whisper-cpp` (`brew install ffmpeg whisper-cpp`).

---

## The mods

### Wispr File · find any file by saying it

> "the GST invoice from October" · "last screenshot of the admin panel" · "two, copy the path"

Spotlight searches your Mac, results come back as a numbered card of thumbnails, and you say
"two". It pastes the file into the app you were in, or reveals, opens or copies it. File contents
never leave your Mac.

![A numbered card of three image tiles, the second highlighted, with a text field that says Say two](assets/card.jpg)

```text
/plugin install wispr-file@wispr-for-builders
```

### Wispr Wish · say what should happen to a file

> "make this a PDF" · "compress this video for WhatsApp" · "turn these PNGs into WebP" ·
> "transcribe this audio" · "a timer for 25 min" · "split this bill three ways" · "a QR for this link"

Acts on what you selected in Finder, using ffmpeg and a local whisper transcript. Ask for a small
tool and it opens one in its own window. It answers questions instead of acting on them, and asks
before deleting anything.

![Three small dark windows: a bill split showing 944 rupees each, a QR code for a link, and a 10 minute timer](assets/wish.jpg)

```text
/plugin install wispr-wish@wispr-for-builders
```

### Wispr Review · review a website by talking at it

> Point at the headline, hold Fn: "too big on mobile". Point at the price: "say per seat".

A Chrome extension pins each dictated note to the element under your cursor, with a crop, the
selector and the URL. Notes go to a local inbox, and Claude reads them with `/wispr-review` and
fixes them one by one.

![A web page with a pinned note on the price that says Price should say per seat, and a Review dock in the corner](assets/review.jpg)

```text
/plugin install wispr-review@wispr-for-builders
```

Then load `plugins/wispr-review/extension` in chrome://extensions (Developer mode, Load unpacked)
and press Option+Shift+R on any site.

### Wispr PM · your task boards, by voice

> "park this for the portfolio" · "what's next on the portfolio" · "split this into tasks" ·
> "start a thread for the hero fix" · "what's waiting on me"

One Markdown board per project. Parked items become cards, "what's next" comes back as a numbered
card, and "start a thread" runs a Claude Code session on that card and moves it to review when
it's done.

```text
/plugin install wispr-pm@wispr-for-builders
```

### Wispr Guru · a second cursor that shows you where to click

> "walk me through exporting a frame in Figma" · then "done", "next", "wait, where?"

Guru points at the control you need, shows the step in a small card beside it, and waits for you.
When a long Claude turn finishes, it plays a short sound and gives you a card to dictate your reply
into.

```text
/plugin install wispr-guru@wispr-for-builders
```

### Wispr Video · a video editor you talk to

> "cut the silences" · "captions on, highlight the product name" · "export 9:16"

Record with a teleprompter that moves when you finish a line, add a screen take, and get
word-timed captions from an on-device transcript. Say the edit and Claude changes the timeline
while you watch. Exports 9:16, 4:5 and 16:9 with ffmpeg.

![The Wispr Video editor: a preview, a transcript, and a timeline with camera, screen and caption tracks](assets/video.jpg)

```text
/plugin install wispr-video@wispr-for-builders
```

### Wispr Bridge · what ties them together

`wispr-bridge ask` opens a small field. Dictate any request and it goes to the mod that handles
it. Every mod shows choices on the same numbered card, so you answer by voice, by pressing a number
key or by clicking. It installs with the pack, and other mods can use it: see
[plugins/wispr-bridge/API.md](plugins/wispr-bridge/API.md).

```text
/plugin install wispr-bridge@wispr-for-builders
```

---

## Coming

- **Pack 2, for editors**: for people who have Claude but haven't found what to use it for.
- **Pack 3, for designers**.
- A global hotkey for `wispr-bridge ask`. For now, bind it with Raycast or Shortcuts.

## What runs where

Everything runs on your Mac. A few things call Claude through your own `claude` CLI: the bridge's
router and anything you dictate to it, wispr-file's fallback when nothing matches (the request
text only; turn it off with `WISPR_FILE_LOCAL=1`), and wispr-pm's split and unclear phrases. File
contents are never sent. Each mod's README in `plugins/` says exactly what it reads and writes.

## License

MIT. See [LICENSE](LICENSE).
