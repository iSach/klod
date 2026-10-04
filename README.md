# klod

A personal [Claude Code](https://claude.com/claude-code) mod: a side pane showing the context window live.

![The pane](screenshot.svg)

## Features

- **Context grid**: what fills the window, by category, updated as Claude works.
- **Prompt cache timer**: time left before the cache lapses. An idle session is refreshed once, then compacted (toggle in the pane).
- **New-topic warning**: a prompt that starts an unrelated task in a large context offers to clear first (toggle in the pane).
- **Usage**: tokens in and out, cost at API prices, plan limits.
- **Agents**: running subagents and the tool each is using.

Opens on start, or with `/context-view`.

## Install

```sh
git clone https://github.com/iSach/klod.git ~/.claude/mods
```

Then in `~/.claude/settings.json`:

```json
"env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/klod" }
```
