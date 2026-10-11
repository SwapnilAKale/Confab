# Roadmap

## Next

- **Sign the native files before sharing publicly.** Smart App Control loads an unsigned DLL only while Microsoft's cloud reputation vouches for it, and that verdict can change: on 8 October 2026 it turned against a speech-engine DLL that had loaded the day before, and that component had to be replaced. A file signed with a certificate chaining to the Microsoft Trusted Root Program is allowed even without reputation ([Smart App Control for developers](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview)).
  - **Certificate:** an OV code-signing certificate (about $150–300 a year, key on a hardware token or cloud HSM, RSA). Azure Artifact Signing is open to individuals only in the USA and Canada ([code signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)).
  - **Files to sign** (unsigned today): `koffi.node` (`@koromix/koffi-win32-x64`), `sherpa-onnx.node`, `sherpa-onnx-c-api.dll`, `sherpa-onnx-cxx-api.dll`, `onnxruntime.dll` and `onnxruntime_providers_shared.dll` (all in `sherpa-onnx-win-x64`). Already signed: `node.exe` (OpenJS Foundation).
  - **Distribution:** signing changes the bytes, so the signed copies are hosted by the project, and `assets/live-models.json` records both the upstream hash and the signed hash of each file.
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
