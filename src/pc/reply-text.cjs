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

// Code, paths, links and data in a reply never silence it: they are rewritten into something that can be said.
// - A fenced code block is described in a few words (describeBlock): its language, size and the names it defines,
//   or the command it runs, or the data's main keys. A stray line of code in prose (classify) becomes
//   "Code on screen." (once for a run of them).
// - A diff names the files it changes and the lines added and removed; a link becomes "a link"; a line of JSON is
//   described as data.
// - A file path (C:\..., src/pc/x.cjs, ~/notes, or a file name such as reply-text.cjs) is said as its file name:
//   "reply text dot cjs".
// - Inline `code`: plain words, key names and identifiers are said; a path is said as its file name; a command
//   (npm, git, node ...) is said as it is when short and plain ("npm test"), else as "the npm command"; anything
//   else becomes "the code on screen".
// Before this, any of these anywhere in a reply (in full-reply mode), or in its first sentence, silenced it.
const EXTENSIONS = 'py|js|mjs|cjs|ts|tsx|jsx|json|md|cpp|c|h|cs|java|go|rs|rb|php|exe|dll|ps1|psm1|sh|bat|cmd|yml|yaml|toml|ini|txt|log|csv|html|css|scss|xml|wav|png|jpg|svg|pdf|zip|lock|env';
const FILE_RE = new RegExp('\\.(' + EXTENSIONS + ')$', 'i');
const COMMAND_RE = /^(?:npm|npx|pnpm|yarn|pip|pip3|python|python3|py|node|git|gh|curl|wget|sudo|powershell|pwsh|cmd|cd|ls|dir|rm|del|mkdir|cat|type|echo|docker|make|winget|choco|code|claude|set|export)\b/i;
const CODE_ON_SCREEN = 'Code on screen.';
// "src/pc/reply-text.cjs" -> "reply text dot cjs"; "C:\Users\ASUS\Desktop" -> "Desktop".
function fileName(path) {
  const parts = String(path).replace(/[\\/]+$/, '').split(/[\\/]+/).filter(Boolean);
  let name = parts.at(-1) || '';
  if (!name || /^[A-Za-z]:$/.test(name)) return 'a folder';
  name = name.replace(/^~$/, 'your home folder');
  const ext = FILE_RE.exec(name);
  const base = ext ? name.slice(0, -ext[0].length) : name;
  const spoken = base.replace(/[-_.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return ext ? (spoken ? spoken + ' dot ' : 'dot ') + ext[1].toLowerCase() : spoken || 'a folder';
}
// Code, diffs, commands and data in a reply are described in a few words instead of being read: what it is, how big
// it is, and what it names. Built from the text alone (no model), so the same block is always described the same way.
//   ```python (def parse_log / def main)  -> "Python code, 14 lines, defining parse log and main."
//   a unified diff                        -> "Changes to controller dot cjs and README dot md: 12 lines added, 3 removed."
//   ```bash  npm test                     -> "npm test." (a short plain command is said as it is)
//   ```json {"name":..,"age":..}          -> "Data with name and age."
const LANGUAGES = {py:'Python',python:'Python',js:'JavaScript',javascript:'JavaScript',mjs:'JavaScript',cjs:'JavaScript',jsx:'JavaScript',node:'JavaScript',ts:'TypeScript',tsx:'TypeScript',typescript:'TypeScript',java:'Java',c:'C',h:'C',cpp:'C plus plus','c++':'C plus plus',cc:'C plus plus',hpp:'C plus plus',cs:'C sharp',csharp:'C sharp',go:'Go',golang:'Go',rs:'Rust',rust:'Rust',rb:'Ruby',ruby:'Ruby',php:'PHP',swift:'Swift',kt:'Kotlin',kotlin:'Kotlin',scala:'Scala',dart:'Dart',lua:'Lua',r:'R',sql:'SQL',html:'HTML',xml:'XML',css:'CSS',scss:'CSS',vue:'Vue',svelte:'Svelte'};
const SHELLS = new Set(['sh','bash','zsh','shell','console','terminal','powershell','ps','ps1','pwsh','cmd','bat','batch','bash-session','shell-session']);
const SETTINGS = {yaml:'YAML',yml:'YAML',toml:'TOML',ini:'Settings',cfg:'Settings',conf:'Settings',env:'Settings',dotenv:'Settings',properties:'Settings'};
const TEXT = new Set(['text','txt','plaintext','output','log','logs','md','markdown','stdout','stderr']);
// "parse_log" -> "parse log", "loadConfig" -> "load config", "Get-ChildItem" -> "Get Child Item".
function speakName(name) { return String(name).replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/\s+/g, ' ').trim().toLowerCase(); }
function listOf(items, more = 0) {
  const all = more > 0 ? [...items, count(more) + ' more'] : items;
  return all.length <= 1 ? all.join('') : all.slice(0, -1).join(', ') + ' and ' + all.at(-1);
}
// Small counts are said as words, so "2 lines added, one line removed" reads evenly.
const WORDS = ['no','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve'];
function count(n) { return WORDS[n] || String(n); }
function lineCount(n) { return n === 1 ? 'one line' : count(n) + ' lines'; }
function nonEmpty(body) { return body.split('\n').filter(line => line.trim()); }
// Names a block of code defines: functions, classes, methods, tables. At most three are said.
const DEFINES = [
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm,                                                // Python
  /^\s*(?:(?:export|default|public|private|protected|internal|abstract|static|final|sealed|partial)\s+)*class\s+([A-Za-z_$][\w$]*)/gm, // most languages
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm,   // JavaScript
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/gm,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm,                                          // Go
  /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/gm,                                     // Rust
  /^\s*(?:(?:public|private|protected|internal|static|final|override|virtual|async)\s+)+[\w<>[\],.?]+\s+([A-Za-z_]\w*)\s*\(/gm, // Java, C#
  /^\s*function\s+([A-Za-z][\w-]*)/gim,                                                    // PowerShell
  /^\s*create\s+(?:table|view|function|procedure)\s+(?:if\s+not\s+exists\s+)?[`"[]?([\w.]+)/gim, // SQL
  /^\s*(?:interface|type|struct|enum)\s+([A-Za-z_]\w*)/gm
];
function definedNames(body) {
  const found = [];
  for (const re of DEFINES) for (const m of body.matchAll(re)) found.push({at: m.index, name: m[1]});
  const seen = new Set(), names = [];
  for (const {name} of found.sort((a, b) => a.at - b.at)) if (!seen.has(name) && !/^(?:if|for|while|switch|catch|return|new|else)$/.test(name)) { seen.add(name); names.push(name); }
  return names;
}
function guessLanguage(body) {
  if (/^\s*(?:async\s+)?def\s+\w+\s*\(|^\s*(?:from\s+[\w.]+\s+)?import\s+\w+|^\s*print\(/m.test(body) && !/[;{}]\s*$/m.test(body)) return 'Python';
  if (/\b(?:const|let)\s+\w+\s*=|=>|\bfunction\b|\brequire\(|\bconsole\.\w+\(|\bmodule\.exports\b/.test(body)) return 'JavaScript';
  if (/^\s*\$\w+\s*=|\b(?:Get|Set|New|Remove|Write)-[A-Z]\w+/m.test(body)) return 'PowerShell';
  if (/^\s*(?:SELECT|INSERT|UPDATE|DELETE|CREATE)\s/im.test(body)) return 'SQL';
  if (/^\s*<(?:!DOCTYPE|html|div|span|head|body)\b/im.test(body)) return 'HTML';
  if (/^\s*(?:package\s+\w+|func\s+\w+\()/m.test(body)) return 'Go';
  if (/^\s*(?:pub\s+)?fn\s+\w+|\blet\s+mut\b/m.test(body)) return 'Rust';
  if (/^\s*(?:public|private)\s+(?:static\s+)?(?:class|void)\b/m.test(body)) return /\busing\s+System\b|\bnamespace\b/.test(body) ? 'C sharp' : 'Java';
  if (/^\s*#include\s*</m.test(body)) return 'C plus plus';
  return null;
}
const COMMAND_START = /^(?:\$\s*|PS[^>]*>\s*|>\s*)?(?:npm|npx|pnpm|yarn|pip|pip3|python|python3|py|node|git|gh|curl|wget|sudo|powershell|pwsh|cmd|cd|ls|dir|rm|del|mkdir|cat|type|echo|docker|make|winget|choco|code|claude|set|export|brew|apt|apt-get|cargo|go|dotnet|java|mvn|gradle|kubectl|ssh|scp|tar|chmod|copy|move|start|setx|Get-\w+|Set-\w+|New-\w+|Remove-\w+|Invoke-\w+|\.\\|\.\/)\b/i;
// A command short and plain enough to say as it is ("npm test", "git status"); otherwise the program's name is said.
function plainCommand(line) {
  const cmd = line.trim().replace(/^(?:\$|PS[^>]*>|>)\s*/, '');
  return cmd.length <= 30 && cmd.split(/\s+/).length <= 4 && /^[A-Za-z][\w .:@-]*$/.test(cmd) && !/\s--?\w/.test(cmd) ? sayCmdlets(cmd) : null;
}
// A PowerShell cmdlet is said as words: "Get-ChildItem" -> "get child item".
function sayCmdlets(text) { return text.replace(/\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/g, speakName); }
function programOf(line) { const word = line.trim().replace(/^(?:\$|PS[^>]*>|>)\s*/, '').split(/\s+/)[0] || ''; return /^[.\\/]/.test(word) ? null : sayCmdlets(word.replace(/\.exe$/i, '')); }
function describeCommands(lines) {
  const commands = lines.filter(line => !/^\s*(?:#|::|REM\b|\/\/)/i.test(line));
  if (commands.length === 1) { const plain = plainCommand(commands[0]); if (plain) return plain + '.'; }
  const programs = [...new Set(commands.map(programOf).filter(Boolean))];
  if (commands.length === 1) return programs[0] ? 'A ' + programs[0] + ' command.' : 'A command on screen.';
  return (programs.length && programs.length <= 3 ? 'Commands for ' + listOf(programs) : 'Commands') + ', ' + lineCount(commands.length) + '.';
}
function describeData(body, label = 'Data') {
  let value; try { value = JSON.parse(body); } catch { value = undefined; }
  if (Array.isArray(value)) return 'A list of ' + (value.length === 1 ? 'one item' : count(value.length) + ' items') + '.';
  if (value && typeof value === 'object') { const keys = Object.keys(value); return keys.length ? label + ' with ' + listOf(keys.slice(0, 3).map(speakName), keys.length - 3) + '.' : 'Empty data.'; }
  return label + ', ' + lineCount(nonEmpty(body).length) + '.';
}
function describeSettings(body, label) {
  const keys = [...new Set([...body.matchAll(/^([A-Za-z_][\w.-]*)\s*[:=]/gm)].map(m => m[1]))];
  const head = label + ', ' + lineCount(nonEmpty(body).length);
  return keys.length ? head + ', with ' + listOf(keys.slice(0, 3).map(speakName), keys.length - 3) + '.' : head + '.';
}
function describeDiff(body, fileName) {
  const files = [];
  for (const m of body.matchAll(/^(?:\+\+\+ (?:b\/)?|diff --git a\/\S+ b\/)(\S.*?)\s*$/gm)) if (!/^\/dev\/null$/.test(m[1])) { const name = fileName(m[1].replace(/^b\//, '')); if (!files.includes(name)) files.push(name); }
  const added = (body.match(/^\+(?!\+\+ )/gm) || []).length, removed = (body.match(/^-(?!-- )/gm) || []).length;
  const counts = added || removed ? [added ? lineCount(added) + ' added' : '', removed ? lineCount(removed) + ' removed' : ''].filter(Boolean).join(', ') : '';
  const what = !files.length ? 'Changes on screen' : files.length <= 3 ? 'Changes to ' + listOf(files) : 'Changes to ' + files.length + ' files';
  return what + (counts ? ': ' + counts : '') + '.';
}
function looksLikeDiff(body) { return /^(?:\+\+\+|---) \S/m.test(body) && /^@@ /m.test(body) || /^diff --git /m.test(body); }
// One fenced block (its info string and body) in a few words.
function describeBlock(info, body, fileName) {
  const tag = String(info || '').trim().split(/[\s{,]/)[0].toLowerCase().replace(/^\./, '');
  const lines = nonEmpty(body);
  if (!lines.length) return 'Code on screen.';
  if (tag === 'diff' || tag === 'patch' || (!tag && looksLikeDiff(body))) return describeDiff(body, fileName);
  if (SHELLS.has(tag) || (!tag && lines.every(line => COMMAND_START.test(line.trim()) || /^\s*#/.test(line)))) return describeCommands(lines);
  if (/^json[c5]?$/.test(tag) || (!tag && /^\s*[[{]/.test(body) && (() => { try { JSON.parse(body); return true; } catch { return false; } })())) return describeData(body);
  if (SETTINGS[tag]) return describeSettings(body, SETTINGS[tag]);
  if (TEXT.has(tag)) return (tag === 'md' || tag === 'markdown' ? 'Text' : 'Output') + ' on screen, ' + lineCount(lines.length) + '.';
  // A tag this list doesn't know ("elixir") is said as the language's name.
  const language = LANGUAGES[tag] || (/^[a-z][a-z0-9+#]{0,14}$/.test(tag) ? tag[0].toUpperCase() + tag.slice(1) : null) || guessLanguage(body);
  const names = definedNames(body);
  return (language ? language + ' code' : 'Code') + ', ' + lineCount(lines.length) + (names.length ? ', defining ' + listOf(names.slice(0, 3).map(speakName), names.length - 3) : '') + '.';
}

// A path has a drive (C:\...), is a network path (\server\...), starts with ~ . or /, has a file extension, or has
// three or more separators. "push/pull", "km/h" and "sets/reps/RPE" are words with slashes, not paths.
function isPath(text) {
  const t = String(text).trim();
  if (/^[A-Za-z]:[\\/]/.test(t) || /^\\\w/.test(t)) return true;
  if (/\s/.test(t) || !/[A-Za-z]/.test(t) || /^[\d/.-]+$/.test(t)) return false;
  const separators = (t.match(/[\\/]/g) || []).length;
  if (separators && /^(?:~|\.{1,2})?[\\/]?[\w.-]+(?:[\\/][\w.-]+)*[\\/]?$/.test(t)) return /^(?:~|\.{1,2}[\\/]|[\\/])/.test(t) || FILE_RE.test(t) || separators >= 3;
  return FILE_RE.test(t) && /^[\w.-]+$/.test(t) && /[A-Za-z]/.test(t.replace(FILE_RE, ''));
}
// What an inline `span` is said as.
function spanSpeech(inner) {
  const t = inner.trim();
  if (!t) return '';
  if (COMMAND_RE.test(t) && /\s|^(?:npm|npx|git|node|python|pip)$/i.test(t)) { const plain = plainCommand(t), program = programOf(t); return plain || (program ? 'the ' + program + ' command' : 'the command on screen'); }
  if (isPath(t)) return fileName(t);
  if (/^[A-Za-z0-9][A-Za-z0-9 '’-]*$/.test(t)) return t;
  if (/^[A-Za-z0-9]+(?:\+[A-Za-z0-9]+)+$/.test(t)) return t.replace(/\+/g, ' ');
  if (/^[A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)*$/.test(t)) return t.replace(/\./g, ' dot ').replace(/_/g, ' ');
  return 'the code on screen';
}
// Each fenced block becomes its description. A fence that is never closed (a reply cut short, or a stray ```) runs
// only to the next blank line, so the prose after it is still read.
function describeFences(text, keep) {
  const lines = text.split('\n'), out = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (!open || (open[1][0] === '`' && open[2].includes('`'))) { out.push(lines[i]); continue; }
    const fence = open[1], closes = line => new RegExp('^[ \\t]*' + fence[0] + '{' + fence.length + ',}[ \\t]*$').test(line);
    let end = lines.findIndex((line, j) => j > i && closes(line)), closed = end >= 0;
    if (!closed) { end = lines.findIndex((line, j) => j > i && !line.trim()); if (end < 0) end = lines.length; }
    out.push(keep(describeBlock(open[2], lines.slice(i + 1, end).join('\n'), fileName)));
    i = closed ? end : end - 1;
  }
  return out.join('\n');
}
// Bare paths and file names in prose.
const PATH_IN_TEXT = /(?:^|(?<=[\s(["'“]))(?:[A-Za-z]:[\\/][^\s"'<>|)\]]*|\\\\[^\s"'<>|)\]]+|(?:~|\.{1,2})?\/?(?:[\w.-]+[\\/])+[\w.-]+[\\/]?|[\w-]+(?:\.[\w-]+)*\.[A-Za-z0-9]{1,5})(?=$|[\s)\]"'”,;:!?]|\.(?:\s|$))/g;
function softenReply(raw) {
  let out = String(raw ?? '').replace(/\r\n?/g, '\n');
  // Each description is kept as it is by the steps below (it is already speech).
  const said = new Set(), describe = text => { said.add(text); return text; };
  out = describeFences(out, block => describe(block));
  out = out.replace(/(^|\n)((?:(?:\+\+\+|---) [^\n]*\n)+(?:@@[^\n]*\n)?(?:[ +\-@][^\n]*(?:\n|$))*)/g, (m, lead, diff) => lead + describe(describeDiff(diff, fileName)) + '\n');
  out = out.replace(/\bhttps?:\/\/[^\s)>\]"']+|\bwww\.[^\s)>\]"']+/gi, 'a link');
  out = out.replace(/(?<!`)(`+)(?!`)([^\n]+?)(?<!`)\1(?!`)/g, (m, ticks, inner) => spanSpeech(inner));
  // A backtick left over in prose ("type ``` to open a block") is not code: drop it rather than silence the line.
  out = out.replace(/`+/g, '');
  // A path followed by punctuation keeps it out of the path ("... docs/GUIDE.md.", "C:\x\a.json, then").
  out = out.replace(PATH_IN_TEXT, m => { const end = /[.,;:!?]+$/.exec(m)?.[0] || '', core = m.slice(0, m.length - end.length); return isPath(core) ? fileName(core) + end : isPath(m) ? fileName(m) : m; });
  // A function named in prose ("call parse_log() first") is said as its name.
  out = out.replace(/(^|[\s("'])([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\(\)(?=[\s.,;:!?)"']|$)/g, (m, lead, name) => lead + speakName(name.replace(/\./g, ' ')));
  out = out.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed === CODE_ON_SCREEN || said.has(trimmed)) return line;
    if (/^[{[]/.test(trimmed)) { try { JSON.parse(trimmed); return describeData(trimmed); } catch {} }
    const kind = classify(trimmed.replace(/^\s*(?:[-*+•]|\d{1,3}[.)])\s+/, ''));
    return kind === 'json' ? 'Data on screen.' : kind ? CODE_ON_SCREEN : line;
  }).join('\n');
  // One placeholder for a run of them.
  return out.replace(/(?:(Code on screen\.|Changes on screen\.|Data on screen\.)\s*\n?\s*)(?:\1\s*\n?\s*)+/g, '$1\n').replace(/\n{3,}/g, '\n\n');
}

// What is read aloud for a reply: the reply with code, paths, links and data rewritten (softenReply). With an
// opening limit only its first paragraph is read (up to `sentences` / `chars`), with "Full reply on screen." when
// anything was left out; without a limit, the whole reply. "The reply is on screen." when nothing can be said.
function spokenReply(raw, {sentences = 0, chars = 0} = {}) {
  if (!(sentences > 0) && !(chars > 0)) return prepareReply(raw);
  // An empty reply, or one with nothing that can be said, is silent in both modes.
  if (typeof raw !== 'string' || !speakable(softenReply(raw))) return prepareReply(raw);
  const soft = softenReply(raw), opening = spokenOpening(soft, {sentences, chars});
  let cut = opening.cut; const kept = [];
  for (const sentence of opening.text.split(/(?<=[.!?])\s+/).filter(Boolean)) {
    const prepared = prepareReply(sentence);
    if (prepared.ok) kept.push(prepared.text); else cut = true;
  }
  if (!kept.length || kept.every(t => /^(?:Code|Changes|Data) on screen\.$/.test(t))) return {ok:true, text:'The reply is on screen.', opening:true};
  return {ok:true, text:kept.join(' ') + (cut ? ' Full reply on screen.' : ''), opening:true};
}

function prepareReply(value) {
  if (typeof value !== 'string' || !value.trim()) return {ok:false, reason:'display_only', detail:'empty'};
  let text = speakable(softenReply(value));
  if (!text) return {ok:false, reason:'display_only', detail:'empty'};
  if (/^(?:(?:Code|Changes|Data) on screen\.\s*)+$/.test(text)) return {ok:true, text:'The reply is on screen.'};
  // A very long reply is read up to MAX_SPOKEN characters, ending at a sentence, rather than not at all.
  if (text.length > MAX_SPOKEN) { const cut = text.slice(0, MAX_SPOKEN).search(/[.!?](?=\s)(?![\s\S]*[.!?]\s)/); text = text.slice(0, cut > 0 ? cut + 1 : MAX_SPOKEN).trim() + ' Full reply on screen.'; }
  return {ok:true, text};
}

module.exports = {prepareReply, spokenReply, softenReply, fileName, describeBlock, classify, speakable, speechUnits, spokenOpening, MAX_SPOKEN};
