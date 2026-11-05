# Wispr File

Find any file on your Mac by saying what it is.

> "find my passport photo" · "the GST invoice from October" · "last screenshot of the admin panel, reveal it"

You dictate the request with Wispr Flow. A card shows the 3-6 best matches as Quick Look thumbnails,
numbered 1-6. Click one or press its number, and the file is pasted into the app you were in. To do
something else with it, add it in your own words: "2, reveal it", "2, copy the path", "2, attach it in
Slack".

It never opens the microphone. Wispr types your words into a text field, and that's all the mod reads.

## Try it

```sh
claude --plugin-dir ~/Documents/Projects/relay/packages/wispr-file      # uses ../wispr-bridge or ~/.wispr-bridge
```

Then run `/find the GST invoice from October`, or `/find` on its own to get a floating field you dictate into.
Or paste this into Claude: "Load the plugins at ~/Documents/Projects/relay/packages/wispr-bridge and
~/Documents/Projects/relay/packages/wispr-file, then run /find my passport photo".

From a shell or a hotkey tool (Raycast, Shortcuts, skhd):

```sh
~/.wispr-file/bin/wispr-file ask                              # floating field: dictate, Enter
~/.wispr-file/bin/wispr-file "the deck about pricing, open it"
~/.wispr-file/bin/wispr-file "passport" --dry-run             # plan, timings and ranked hits, no card
```

Through the bridge, `wispr-bridge ask` sends "find ..." requests here (registered as the `file.find` handler).

## How it finds things (all on this Mac)

1. **Parse locally, no model.** The request is split into words, a kind (screenshot, photo, PDF, deck,
   sheet, doc, video, audio, folder, archive), a date ("yesterday", "last week", "from October",
   "in 2025"), a place ("on my desktop", "in downloads"), "latest", and an action.
2. **Spotlight, in parallel.** `mdfind` runs filename word-prefix, indexed text (including the text macOS reads
   out of screenshots), kind and date queries at the same time, skipping Library, node_modules, .git and hidden folders.
3. **Rank.** Name matches beat text matches. The kind and date count, recent files and Desktop, Downloads and Documents
   get a small boost, code files are pushed down, and duplicate "(1)" copies are folded into one.
4. **Preview.** Images and PDFs go straight onto the card. Everything else gets a Quick Look thumbnail
   (`qlmanage -t`), cached in `~/.wispr-file/thumbs`, or the Finder icon until the thumbnail is ready.
   `wispr-file warm` (run in the background at session start, at most every 6 h) pre-renders thumbnails for recent files.
5. **Act.** `helper/wf-clip` puts the file on the clipboard as a file, with the image data too for images,
   brings back the app you were in and presses ⌘V. If macOS hasn't given it Accessibility permission,
   you get "Copied. Press ⌘V" instead.

**Claude is optional.** It is used only when nothing matches, even after the date is dropped, or
with `--smart` (re-rank). It is sent the request text and, for `--smart`, the file names, folders, kinds and
dates. It never gets file contents. Calls give up after 25 s (`WISPR_FILE_CLAUDE_MS`). `--local` (or
`WISPR_FILE_LOCAL=1`) turns it off completely, and `--dry-run` never calls it unless you add `--smart`
(the result says `wouldAskClaude: true` instead).

**Card replies.** A number past the end ("nine" when there are six) asks once more, then cancels. Any other
reply that isn't a pick ("the blue one") refines the search once; a second reply like that cancels.

## Files

- `lib/find.mjs`: parse, Spotlight, ranking, thumbnails, the card, actions (Node 18+, no dependencies)
- `bin/wispr-file`: the CLI (`install`, `register`, `warm`, `ask`, `--dry-run`, `--smart`, `--action`, `--pick`, `--timeout`)
- `helper/wf-clip.swift` / `helper/wf-clip`: `copy`, `icon` and `paste` (no network, no microphone)
- `hooks/register.js`: the Claude Code mod (`/find`, plus install and warm at session start)
- `tests/parse.test.mjs` (`node --test tests/`), `tests/dry.sh "<request>" ...`

## Build

`ARCH=arm64 ./build.sh` for a quick build, or `./build.sh` for a universal one, signed if the Developer ID is available.
`./package.sh` zips the plugin without rebuilding: `dist/wispr-file.zip`. The zip vendors wispr-bridge
(`vendor/wispr-bridge`: bridge.mjs + wb-card), so it works on its own; an installed bridge at `~/.wispr-bridge` wins.
