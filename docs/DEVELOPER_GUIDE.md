# Developer guide

For anyone connecting an agent to Local Voice, adding support for a new agent, or working on Local Voice itself.

- [How it fits together](#how-it-fits-together)
- [Custom agents](#custom-agents): read your own agent's replies aloud
- [Adding an agent](#adding-an-agent) with lifecycle hooks
- [Hotkeys](#hotkeys)
- [What is spoken](#what-is-spoken) and [Pronunciation](#pronunciation)
- [Working on Local Voice](#working-on-local-voice)

## How it fits together

```text
 hotkey ─▶ resident service (tray app, src/pc/resident.cjs)
            ├─ microphone ─▶ Silero VAD (segments) ─▶ Parakeet (text) ─▶ paste into the focused box
            ├─ talk-back gate: remembers the talk-back draft, matches it against reported turns
            └─ reply ─▶ reply-text rules ─▶ Node normaliser ─▶ Kokoro ─▶ speakers
                 ▲
 agent hooks ─▶ src/adapters/hooks/adapter.cjs ─┐
 custom agent ─▶ src/pc/client.cjs or local_voice.py ─┴─▶ POST http://127.0.0.1:<port>/event
```

- **Resident service** (`src/pc/`): one process per Windows user, started at login. It owns the tray, the global hotkeys, the badge, audio, and a loopback HTTP endpoint. Speech models load in worker processes on first use (`src/service/native-engine.cjs`, `src/speech-worker.cjs`) and unload after 15 idle minutes.
- **Input** (`src/input/`): `RegisterHotKey` hotkeys (no keyboard hook), clipboard paste with one Ctrl+V and clipboard restore, and a UI Automation helper that identifies the focused box.
- **Agent hooks** (`src/adapters/hooks/`): one adapter program plus a mapping file per agent; `install.cjs` writes and removes the hook entries. The Claude Code plugin lives in `src/adapters/claude-code/`.
- **Profile** (`%LOCALAPPDATA%\LocalVoice\resident\`): `auth.json` (token), `endpoint.json` (port, while running), `settings.json`, `drafts/`, and the logs `requests.jsonl` and `hooks.jsonl`. The installer limits the folder to the current user and SYSTEM.

## Custom agents

Any agent with a backend can have its replies spoken. You don't need to read Local Voice's source code.

### How talk-back works

| Hotkey | Action |
|---|---|
| Ctrl+Shift+8 | **Plain dictation.** Pastes the text into the focused box. Never causes speech. |
| Ctrl+Shift+7 | **Talk-back dictation.** Pastes the text, and marks the turn it becomes for one spoken reply. |
| Ctrl+Shift+6 | **Cancel.** Cancels the pending talk-back, stops playback and clears queued speech. |

The service keeps the last talk-back draft in memory until it is used or cancelled. Your agent reports each user message as a **turn**. If the message matches the draft, that turn owns the talk-back, and **its one reply** is spoken. Every other reply is silent: plain dictation, typed messages, later replies, background wake-ups.

- Only one turn on the whole PC owns a talk-back at a time. A newer talk-back anywhere silences an older pending one, and Cancel clears it.
- A pending draft or turn has no short expiry, so an agent can report a turn when a long task ends. It is cleared by its reply, by Cancel, by a newer talk-back, or after a 2-hour safety cap (`talkbackCapMs` in `settings.json`, 10 minutes to 24 hours). The cap clearing one is logged.
- Your agent never needs to know which hotkey was used. It reports turns and replies, and the service decides.
- The tray has two modes: **Talk-back only** (default) and **Off**.
- **An agent that does not send turn events is never spoken.** There is no mode that speaks every reply.

### Integration point: your backend, on every turn

Make two HTTP calls from your agent's **backend process**:

1. **When a user message arrives**, send a `turn` event with the message text and a turn ID.
2. **After the final public answer for that message**, send a `reply` event with the same turn ID.

Do this for every message, however it arrived. Dictation pastes text into whatever box has focus, so dictated text reaches your backend through your own UI, exactly like typed text. Local Voice never sees the message unless your backend reports it. That is why the service matches the turn text.

Send only the public final answer as the reply: never chain of thought, scratchpad, tool payloads or partial streaming output.

### Clients

Two single-file clients do the discovery, headers and timeouts for you. Copy one into your project. An installed Local Voice has them in `%LOCALAPPDATA%\LocalVoice\app\src\pc\` (`local_voice.py` and `client.cjs`). Your agent needs no connecting in the tray: the clients find the running service by themselves.

**Python** ([`src/pc/local_voice.py`](../src/pc/local_voice.py), standard library only, Python 3.8+):

```python
from local_voice import turn, speak

def handle_message(message: str, conversation_id: str) -> str:
    t = turn(message, agent="my-agent", session_id=conversation_id)      # as the message arrives
    answer = run_agent(message)                                           # your agent
    result = speak(answer, agent="my-agent", session_id=conversation_id, turn_id=t["turnId"])
    log.debug("Local Voice: turn=%s reply=%s", t["reason"], result["reason"])   # development visibility
    return answer
```

- `turn(text, *, agent, session_id, turn_id=None, ...)` generates a turn ID when you don't pass one, and returns it as `"turnId"`.
- `speak(text, *, agent, session_id, turn_id=None, id=None, profile=None, timeout=0.25)` generates the reply `id`.
- Both return the service's result plus `status`, and never raise. `status()` wraps `GET /health`.

**Node** ([`src/pc/client.cjs`](../src/pc/client.cjs), Node built-ins only):

```js
const {turn,speak}=require('./local-voice-client.cjs');
const t=await turn(message,{agent:'my-agent',sessionId:conversationId});
const answer=await runAgent(message);
await speak(answer,{agent:'my-agent',sessionId:conversationId,turnId:t.turnId});
```

### Discovery

Both files live in the per-user profile folder:

```text
%LOCALAPPDATA%\LocalVoice\resident\
  endpoint.json   {"pid": 1234, "port": 52151, "version": "0.8.0"}   (written while the service runs)
  auth.json       {"token": "<64 lowercase hex characters>"}          (created at install; never changes)
```

- Read both files **per call**, or re-read after any failure. The port is chosen at each start.
- If either file is missing or unreadable, the service is not installed or not running. Skip the call silently.
- The folder is readable only by the current Windows user. Never copy the token into source, config files, logs, prompts or a browser.

### HTTP contract

```text
POST http://127.0.0.1:<port>/event
```

| Header | Value |
|---|---|
| `Authorization` | `Bearer <token from auth.json>` |
| `Host` | exactly `127.0.0.1:<port>`. `localhost:<port>` is rejected. |
| `Content-Type` | `application/json` |
| `Origin` | **must be absent**. Any `Origin` or `Sec-Fetch-*` header is rejected, and so is any `OPTIONS` request. |

Every body (a JSON object, at most 256 KiB) has:

| Field | Required | Meaning |
|---|---|---|
| `event` | yes | `"turn"`, `"reply"`, `"reply-end"` or `"detach"` |
| `agent` | yes | Your agent's name, 1–100 characters, for example `"my-agent"`. |
| `sessionId` | yes | Your conversation ID, at most 200 characters (`"default"` is fine). |

**`turn`**, when a user message reaches the backend:

| Field | Required | Meaning |
|---|---|---|
| `text` | yes, for matching | The user's message exactly as received, at most 60,000 characters. It is compared with the talk-back draft in memory, then discarded. It is never logged or stored. |
| `turnId` | recommended | A unique ID for this message (a UUID), at most 200 characters. Without one, ownership is per `agent` + `sessionId`, so the session's next reply is the one spoken. |

**`reply`**, with the final public answer:

| Field | Required | Meaning |
|---|---|---|
| `text` | yes | The final public answer, at most 60,000 characters. |
| `id` | **yes** | A unique ID for this reply (a UUID), at most 200 characters. A retry with the same `id` is ignored as a duplicate. A missing `id` returns 400 `missing_id`. |
| `turnId` | yes, if you sent one with the turn | The `turnId` of the message this answers. A reply with a different or missing `turnId` does not use that turn's talk-back. |

**Agents that report every assistant message** (in-between ones included): send each as a `reply` with `"final": false`. The service keeps only the latest one per `sessionId` and `turnId`. When the turn ends, send `{"event": "reply-end", "turnId": ..., "status": "completed"}`. The last candidate is then judged like a normal reply. A status other than `completed` discards it. A candidate that is never ended is dropped after 30 minutes.

**`detach`**, optional: send when a conversation closes. It drops any pending talk-back held by that session.

`GET /health` (same headers, no body) returns the service state, the mode, request counters and the last rejected request. `GET /requests` returns the last 100 log entries.

### Responses

Every response is JSON: `{"accepted": <bool>, "reason": "<code>"}`. Some also carry a `detail`.

| Status | `accepted` | `reason` | Meaning |
|---|---|---|---|
| 200 | true | `match` | `turn`: this message matched the talk-back draft. Its reply will be spoken. |
| 200 | true | `no_match` | `turn`: no talk-back for this message. Its reply will be silent. |
| 202 | true | `queued` | `reply`: will be spoken after any earlier replies. Nothing waits for the speech. |
| 202 | true | `held` | `reply`: no turn owns the talk-back yet, but a talk-back draft is waiting. The reply is held for up to 2 s in case its turn arrives late. Logged as `held_released` (spoken if the late turn matched) or `held_expired`. |
| 202 | true | `candidate` | `reply` with `final: false`: kept until `reply-end`. |
| 200 | false | `not_talkback` | `reply`: this reply's turn does not own the talk-back. |
| 200 | false | `disabled` | `reply`: the tray mode is *Off*. |
| 200 | false | `duplicate` | `reply`: this `id` was already received for this `agent` + `sessionId`. |
| 200 | false | `display_only` | `reply`: nothing in it can be spoken. `detail` is `code`, `diff`, `path`, `url`, `json`, `too_long` or `empty`. See [What is spoken](#what-is-spoken). |
| 200 | false | `paused` | The user paused Local Voice in the tray. Turns are not matched while paused. |
| 200 | false | `queue_full` | 100 replies are already waiting. |
| 200 | true | `recorded` | `detach` was applied. |
| 200 | true | `discarded` | `reply-end` with a status other than `completed`; `detail` is the status. |
| 200 | true | `no_candidate` | `reply-end` with no candidate yet. A candidate within 2 s still counts as the final reply. |
| 400 | false | `missing_id` | `reply` without `id`. |
| 400 | false | `invalid_id` / `invalid_turn_id` | `id` or `turnId` is not a non-empty string of at most 200 characters. |
| 400 | false | `invalid_text` | `text` is the wrong type or longer than 60,000 characters. |
| 400 | false | `invalid_identity` | `agent` or `sessionId` is missing, the wrong type or too long. |
| 400 | false | `unknown_event` | `event` is not a supported value. |
| 400 | false | `invalid_json` / `too_large` | The body is not JSON, or exceeds 256 KiB. |
| 403 | false | `browser_request` | An `Origin` or `Sec-Fetch-*` header was present, or the method was `OPTIONS`. |
| 403 | false | `bad_host` | The `Host` header is not exactly `127.0.0.1:<port>`. |
| 403 | false | `unauthorized` | The bearer token is missing or wrong. Re-read `auth.json`. |
| 404 | false | `not_found` | Wrong method or route. |

The clients also return `{"accepted": false, "reason": "unavailable"}` without contacting the service when it isn't running, or when the request times out or fails.

### Fire and forget, but log while developing

- Use a short timeout. The clients default to **250 ms**. Never let these calls delay or fail your agent.
- Never retry in a loop. If you retry a reply once, reuse its `id`.
- Don't block on speech: 202 means queued, not spoken.
- **Log every result while developing** (`reason`, `detail`, status), so "silent" means silent to your user, not invisible to you.
- **Never call from a browser.** A web page can't hold the token without exposing it, and browsers always send an `Origin` header, which the service rejects.

### Matching

Both texts are lowercased, `<pasted_content>` wrappers are removed, and every run of punctuation or whitespace becomes one space. The turn matches when either:
- character similarity, 1 − (Levenshtein distance ÷ length of the longer text), is at least **0.75**, or
- the message contains the whole draft, and the draft is at least 60% of the message.

Editing a few words before sending still matches. A short message that only shares a prefix, or a long message where the draft is a small part, does not. A matched draft is consumed, so it cannot match a second conversation.

### Observability

`GET /health` includes `readMode`, `talkback` (`none`; `dictation` while a draft waits; `turn` while a matched turn awaits its reply), the request counters and `lastRejected`.

The service appends one JSON line per request to `requests.jsonl` in the profile folder (moved to `requests.1.jsonl` at 256 KiB). Entries hold only `at`, `route`, `event`, `agent`, `session`, `turn`, `status`, `accepted`, `reason`, `detail` and `decision`. When the 2-hour cap clears a forgotten talk-back, a `{"route":"talkback","event":"cap_cleared",...}` line is written. Entries never contain prompt text, reply text, reply IDs or tokens.

### Example: curl (Windows PowerShell)

```powershell
$dir = "$env:LOCALAPPDATA\LocalVoice\resident"
$port = (Get-Content "$dir\endpoint.json" | ConvertFrom-Json).port
$token = (Get-Content "$dir\auth.json" | ConvertFrom-Json).token
$turnId = [guid]::NewGuid().ToString()
$turn = @{event='turn'; text='How should I train this week?'; turnId=$turnId; agent='my-agent'; sessionId='default'} | ConvertTo-Json -Compress
$turn | curl.exe -s -m 1 -X POST "http://127.0.0.1:$port/event" -H "Authorization: Bearer $token" -H "Content-Type: application/json" --data-binary '@-'
$reply = @{event='reply'; text='Do 3 sets (RPE 8) on push/pull days.'; id=[guid]::NewGuid().ToString(); turnId=$turnId; agent='my-agent'; sessionId='default'} | ConvertTo-Json -Compress
$reply | curl.exe -s -m 1 -X POST "http://127.0.0.1:$port/event" -H "Authorization: Bearer $token" -H "Content-Type: application/json" --data-binary '@-'
```

### Checklist

- [ ] `turn` is sent from the backend when each message arrives, with the message text and a turn ID.
- [ ] `reply` is sent after the final answer, with a unique `id` and the same turn ID.
- [ ] Port and token are read from the profile files at runtime, and never stored or logged.
- [ ] The timeout is about 250 ms, and errors never reach the user.
- [ ] Results are logged during development.
- [ ] Manual test: plain dictation gives `no_match` and `not_talkback`; talk-back dictation (Ctrl+Shift+7) gives `match`, then `queued`, and is heard once.

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
   | `install` | Where the hook is registered: `requires` (the support check: `name`, `binaries`, `marker`, `needs`), `file`, `format` (`nested` = Claude/Codex style, `flat` = Cursor style, `group` = Antigravity style, `files` = one script per hook), `events` with their timeout/async settings, optional `top`, `group`, `eventArg`, `after`, `trust`. |

4. **Add sample payloads** in `test/fixtures/hook-payloads/<name>.json`: a `source` line saying where the shapes came from, and `cases` with `payload`, the expected `expect` messages, and optional `missing` and `stdout`. `test/agent-hooks.test.cjs` runs every fixture file and fails if a mapping has none. It also runs each installed command the way the agent's shell would.
5. **Add the agent** to the list in `scripts/agent-hooks.cjs` and to [SUPPORTED_AGENTS.md](SUPPORTED_AGENTS.md), marked "Sample payloads" until it is tested live.

**Rules every hook keeps:** always exit 0; print nothing the agent would treat as output; act on the first JSON object and never wait for end of stdin; exit within 1.5 s. The adapter does all of this, so a mapping file is enough.

## Hotkeys

Keep this table current whenever a shortcut changes. All hotkeys use `RegisterHotKey` (no keyboard hook). Each key belongs to whichever process registers it first. The tray menu shows the live keys.

| Key | Active when | What it does |
|---|---|---|
| **Ctrl+Shift+8** | Service running, hotkeys not paused. | **Plain dictation.** First press: grey **Starting…** badge at once, playback stops and the microphone opens. When capture is live, the badge turns red (**● Dictating**) with the start beep. Audio is buffered while models load. The box focused at the press is the target; if focus leaves it, recording continues and the badge warns **⚠ Focus moved — click back to paste here**. Second press, or Ctrl+Shift+7: stops (**… Transcribing**), then pastes without Enter into the target box (**✓ Pasted**). If the box can't be proven the same: **⧉ Not pasted — copied**, the text is on the clipboard, plus a notification. Never causes a spoken reply. |
| **Ctrl+Shift+7** | Same. | **Talk-back dictation.** Same as Ctrl+Shift+8 with a purple **◆ Talk-back** badge. The draft is kept until its reply, Cancel or a newer talk-back (2-hour cap), and the turn it becomes owns one spoken reply. The key that **starts** a recording sets its mode; either key stops it. |
| **Ctrl+Shift+6** | Same. | **Cancel.** At any point (starting, recording, focus moved, transcribing): discards the recording, so nothing is pasted or copied. Also cancels the pending talk-back, stops playback, clears queued replies and clears the target box. Two-tone falling cue when something was cancelled; otherwise a soft tick. |
| Ctrl+Shift+9 | **Off by default.** Turn it on with `"hotkeys": {"arm": "Ctrl+Shift+9"}`. | **Arm text box.** Targets the focused editable box without recording. Rarely needed, because 8 and 7 target the box themselves. |

Keys can be changed in `settings.json` (quit first): `"hotkeys": {"capture": "Ctrl+Shift+8", "talkback": "Ctrl+Shift+7", "disarm": "Ctrl+Shift+6", "arm": "off"}`. Use Ctrl+Shift plus a letter, number, F1–F24 or Space. If another program holds a key, the service keeps its other keys, names the missing ones in a notification, retries every 15 seconds, and lists them as `hotkeysUnavailable` in `/health`.

**Feedback details:**
- The badge shows Starting… within about 150 ms. It turns red or purple, and the beep plays, only when Windows has created the capture stream: typically 0.6–0.8 s after the press. Creating any Windows audio stream (`IAudioClient::Initialize`) takes 380–660 ms on typical hardware.
- Capture uses WASAPI through koffi (`src/pc/wasapi-audio.cjs`), with WinMM as the fallback. The microphone stream is created per recording and closed afterwards. Output streams stay initialized and stopped, so cues start within milliseconds.
- Badge states: ○ Starting…, ● Dictating, ◆ Talk-back, ⚠ Focus moved, … Transcribing / Transcribing — loading models…, ✓ Pasted, ⧉ Not pasted — copied, ✕ Failed (the reason is in a notification), … Preparing reply, ♪ Speaking.
- **Same box** means the same top-level window, the same UI Automation element runtime id, and the same containing document (runtime id and title). A recreated element or another browser tab counts as a different box, and the text is copied, never pasted.
- After a verified paste the previous clipboard is restored, unless another app changed it meanwhile. A changed focus, a locked desktop or active typing never triggers an automatic retry; the draft is left on the clipboard. If clipboard access itself fails, the draft is saved under `drafts/` in the profile.

## What is spoken

Only the **opening** of a reply is read: the first prose paragraph, at most 3 sentences or 400 characters, stopping at the first heading, list, table, quote or code. Opening sentences that can't be spoken are dropped one by one. "Full reply on screen." is added when anything was left out, and "The reply is on screen." is said if nothing in the opening can be spoken. `spokenSentences` / `spokenChars` change the limits (0 and 0 = the full reply). Lead a reply with a short plain-language summary and it is the part that is heard. The rules are in `src/pc/reply-text.cjs`.

**Rejected entirely (`display_only`):**

| `detail` | Triggers |
|---|---|
| `code` | Fenced code blocks. Inline code that is not plain words (`` `max_sets=5` ``) or is a shell command (`` `npm test` ``). Curly braces. A line starting with a code keyword or shell command (`const`, `def`, `import`, `return`, `npm`, `git`, `python`, ...) or `$ `. Operators such as `===`, `!==`, `=>`, `&&`, `\|\|`, `::`, `->`. Calls such as `foo()` or `obj.method(`. A statement ending in `;` alongside `=`. |
| `diff` | Unified-diff headers (`--- ` / `+++ ` lines, `@@ ` hunks). |
| `path` | Drive paths (`C:\`), backslash paths, Unix paths with two or more segments (`/usr/bin`, `./a/b`), file names with code or config extensions (`.py`, `.json`, `.md`, ...). |
| `url` | A bare `http://`, `https://` or `www.` URL. A markdown link keeps its text and is spoken. |
| `json` | A reply that parses as JSON, or contains `"key": value`. |
| `too_long` / `empty` | More than 5,000 characters after normalisation, or nothing left to say. |

**Rewritten, then spoken:**

| Input | Spoken as | Rule |
|---|---|---|
| `**bold**`, `*it*`, `__b__`, `_i_`, `~~s~~`, `` `Lat Pulldown` `` | `bold`, `it`, ... | Emphasis and plain-word inline code are unwrapped. `snake_case` words are untouched. |
| `# Heading` | `Heading.` | The heading becomes its own sentence. |
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

| Input | NeMo | Local Voice | Verdict |
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

## Working on Local Voice

```bash
npm install
```

```bash
npm test
```

- `npm test` runs every `*.test.cjs` in `test/` and `src/adapters/claude-code/test/`. Some tests load the real speech models from `assets/models/`, so download them first: `node scripts/models.cjs fetch` (the same downloader setup uses; `check --full` re-hashes every file). One test runs `src/pc/local_voice.py`, so Python 3.8+ should be on PATH.
- Setup and uninstall are `scripts/setup.ps1` and `scripts/uninstall.ps1`, started by `setup.cmd` and `uninstall.cmd`. The installed layout is `%LOCALAPPDATA%\LocalVoice\app` (a copy of this folder with `node_modules` and the models), `runtime\node` (Node.js pinned in [`assets/runtime.json`](../assets/runtime.json)) and `resident` (the profile). The tray's windows are `src/ui/dialogs.ps1`; they call `scripts/agents.cjs` and `scripts/diagnose.cjs`, which you can also run directly.
- **Atomic setup and uninstall.** The shared helpers are in `scripts/windows-shell.ps1`. A named mutex (`Local\LocalVoiceSetup`) lets only one setup or uninstall run at a time. `state.json` in the installation folder is `installing`, `ready` or `uninstalling`, and the launcher (`scripts/start-resident.ps1`) starts the service only when it is `ready` or absent. Setup first copies the uninstaller to `uninstaller\` and registers the **Settings → Apps** entry, which runs it with `-Gui`. Node.js, the app files and `node_modules` are then built in `staging\` and swapped in with `Install-Staged`, which renames each target to `*.old-xxxxxxxx` and undoes every swap if one fails. Uninstall runs `agents.cjs check-disconnect` (read-only) before `disconnect all`, then removes startup, stops processes, and renames every folder to `*.removing-xxxxxxxx` before deleting (a file in use stops it with all moves undone). It removes the Apps entry and its own folder last. `Remove-InterruptedLeftovers` clears staging and renamed folders left by an interrupted run. The tray and Settings → Apps open the same uninstaller windows (`-Gui`): confirmation, a progress window in its own process (it outlives the service), and a summary. `uninstall.cmd` runs the same steps in the console.
- `npm start` runs the service in the foreground from this folder (quit any installed copy first; only one runs per user).
- `node scripts/compare-normalizer.cjs --diff` compares the normaliser with the NeMo reference cases.
- Speech settings are built in. An optional `"speech"` object in `settings.json` overrides them: `ttsThreads` (default 6) and `modelRoot` (relative to this folder; default `assets/models`).
- Live models and their exact files are recorded in [`assets/live-models.json`](../assets/live-models.json). Update it when a model changes. When a piece is dropped, list its folder under `retired`: setup and uninstall delete retired folders from existing installations.
- **Speech detector.** `src/silero-segmenter.cjs` runs Silero VAD through sherpa-onnx and only marks where speech is; `src/context-turns.cjs` decides turns (a turn ends after 2.2 s of silence, or at 24 s with 3 s of context overlap). Its three settings (`threshold`, `preSpeechSeconds`, `minSilenceSeconds`) come from the `vad` object in `settings.json` through `src/vad-settings.cjs`; the README lists them.
- **Tuning with your own voice.** `node scripts/record-test-voice.cjs` records 12 test dictations (short phrases, pauses of 1–3 s, fast speech, a soft first word, fillers) with the product's own microphone capture into `test-output/my-recordings`, one `.wav` and one `.txt` reference each. Pause the installed service's hotkeys first. Replay them through the detector and Parakeet to compare settings before changing a default.
- The service has no network access in its speech workers (`src/no-network.cjs`), binds only 127.0.0.1, and requires the bearer token on every route.
