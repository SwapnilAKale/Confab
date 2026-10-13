# Confab

Local, offline dictation for Windows, with spoken replies from your coding agent when you ask for them.

- **Dictate anywhere.** Press a hotkey, speak, press again: the text is pasted into the box you were typing in. It is never sent with Enter, so you review it first. Terminals are the exception: there the text is copied to the clipboard instead (see [Terminals](#terminals)).
- **Talk-back.** Dictate with the talk-back hotkey and the agent's reply to that message is read aloud. Everything else stays silent.
- **Private.** Speech recognition and speech synthesis run on your PC. No audio or text leaves it.

Works with Claude Code, Codex, Cursor, Antigravity and other agents with lifecycle hooks (see [Supported agents](docs/SUPPORTED_AGENTS.md)), and with your own agent through a small HTTP call (see [Custom agents](docs/CUSTOM_AGENTS.md)).

## Requirements

- Windows 10 (version 1809 or later) or Windows 11, 64-bit.
- About 3 GB of free disk space during setup (1.2 GB once installed), and about 1.5 GB of memory while the speech models are loaded. They unload after 15 minutes without use.
- A microphone and speakers, and an internet connection for setup.

Nothing else: setup brings its own copy of Node.js. You don't need administrator rights, and setup changes no Windows security or firewall settings.

**Smart App Control.** Confab is not code-signed yet. On PCs where Windows' Smart App Control is turned on (Windows Security → App & browser control), Windows decides by reputation whether to let unsigned program files run, and it may block one of the speech engine's files. If that happens, the tray menu → **Diagnose…** names the blocked file. Confab never changes this setting for you.

## Install

1. Download this folder (for example **Code → Download ZIP** and unzip it) and open it.
2. Click the address bar of the folder window, type `powershell` and press Enter. A PowerShell window opens in the folder.
3. Run:
   ```powershell
   .\setup.cmd
   ```

Setup takes a few minutes. It:

- checks the PC and says plainly if something is missing;
- installs an official, signed Node.js for Confab's own use;
- downloads the speech models (about 1 GB) from their official sources and checks every file against the SHA-256 checksums in [`assets/live-models.json`](assets/live-models.json). If the download is interrupted, run `.\setup.cmd` again and it carries on where it stopped;
- installs Confab into `%LOCALAPPDATA%\Confab`, starts it, and starts it at every sign-in. **Confab** appears in the Start menu and in **Settings → Apps**;
- finds the coding agents on the PC and offers to connect each one.

If you start setup from a terminal inside another app (for example a coding agent's built-in terminal), it may continue in a new PowerShell window: some apps give their terminal a private copy of AppData, and Confab installed there could not start with Windows. The new window installs it normally. Its log is `%TEMP%\confab-setup.log`.

After setup you can delete the downloaded folder. Running setup again is safe: it repairs or updates the installation and never duplicates anything.

If setup stops partway (a lost connection, a closed window, a full disk), nothing is left half-updated. Each part (the uninstaller, Node.js, the app, its libraries) is prepared beside the installation and swapped in whole, so it is either as it was or completely new. Until setup finishes, Confab does not start; at sign-in it says that setup did not finish. Run `.\setup.cmd` again to complete it, or uninstall it: the uninstaller and its **Settings → Apps** entry are put in place first, so even an unfinished installation can be removed.

A Confab icon appears in the taskbar tray. Windows may put it under the **^** arrow; you can drag it onto the taskbar.

## Use

Click into any text box, in any app, then:

| Hotkey | What it does |
|---|---|
| **Ctrl+Shift+8** | **Dictate.** Press, wait for the beep and the red badge, speak, press again. The text is pasted into the box. |
| **Ctrl+Shift+7** | **Dictate with talk-back.** The same, with a purple badge. When you send that message to a connected agent, its reply is read aloud once. |
| **Ctrl+Shift+6** | **Cancel.** Discards a recording in progress, cancels a pending talk-back, and stops speech. |

- A small badge near the pointer shows what is happening: Starting…, Dictating, Talk-back, Transcribing, Pasted.
- If you click away while recording, the badge warns you. If the text can't be pasted into the same box, it is copied to the clipboard instead, and a notification tells you.
- The first dictation after start-up, or after 15 idle minutes, takes longer while the models load.
- Only the opening of a reply is read: its first paragraph, up to 3 sentences. Code, file paths, links and JSON are never read out.

**Tray menu** (click the icon): read-aloud mode (**Talk-back only** or **Off**), **Status badge near pointer**, **Pause hotkeys**, **Connect agents…**, **Diagnose…**, **Uninstall Confab…** and **Quit Confab**. After quitting, start it again from **Start → Confab**.

### Terminals

Confab does not type into terminal windows. In Windows Terminal, PowerShell and Command Prompt windows, the dictated text is copied to the clipboard instead, with a notification; check it and paste it with **Ctrl+V**. This applies to agents that run there too, such as the Claude Code, Codex or Gemini CLI. Dictation never lands in a shell command or an agent's terminal prompt by surprise.

The terminal panels inside VS Code and Cursor are different: Confab pastes there directly, so dictating to an agent CLI in those panels works like any other box. The text is never sent with Enter. Those panels don't let Confab read their text back to confirm the paste, so it keeps the text on the clipboard as a backup; if the badge says **Pasted** but nothing arrived, press **Ctrl+V**.

To dictate to an agent, use its app or its chat panel in the editor (the Claude app, the Codex app, Cursor's or VS Code's agent panel). Dictation pastes there directly.

## Connect your agents

Dictation works in every app with no setup. Talk-back needs a small hook in each agent, so that Confab can see which message was dictated and what the reply was.

Open the tray menu → **Connect agents…**. The window lists the supported agents and shows each one as:

- **Not installed**, or **Installed – not connected**: click **Connect**.
- **Connected**: talk-back works. **Disconnect** removes the hook and puts the agent's settings back as they were.
- **Connected – needs restart**: the agent was already running when you connected it. Restart it as the window says.
- **Needs action**: something to do in the agent itself, spelled out in the window. Codex, for example, runs a new hook only after you trust it: in the Codex app or VS Code extension, open **Settings → Hooks** and click **Trust all**; in the Codex CLI, type `/hooks` and press `t`.

Connecting changes only Confab's own entries, keeps a backup of the agent's file, and never needs the agent to be reinstalled or updated. See [Supported agents](docs/SUPPORTED_AGENTS.md) for what each agent supports.

Your own agent can use talk-back too, with the small Python or Node client described in [Custom agents](docs/CUSTOM_AGENTS.md).

## Uninstall

Any of these does the same:

- Tray menu → **Uninstall Confab…**
- **Settings → Apps → Installed apps → Confab → Uninstall**
- In PowerShell:
  ```powershell
  powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Confab\uninstaller\uninstall.ps1"
  ```

It asks whether to keep the downloaded speech models (to reinstall later without downloading them again) or delete them, then shows its progress and a summary. It removes the hook in every agent it connected, restoring each agent's settings; the background service, its sign-in entry, the Start menu and Settings entries; and the app, its Node.js and your Confab settings.

It works in an order that never leaves Confab half-removed:

- It first checks, changing nothing, that every agent's settings file can be restored. If one cannot (it is open in another program or is not valid), it stops and says which file, and Confab stays installed and working.
- Agents are disconnected before anything else is removed.
- Before deleting any file it moves every folder aside, which fails if a file is in use. Then it puts everything back and says which folder is in use; nothing has been deleted.
- The **Settings → Apps** entry and the uninstaller itself are removed last. If an uninstall stops for any reason, Confab no longer starts, and **Settings → Apps → Confab → Uninstall** finishes the job.

## Settings

Settings live in `%LOCALAPPDATA%\Confab\resident\settings.json`. The tray writes some of them. To edit the file, quit Confab first.

| Setting | Default | Meaning |
|---|---|---|
| `readMode` | `"talkback"` | `"talkback"` or `"off"`. |
| `hotkeys` | see above | `{"capture": "Ctrl+Shift+8", "talkback": "Ctrl+Shift+7", "disarm": "Ctrl+Shift+6"}`. Ctrl+Shift plus a letter, number, F1–F24 or Space. |
| `spokenSentences`, `spokenChars` | `3`, `400` | How much of a reply is read. `0` and `0` reads the whole reply. |
| `dateOrder` | `"dmy"` | How ambiguous dates such as 07/10/2026 are read: day first (`"dmy"`) or month first (`"mdy"`). |
| `modelsIdleMs` | `900000` | Unload the models after this many idle milliseconds. |
| `talkbackCapMs` | `7200000` | A talk-back still unused after this long is cleared (10 minutes to 24 hours). |
| `badge` | `true` | Show the status badge near the pointer. |
| `vad` | see below | How speech is found in the recording: `{"threshold": 0.3, "preSpeechSeconds": 0.75, "minSilenceSeconds": 0.5}`. |

The `vad` values tune the speech detector (Silero VAD). Leave them alone unless dictation misbehaves, and change one at a time:

| Value | Default | Range | Raise it if… | Lower it if… |
|---|---|---|---|---|
| `threshold` | `0.3` | 0.05–0.95 | background noise (fans, typing) gets transcribed as words | soft or quiet speech is missed |
| `preSpeechSeconds` | `0.75` | 0–2 | the first word of a dictation is cut off | (rarely needed) a noise just before you speak is transcribed |
| `minSilenceSeconds` | `0.5` | 0.1–2 | words around short pauses are dropped or garbled | (rarely needed) |

A pause only ends your dictation's current sentence group after about 2 seconds, whatever `minSilenceSeconds` is, and pressing the hotkey again always ends the recording. Quit Confab before editing `settings.json`, then start it again.

## Troubleshooting

Start with the tray menu → **Diagnose…**. It checks the speech models, the speech engine, the background service, the hotkeys and each connected agent's hook, and says in plain words what is wrong and what to do.

- **No tray icon:** start Confab from **Start → Confab**. If it still doesn't appear, run setup again (`& "$env:LOCALAPPDATA\Confab\app\setup.cmd"`); it repairs the installation.
- **Nothing happens on a hotkey:** hotkeys may be paused (tray menu), or another program holds the shortcut. Confab names it in a notification and takes the key back when it is free.
- **"Failed" badge:** the notification says why, for example an unavailable microphone.
- **Dictation in a terminal went to the clipboard:** that is by design; Confab does not type into terminal windows (see [Terminals](#terminals)). Paste it with Ctrl+V, or dictate into the agent's app or chat panel.
- **A reply was not read:** it is read only if you dictated the message with Ctrl+Shift+7 and the agent is **Connected** in **Connect agents…**. An agent that shows **needs restart** or **needs action** isn't running the hook yet.
- **Connected, but the agent never calls Confab** (Diagnose shows "No hook call recorded yet"): the agent may still be running without its hooks loaded, for example right after it updated itself. Quit and reopen the agent. In Codex, **Settings → Hooks** should then list three Confab hooks.
- **Setup stopped:** it says why. Fix that and run it again; it carries on where it stopped.
- **Logs:** `%LOCALAPPDATA%\Confab\resident` holds `requests.jsonl` (each talk-back decision), `hooks.jsonl` (each hook call) and `resident-error.log`. They never contain your prompts or replies.

## For developers

To run from a checkout instead of installing: `npm install`, then `npm start`. `npm test` runs the tests. `node scripts/agent-hooks.cjs install <agent>` connects an agent from the command line, and `node scripts/agents.cjs list` shows what the tray shows. See the [developer guide](docs/DEVELOPER_GUIDE.md).

## Licence

Confab's own code is released under the [MIT licence](LICENSE): free to use, change and share, with no warranty. The speech models and libraries it uses are not part of this licence; they keep their own, listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Setup downloads the models from their publishers, and they are not stored in this repository.
