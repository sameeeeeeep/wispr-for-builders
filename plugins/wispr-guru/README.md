# Wispr Guru

A second cursor for Claude. Ask how to do something on your Mac; Guru points at the control, shows
the step in a small card beside it, and moves on when you do it (or click Next). Stuck? Hold your
Wispr key and ask in the card, in your own words.

It also brings you back to threads that are waiting: when a long Claude turn finishes, Guru plays a
short sound (a meow by default) and shows a card you can dictate a reply into. The reply goes back
to that exact thread.

## Try it for one session

```sh
claude --plugin-url https://sameep.ai/wispr-guru/wispr-guru.zip
```

Then ask “walk me through making this text bold in TextEdit”, or run `/guru test`.

## What Claude gets

| Tool | Does |
| --- | --- |
| `guide` | One step: points at a control (by its label, found through Accessibility, so it follows the window) and waits for the reply |
| `point` | Points for a few seconds, no waiting |
| `present` | Up to 9 numbered options or image tiles; click or press `2`, and add a note in your own words (“1 but shorter”) |
| `look` | Screenshot path, window and screen rects, and controls matching a label |

Other mods can call the same helper: see [API.md](API.md).

## Commands

| Command | Effect |
| --- | --- |
| `/guru <what you want to do>` | Claude guides you through it |
| `/guru test` | Show a test step |
| `/guru ping` | Show a test reply card for this thread |
| `/guru sound meow\|metal\|pspsps\|boop\|off` | Alert sound (add `here` for this project only) |
| `/guru mute` / `/guru unmute` | Sounds off / on |
| `/guru quiet 22-8` / `/guru quiet off` | No sound between those hours (cards still show) |
| `/guru back on\|off` | Reply cards for finished threads |

`touch ~/.wispr-guru/mute` silences every session at once.

The sounds are original, synthesised by `tools/make-sounds.py`; no samples.

## Permissions

Finding controls by label needs Accessibility, and `look` screenshots need Screen Recording, for
the app Claude Code runs in. Without them Guru points by coordinates and still works.

## What it does on your machine

Everything is in `hooks/register.js` and `helper/guru.swift`. The helper draws its own windows,
prints one line of JSON and exits; nothing runs between cards. It makes no network requests. It
writes only `~/.wispr-guru/` (card position, stacking slots, a copy of the helper for other mods).
