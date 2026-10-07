# Roadmap

## Next

- **One setup command.** Downloads the speech models and the Moonshine engine from the sources in `assets/live-models.json`, checks every file's SHA-256, runs `npm install`, and installs login startup.
- **"Connect agents" in the tray.** Lists the agents found on the PC and installs or removes each one's hook, using the same installer as `scripts/agent-hooks.cjs`.
- **One uninstall command.** Removes every agent hook, login startup and the Start menu shortcut, and offers to delete the profile folder.
- **Live tests for Cursor.** Its hook is installed and reproduced in tests, but talk-back hasn't been confirmed with a real Cursor run.

## Parked for later

Not being worked on. Recorded so they aren't lost.

- **Read-aloud for apps without hooks.**
  - **Which apps:** Claude Desktop, claude.ai, ChatGPT and Gemini on the web.
  - **Approach:** a browser extension for web chat, and Windows UI Automation for desktop apps. Either one reads the reply after a talk-back dictation.
  - **First step:** a feasibility spike covering reliable reply detection, end-of-reply detection and privacy, before building anything.
- **Agents with no usable hooks** (survey, October 2026):
  - **No hooks:** Aider (a notification command with no payload), Roo Code (shut down 15 May 2026), the Zed agent panel.
  - **Hooks not built yet:** GitHub Copilot CLI and VS Code agent mode. Their turn-finished hook carries only a transcript path, and the transcript format is not a stable API.
  - **JavaScript plugins only:** OpenCode, Kilo Code and Amp run plugins inside the agent rather than command hooks. Each would need a small plugin that calls the adapter.
- **Optional per-agent "always speak" setting.** Today a reply is spoken only after talk-back dictation; some users may want one agent to speak every reply.

## Agent survey (October 2026)

| Agent | Status | Turn finished (reply) | Prompt submitted | Config | Evidence |
|---|---|---|---|---|---|
| GitHub Copilot CLI | Hooks, not built | `Stop`/`agentStop`: transcript path only | `UserPromptSubmit.prompt` | `~/.copilot/hooks/*.json` | [CLI hooks reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference) |
| Copilot agent mode (VS Code) | Hooks (preview), not built | `Stop`: transcript path only | `UserPromptSubmit.prompt` | `~/.copilot/hooks/*.json` | [VS Code hooks](https://github.com/microsoft/vscode-docs/blob/main/docs/agent-customization/hooks.md) |
| OpenCode | Plugin API only | `session.idle` (session id only) | `chat.message` | `~/.config/opencode/plugins/` | [plugins](https://opencode.ai/docs/plugins/) |
| Kilo Code | Plugin API only | `session.idle` (payload unverified) | unverified | `~/.config/kilo/plugin/` | [plugins](https://kilo.ai/docs/automate/extending/plugins) |
| Amp | Plugin API only | `agent.end` → `messages[]` | `agent.start` → `message` | `~/.config/amp/plugins/` | [plugins](https://ampcode.com/docs/markdown/customize/plugins) |
| Aider | No hooks | notification command with no payload | none | `.aider.conf.yml` | [notifications](https://aider.chat/docs/usage/notifications.html) |
| Roo Code | No hooks | none | none | none | [repository (archived)](https://github.com/RooCodeInc/Roo-Code) |
| Zed agent panel | No hooks | none | none | none | [agent panel](https://zed.dev/docs/ai/agent-panel) |

Built agents are listed in [SUPPORTED_AGENTS.md](SUPPORTED_AGENTS.md).
