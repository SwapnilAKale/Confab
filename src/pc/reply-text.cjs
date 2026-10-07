'use strict';
// Read-aloud preparation for replies posted to the resident's /event route.
// Prose punctuation is rewritten for speech; only genuine code, diffs, paths,
// URLs and JSON keep whole-reply rejection. Rules are documented in
// docs/DEVELOPER_GUIDE.md.

const MAX_SPOKEN = 5000;

// Singular denominators make "x/y" read as "x per y"; a plural right-hand side
// ("sets/reps", "days/weeks") reads as an alternative. Abbreviations are
// expanded so "km/h" becomes "km per hour" rather than "km per h".
const PER = {s:'second',sec:'second',second:'second',min:'minute',minute:'minute',h:'hour',hr:'hour',hour:'hour',d:'day',day:'day',wk:'week',week:'week',mo:'month',month:'month',yr:'year',year:'year',set:'set',rep:'rep',session:'session',workout:'workout',meal:'meal',serving:'serving',side:'side',leg:'leg',arm:'arm'};
// Dose units: "1.6 g/kg" is "per kg", but "lbs/kg" stays an alternative.
const DOSE = new Set(['g','mg','mcg','ml','kcal','cal','calories','grams']);
const BODY = new Set(['kg','lb','lbs','pound','pounds','kilogram','kilograms']);
const FIXED = {'and/or':'and or','w/o':'without','n/a':'not applicable'};

function classify(text) {
  if (/(?:^|\n)\s*(?:```|~~~)/.test(text) || /`/.test(text)) return 'code';
  if (/(?:^|\n)(?:\+\+\+|---) [^\n]*\n|(?:^|\n)@@ /.test(text)) return 'diff';
  if (/\bhttps?:\/\/|\bwww\.\w/i.test(text)) return 'url';
  const trimmed = text.trim();
  if (/^[{[]/.test(trimmed)) { try { JSON.parse(trimmed); return 'json'; } catch {} }
  if (/"[^"\n]{1,80}"\s*:\s*["{[\d]/.test(text)) return 'json';
  if (/[{}]/.test(text)) return 'code';
  if (/(?:^|\n)\s*(?:const|let|var|import|def|class|function|return|SELECT|INSERT|UPDATE|DELETE|npm|npx|pip|python|node|git|curl|sudo|powershell)\s/.test(text)) return 'code';
  if (/(?:^|\n)\s*\$\s/.test(text) || /===|!==|=>|&&|\|\||::|->/.test(text)) return 'code';
  if (/\b[A-Za-z_]\w*\(\)|\b[a-z_]\w*\.[a-z_]\w*\(|\b[a-z]+_[a-z_]+\(/.test(text)) return 'code';
  if (/;\s*$/m.test(text) && /=/.test(text)) return 'code';
  if (/(?:^|[\s(])[A-Za-z]:[\\/]|\\\\\w|\w\\\w/.test(text)) return 'path';
  if (/(?:^|[\s(])(?:~|\.{1,2})?\/\w[\w.-]*\/\w/.test(text)) return 'path';
  if (/\b[\w-]+\.(?:py|js|mjs|cjs|ts|tsx|jsx|json|md|cpp|cs|exe|ps1|sh|bat|yml|yaml|toml|txt|log|html|css)\b/i.test(text)) return 'path';
  return null;
}

function slash(match) {
  const lower = match.toLowerCase();
  if (FIXED[lower]) return FIXED[lower];
  if (/^w\//i.test(match)) return 'with ' + slash(match.slice(2)).trim();
  const parts = match.split('/');
  if (parts.length === 1) return match;
  if (parts.length === 2) {
    const [left, right] = parts, l = left.toLowerCase(), r = right.toLowerCase();
    if (PER[r]) return left + ' per ' + PER[r];
    if (DOSE.has(l) && BODY.has(r)) return left + ' per ' + right;
  }
  return parts.length === 2 ? parts.join(' or ') : parts.slice(0, -1).join(', ') + ' or ' + parts.at(-1);
}

// Markdown flattening, after hermes-agent's prepare_spoken_text pipeline: links keep their text,
// emphasis and inline code are unwrapped, headings/blockquotes/rules/list markers are removed,
// table pipes become pauses, and each separate line becomes its own sentence.
function flattenMarkdown(text) {
  let out = text.replace(/\r\n?/g, '\n');
  out = out.replace(/!\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/g, ' $1 ').replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, '$1');
  out = out.replace(/`([^`\n]+)`/g, '$1');
  out = out.replace(/\*\*([\s\S]+?)\*\*/g, '$1').replace(/__([\s\S]+?)__/g, '$1').replace(/~~([\s\S]+?)~~/g, '$1');
  out = out.replace(/(?<![*\w])\*(?![*\s])([^*\n]+?)(?<!\s)\*(?![*\w])/g, '$1').replace(/(?<![_\w])_(?![_\s])([^_\n]+?)(?<!\s)_(?![_\w])/g, '$1');
  out = out.replace(/(\d)[ \t]*[*×][ \t]*(?=\d)/g, '$1 times ').replace(/^[ \t]*[*+•][ \t]+/gm, '- ').replace(/\*+/g, ' ');
  out = out.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, (m, title) => title.replace(/[.:;,]+$/, '') + '.');
  out = out.replace(/^\s*>\s?/gm, '').replace(/^\s*[-_]{3,}\s*$/gm, '');
  out = out.replace(/^.*\|.*$/gm, row => /^[\s|:-]+$/.test(row) ? '' : row.split('|').map(c => c.trim()).filter(Boolean).join(', '));
  // Line-start list markers: "- x", "* x", "+ x", "• x", "1. x", "1) x".
  // Inline lists first, so a list that opens its line still has its "1." marker.
  return inlineList(out).replace(/^[ \t]*(?:-|\d{1,3}[.)])[ \t]+/gm, '');
}

// Inline lists such as "Today's plan: 1. Squats 2. Bench 3. Rows" or "a • b • c": markers counting
// up from 1 (at least two of them) become sentence breaks, so no number attaches to the previous item.
function inlineList(text) {
  return text.replace(/([.!?:])?[ \t]+•[ \t]+/g, (m, p) => p ? p + ' ' : '. ').split('\n').map(line => {
    // The first marker must open the line or follow a colon ("plan: 1. ..."), so prose such as
    // "Step 1. Warm up and 2. Lift" is not taken for a list.
    let expected = 1, run = [];
    for (const m of line.matchAll(/(^|:\s*|\s)(\d{1,2})[.)][ \t]+(?=[A-Za-z])/g)) {
      const opens = m.index === 0 || m[1].startsWith(':');
      if (Number(m[2]) === expected && (expected > 1 || opens)) { run.push(m); expected++; } else if (Number(m[2]) === 1 && opens) { run = [m]; expected = 2; }
    }
    if (run.length < 2) return line;
    let result = '', last = 0;
    for (const m of run) {
      const at = m.index + m[1].length;
      result += line.slice(last, at).replace(/[\s,;]+$/, '');
      if (result) result += /[.!?:]$/.test(result) ? ' ' : '. ';
      last = m.index + m[0].length;
    }
    const tail = line.slice(last).trimEnd();
    return result + tail + (/[.!?]$/.test(tail) ? '' : '.');
  }).join('\n');
}

// Scale ratios read "8 out of 10" only in rating context (RPE, rating, score, effort, ...).
// Plain fractions (3/4) and dates (10/04) are left to the pronunciation stage.
const SCALE = 'RPE|rating|rated|rate|score|scored|scale|effort|intensity|difficulty|pain|soreness|fatigue|energy|mood|sleep|confidence';
const SCALE_BEFORE = new RegExp('\\b(' + SCALE + ')((?:\\s+(?:of|at|around|about|was|is|it|this|that|them|a|an))*\\s*:?\\s*)(\\d+(?:\\.\\d+)?)\\s*/\\s*(5|10|100)\\b', 'gi');
const SCALE_AFTER = new RegExp('\\b(\\d+(?:\\.\\d+)?)\\s*/\\s*(5|10|100)(?=\\s+(?:' + SCALE + ')\\b)', 'gi');
function ratios(text) { return text.replace(SCALE_BEFORE, '$1$2$3 out of $4').replace(SCALE_AFTER, '$1 out of $2'); }

function speakable(text) {
  let out = flattenMarkdown(text);
  // Citation markers: [1], [1, 2], [3-5], [12]. Removed with their leading space.
  out = out.replace(/\s*\[\d+(?:\s*[-–,]\s*\d+)*\]/g, '');
  // Plural markers such as set(s) read as the plural.
  out = out.replace(/\b(\w+)\(s\)/g, '$1s');
  // Remaining brackets and parentheses are spoken with a pause on each side.
  for (let previous; previous !== out;) { previous = out; out = out.replace(/\s*[([]\s*([^()[\]]*?)\s*[)\]]/g, (m, inner) => inner.trim() ? ', ' + inner.trim() + ', ' : ' '); }
  out = out.replace(/[()[\]]/g, ' ');
  out = out.replace(/;/g, ',');
  // Symbols: an en-dash between numbers is a range, arrows read "to", decorative symbols and emoji
  // (●, ✓, ⚠ ...) are dropped, and seconds/milliseconds after a number are spelled out.
  out = out.replace(/(\d)\s*–\s*(?=\d)/g, '$1 to ').replace(/\s*(?:→|⇒|->)\s*/g, ' to ').replace(/[\p{So}️‍]/gu, ' ')
    .replace(/(\d)\s?ms\b/g, '$1 milliseconds').replace(/(\d)\s?s\b(?![\w'])/g, '$1 seconds');
  // Spaced dashes are pauses, not "minus".
  out = out.replace(/[ \t]+[-–—][ \t]+/g, ', ');
  out = ratios(out);
  // Slashes between words: unit pairs read "per", alternatives read "or".
  // Numeric forms such as 3/5 or 24/7 are left for the pronunciation stage.
  out = out.replace(/\b[A-Za-z][\w-]*(?:\/[A-Za-z][\w-]*)+/g, slash);
  out = out.replace(/(\d)\s*\/\s*([A-Za-z]+)\b/g, (m, n, unit) => PER[unit.toLowerCase()] ? n + ' per ' + PER[unit.toLowerCase()] : m);
  out = out.replace(/\bw\/\s*/gi, 'with ');
  // Tidy pauses created above.
  out = out.replace(/[ \t]+,/g, ',').replace(/,(?:\s*,)+/g, ',').replace(/,\s*([.!?:])/g, '$1').replace(/,\s*(\*{1,3}|_{1,3})(?=[\s.,!?:]|$)/g, '$1')
    .replace(/([.!?:])\s*,\s*/g, '$1 ').replace(/(^|\n)\s*,\s*/g, '$1').replace(/,\s*(?=\n|$)/g, '')
    .replace(/,(?=[A-Za-z])/g, ', ').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+(?=\n|$)/g, '');
  // Each remaining line is a sentence: a pause between list items and paragraphs.
  const lines = out.split('\n').map(line => line.trim()).filter(Boolean);
  if (lines.length > 1) return lines.map(line => /[.!?]$/.test(line) ? line : line.replace(/[:;,]$/, '') + '.').join('\n');
  return (lines[0] || '').replace(/([^0-9])[:;,]$/, '$1.');
}

// Sentence-sized synthesis units of at most ~160 characters, split at sentence ends and lines.
// Synthesis units. The first is short so speech starts soon: the text up to the last natural break
// within `first` characters (a sentence end, a comma/semicolon/colon, or before a clause word such
// as "and" or "because"), else the first break within 90 characters, else the first sentence.
// Kokoro fp32 takes roughly 35-50 ms per character on the development PC. Later units are whole sentences,
// merged up to `second` characters for the second unit and `limit` after that, so a pause can only
// fall between units, never inside one.
const BREAK = /[.!?](?=\s)|\n|[,;:](?= )|\s(?=(?:and|but|so|because|which|while|then|or|when|where|if|with)\s)/g;
function speechUnits(text, limit = 160, {first = 50, second = 120} = {}) {
  const clean = String(text).trim();
  if (!clean) return [];
  if (clean.length <= first) return [clean];
  const cuts = [...clean.slice(0, 91).matchAll(BREAK)].map(m => ({end: /[.!?,;:]/.test(m[0]) ? m.index + 1 : m.index, resume: m.index + 1})).filter(c => c.end >= 15);
  const cut = cuts.filter(c => c.end <= first).pop() || cuts[0];
  let head, rest;
  if (cut) { head = clean.slice(0, cut.end).trim(); rest = clean.slice(cut.resume).trim(); }
  else { const m = /[.!?](?=\s)|\n/.exec(clean); head = m ? clean.slice(0, m.index + 1).trim() : clean; rest = m ? clean.slice(m.index + 1).trim() : ''; }
  const units = [head];
  for (const sentence of rest.split(/\n+|(?<=[.!?])\s+/).map(x => x.trim()).filter(Boolean)) {
    const last = units.length - 1, cap = last === 0 ? 0 : last === 1 ? second : limit;
    if (last >= 1 && units[last].length + 1 + sentence.length <= cap) units[last] += ' ' + sentence; else units.push(sentence);
  }
  return units;
}

// Spoken opening: only the start of a reply is read aloud. Takes the first prose paragraph (after any
// leading headings), stopping at a blank line, heading, list item, table, quote or code fence, then
// at most `sentences` sentences and `chars` characters (always at least the first sentence). If
// that paragraph is missing, the start of the reply is used instead. `cut` is true when anything
// else in the reply was left out. sentences = 0 and chars = 0 mean the full reply.
const OPENING_STOP = /^\s*(?:#{1,6}\s|[-*+•]\s|\d{1,3}[.)]\s|>|\||```|~~~)/;
function spokenOpening(raw, {sentences = 3, chars = 400} = {}) {
  const text = String(raw ?? '').replace(/\r\n?/g, '\n').trim();
  if (!text || (!(sentences > 0) && !(chars > 0))) return {text, cut: false};
  const lines = text.split('\n'); let i = 0;
  while (i < lines.length && (!lines[i].trim() || /^\s*#{1,6}\s/.test(lines[i]))) i++;
  const paragraph = [];
  for (; i < lines.length && lines[i].trim() && !OPENING_STOP.test(lines[i]); i++) paragraph.push(lines[i].trim());
  const source = paragraph.length ? paragraph.join(' ') : text;
  const all = source.split(/(?<=[.!?])\s+/).filter(Boolean), picked = [];
  for (const sentence of all) {
    if (sentences > 0 && picked.length >= sentences) break;
    if (chars > 0 && picked.length && picked.join(' ').length + 1 + sentence.length > chars) break;
    picked.push(sentence);
  }
  const opening = picked.join(' ').trim();
  const rest = text.replace(/\s+/g, ' ').trim().length - opening.replace(/\s+/g, ' ').length;
  return {text: opening, cut: rest > 3};
}

// What is read aloud for a reply. With an opening limit, each opening sentence is checked on its own
// and display-only ones (code, paths, URLs ...) are dropped rather than silencing the whole reply;
// "Full reply on screen." follows when anything was left out, and "The reply is on screen." is said
// when nothing in the opening can be spoken. Without a limit, the full reply is prepared as before.
function spokenReply(raw, {sentences = 0, chars = 0} = {}) {
  if (!(sentences > 0) && !(chars > 0)) return prepareReply(raw);
  const opening = spokenOpening(raw, {sentences, chars});
  let cut = opening.cut; const kept = [];
  for (const sentence of opening.text.split(/(?<=[.!?])\s+/).filter(Boolean)) {
    const prepared = prepareReply(sentence);
    if (prepared.ok) kept.push(prepared.text); else cut = true;
  }
  if (!kept.length) return {ok:true, text:'The reply is on screen.', opening:true};
  return {ok:true, text:kept.join(' ') + (cut ? ' Full reply on screen.' : ''), opening:true};
}

function prepareReply(value) {
  if (typeof value !== 'string' || !value.trim()) return {ok:false, reason:'display_only', detail:'empty'};
  // Inline code spans holding plain words ("`Lat Pulldown`") are formatting; any other span is code.
  const spans = [...value.matchAll(/`([^`\n]*)`/g)];
  if (/```|~~~/.test(value) || value.replace(/`[^`\n]*`/g, '').includes('`') || spans.some(m => !/^[A-Za-z0-9][A-Za-z0-9 '’-]*$/.test(m[1]) || /^(?:npm|npx|pip|python|node|git|curl|sudo|powershell|cd|ls|rm|mkdir|cat|echo|docker|make)\b/.test(m[1]))) return {ok:false, reason:'display_only', detail:'code'};
  const kind = classify(value.replace(/`([^`\n]*)`/g, '$1').replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, '$1'));
  if (kind) return {ok:false, reason:'display_only', detail:kind};
  const text = speakable(value);
  if (!text) return {ok:false, reason:'display_only', detail:'empty'};
  if (text.length > MAX_SPOKEN) return {ok:false, reason:'display_only', detail:'too_long'};
  return {ok:true, text};
}

module.exports = {prepareReply, spokenReply, classify, speakable, speechUnits, spokenOpening, MAX_SPOKEN};
