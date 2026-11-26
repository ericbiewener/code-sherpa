# Code Sherpa

A TypeScript Electron app for interactive PR walkthroughs with local Codex, Claude Code, and Pi agents.

## Run

Use the Node version in `.nvmrc` and pnpm declared in `package.json`.

```sh
pnpm install
pnpm dev
```

Development watches the renderer, main process, and preload bridge. Main-process changes restart Electron; preload changes reload its window. Restart `pnpm dev` once after changing the dev command itself.

The home screen starts a **PR Walkthrough**. Enter a PR URL, choose saved agent settings, and click **Start walkthrough**. A new session automatically sends the guidelines from `src/renderer/src/initial-prompt.md`, followed by `Fetch the full PR diff, title, and body for this URL: <url>. Summarize the changeset.` The guidelines are bundled into the app at build time. Once the agent responds, continue asking questions in the conversation. **Walkthroughs** returns to the form and your **Recent walkthroughs**. Click **Resume** to reopen a saved transcript and continue with the same agent conversation, including after restarting the app. The initial prompt is only sent when creating a new walkthrough.

The hamburger menu opens **Basic Agent Session**, where you manage integrations and start regular conversations. You can also use **Manage integrations** on the walkthrough form. Click **Add integration**, choose **Codex**, **Claude Code**, or **Pi**, then configure that integration:

- **Codex:** model, reasoning effort, approval policy, and sandbox access.
- **Claude Code:** model, effort, permission mode, and maximum turns.
- **Pi:** provider, model, and thinking level. A provider requires a model; tool access follows Pi’s configuration and extensions.

Unset options use the agent’s native defaults. Name is optional and defaults to the integration’s name. Under **Executable location**, you can optionally select an executable path or name on PATH; enter paths with spaces without quotes. There is no command-line field. Use the agent’s own configuration for settings not exposed in the form.

Each integration also has an optional **Configuration directory** field: `CODEX_HOME` for Codex, `CLAUDE_CONFIG_DIR` for Claude Code, and `PI_CODING_AGENT_DIR` for Pi. Use an absolute path or `~/path`, without quotes. The app sets that variable only in the selected agent’s process environment; other sessions and the app’s environment are unaffected. Blank inherits the login shell’s value or the agent’s default (`~/.codex`, `~/.claude`, or `~/.pi/agent`). The directory is saved as `configDir` in the profile and copied into each new session for resuming.

Use the pencil to edit settings; **Cancel** or **Escape** discards the edit. The copy button clones an integration and immediately opens the copy’s settings with its name selected. The copy is saved immediately; cancelling the form keeps the copy and discards only unsaved edits. The trash button deletes the saved profile. Click a profile to start a session. Multiple profiles can use the same integration with different settings. Each session stores a copy of its settings, so editing or deleting a profile affects only future sessions.

Install and sign in to the CLI in your terminal first. Code Sherpa uses its existing authentication and your login shell's environment. A session starts in the directory you launched the development app from, or your home directory in the packaged app.

Chat supports streamed Markdown, tool activity, approvals, questions, and stopping a turn. Enter sends; Shift+Enter adds a line. **Walkthroughs**, **Integrations**, and the hamburger menu change views while agents continue working in the background. Recent sessions show whether an agent is working, ready, or needs input; reopen one to see its latest messages and answer pending questions. Unsent drafts are preserved while navigating. Use **Stop** to interrupt a turn explicitly. Quitting the app stops its agent processes; saved sessions reconnect using their native session IDs when you send the next message after reopening.

## Config

Integration profiles are saved to:

```text
~/.config/code-sherpa/config.json
```

The file lives outside the installation and Electron’s app data, so it survives reinstalling the app. Manage it with your dotfiles to share settings between machines. Writes preserve symlinks, including links whose targets don’t exist yet. A new config starts with an empty profile list.

```json
{
  "version": 2,
  "profiles": [
    {
      "id": "work",
      "name": "Work",
      "harness": "codex",
      "options": {
        "model": "your-model-id",
        "reasoningEffort": "medium",
        "approvalPolicy": "never",
        "sandbox": "danger-full-access"
      }
    }
  ]
}
```

The app generates profile IDs. `harness` must be `codex`, `claude`, or `pi`, and each integration has its own validated `options` object. Omit an option to inherit its native default. An optional `executable` property overrides the executable name. The example explicitly disables Codex approval prompts and sandbox restrictions; omit those options to inherit your Codex configuration. You can edit the file directly; it reloads when the home screen regains focus. Invalid files are preserved and show an error with a Retry button.

Version 1 command profiles are converted when read, and version 2 is written on the next settings save. Supported legacy model and permission flags become explicit form values. Unsupported flags and unknown integrations retain the original command and show a review notice; edit and save the profile before launching it. Shell command parsing exists only in this compatibility reader. Saved legacy sessions retain their transcript and native session ID. If their old command needs review, open the session and choose reviewed settings for the same integration before continuing.

`XDG_CONFIG_HOME` overrides `~/.config`. `SHERPA_CONFIG_FILE` can specify an absolute config filename. Conversation transcripts are stored separately in Electron’s `userData` directory. Saved PR walkthroughs appear on the walkthrough page, and basic sessions appear under **Recent sessions**. Existing walkthroughs from older versions are recognized from their initial prompt. `SHERPA_DATA_DIR` overrides that directory for testing.

Codex launches `codex app-server --listen stdio://` and receives model, approval, sandbox, and reasoning settings through JSON-RPC. Claude receives settings through the official Agent SDK, including the required bypass-permissions opt-in when that mode is selected. Pi launches with app-generated RPC, model, provider, and thinking arguments. Native session IDs are used to resume conversations. The app never interprets a new profile as a shell command.

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
