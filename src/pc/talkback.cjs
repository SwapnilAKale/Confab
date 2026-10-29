'use strict';
// Talk-back gate: a reply is spoken only when the user turn that produced it was sent with
// talk-back dictation. Prompt and dictation text live only in memory for matching and are
// never logged or persisted. Contract: docs/CUSTOM_AGENTS_REFERENCE.md.

// There is deliberately no mode that speaks every reply.
const MODES = ['talkback', 'off'];
// The pending talk-back (draft or matched turn) has no short expiry: some harnesses report the turn
// only when a long task ends. It is cleared by its reply, Disarm or a newer talk-back, and by this
// safety cap so a forgotten one cannot linger forever.
const DEFAULT_CAP_MS = 2 * 60 * 60 * 1000;
// A submitted prompt matches the talk-back draft when their normalized character similarity
// (1 - Levenshtein distance / longer length) is at least this, or when the prompt contains the
// whole draft and the draft is at least 60% of the prompt.
// The threshold is a chosen value. scripts/benchmark.cjs checks its margin on the 12 test prompts: two different
// prompts score at most 0.40, and a dictation sent with its recognition errors fixed scores at least 0.77
// ("8000" vs "eight thousand" is the closest).
const MATCH_THRESHOLD = 0.75;
const CONTAINED_SHARE = 0.6;

// Context an agent adds to the prompt it reports is not what the user sent: the Claude desktop app puts a
// <system-reminder> block before the first message of a new session, and wraps pasted text in <pasted_content>.
function normalize(text) {
  return String(text)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/<\/?pasted_content[^>]*>/gi, ' ')
    .toLowerCase().normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function similarity(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  // Two-row Levenshtein; prompts are short enough that O(n*m) is fine. Very long texts are
  // compared on their first 4000 characters.
  a = a.slice(0, 4000); b = b.slice(0, 4000);
  let previous = Array.from({length: b.length + 1}, (_, i) => i), current = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    [previous, current] = [current, previous];
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

function matches(draft, prompt) {
  if (!draft || !prompt) return false;
  if (similarity(draft, prompt) >= MATCH_THRESHOLD) return true;
  return prompt.includes(draft) && draft.length >= CONTAINED_SHARE * prompt.length;
}

class TalkbackGate {
  constructor({mode = 'talkback', capMs = DEFAULT_CAP_MS, clock = Date.now, onExpire = () => {}} = {}) {
    this.mode = MODES.includes(mode) ? mode : 'talkback';
    Object.assign(this, {capMs, clock, onExpire});
    this.record = null;   // {text, at}: talk-back dictation pasted, not yet matched to a turn
    this.owner = null;    // {key, turnId, at}: the one turn whose reply will be spoken
  }
  // Clears a pending talk-back older than the cap and reports it (onExpire gets no text).
  sweep() {
    const now = this.clock();
    for (const [slot, pending] of [['record', 'dictation'], ['owner', 'turn']]) {
      const value = this[slot];
      if (value && now - value.at > this.capMs) { this[slot] = null; try { this.onExpire({pending, ageMs: now - value.at}); } catch {} }
    }
  }
  setMode(mode) { if (!MODES.includes(mode)) throw Error('Unknown read-aloud mode'); this.mode = mode; }
  // Talk-back dictation pasted text. A newer draft replaces an older unmatched one.
  dictated(text) { this.sweep(); const value = normalize(text); this.record = value ? {text: value, at: this.clock()} : null; }
  // A user turn reached an agent. Returns 'match' or 'no_match'. A turn that does not match a waiting draft
  // leaves lastMismatch: the similarity and the two normalized lengths (numbers only, never text).
  turn(key, turnId, text) {
    this.sweep(); this.lastMismatch = null;
    if (!this.record || typeof text !== 'string') return 'no_match';
    const prompt = normalize(text);
    if (!matches(this.record.text, prompt)) {
      this.lastMismatch = {similarity: Math.round(similarity(this.record.text, prompt) * 1000) / 1000, draftChars: this.record.text.length, promptChars: prompt.length, contained: prompt.includes(this.record.text)};
      return 'no_match';
    }
    // Single owner: this turn replaces any earlier pending talk-back, which then replies silently.
    this.record = null; this.owner = {key, turnId: turnId ?? null, at: this.clock()};
    return 'match';
  }
  // A reply arrived. Returns {speak, decision}. The owner is cleared by its first reply.
  reply(key, turnId) {
    this.sweep();
    const owner = this.owner, owns = !!owner && owner.key === key && (owner.turnId === null || owner.turnId === (turnId ?? null));
    // The owning turn's reply uses up the talk-back even when Off keeps it silent.
    if (owns) this.owner = null;
    if (this.mode === 'off') return {speak: false, decision: 'mode_off'};
    return owns ? {speak: true, decision: 'talkback'} : {speak: false, decision: 'not_talkback'};
  }
  // Disarm: cancels the pending talk-back (record and owner). Returns whether anything was pending.
  disarm() { this.sweep(); const pending = !!(this.owner || this.record); this.record = null; this.owner = null; return pending; }
  detach(key) { if (this.owner?.key === key) this.owner = null; }
  status() { this.sweep(); return {mode: this.mode, pending: this.owner ? 'turn' : this.record ? 'dictation' : 'none'}; }
}

module.exports = {TalkbackGate, normalize, similarity, matches, MODES, MATCH_THRESHOLD, CONTAINED_SHARE, DEFAULT_CAP_MS};
