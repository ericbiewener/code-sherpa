# Code Sherpa

A TypeScript Electron app for chatting with local Codex, Claude Code, and Pi agents.

## Run

Use the Node version in `.nvmrc` and pnpm declared in `package.json`.

```sh
pnpm install
pnpm dev
```

Development watches the renderer, main process, and preload bridge. Main-process changes restart Electron; preload changes reload its window. Restart `pnpm dev` once after changing the dev command itself.

The home screen lists the commands saved in your config file. Click **+ Add**, fill in the separate **Name** and **Command** fields, and press **Enter** or **Save**. Name is optional; for example, use `Luna` as the name and `codex -c "model=gpt-6-luna" -c "model_reasoning_effort=medium"` as the command. The name appears in the list and session header, with the command shown beneath it in the list.

Use the pencil to edit either field in place; **Cancel** or **Escape** discards the edit. The trash button deletes the saved entry. Click an entry to start a session. For an executable wrapper with an unfamiliar name, choose its agent type on first launch; that choice is saved. Changing the command re-detects its agent type and may ask again for an unfamiliar wrapper. Renaming alone preserves its chosen type.

Install and sign in to the CLI in your terminal first. Code Sherpa uses its existing authentication and your login shell's environment. A session starts in the directory you launched the development app from, or your home directory in the packaged app.

Chat supports streamed Markdown, tool activity, approvals, questions, and stopping a turn. Enter sends; Shift+Enter adds a line. **Commands** returns to the list and stops the current session's process. Selecting a command starts a new conversation.

## Config

Commands are saved to:

```text
~/.config/code-sherpa/config.json
```

The file lives outside the installation and Electron's app data, so it survives reinstalling the app. Manage it with your dotfiles to share commands between machines. Writes preserve symlinks, including links whose targets don't exist yet. Existing configs remain compatible; a new config starts with an empty command list.

```json
{
  "version": 1,
  "profiles": [
    {
      "id": "work",
      "name": "Work",
      "command": "codex --profile work",
      "harness": "codex"
    }
  ]
}
```

The app generates IDs and stores names separately from commands. If you leave Name blank, the command is used as its label. Existing names in your config are displayed and editable. `harness` can be `codex`, `claude`, or `pi`; recognizable executable names are inferred. You can also edit or remove entries directly in the file; the list reloads when the home screen regains focus. Invalid files are preserved and show an error with a Retry button.

`XDG_CONFIG_HOME` overrides `~/.config`. `SHERPA_CONFIG_FILE` can specify an absolute config filename. Conversation transcripts are stored separately in Electron's `userData` directory; the simplified UI does not expose saved conversation history. `SHERPA_DATA_DIR` overrides that directory for testing.

Commands support arguments, quoting, `~/` paths, and environment-variable expansion:

```text
codex --profile work
claude --model sonnet
"/path with spaces/my-agent" --custom-option
~/bin/pi-work
env MY_AGENT_SETTING=work ~/bin/my-agent
```

The app appends the flags needed for the chosen agent's structured protocol. Commands are parsed into an executable and arguments. For aliases, shell functions, pipelines, or setup steps, use an executable wrapper script that forwards arguments and stdin/stdout, ideally with `exec` for cancellation.

## Build and verify

```sh
pnpm check          # TypeScript and protocol/config/lifecycle tests
pnpm test:e2e       # Build and test the Electron UI with fixture agents
pnpm format:check
pnpm package        # Unsigned application bundle in release/
```

Tests use local protocol fixtures, including the real Claude SDK talking to a fixture CLI, and make no model requests. Electron tests require a graphical desktop. `pnpm test:clis` checks initialization against installed CLIs without sending prompts. Authenticated model generation has not been tested.

## Implementation

- Electron main process owns agent processes, portable configuration, and local transcript storage.
- The sandboxed React renderer uses a narrow, validated preload bridge.
- Codex uses `app-server` JSON-RPC; Claude uses the official Agent SDK with the configured executable; Pi uses RPC mode.
- Approval controls appear when a harness requests them. Pi uses its tools and extensions and has no universal approval gate.

This version starts its own agent processes; it cannot attach to processes already running in another terminal. macOS is the verified platform. Windows launchers/process cleanup, installers, signing, and updates are not configured. There is no standalone browser backend.

Protocol references: [Codex app server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md), [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/typescript), [Pi RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md).
