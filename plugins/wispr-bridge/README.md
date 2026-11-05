# Wispr Bridge

The small harness every Wispr for Builders Claude Code mod runs on.

You hold your Wispr key and say what you want. Wispr types it into the bridge's floating field, the
bridge works out what you meant (find a file, run a wish, convert something, leave a review note,
guide you, or just answer), and hands it to the mod that does that. When a mod needs you to choose, a
small card shows numbered options, as rows or as image thumbnails: click one or press its number, and
add a note in your own words if you like ("1 but make it shorter").

The bridge never opens the microphone, so it never fights Wispr or any other app for it.

![Wispr Bridge card with three numbered image options](assets/card-tiles.png)

## Try it for one session

```sh
claude --plugin-dir ~/Documents/Projects/relay/packages/wispr-bridge
```

Then `/wispr test` for a sample card, or `/wispr ask` to dictate a request.
Or paste this into Claude: "Load the plugin at ~/Documents/Projects/relay/packages/wispr-bridge and run /wispr test".

## For mod authors

Code against [API.md](API.md). From any language:

```sh
~/.wispr-bridge/bin/wispr-bridge present '{"title":"Which one?","options":[{"label":"A","image":"/abs/a.png"},{"label":"B","image":"/abs/b.png"}]}'
# -> {"pick":2,"label":"B"}
~/.wispr-bridge/bin/wispr-bridge register file.find /abs/path/to/your-mod/bin/find
```

From Node: `import { present, notify, progress, route } from '<home>/.wispr-bridge/lib/bridge.mjs'`.

## What it does on your machine

- Starts `helper/wb-card` (a small AppKit/SwiftUI program in this plugin) to draw cards. No network,
  no microphone, writes no files.
- Runs `claude -p` with Haiku, no tools, to classify a request. Your request text goes to Claude
  like any other prompt.
- Runs the handler command a mod registered in `~/.wispr-bridge/intents.json`.
- Writes `~/.wispr-bridge/` (symlinks, handler list, progress pill state). Delete the folder to remove it.

## Build

`ARCH=arm64 ./build.sh` for a quick local build, `./build.sh` for universal (signs if the Developer
ID is in the keychain). Output: `dist/wispr-bridge.zip`.
