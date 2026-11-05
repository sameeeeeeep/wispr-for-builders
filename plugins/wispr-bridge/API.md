# Wispr Bridge API

The ultralight harness every Wispr for Builders pack mod uses.

Three jobs:

1. **Input**: a voice request arrives as text (Wispr dictation typed into a focused field). The bridge
   never opens the microphone. Text comes from the floating ask field (`wispr-bridge ask`), the card's
   own text box, or any caller passing text.
2. **Router**: `route(text)` asks `claude -p` (Haiku, strict JSON) to classify the text into an
   intent with args, then runs the mod registered for that intent.
3. **Presenter**: `present()` shows a small draggable card with numbered options (text rows, or an
   image tile grid numbered 1/2/3) and returns the pick. Plus `notify()` and `progress()`.

`WISPR_BRIDGE_HOME` overrides `~/.wispr-bridge` (handy for tests).

Stable install path (so any mod or shell can call it): `~/.wispr-bridge/bin/wispr-bridge`
(symlink to this package's `bin/wispr-bridge`). Node module: `~/.wispr-bridge/lib/bridge.mjs`.

## Node module

```js
import { present, notify, progress, route, classify, ask } from
  process.env.HOME + '/.wispr-bridge/lib/bridge.mjs'
```

### `present(spec) -> Promise<Result>`

```js
await present({
  title: 'Which thumbnail?',            // required, one line
  subtitle: 'From your Desktop',        // optional
  options: [                            // 1-9 options
    { label: 'Hero shot', detail: '1920x1080', image: '/abs/path/a.png' },
    { label: 'Close-up',  image: '/abs/path/b.jpg' },
    { label: 'Wide' ,     image: '/abs/path/c.png' },
  ],
  multi: false,                         // true: toggle several, then Enter
  recommended: 1,                       // optional 1-based highlight
  at: 'notch' | 'cursor' | 'center',    // default 'notch'
  focus: true,                          // false: show without taking keyboard focus; the card
                                        //   takes focus when the pointer enters it
  timeout: 540,                         // seconds, default 540
})
```

Layout: if **every** option has `image`, options render as a numbered thumbnail grid (1/2/3 badges);
otherwise as numbered rows. `image` is an absolute local path (png/jpg/gif/heic/pdf first page).

Focus: with `focus: true` (default) the card becomes the key window so keys and Wispr dictation land
in its text box. An Enter in the first 0.8 s is ignored (a Wispr paste meant for the previous app).
Use `focus: false` for cards that appear while the user may be dictating elsewhere.

Pick by: click, keys **1-9**, arrow keys + **Enter**, or by typing/dictating into the card's text box
("two", "the second one", "number 3", "hero shot", "one and three" for multi). Esc cancels.
The card is draggable (drag anywhere on its background).

Result (one JSON object):

```json
{ "pick": 2, "label": "Close-up" }                      // single
{ "picks": [1, 3], "labels": ["Hero shot", "Wide"] }    // multi
{ "text": "none of these, the blue one" }               // free text that matched no option
{ "cancelled": true }                                   // esc, or timeout ({"cancelled":true,"timeout":true})
```

### `notify(text, {title?, ttl?}) -> Promise<void>`

Small toast card, auto-dismisses after `ttl` seconds (default 3). Never steals focus.

### `progress(text, {id?, done?}) -> Promise<void>`

Persistent status pill. Call repeatedly with the same `id` (default `"default"`) to update its text;
`{done: true}` closes it. Backed by a file at `~/.wispr-bridge/progress/<id>.json` the pill watches,
so updates are instant and cheap.

### `classify(text) -> Promise<Intent>`

Only the classification, no dispatch:

```json
{ "intent": "file.find", "args": { "query": "q3 deck", "kind": "keynote" },
  "confidence": 0.92, "say": "Looking for your Q3 deck" }
```

Intents (fixed set):

| intent | for | args |
| --- | --- | --- |
| `file.find` | find a file/folder/image on this Mac | `query`, `kind?`, `where?`, `when?` |
| `wish.run` | "make/build/do X" — a task for Claude Code | `wish`, `project?` |
| `convert` | convert/resize/export a file | `input?`, `to`, `options?` |
| `review.note` | a review comment on what's on screen / a page | `note`, `target?`, `severity?` |
| `guide` | "how do I / show me where" — walk through steps | `task`, `app?` |
| `ask` | a plain question, or anything else | `question` |

Model: `claude -p --model haiku --output-format json --tools "" --strict-mcp-config
--no-session-persistence --setting-sources ""` (prompt on stdin; adds `--bare` when `ANTHROPIC_API_KEY`
is set) with the schema in the prompt. Latency is claude CLI startup plus ~2 s of API: 10-15 s on an
idle Mac, up to ~70 s under heavy load; the reply
is validated and anything unparseable becomes `{intent:"ask", args:{question:text}}`.
Override the model with `WISPR_BRIDGE_MODEL`.

### `route(text, {dryRun?}) -> Promise<{intent, args, handler, result}>`

Classifies, then runs the handler registered for the intent with one argument: the intent JSON.
The handler's stdout (JSON if it parses, else text) is returned as `result`.
With no handler registered, `handler` is `null` and the intent is returned (and a `notify` says so).

### `ask({placeholder?}) -> Promise<string|null>`

Opens the floating ask field (focused, centered near the top of the screen) for Wispr to dictate into.
Enter returns the text, Esc returns `null`.

## Handlers (how a mod plugs in)

`~/.wispr-bridge/intents.json` maps intent to a command (argv array). Register with the CLI:

```sh
wispr-bridge register file.find  /abs/path/to/my-mod/bin/find
wispr-bridge register guide      ~/.wispr-guru/guru-route
wispr-bridge handlers            # list
```

The command gets the intent JSON as `argv[1]` and also on stdin. It may call `wispr-bridge present`
itself to show choices. Exit 0 = success.

Built-in fallbacks when nothing is registered:
- `wish.run` → `claude -p "<wish>"` in `args.project` (or cwd), result notified.
- `ask` → `claude -p --model haiku "<question>"`, answer shown with `notify`.

## CLI

```sh
wispr-bridge present '<json spec>'           # prints the Result JSON
wispr-bridge present @spec.json              # spec from a file (or `-` for stdin)
wispr-bridge notify "Saved 3 files" [--ttl 4]
wispr-bridge progress "Rendering 40%" [--id render] [--done]
wispr-bridge classify "find my q3 deck"      # prints the Intent JSON
wispr-bridge route "find my q3 deck" [--dry-run]
wispr-bridge ask                             # floating field -> route the dictated text
wispr-bridge register <intent> <cmd...> | unregister <intent> | handlers
wispr-bridge ask --no-route                  # floating field -> just print {"text"}
wispr-bridge install                         # (re)link ~/.wispr-bridge/bin + lib to this package
wispr-bridge doctor                          # checks helper, claude CLI, handlers
```

Exit codes: 0 ok, 1 cancelled / no answer, 2 bad input, 3 helper or claude failed.

## Native helper

`helper/wb-card` (Swift, AppKit+SwiftUI, extended from the Switchboard notch's `sb-card`): one JSON
argument with `mode: "present" | "notify" | "progress" | "ask"`, prints one JSON line, exits.
No network, no microphone, no files written.

## Claude Code plugin

Packaged like `notch-mod`. Commands: `/wispr ask`, `/wispr route <text>`, `/wispr classify <text>`,
`/wispr test`, `/wispr handlers`. On
`session.start` the mod installs the stable `~/.wispr-bridge` symlinks.
