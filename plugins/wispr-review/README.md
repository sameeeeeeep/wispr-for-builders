# Wispr Review

Review any website by voice. Point at something, hold your Wispr key and talk: the note pins itself to the element
under the cursor, with a screenshot crop, a selector and the URL. Point at the next thing and talk again. No clicking.
Then hand all of it to Claude in one paste.

Pack 1 of "Wispr for Builders", next to Guru and Wispr Video. It reuses portfolio/build/review/extension (per-site
on/off, selector builder, screen crop) and plugs into wispr-bridge for quiet toasts.

## Install

**Give it to your Claude** (one line, paste into Claude Code):

> Install the Wispr Review plugin from ~/Documents/Projects/relay/packages/wispr-review: run its `bin/wispr-review install` and `bin/wispr-review serve --daemon`, then walk me through loading its extension folder in Chrome.

Or load the plugin for a session: `claude --plugin-dir ~/Documents/Projects/relay/packages/wispr-review`
(it links `~/.wispr-review/bin/wispr-review`, starts the inbox and adds `/wispr-review`).

**Chrome (unpacked, once):**
1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. **Load unpacked** and pick `~/Documents/Projects/relay/packages/wispr-review/extension`
   (or unzip `dist/wispr-review-extension.zip` and pick that folder).
3. Pin **Wispr Review**. Check the shortcut at `chrome://extensions/shortcuts` (default Option+Shift+R).

## Use
1. On any site press **Option+Shift+R** (or click the toolbar button). A small "point and talk" pill follows the cursor.
2. Point at the thing. Hold your Wispr key (Fn) and say the note. When the words land, the element locks, and the
   note saves itself about 2 s later. **Enter** saves now, **Esc** drops it, keep talking to add to it.
   Typing works too (then Enter saves).
3. Optional: tap **Option** to lock the element before you talk (or Option-click it), tap again to unlock.
4. Numbered pins mark every note. **← →** (or **Walk**) steps through them: the page scrolls to each one and a pointer
   card shows the note, its crop, and Done / Delete.
5. **Send to Claude** copies a prompt plus the notes JSON. Paste it into Claude Code in the site's repo.
   **.md** downloads the site's notes as markdown.

The mic is never touched: the words come from Wispr's own dictation, typed into the focused pill.
While voice mode is on, Space / arrows / Page keys scroll the page when the pill is empty; Esc on an empty pill turns voice mode off,
and voice mode stays the way you left it on that site. Token-like query params are stored as REDACTED in the note URL.

## The local inbox (optional, recommended)
`wispr-review serve --daemon` listens on 127.0.0.1:4377. Only this extension may talk to it (its id is pinned by the
`key` in `extension/manifest.json`; requests with any other Origin, or a Host other than 127.0.0.1/localhost, get 403). Every note is also
written to `~/.wispr-review/notes.json`, `notes.md` and `shots/*.jpg`, so Claude can read the crops.
- `wispr-review notes` open notes as markdown (`--json`, `--all`, `--site host`)
- `wispr-review done <n> "what changed"` marks a note done; the pin turns grey on the next page load
  (if two sites both have that number, add `--site <host>` or pass the note id)
- `wispr-review doctor`, `wispr-review path`

## Files
- `extension/` the Chrome extension (MV3): `background.js` (per-site on/off, crops, inbox relay), `content.js` (UI in a shadow root)
- `bin/` the CLI and inbox; `hooks/` the Claude Code plugin module (`/wispr-review`); `skills/wispr-review/` how Claude acts on notes
- `test/harness.html` runs content.js with stubbed chrome APIs; `test/site.html` a sample page; `build.sh` makes `dist/*.zip`
