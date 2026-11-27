# Developer guide

For anyone connecting an agent to Confab, adding support for a new agent, or working on Confab itself.

- [How it fits together](#how-it-fits-together)
- [Custom agents](CUSTOM_AGENTS.md): read your own agent's replies aloud (its own page)
- [Adding an agent](#adding-an-agent) with lifecycle hooks
- [Hotkeys](#hotkeys)
- [What is spoken](#what-is-spoken) and [Pronunciation](#pronunciation)
- [Working on Confab](#working-on-confab)

## How it fits together

```text
 hotkey ─▶ resident service (tray app, src/pc/resident.cjs)
            ├─ microphone ─▶ Silero VAD (segments) ─▶ Parakeet (text) ─▶ paste into the focused box
            ├─ talk-back gate: remembers the talk-back draft, matches it against reported turns
            └─ reply ─▶ reply-text rules ─▶ Node normaliser ─▶ Kokoro ─▶ speakers
                 ▲
 agent hooks ─▶ src/adapters/hooks/adapter.cjs ─┐
 custom agent ─▶ src/pc/client.cjs or confab.py ─┴─▶ POST http://127.0.0.1:<port>/event
```

- **Resident service** (`src/pc/`): one process per Windows user, started at login. It owns the tray, the global hotkeys, the badge, audio, and a loopback HTTP endpoint. Speech models load in worker processes on first use (`src/service/native-engine.cjs`, `src/speech-worker.cjs`) and unload after 15 idle minutes. The service and every speech worker opt out of Windows power throttling at start (`src/power.cjs`): Windows 11 runs windowless processes on the efficiency cores at low clock speed, which made Kokoro about 5 times slower (real-time factor 1.3-2.0 instead of 0.39-0.50, measured 23 November 2026 on an i5-13420H on mains power). `/health` reports `powerThrottlingOff` for the service and `speechPowerThrottlingOff` for each speech process once it has started (`tts`, `asr`, `decode`, `vad`); each worker includes the result in its `ready` message.
- **Input** (`src/input/`): `RegisterHotKey` hotkeys (no keyboard hook), clipboard paste with one Ctrl+V (followed by one Enter only in voice mode, after the paste is read back) and clipboard restore, and a UI Automation helper that identifies the focused box.
- **Agent hooks** (`src/adapters/hooks/`): one adapter program plus a mapping file per agent; `install.cjs` writes and removes the hook entries. The Claude Code plugin lives in `src/adapters/claude-code/`.
- **Profile** (`%LOCALAPPDATA%\Confab\resident\`): `auth.json` (token), `endpoint.json` (port, while running), `settings.json`, `drafts/`, and the logs `requests.jsonl` and `hooks.jsonl`. The installer limits the folder to the current user and SYSTEM.

## Custom agents

Connecting your own agent to talk-back is described on its own page: [Custom agents](CUSTOM_AGENTS.md), with every detail in the [Custom agents reference](CUSTOM_AGENTS_REFERENCE.md).

## Adding an agent

For an agent with lifecycle hooks (a command run when a prompt is submitted and when a turn finishes):

1. **Try it with no mapping file.** The default mapping ([`mappings/default.json`](../src/adapters/hooks/mappings/default.json)) handles the common conventions:
   - event name in `hook_event_name`; turn events `UserPromptSubmit` / `BeforeAgent`; reply events `Stop` / `AfterAgent`; detach on `SessionEnd`
   - prompt in `prompt`; reply in `last_assistant_message` or `prompt_response`
   - session in `session_id`, `conversation_id` or `conversationId`; turn id in `turn_id`

   Register `node <folder>/src/adapters/hooks/adapter.cjs <name>` for the agent's prompt and reply events. `<name>` becomes the agent name.
2. **Check `hooks.jsonl`** in the profile folder. A `missing` field or a `kind: null` event shows what differs.
3. **Add `src/adapters/hooks/mappings/<name>.json` with only the differences.** Each key under `events` and `fields` replaces the default list for that key.

   | Key | Meaning |
   |---|---|
   | `agent` | Agent name sent to the service (default: the file name). |
   | `input` | `"stdin"` (default) or `"argv"` (the payload is the last command-line argument). |
   | `eventField` | Payload fields holding the event name. Empty when the event comes from the command line (`adapter.cjs <name> <Event>`). |
   | `events.turn` / `events.reply` / `events.candidate` / `events.end` / `events.detach` | The agent's event names for prompt submitted, turn finished, every assistant message, turn ended, session closed. A reply event that also carries the prompt reports its turn first. |
   | `fields.prompt` / `reply` / `session` / `turn` / `transcript` | Payload field names; the first one found wins. A prompt may be a string or an array of strings. |
   | `transcript` | Name of a reader in `transcripts.cjs`. Use it only when the hooks carry no text. |
   | `skipIf` | Payload fields whose presence means the call belongs to another agent (for example `cursor_version`). |
   | `repairEncoding` | `"cp1252"` repairs text that a Windows PowerShell pipe mis-decoded. |
   | `ignore` | Events the agent sends for other purposes; they are not logged. |
   | `stdout` | Exact text to print per event name (or `"*"`), for agents that require an acknowledgement. Default: nothing. |
   | `install` | Where the hook is registered: `requires` (the support check: `name`, `binaries` (`~` and `%VAR%` expanded, `*` matches a folder entry, `PATH:name` searches PATH, `APPX:<package>:<file>` is a file inside an installed Microsoft Store app, looked up only when nothing else was found), `marker`, `needs`), `file`, `format` (`nested` = Claude/Codex style, `flat` = Cursor style, `group` = Antigravity style, `files` = one script per hook), `events` with their timeout/async settings, optional `top`, `group`, `eventArg`, `after`, `trust`. |

4. **Add sample payloads** in `test/fixtures/hook-payloads/<name>.json`: a `source` line saying where the shapes came from, and `cases` with `payload`, the expected `expect` messages, and optional `missing` and `stdout`. `test/agent-hooks.test.cjs` runs every fixture file and fails if a mapping has none. It also runs each installed command the way the agent's shell would.
5. **Add the agent** to the list in `scripts/agent-hooks.cjs` and to [SUPPORTED_AGENTS.md](SUPPORTED_AGENTS.md), marked "Sample payloads" until it is tested live.

**Rules every hook keeps:** always exit 0; print nothing the agent would treat as output; act on the first JSON object and never wait for end of stdin; exit within 1.5 s. The adapter does all of this, so a mapping file is enough.

## Hotkeys

Keep this table current whenever a shortcut changes. All hotkeys use `RegisterHotKey` (no keyboard hook). Each key belongs to whichever process registers it first. The tray menu shows the live keys.

| Key | Active when | What it does |
|---|---|---|
| **Ctrl+Shift+8** | Service running, hotkeys not paused. | **Plain dictation.** First press: grey **Starting…** badge at once, playback stops and the microphone opens. When capture is live, the badge turns red (**● Dictating**) with the start beep. Audio is buffered while models load. The box focused at the press is the target; if focus leaves it, recording continues and the badge warns **⚠ Focus moved — click back to paste here**. Second press, or Ctrl+Shift+7: stops (**… Transcribing**), then pastes without Enter into the target box (**✓ Pasted**). If the box can't be proven the same: **⧉ Not pasted — copied**, the text is on the clipboard, plus a notification. Never causes a spoken reply. |
| **Ctrl+Shift+7** | Same. | **Talk-back dictation.** Same as Ctrl+Shift+8 with a purple **◆ Talk-back** badge. The draft is kept until its reply, Cancel or a newer talk-back (2-hour cap), and the turn it becomes owns one spoken reply. The key that **starts** a recording sets its mode; either key stops it. |
| **Ctrl+Shift+6** | Same. `"voice": "off"` turns it off. | **Voice mode** (toggle). The input checks the focused box first (it must be editable, as for dictation) and keeps it as the target until voice mode ends. One capture stays open on a communications-category WASAPI stream (`IAudioClient2::SetClientProperties`, `AudioCategory_Communications`, ducking opted out), so the driver's echo cancellation applies; `/health` reports `voice.echoCancel`. Each turn the speech detector ends (1.2 s of silence in voice mode, `VOICE_SETTLE` in `src/turn-settings.cjs`, asked for with `engine.start(id, emit, {voice: true})`; dictation keeps 2.2 s; 24 s pieces are joined) is given to the talk-back gate as the dictation, then pasted and sent with Enter (`insert(text, true)`): **➤ Sent**. A box that can't be read back (the terminal panels of VS Code and Cursor) gets the paste without Enter; terminal windows are refused as for dictation, so the turn goes to the clipboard. Replies play while it listens. Barge-in (`src/pc/self-echo.cjs`): while a reply is prepared or played, it stops when the detector reports speech **and** at least 12 of the last 30 20-ms microphone frames (about 0.24 s within 0.6 s) are the user. A frame is the user when it is 3 times louder than the quietest fifth of the frames heard while Confab was silent (and at least RMS 0.005), pitched (normalised autocorrelation of its last 40 ms at least 0.45 at a lag of 2.5-12.5 ms, and of its own 20 ms at least 0.35 at a lag of 2.5-10 ms, so a cough's first frames do not borrow the pitch of a grunt before it: speech scores about 0.9; a cough or click scores about 0.17 on average, and only a stray slice reaches the bar), and, while Confab's output may be sounding, at least 1.5 times the echo predicted from that output (the loudest output frame within 20 ms of the delayed time, times the gain). Confab records the loudness of everything it plays (20 ms frames on a timeline); from the microphone frames of the first 1.6 s of each reply (0.6 s of output plus the longest echo delay tried, 1 s: on the development PC the echo came back after about 460 ms, at the edge of the former 480 ms limit) it learns the echo delay (0-1000 ms, by correlating the microphone's log level with the delayed output over every frame of that window, counting the time before the reply began as silence, so a wrong long delay is not judged on a few lucky frames; the shortest delay whose fit is within 0.05 of the best, because a reply with a steady rhythm also fits one beat late) and gain (the 65th percentile of microphone/output ratios where the output is loud; the median learnt it 25-30% low for some replies, which then interrupted themselves); frames in that window never count as the user, so about the first 1.6 s of the first reply cannot be interrupted; once a delay has been learnt with a good fit (correlation at least 0.6), later replies wait only 0.6 s plus that delay plus 0.2 s (about 1.3 s with a 460 ms echo), and a poor fit brings back the full 1.6 s. If such a shortened window finds no good fit, or a delay more than 100 ms from the known one, the reply is "unsure": the learnt values are kept but marked as a poor fit, nothing counts as the user until that reply's echo could have died away at the longest delay (only the keys stop it), and the next reply learns with the full window. Without this, a longer echo after a device change (120 -> 600 ms, 200 -> 800 ms) made the second reply interrupt itself (25 of 180 simulated replies); with it, none did. The cost: a user who starts talking within about the first second of a later reply can make it unsure, and then only the keys stop that reply (missed in 5 of 108 simulated runs at 3 times the echo's loudness, against 1). Once a gain is known, learning samples more than 3 times it are left out (a user talking during a later reply's learning window made the echo seem about 3 times louder and was then never caught), unless that leaves fewer than half of them, so turning the volume up 3 times between replies is still learnt (no self-interruptions with volume x3 or x0.3). Delay and gain carry over to the next reply until it refreshes them. On simulated speaker echo (`test/pc-self-echo.test.cjs`): no echo-only run interrupts (180 runs: 20 replies, echo gain 0.1-1.5, delay 30-300 ms; also 0 of 2,000 in a wider run of 100 more replies); no cough interrupts (24 runs, 0.3-0.9 s, 1-2 bursts, at 3 and 10 times the echo), nor one that starts with a voiced grunt (speech-like up to 0.2 s, a steady "uhh" up to 0.17 s, and the measured 0.2 s cases; a very loud steady 0.2 s "uhh" still can, about 1 in 100), while a steady 0.5 s voice or 0.6 s of speech does; and a voice talking over the reply interrupts with a median of about 0.6 s (108 runs per loudness, echo gain 0.05-1, delay 40-400 ms): the test allows at most 3.5 s at 1.5 times the echo's loudness, 1.7 s at twice and 1.4 s at 3 times (measured: 3.2, 1.58 and 1.26 s; the 3.2 s case is a voice 1.5 times an echo of gain 0.05, barely above the room noise, slowed by the longer learning window; the next slowest at 1.5 times is 1.78 s). A turn during which the user interrupted is never dropped as echo: of its words that began more than 0.4 s before the interruption was detected (by the recogniser's word times; without them, by the share of the turn's duration), the longest leading run of the reply's own words is trimmed and the rest is sent, so words the user says after starting are kept even when the reply said them too. An interrupted reply goes on when nothing was said (`resumePoint`, `turnHeard` in `src/pc/controller.cjs`): the interruption keeps where the reply was when the user started talking (0.4 s before it was detected), from where each synthesized piece started playing. When the turn that follows comes back empty, is dropped as echo or falls in a mute, and no speech was reported in the last 0.6 s, the rest is read from the start of the sentence that was playing (a reply not yet playing, and replies queued behind it, are read whole); if no turn comes back, it goes on after 2.5 s without speech. A turn that is pasted keeps it stopped, and stops a reply that already went on; a new reply, a key press or ending voice mode drops it. No tick plays when it goes on. `/health` reports `voice.resumePending` and `metrics.resumed`. The detector's own timings are not used: its first activity already includes the 0.75 s pre-speech and it reports 0.5 s of hang-over after any sound. Windows echo cancellation (the communications stream) is requested but not required. `"voiceInterrupt": false` turns barge-in off; only the keys stop a reply then (badge **press Cancel to stop**). In voice mode a reply's first piece is at most 30 characters (50 otherwise): at a natural pause if there is one, else at the last word break (any whitespace) within 30 characters, even after a single short word; a first word longer than 30 characters is spoken on its own, and pieces are trimmed. `/health` reports `voice.selfEcho` (learnt delay and gain). A turn heard during a reply, or within 3 s after it, whose words are at least 70% the reply's words (for one or two words: contained in the reply while it still plays) is echo and is dropped. Second press (or Ctrl+Shift+8 or 7): the reply being read stops and the pending talk-back is cancelled, the microphone closes, speech already heard is pasted without Enter and without talk-back (also a turn whose paste is under way: `insert` skips its Enter once voice mode has ended, reason `voice_ended`), then voice mode ends. Ends by itself after 10 minutes without speech (limit cue). While it is on, 8 and 7 end it too, like a second press of the voice key (even while a turn is being pasted). The target box is the same box while its window, element and document stay the same; the first changed window title within 15 s after one of its own sends is taken as the app naming the chat (the Claude app retitles "New chat") and adopted; any other title change (a second one, or a later one) means another chat. |
| Cancel | **Off by default.** Turn it on with `"hotkeys": {"disarm": "Ctrl+Shift+0"}`. | **Cancel.** In voice mode it also ends voice mode and discards speech not yet sent. At any point (starting, recording, focus moved, transcribing): discards the recording, so nothing is pasted or copied. Also cancels the pending talk-back, stops playback, clears queued replies and forgets the target box. Text already in that box is never erased: the only keystrokes Confab sends to a box are the Ctrl+V of a paste and, in voice mode, the Enter after a confirmed paste. Cancel also works while a voice turn is being pasted: it clears the target, so that paste gets no Enter. Two-tone falling cue when something was cancelled; otherwise a soft tick. |
| Ctrl+Shift+9 | **Off by default.** Turn it on with `"hotkeys": {"arm": "Ctrl+Shift+9"}`. | **Arm text box.** Targets the focused editable box without recording. Rarely needed, because 8 and 7 target the box themselves. |

Keys can be changed in `settings.json` (quit first): `"hotkeys": {"capture": "Ctrl+Shift+8", "talkback": "Ctrl+Shift+7", "voice": "Ctrl+Shift+6", "disarm": "off", "arm": "off"}`. Hotkey ids are positional: arm 1, capture 2, disarm 3, talk-back 4, voice 5. Use Ctrl+Shift plus a letter, number, F1–F24 or Space. If another program holds a key, the service keeps its other keys, names the missing ones in a notification, retries every 15 seconds, and lists them as `hotkeysUnavailable` in `/health`.

**Feedback details:**
- The badge shows Starting… within about 150 ms. It turns red or purple, and the beep plays, only when Windows has created the capture stream: typically 0.6–0.8 s after the press. Creating any Windows audio stream (`IAudioClient::Initialize`) takes 380–660 ms on typical hardware.
- Capture uses WASAPI through koffi (`src/pc/wasapi-audio.cjs`), with WinMM as the fallback. The microphone stream is created per recording and closed afterwards. Output streams stay initialized and stopped, so cues start within milliseconds.
- Badge states: ○ Starting…, ● Dictating, ◆ Talk-back, ⚠ Focus moved, … Transcribing / Transcribing — loading models…, ✓ Pasted, ⧉ Not pasted — copied, ✕ Failed (the reason is in a notification), … Preparing reply, ♪ Speaking.
- **Same box** means the same top-level window, the same UI Automation element runtime id, and the same containing document (runtime id and title). A recreated element or another browser tab counts as a different box, and the text is copied, never pasted.
- After a verified paste the previous clipboard is restored, unless another app changed it meanwhile. A changed focus, a locked desktop or active typing never triggers an automatic retry; the draft is left on the clipboard. If clipboard access itself fails, the draft is saved under `drafts/` in the profile.

## What is spoken

Only the **opening** of a reply is read: the first prose paragraph, at most 3 sentences or 400 characters. A heading at the very start is skipped, and the opening stops at the next heading, list, table, quote or code. Opening sentences that can't be spoken are dropped one by one. "Full reply on screen." is added when anything was left out, and "The reply is on screen." is said if nothing in the opening can be spoken (an empty reply is silent). `spokenSentences` / `spokenChars` change the limits (0 and 0 = the full reply). The tray's **Read full reply** (`fullReply`, off by default) reads the full reply whatever the limits. Lead a reply with a short plain-language summary and it is the part that is heard. The rules are in `src/pc/reply-text.cjs`.

**Code, paths, links and data are described or said in a short form** (`softenReply` in `src/pc/reply-text.cjs`), in the opening and in the full reply alike, so none of them silences a reply. A description is built from the text alone (no model), so the same block is always described the same way:

| In the reply | Said as |
|---|---|
| A fenced code block | its language (from the fence's tag, or guessed), its size and up to three names it defines: "Python code, six lines, defining load config and save config." An unknown tag is said as the language ("Elixir code, two lines."); with no tag and no guess, "Code, one line." |
| A shell block (`bash`, `powershell`, `cmd`, ... or untagged lines that all start with a command) | one short plain command as it is ("npm test."); else the programs it runs: "A docker command.", "Commands for git and npm, three lines." PowerShell cmdlets are said as words ("get child item"). |
| A JSON block, or a line that is JSON | its first three keys: "Data with name, version, scripts and one more."; a list: "A list of three items." |
| A YAML, TOML or settings block | "YAML, four lines, with name, version and models." |
| An output, log or text block | "Output on screen, two lines." / "Text on screen, two lines." |
| A unified diff, fenced or not | the files it changes and the lines added and removed: "Changes to controller dot cjs: two lines added, one line removed." |
| A stray line of code in prose (a code keyword or shell command at its start, `$ `, curly braces, operators such as `===`, `=>`, `&&`, `::`, a statement ending in `;` with `=`) | "Code on screen." (once for a run of them) |
| A URL (`http://`, `https://`, `www.`); a markdown link keeps its text | "a link" |
| A file path: a drive path (`C:\...`), a network path, a path starting with `~`, `.` or `/`, a path with a file extension or three or more separators, or a file name with a code or config extension | its file name: `src/pc/reply-text.cjs` is "reply text dot cjs", `C:\Users\A\Desktop` is "Desktop". Punctuation after a path (`.`, `,`, `?`, `;`, `:`, `!`) stays part of the sentence. |
| A function named in prose (`parse_log()`) | its name ("parse log") |
| Inline code: plain words, key names (`Ctrl+Shift+5`), identifiers (`voiceUnits`); a path; a command; anything else (`max_sets=5`) | the words; the file name; a short plain command as it is (`npm test`), a longer one as "the npm command"; "the code on screen" |

Counts up to twelve are said as words. A fence that is never closed (a reply cut short) runs only to the next blank line, so the prose after it is still read; a stray ``` in prose is dropped rather than treated as code. Words with slashes (`push/pull`, `km/h`, `sets/reps/RPE`), dates (`10/04/2026`) and versions (`2.4.1`) are not paths. When nothing else is left (a reply that is only stray code lines), "The reply is on screen." is said. A reply longer than 5,000 characters after normalisation is read up to that point, ending at a sentence, followed by "Full reply on screen.". A reply that is empty, or has nothing that can be said, is refused in both modes (`display_only`, `empty`) and nothing is spoken.

**Rewritten, then spoken:**

| Input | Spoken as | Rule |
|---|---|---|
| `**bold**`, `*it*`, `__b__`, `_i_`, `~~s~~`, `` `Lat Pulldown` `` | `bold`, `it`, ... | Emphasis and plain-word inline code are unwrapped. `snake_case` words are untouched. |
| `# Heading` | `Heading.` | When the full reply is read (`0` and `0`), or the reply is only a heading, the heading becomes its own sentence. With the default limits, a heading at the start is skipped and a later one ends the opening. |
| `> quote`, `---` | `quote` | Blockquote markers and horizontal rules are removed. |
| `[text](url)` | `text` | Link text only. |
| `\| a \| b \|` | `a, b.` | Table cells become pauses. Separator rows are dropped. |
| line-start `- x`, `* x`, `+ x`, `• x`, `1. x`, `1) x` | `x.` | List markers are removed; each item ends as its own sentence. |
| `Today's plan: 1. Squats 2. Bench 3. Rows` | `Today's plan: Squats. Bench. Rows.` | Inline numbered lists counting up from 1, opening the line or following a colon. |
| `growth [1].`, `[2, 3]` | `growth.` | Numeric citation brackets are removed. |
| `3 sets (RPE 8).` | `3 sets, RPE 8.` | Parentheses are **spoken** with a comma pause on each side. |
| `set(s)` | `sets` | The plural marker reads as the plural. |
| `Rest; eat.`, `Curl - 3 sets` | `Rest, eat.`, `Curl, 3 sets` | Semicolons and spaced dashes become comma pauses. |
| `5 * 3`, `5×3` | `5 times 3` | A multiplication sign between numbers. |
| `RPE 8/10`, `rated it 4/5` | `RPE 8 out of 10`, ... | `N/5`, `N/10` or `N/100` reads "out of" next to a rating word (`RPE`, `rating`, `rated`, `score`, `scale`, `effort`, `intensity`, `difficulty`, `pain`, `soreness`, `fatigue`, `energy`, `mood`, `sleep`, `confidence`). |
| `sets/week`, `12 km/h`, `reps/set` | `sets per week`, `12 km per hour`, ... | **per** before a singular time unit or count unit. |
| `1.6 g/kg` | `1.6 g per kg` | **per** for a dose over body mass. |
| `push/pull`, `lbs/kg` | `push or pull`, ... | **or** for every other word/word pair. |
| `w/`, `w/o`, `and/or`, `N/A` | `with`, `without`, `and or`, `not applicable` | Fixed phrases. |

Known ambiguities: `sets/reps` reads "sets or reps"; a plural after a slash reads "or"; a rating-like ratio without a rating word (`8/10 of the way`) stays a fraction.

Each reply is synthesised a sentence at a time and played through one continuous audio stream. Playback starts once the buffered audio covers the estimated remaining synthesis time, so pauses fall only between sentences.

## Pronunciation

After the rules above, the Node normaliser (`src/pc/spoken-normalizer.cjs`, no dependencies) spells out numbers, ordinals, decimals, ranges, dates, times, units, money, percentages and symbols: `130 lbs` is "one hundred thirty pounds", `2026-04-10` is "April tenth twenty twenty six", `$12.50` is "twelve dollars fifty cents", `3x10` is "three by ten".

**Checked against NeMo.** The reference is NeMo text processing r1.2.0's English test cases (`test/fixtures/nemo-reference`, Apache 2.0). 290 of 320 give the same spoken words, ignoring case, punctuation and NeMo's optional "and" after "hundred". `node scripts/compare-normalizer.cjs --diff` lists the rest, and `test/pc-spoken-normalizer.test.cjs` fails on any new difference.

**Where it differs from NeMo:**

| Input | NeMo | Confab | Verdict |
|---|---|---|---|
| `13000`, `123000` | digit by digit | thirteen thousand | Better |
| `2-5`, `from 2-10` | "two - five" | "two to five" | Better for ranges |
| `2x8` | two x eight | two by eight | Better (sets by reps) |
| `2+3 m2` | two plus three m two | two plus three square meters | Better |
| `4.4x` | four point four x | four point four times | Better |
| `80 s`, `3 cc/s` | eighty S, CC per S | eighty seconds, CC per second | Better |
| `$18081` | eighteen thousand and eighty one dollars | without "and" | Neutral |
| `1428 Elm St.` | fourteen twenty eight Elm Street | one thousand four hundred twenty eight Elm St. | Worse (addresses; rare in replies) |
| `2Q22`, `340 A.D`, `1795 / 1805` | second quarter of twenty two, three forty AD, a fraction | two Q twenty two, three hundred forty A.D, numbers with a slash | Worse (rare) |
| `C. S. Lewis`, `401(k)`, SSML tags | special handling | left as written | Neutral |

**Other choices:**
- No "and" after "hundred".
- Years are read as years after a date word ("in 1994"), standing alone, or in a year range. A count such as "1110 sets" stays a number.
- "x/y" is a fraction when proper ("3/4"), a date only with a leading zero ("10/04"). "24/7" reads "twenty four seven".
- An ungrouped run of more than 15 digits is read digit by digit.

**Durations and clock times** both use the m:ss form, so context decides.
- **Clock time:** with am/pm, or a clock word right before it (at, by, until, from, before, after, since, starts, opens, closes, wake). "6:30 PM" is "six thirty PM".
- **Duration:** with a duration cue just before it (rest, between sets, pace, split, lap, run, plank, hold, time, took, lasted, interval, finished, under, for, best, total, in, ...) or right after it (/km, per km, minutes, rest, pace, split, hold, between). "rest 1:30" is "rest one minute thirty", "2:00" is "two minutes", "0:45" is "forty five seconds", "1:05:30" is "one hour five minutes thirty seconds".
- **Neither cue:** read as a clock time. A value that can't be a time of day ("25:30") is a duration.
- **Both cues:** a clock word right before the time wins; otherwise duration cues win.

**Numeric dates** (07/10/2026, 07.10.2026):
- ISO (2026-10-07) is unambiguous: "October seventh twenty twenty six".
- A part above 12 settles the order: 25/12/2026 is day-first, 12/25/2026 month-first.
- Otherwise other unambiguous dates in the same reply decide; a reply with both orders settles nothing.
- Otherwise `dateOrder` in `settings.json` decides: `"dmy"` (default) or `"mdy"`.
- Day-first reads "the seventh of October twenty twenty six"; month-first reads "July tenth twenty twenty six".

## Working on Confab

```bash
npm install
```

```bash
npm test
```

- `npm test` runs every `*.test.cjs` in `test/` and `src/adapters/claude-code/test/`. Some tests load the real speech models from `assets/models/`, so download them first: `node scripts/models.cjs fetch` (the same downloader setup uses; `check --full` re-hashes every file). One test runs `src/pc/confab.py`, so Python 3.8+ should be on PATH.
- Setup and uninstall are `scripts/setup.ps1` and `scripts/uninstall.ps1`, started by `setup.cmd` and `uninstall.cmd`. The installed layout is `%LOCALAPPDATA%\Confab\app` (a copy of this folder with `node_modules` and the models), `runtime\node` (Node.js pinned in [`assets/runtime.json`](../assets/runtime.json)) and `resident` (the profile). The tray's windows are `src/ui/dialogs.ps1`; they call `scripts/agents.cjs` and `scripts/diagnose.cjs`, which you can also run directly.
- **Atomic setup and uninstall.** The shared helpers are in `scripts/windows-shell.ps1`. A named mutex (`Local\ConfabSetup`) lets only one setup or uninstall run at a time. `state.json` in the installation folder is `installing`, `ready` or `uninstalling`, and the launcher (`scripts/start-resident.ps1`) starts the service only when it is `ready` or absent. Setup first copies the uninstaller to `uninstaller\` and registers the **Settings → Apps** entry, which runs it with `-Gui`. Node.js, the app files and `node_modules` are then built in `staging\` and swapped in with `Install-Staged`, which renames each target to `*.old-xxxxxxxx` and undoes every swap if one fails. Uninstall runs `agents.cjs check-disconnect` (read-only) before `disconnect all`, then removes startup, stops processes, and renames every folder to `*.removing-xxxxxxxx` before deleting (a file in use stops it with all moves undone). It removes the Apps entry and its own folder last. `Remove-InterruptedLeftovers` clears staging and renamed folders left by an interrupted run. The tray and Settings → Apps open the same uninstaller windows (`-Gui`): confirmation, a progress window in its own process (it outlives the service), and a summary. `uninstall.cmd` runs the same steps in the console.
- `npm start` runs the service in the foreground from this folder (quit any installed copy first; only one runs per user).
- `node scripts/compare-normalizer.cjs --diff` compares the normaliser with the NeMo reference cases.
- Speech settings are built in. An optional `"speech"` object in `settings.json` overrides them: `ttsThreads` (default 6) and `modelRoot` (relative to this folder; default `assets/models`).
- Live models and their exact files are recorded in [`assets/live-models.json`](../assets/live-models.json). Update it when a model changes. When a piece is dropped, list its folder under `retired`: setup and uninstall delete retired folders from existing installations. Every download source names a commit (a test enforces it): a release archive or web page can be replaced upstream, and the pinned SHA-256 then fails every new install, as happened to Kokoro on 8 September and Parakeet on 7 November 2026.
- **Updating a model.** Models never update by themselves. `node scripts/check-model-updates.cjs` reports what was published after each piece's `watch.since` date: a newer revision of a pinned source in which a file Confab uses changed, and new models from the piece's `watch` list. It also runs on the 1st of every month on GitHub ([`.github/workflows/model-updates.yml`](../.github/workflows/model-updates.yml)); a failed run means something is new, and its summary lists it. GitHub pauses scheduled workflows after 60 days without a commit in a public repository, so each run first re-enables itself, which resets that clock. To try a candidate:
  1. Record your voice once with `record-test-voice.cjs`, then run `benchmark.cjs` on the current models for a baseline.
  2. Point the piece's `download` at the candidate's commit (`https://huggingface.co/<repo>/resolve/<commit>/`) and list its files with their sizes and SHA-256 (the Hugging Face API's `tree/<commit>` gives both for large files). A model with different files or a different type may also need changes in `src/parakeet.cjs` or `src/speech.cjs`.
  3. `node scripts/models.cjs fetch`, then run the benchmark again with the same clips.
  4. Keep it only if the word error rate is lower and it is no slower. Either way, set `watch.since` to the day of the review and note what was compared in `upstreamCheck`, so the same items are not reported again.
- **Speech detector.** `src/silero-segmenter.cjs` runs Silero VAD through sherpa-onnx and only marks where speech is; `src/context-turns.cjs` decides turns (a turn ends after 2.2 s of silence, or 1.2 s in voice mode, or at 24 s with 3 s of context overlap). Its three settings (`threshold`, `preSpeechSeconds`, `minSilenceSeconds`) come from the `vad` object in `settings.json` through `src/vad-settings.cjs`; the README lists them.
- **Tuning with your own voice.** `node scripts/record-test-voice.cjs` records 12 test dictations (short phrases, pauses of 1–3 s, fast speech, a soft first word, fillers) with the product's own microphone capture into `test-output/my-recordings`, one `.wav` and one `.txt` reference each. Pause the installed service's hotkeys first. Replay them through the detector and Parakeet to compare settings before changing a default.
- **Benchmark.** `node scripts/benchmark.cjs [--synthetic] [--mic]` measures the real dictation and read-aloud paths: it runs the service's controller and engine with recorded audio fed at real-time pace, and only the microphone, speakers and paste are stand-ins. It reports word error rate and stop-to-text time for the clips in `test-output/my-recordings` (or `--dir <folder>`), reply-to-first-audio time and real-time factor for six agent replies, the talk-back match margin, and with `--mic` the microphone open time and main-thread stall. `--synthetic` also dictates the 12 test prompts spoken by the Kokoro voice. Quit or pause the installed service, close busy programs and plug in the charger first; the script warns when the CPU is busy. Results are saved to `test-output/benchmark/`.

  Results on 29 October 2026 (i5-13420H, 16 GB, on battery, CPU 8% busy at start):

  | Measure | Result |
  |---|---|
  | Word error rate, Kokoro voice (12 prompts, 115 words) | 0.9% (1 error: "build" heard as "bill"). A pipeline check, not accuracy on human speech. |
  | Stop press to text ready | median 581 ms, max 965 ms |
  | Stop press to paste | median 803 ms (Confab waits at least 800 ms before pasting) |
  | Reply received to first audio | median 1.3 s, max 3.1 s |
  | Read-aloud real-time factor | median 0.43 (speech is made about 2.3 times faster than it plays) |
  | Model load (first use after idle unload) | 3.3 s |
  | Microphone open | about 410 ms; longest main-thread pause 19 ms on the worker thread vs 423 ms on the main thread |

  Word error rate on human speech is not measured yet: record your voice with `record-test-voice.cjs`, then run the benchmark.
- The service has no network access in its speech workers (`src/no-network.cjs`), binds only 127.0.0.1, and requires the bearer token on every route.
