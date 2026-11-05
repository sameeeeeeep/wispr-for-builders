# Wispr PM

Run your task boards by voice. Dictate with Wispr Flow and the board does the rest:

| You say | It does |
| --- | --- |
| "park fix the hero on mobile for the portfolio" | adds a backlog card to the portfolio board (deduped) |
| "park this for nailinit" | parks the first line of your clipboard |
| "remind me to email Arjun about the samples for nail in it" | same as park |
| "what's next on nailinit" | a numbered card of the top 4, then: start a thread · done · park · doing |
| "split this into tasks" | adhd-pm style: the dump (or clipboard) becomes deduped, prioritised cards; you keep the ones you want |
| "start a thread for the hero fix" | finds the card (or makes one) and runs Claude Code on it: in the background with `claude -p`, or in Terminal |
| "what's waiting on me" | every card in review across all boards (finished threads land here), as a card |
| "mark the hero fix done" | ticks it off |

The mod never opens the microphone: Wispr types the words into
the bridge's floating field, the `/pm` command, or the CLI.

## Try it

```sh
claude --plugin-dir ~/Documents/Projects/relay/packages/wispr-pm      # or dist/wispr-pm.zip
```

Then `/pm what's next on the portfolio`, or `/pm ask` and dictate. Paste-into-Claude version:
"Load the plugin at ~/Documents/Projects/relay/packages/wispr-pm and run /pm what's waiting on me".

Outside Claude Code: `~/.wispr-pm/bin/wispr-pm ask` (bind it to a key in Raycast or Shortcuts),
or `wispr-pm "<what you said>"`.

Needs [Wispr Bridge](../wispr-bridge) for the cards, toasts and the notch pill (without it, it still
works and prints JSON).

## Boards

One board per project, in the Switchboard board dialect (`- [ ] title status:doing prio:high …`), using
the same parser and writer as the Switchboard connector (`vendor/tasks.mjs`, copied from `bank-mcp`):

- Projects that already live on the Switchboard board (`#switchboard`, `#pptlive`) use
  `~/SwitchboardBrain/tasks.md`, filtered by tag. New voice cards go under `## Voice inbox`.
- Every other project gets `~/.wispr-pm/boards/<project>.md`. Plain markdown, opens in Obsidian.

Projects and their spoken aliases are in `~/.wispr-pm/projects.json` (portfolio, nailinit, switchboard,
pptlive, wispr-pack to start). Any folder under `~/Documents/Projects` said by name works too. With no
project said, it uses the folder you are in, else the last one you used.

## Threads

A thread is Claude Code working on one card, in the project's folder. Background threads run
`claude -p --permission-mode acceptEdits` (set `WISPR_PM_PERMISSION` to change it), are told not to commit
or publish, log to `~/.wispr-pm/threads/<id>.log`, and on exit move the card to **review**: it is now
waiting on you, a toast says so, and the notch pill updates. Terminal threads open an interactive
`claude` with the card as the first message.

## Waiting on you

`wispr-pm notch` (also run at session start and after every thread) keeps a small pill at the notch:
"3 waiting on you: …". Cards in `review` or tagged `@me` count. It closes itself at zero.

## How a phrase is understood

A keyword router first (instant, no model, nothing leaves the Mac). Anything it does not catch is sent,
word for word, to Anthropic's Haiku through your own `claude -p` (no tools, about 7-12 s) to work out what you
meant. So only say board things to it: a stray sentence ("my bank pin is …") would be sent too.
"Split this" sends the dump to Haiku as well; the clipboard is used only when you say "this" (or nothing),
never in place of words you dictated. `wispr-pm parse "<text>"` shows the keyword result with no side
effects: no model call, no file written.

Project names can have punctuation or accents ("café", "my proj (1)"). A project you name that is neither
in `projects.json` nor a folder under `~/Documents/Projects` is not recognised, and the card goes to the
folder you are in, else the last project used (the toast names the board, so you can see where it went).

With `wispr-pm install --chain`, Wispr Bridge's `wish.run` and `ask` intents go through wispr-pm first:
board phrasings are handled, everything else is passed to the handler that was there before.

## Test

`./tests/smoke.sh` runs everything headless against a temp home, a temp board and a fake `claude`.
