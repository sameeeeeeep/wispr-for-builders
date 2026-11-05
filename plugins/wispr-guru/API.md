# Wispr Guru API

Guru is the pack's **second cursor**: it points at things on screen, walks people through steps, and
presents numbered choices. Everything goes through one native helper, `helper/guru`, a one-shot macOS
program (like the Switchboard notch's `sb-card`): pass one JSON argument, it draws, waits, prints one
JSON line on stdout and exits.

Any pack mod can call it directly. No daemon, no network.

```js
// from another mod's hooks module
const GURU = process.env.HOME + '/.wispr-guru/guru'   // stable path; installed by the guru mod on session.start
const r = await $.process.run([GURU, JSON.stringify(spec)], { timeoutMs: 600_000 })
const out = JSON.parse(r.stdout.trim().split('\n').pop())
```

From a shell: `~/.wispr-guru/guru '{"mode":"point","target":{"label":"Export"},"say":"Here"}'`.

Claude itself uses the tools `mcp__wispr-guru__guide`, `mcp__wispr-guru__point`,
`mcp__wispr-guru__present` and `mcp__wispr-guru__look` (same shapes as below).

## Targets

A target says where to point. Give one of these; the first that resolves wins.

| Field | Meaning |
| --- | --- |
| `label` | Text of a control (button title, menu item, sidebar row, field label). Found through the macOS Accessibility tree, so the arrow **follows the window** if it moves. Case-insensitive; exact match beats contains. |
| `app` | Limit `label` search to this app (name or bundle id). Default: the frontmost app that isn't the terminal/Claude. |
| `role` | Optional AX role filter: `button`, `row`, `menuitem`, `field`, `checkbox`, `tab`, `link`… |
| `x, y` (+ `w, h`) | Screen point/rect in **points**, top-left origin, from a screenshot (`look` returns its scale). Used when nothing in the AX tree matches. |
| `relativeTo: "window"` | With `x,y`: coords are relative to `app`'s front window; the arrow follows the window. |

If nothing resolves, the card still shows (no arrow) with "I can't see it — where is it?" and the person can answer.

## Modes

### `step` — one guided step, waits for the person

```json
{ "mode": "step", "say": "Click Wallpaper in the sidebar", "detail": "It's under Appearance",
  "target": { "label": "Wallpaper", "app": "System Settings" },
  "index": 2, "total": 5, "task": "Change your wallpaper", "size": "full" | "mini" }
```

Out: `{"reply":"next"}` · `{"reply":"back"}` · `{"reply":"where"}` · `{"reply":"stop"}` ·
`{"reply":"text","text":"<what they dictated/typed>"}` · `{"reply":"timeout"}`.
Plus `"targetFound": true|false` and `"rect": {x,y,w,h}` when an arrow was drawn.

The person answers by holding their Wispr key and speaking into the card ("done", "next", "go back",
"wait, where?"), typing, or keys: **⏎** on an empty box = next, **⌘←** back, **esc** stop. Spoken
words are normalised: done/next/ok/got it/yep → `next`; back/previous → `back`;
where/can't find/don't see → `where`; stop/cancel/quit → `stop`; anything else → `text`.

### `point` — just the arrow + a label, no waiting

```json
{ "mode": "point", "target": { "label": "Share" }, "say": "This one", "ttl": 4 }
```

Out: `{"shown":true,"targetFound":true,"rect":{...}}` after `ttl` seconds (default 4).

### `present` — numbered options or images, waits for a pick

```json
{ "mode": "present", "say": "Which file did you mean?",
  "options": [ { "label": "Q3 deck.key", "detail": "~/Desktop · 2 days ago", "image": "/abs/thumb.png" } ],
  "size": "full" | "mini", "at": "cursor" | "notch" | "center" }
```

Up to 9 options; `image` optional per option (absolute path; shows as a tile grid when every option has one).
Out: `{"pick":2,"label":"…"}` (1-based) · `{"reply":"text","text":"…"}` · `{"reply":"stop"}`.
The person says "two" / "the second one" / presses **1–9**.

### `look` — what's on screen (for Claude, before a step)

```json
{ "mode": "look", "app": "System Settings", "find": "Wallpaper" }
```

Out: `{"screenshot":"/tmp/…png","scale":2,"screen":{w,h},"app":"System Settings",
"window":{x,y,w,h},"matches":[{"label":"Wallpaper","role":"AXRow","rect":{x,y,w,h}}]}`.
`matches` needs Accessibility permission; `screenshot` needs Screen Recording. Missing permission →
that field is absent and `"needs":["accessibility"]` says which.

## Card

Fathom green on lumen ivory (Sameep's Wispr palette), dark-mode aware. **Draggable** anywhere;
the position is remembered in `~/.wispr-guru/state.json`. `"size":"mini"` is a one-line pill
(step text + mic dot) for quick hints. The card never covers the target: it docks beside the arrow
unless the person has dragged it.

## Versioning

`guru --version` prints the API version (`1`). New fields are additive.
