# Local Voice

Local, offline dictation for Windows, with spoken replies from your coding agent when you ask for them.

- **Dictate anywhere.** Press a hotkey, speak, press again: the text is pasted into the box you were typing in. It is never sent with Enter, so you review it first.
- **Talk-back.** Dictate with the talk-back hotkey and the agent's reply to that message is read aloud. Everything else stays silent.
- **Private.** Speech recognition and speech synthesis run on your PC. No audio or text leaves it.

Works with Claude Code, Codex, Cursor, Antigravity and other agents with lifecycle hooks (see [Supported agents](docs/SUPPORTED_AGENTS.md)), and with your own agent through a small HTTP call (see the [developer guide](docs/DEVELOPER_GUIDE.md)).

## Requirements

- Windows 10 or 11, x64.
- [Node.js](https://nodejs.org) 22 or later, on PATH.
- About 1.3 GB of disk for the speech models, and about 1.5 GB of memory while they are loaded. Models unload after 15 minutes without use.
- A microphone and speakers.

## Install

A one-step setup command is planned (see the [roadmap](docs/ROADMAP.md)). Until then:

1. Put this folder where it will stay, for example `Documents\local-voice`. Moving it later means running the install again.
2. In the folder, install the two dependencies:
   ```bash
   npm install
   ```
3. Download the speech models into `assets/`. The exact files, sources and SHA-256 checksums are in [`assets/live-models.json`](assets/live-models.json):
   - **Parakeet TDT 0.6B v2 int8** (recognition): extract [sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2) into `assets/models/`.
   - **Kokoro multi-lang v1.0** (speech): extract [kokoro-multi-lang-v1_0.tar.bz2](https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2) into `assets/models/`.
   - **Moonshine medium streaming** (speech segmenting): download the eight files listed under `moonshine-medium-streaming-en` in `assets/live-models.json` into `assets/models/moonshine-medium-streaming-en/`.
   - **Moonshine engine**: download the `moonshine_voice-0.1.5-py3-none-win_amd64.whl` file from [PyPI](https://pypi.org/project/moonshine-voice/0.1.5/#files), and unzip it (it is a zip file) into `assets/moonshine-engine/`.
4. Start Local Voice at every login, and now:
   ```bash
   npm run install-resident -- -StartNow
   ```
   This adds a login entry and a **Local Voice** Start menu shortcut for your Windows user only. No administrator rights are needed.

A Local Voice icon appears in the taskbar tray. Windows may put it in the overflow area; you can pin it.

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

**Tray menu:** read-aloud mode (**Talk-back only** or **Off**), **Status badge near pointer**, **Pause hotkeys** and **Quit Local Voice**. After quitting, start it again from **Start → Local Voice**.

## Connect your agents

Talk-back needs a small hook in each agent, so that Local Voice can see which message was dictated and what the reply was. One command adds it, and one removes it:

```bash
node scripts/agent-hooks.cjs install claude-code
```

```bash
node scripts/agent-hooks.cjs uninstall claude-code
```

Replace `claude-code` with `codex`, `cursor`, `antigravity`, `gemini`, `windsurf`, `cline`, `continue` or `goose`. The command changes only Local Voice's own entries, backs up the agent's file first, and stops with nothing changed if the agent is missing or too old. Codex asks you to trust a new hook once: **Settings → Hooks → Trust all**. See [Supported agents](docs/SUPPORTED_AGENTS.md) for what each agent supports.

Dictation itself needs no setup: it works in any app.

## Settings

Settings live in `%LOCALAPPDATA%\LocalVoice\resident\settings.json`. The tray writes some of them. To edit the file, quit Local Voice first.

| Setting | Default | Meaning |
|---|---|---|
| `readMode` | `"talkback"` | `"talkback"` or `"off"`. |
| `hotkeys` | see above | `{"capture": "Ctrl+Shift+8", "talkback": "Ctrl+Shift+7", "disarm": "Ctrl+Shift+6"}`. Ctrl+Shift plus a letter, number, F1–F24 or Space. |
| `spokenSentences`, `spokenChars` | `3`, `400` | How much of a reply is read. `0` and `0` reads the whole reply. |
| `dateOrder` | `"dmy"` | How ambiguous dates such as 07/10/2026 are read: day first (`"dmy"`) or month first (`"mdy"`). |
| `modelsIdleMs` | `900000` | Unload the models after this many idle milliseconds. |
| `talkbackCapMs` | `7200000` | A talk-back still unused after this long is cleared (10 minutes to 24 hours). |
| `badge` | `true` | Show the status badge near the pointer. |

## Uninstall

1. Remove the agent hooks, one per agent you connected:
   ```bash
   node scripts/agent-hooks.cjs uninstall all
   ```
2. Stop Local Voice and remove its login entry and Start menu shortcut:
   ```bash
   npm run uninstall-resident
   ```
3. Delete this folder. To also delete your settings and logs, delete `%LOCALAPPDATA%\LocalVoice`.

A single uninstall command is planned.

## Troubleshooting

- **Nothing happens on a hotkey:** check the tray icon is there and hotkeys are not paused. Another program may hold the shortcut; Local Voice names it in a notification and takes it back when it is free.
- **"Failed" badge:** the notification says why, for example an unavailable microphone.
- **A reply was not read:** it is read only if you dictated the message with Ctrl+Shift+7 and the agent's hook is installed. The logs in `%LOCALAPPDATA%\LocalVoice\resident` show what happened: `requests.jsonl` (each decision) and `hooks.jsonl` (each hook call). They never contain your prompts or replies.

## Licence

The Local Voice code in this repository is not yet published under an open-source licence. The speech models and libraries it uses keep their own licences; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
