'use strict';
// Pronunciation normaliser for the PC read-aloud path, in plain Node. It replaces the NeMo Python worker,
// which Windows application control (Smart App Control) can block. It runs after the reply rules in
// reply-text.cjs (markdown, lists, slashes, ratios, parentheses, citations) and expands what a speech
// model would otherwise read badly: money, dates, times, measurements, percentages, ordinals, ranges,
// fractions, decimals, cardinals and symbols. Reference: NeMo text normalisation r1.2.0 test cases in
// test/fixtures/nemo-reference; deliberate differences are listed in docs/DEVELOPER_GUIDE.md (Pronunciation).

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES = ['', 'thousand', 'million', 'billion', 'trillion', 'quadrillion', 'quintillion'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_INDEX = new Map([...MONTHS.map((m, i) => [m.toLowerCase(), i]), ...MONTHS.map((m, i) => [m.slice(0, 3).toLowerCase(), i]), ['sept', 8]]);
const MONTH_RE = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';

function below1000(n) {
  const words = [];
  if (n >= 100) { words.push(ONES[Math.floor(n / 100)], 'hundred'); n %= 100; }
  if (n >= 20) { words.push(TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '')); }
  else if (n > 0 || !words.length) words.push(ONES[n]);
  return words.join(' ');
}
// Cardinal words for a string of digits (no sign, no separators). Very long numbers are read digit by digit.
function cardinal(digits) {
  digits = String(digits).replace(/^0+(?=\d)/, '');
  if (digits.length > 21) return digitByDigit(digits);
  if (/^0+$/.test(digits)) return 'zero';
  const groups = [];
  for (let end = digits.length; end > 0; end -= 3) groups.unshift(Number(digits.slice(Math.max(0, end - 3), end)));
  const words = [];
  groups.forEach((group, i) => { if (group) words.push(below1000(group) + (SCALES[groups.length - 1 - i] ? ' ' + SCALES[groups.length - 1 - i] : '')); });
  return words.join(' ');
}
function digitByDigit(digits) { return [...String(digits)].map(d => ONES[Number(d)]).join(' '); }
// Integer reading: leading zeros ("004", "007") are read digit by digit, as NeMo does.
// An ungrouped run of more than 15 digits is an identifier, read digit by digit; "1,000,000,000,000,000" stays a number.
function integer(text) { const digits = text.replace(/,/g, ''); return /^0\d/.test(digits) || (!text.includes(',') && digits.length > 15) ? digitByDigit(digits) : cardinal(digits); }
function decimal(text) {
  const [whole, fraction] = text.replace(/,/g, '').split('.');
  return (whole ? integer(whole) + ' ' : '') + 'point ' + digitByDigit(fraction);
}
function number(text) { return text.includes('.') ? decimal(text) : integer(text); }
function ordinalWords(words) {
  return words.replace(/(\w+)$/, last => ({one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth'})[last]
    || (last.endsWith('y') ? last.slice(0, -1) + 'ieth' : last + 'th'));
}
function ordinal(n) { return ordinalWords(cardinal(String(n))); }
// Years: 2012 "twenty twelve", 2006 "two thousand six", 1906 "nineteen oh six", 1900 "nineteen hundred".
function year(text) {
  const n = Number(text);
  if (text.length !== 4 || n < 1000) return cardinal(text);
  if (n % 1000 < 10 && Math.floor(n / 1000) !== 1 || n === 1000) return cardinal(text);
  const high = Math.floor(n / 100), low = n % 100;
  if (low === 0) return cardinal(String(high)) + ' hundred';
  return cardinal(String(high)) + ' ' + (low < 10 ? 'oh ' + ONES[low] : cardinal(String(low)));
}
function shortYear(text) { return text.length === 2 ? (text[0] === '0' ? 'zero ' + ONES[Number(text[1])] : cardinal(text)) : year(text); }
function monthName(text) { const i = MONTH_INDEX.get(text.toLowerCase().replace(/\.$/, '')); return i === undefined ? null : MONTHS[i]; }
function validDate(month, day) { return month >= 1 && month <= 12 && day >= 1 && day <= 31; }
function datePhrase(month, day, yearText) { return MONTHS[month - 1] + ' ' + ordinal(day) + (yearText ? ' ' + shortYear(yearText) : ''); }

const UNITS = {
  kg: ['kilogram', 'kilograms'], kgs: ['kilogram', 'kilograms'], g: ['gram', 'grams'], mg: ['milligram', 'milligrams'],
  lb: ['pound', 'pounds'], lbs: ['pound', 'pounds'], oz: ['ounce', 'ounces'], km: ['kilometer', 'kilometers'],
  m: ['meter', 'meters'], cm: ['centimeter', 'centimeters'], mm: ['millimeter', 'millimeters'], mi: ['mile', 'miles'],
  ft: ['foot', 'feet'], ml: ['milliliter', 'milliliters'], mL: ['milliliter', 'milliliters'], l: ['liter', 'liters'], L: ['liter', 'liters'],
  kcal: ['kilocalorie', 'kilocalories'], cal: ['calorie', 'calories'], h: ['hour', 'hours'], hr: ['hour', 'hours'], hrs: ['hour', 'hours'],
  min: ['minute', 'minutes'], mins: ['minute', 'minutes'], sec: ['second', 'seconds'], secs: ['second', 'seconds'], s: ['second', 'seconds'],
  ms: ['millisecond', 'milliseconds'], bpm: ['beat per minute', 'beats per minute'], rpm: ['revolution per minute', 'revolutions per minute'],
  mph: ['mile per hour', 'miles per hour'], kph: ['kilometer per hour', 'kilometers per hour'], mbps: ['megabit per second', 'megabits per second'],
  gb: ['gigabyte', 'gigabytes'], GB: ['gigabyte', 'gigabytes'], mb: ['megabyte', 'megabytes'], MB: ['megabyte', 'megabytes'],
  KB: ['kilobyte', 'kilobytes'], kb: ['kilobyte', 'kilobytes'], TB: ['terabyte', 'terabytes'], cc: ['CC', 'CC'],
  KG: ['kilogram', 'kilograms'], LB: ['pound', 'pounds'], LBS: ['pound', 'pounds'], KM: ['kilometer', 'kilometers'],
  'km³': ['cubic kilometer', 'cubic kilometers'], 'm²': ['square meter', 'square meters'], m2: ['square meter', 'square meters'], 'm³': ['cubic meter', 'cubic meters']
};
const UNIT_RE = Object.keys(UNITS).sort((a, b) => b.length - a.length).map(u => u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
function unitWord(unit, value) { const pair = UNITS[unit]; return pair ? pair[/^(?:1|one)$/.test(value) ? 0 : 1] : unit; }

const CURRENCIES = {'$': ['dollar', 'dollars', 'cent', 'cents'], '£': ['pound', 'pounds', 'penny', 'pence'], '€': ['euro', 'euros', 'cent', 'cents'],
  '₹': ['rupee', 'rupees', 'paisa', 'paise'], '¥': ['yen', 'yen', null, null], '₩': ['won', 'won', null, null]};
const MAGNITUDE = {k: 'thousand', K: 'thousand', thousand: 'thousand', m: 'million', M: 'million', million: 'million', mn: 'million',
  b: 'billion', B: 'billion', bn: 'billion', billion: 'billion', t: 'trillion', T: 'trillion', trillion: 'trillion'};
function money(symbol, amount, magnitude) {
  const [one, many, minorOne, minorMany] = CURRENCIES[symbol];
  amount = amount.replace(/,/g, '');
  if (magnitude) return number(amount.replace(/^\./, '0.')) + ' ' + MAGNITUDE[magnitude] + ' ' + many;
  let [whole = '', fraction = ''] = amount.split('.');
  // Two-place amounts are units and cents ($20.50, $20.500); three significant places read as a decimal.
  if (fraction.replace(/0+$/, '').length > 2 || !minorOne) {
    return fraction.replace(/0+$/, '') ? (whole ? decimal(amount) : 'point ' + digitByDigit(fraction)) + ' ' + many : integer(whole || '0') + ' ' + (/^0*1$/.test(whole) ? one : many);
  }
  const cents = Number((fraction + '00').slice(0, 2)), units = Number(whole || '0');
  const parts = [];
  if (units || !cents) parts.push(integer(whole || '0') + ' ' + (units === 1 ? one : many));
  if (cents) parts.push(cardinal(String(cents)) + ' ' + (cents === 1 ? minorOne : minorMany));
  return parts.join(' ');
}
function fraction(numerator, denominator) {
  const n = Number(numerator), d = Number(denominator);
  if (d === 2) return cardinal(numerator) + ' ' + (n === 1 ? 'half' : 'halves');
  if (d === 4) return cardinal(numerator) + ' ' + (n === 1 ? 'quarter' : 'quarters');
  const denom = ordinal(d);
  return cardinal(numerator) + ' ' + (n === 1 ? denom : denom + 's');
}
function clock(hours, minutes, suffix) {
  const h = Number(hours), m = Number(minutes || 0), ampm = suffix ? ' ' + suffix.replace(/\./g, '').toUpperCase() : '';
  if (!m) return cardinal(String(h)) + (ampm || ' o\'clock');
  return cardinal(String(h)) + ' ' + (m < 10 ? 'oh ' + ONES[m] : cardinal(String(m))) + ampm;
}
const plural = (n, word) => cardinal(String(Number(n))) + ' ' + word + (Number(n) === 1 ? '' : 's');

const ABBREVIATIONS = [[/\bDr\.(?=\s+[A-Z])/g, 'doctor'], [/\bMrs\.(?=\s+[A-Z])/g, 'misses'], [/\bMr\.(?=\s+[A-Z])/g, 'mister'], [/\bMs\.(?=\s+[A-Z])/g, 'miz'],
  [/\be\.g\.(?=[\s,]|$)/gi, 'for example'], [/\bi\.e\.(?=[\s,]|$)/gi, 'that is'], [/\bvs\.?(?=\s)/gi, 'versus'], [/\betc\./gi, 'et cetera'],
  [/\bapprox\.(?=\s)/gi, 'approximately'], [/\bavg\.?(?=\s+\d)/gi, 'average'], [/\bno\.(?=\s*\d)/gi, 'number'], [/\btv\b/g, 'TV']];

const PER_WORD = {mo: 'month', month: 'month', yr: 'year', year: 'year', wk: 'week', week: 'week', d: 'day', day: 'day', hr: 'hour', h: 'hour', hour: 'hour',
  min: 'minute', minute: 'minute', s: 'second', sec: 'second', rep: 'rep', set: 'set', session: 'session', serving: 'serving'};
const ZONES = 'est|edt|cst|cdt|mst|mdt|pst|pdt|utc|gmt|ist|bst|cet';

// Developer notation, carried over from the NeMo worker so code-like words read the same as before.
// The word/word slash rule runs last, after units and rates have taken their slashes.
function developer(value) {
  value = value.replace(/\b([A-Za-z][\w-]*)\.(py|js|ts|tsx|jsx|json|cjs|md|cpp|cs)\b/g, (m, name, ext) => name + ' dot ' + [...ext].join(' '));
  value = value.replace(/(?<=[a-z])(?=[A-Z][a-z])/g, ' ');
  value = value.replace(/(?<=[A-Za-z])_(?=[A-Za-z])/g, ' underscore ');
  // Version numbers (v1.2.3, 1.2.3), but not dotted dates such as 01.10.2010.
  value = value.replace(/\bv?(\d+(?:\.\d+){2,})\b/g, m => /^\d{1,2}\.\d{1,2}\.\d{4}$/.test(m) ? m : (m.startsWith('v') ? 'version ' : '') + m.replace(/^v/, '').split('.').map(integer).join(' point '));
  for (const [symbol, spoken] of [['===', ' strictly equals '], ['!==', ' does not strictly equal '], ['=>', ' arrow '], ['==', ' equals '], ['!=', ' does not equal '], ['&&', ' and '], ['||', ' or ']]) value = value.split(symbol).join(spoken);
  return value;
}

const NUM = '\\d[\\d,]*(?:\\.\\d+)?|\\.\\d+';
// A number not glued to a preceding letter ("AH0", "es3" are not quantities).
const FREE = '(?<![A-Za-z\\d.])';
const MONEY = `(?:US)?[$£€₹¥₩]\\s?(?:${NUM})(?:\\s?(?:thousand|million|billion|trillion|bn|mn|[kKmMbBtT])\\b)?`;
const TIME = `\\d{1,2}(?::\\d{2})?\\s?[ap]\\.?m\\b\\.?`;
// Numeric dates whose order is uncertain (07/10/2026) follow the convention set by other dates in the same
// reply: a date with a part above 12 settles it (25/12/2026 is day-first, 12/25/2026 month-first). Returns
// 'dmy', 'mdy', or null when nothing settles it or the reply mixes both.
function inferDateOrder(text) {
  const seen = new Set();
  for (const [, a, b] of String(text).matchAll(/(?<![\d/.-])(\d{1,2})[/.-](\d{1,2})[/.-](?:\d{4}|\d{2})(?![\d/-]|\.\d)/g)) {// a sentence's full stop may follow
    if (+a > 12 && +b <= 12) seen.add('dmy'); else if (+b > 12 && +a <= 12) seen.add('mdy');
  }
  return seen.size === 1 ? [...seen][0] : null;
}
// Durations and clock times share the m:ss form. A clock cue ("at", "by", "until", "o'clock", "tomorrow",
// am/pm) keeps the clock reading; a duration cue (rest, pace, split, plank, run, time, took, per km ...)
// reads a duration; with neither, a value that can be a time of day stays a clock time.
const CLOCK_BEFORE = /\b(?:at|by|until|till|around|from|before|after|since|starts?|starting|begins?|opens?|closes?|wake|woke|alarm)\s+$/i;
const CLOCK_AFTER = /^\s*(?:o'clock|tomorrow|today|tonight|this (?:morning|afternoon|evening)|in the (?:morning|afternoon|evening)|morning|afternoon|evening)\b/i;
const DURATION_BEFORE = /\b(?:rest(?:ed|ing)?|recover(?:y|ed)?|between sets|pace|splits?|laps?|run|ran|running|plank(?:s|ed)?|holds?|held|holding|time[ds]?|took|takes|lasted|lasting|duration|intervals?|finish(?:ed)?|under|for|best|record|PR|average|avg|mile|km|total|row(?:ed)?|swim|swam|cycl(?:e|ed)|ride|rode|walk(?:ed)?|in)\b[^.!?;\n]*$/i;
const DURATION_AFTER = /^\s*(?:\/|per (?:kilometer|km|mile|mi|lap|hundred)\b|min(?:ute)?s?\b|rest\b|pace\b|splits?\b|planks?\b|holds?\b|between\b|long\b)/i;
function timeContext(whole, offset, length) {
  const before = whole.slice(Math.max(0, offset - 60), offset).split(/[.!?;\n]/).pop(), after = whole.slice(offset + length, offset + length + 30);
  // Precedence: a clock word right before the time, then duration cues, then time-of-day words after it
  // ("ran 1:05:30 today" is a duration; "6:30 tomorrow" is a clock time).
  if (CLOCK_BEFORE.test(before)) return 'clock';
  const recent = before.split(/\s+/).slice(-7).join(' ');
  if (DURATION_BEFORE.test(recent) || DURATION_AFTER.test(after)) return 'duration';
  return CLOCK_AFTER.test(after) ? 'clock' : null;
}
// "1:30" "one minute thirty", "2:00" "two minutes", "0:45" "forty five seconds", "1:05" "one minute five seconds";
// "1:05:30" "one hour five minutes thirty seconds".
function minutesSeconds(m, s, secondsWord) {
  const M = +m, S = +s;
  if (!M) return plural(S, 'second');
  if (!S) return plural(M, 'minute');
  return plural(M, 'minute') + ' ' + (S < 10 || secondsWord ? plural(S, 'second') : cardinal(String(S)));
}
function hoursMinutesSeconds(h, m, s) { return [[h, 'hour'], [m, 'minute'], [s, 'second']].filter(([v]) => +v).map(([v, w]) => plural(v, w)).join(' ') || 'zero seconds'; }
function normalize(input, {dateOrder = 'dmy'} = {}) {
  let text = String(input)
    // Typographic variants: non-breaking and figure hyphens, minus sign, narrow and non-breaking spaces.
    .replace(/[‐‑‒]/g, '-').replace(/−/g, '-').replace(/[   ]/g, ' ');
  // The caller passes the reply-wide convention (the controller infers it from the whole reply); dates in
  // this text can still settle it.
  const order = inferDateOrder(text) || (dateOrder === 'mdy' ? 'mdy' : 'dmy');
  // A numeric date, or null when it is not one: a part above 12 is certain; otherwise the convention decides.
  // Day-first reads "the seventh of October twenty twenty six"; month-first reads "October seventh ...".
  const numericDate = (a, b, y) => {
    const first = a > 12 && b <= 12 ? 'dmy' : b > 12 && a <= 12 ? 'mdy' : order, [day, month] = first === 'dmy' ? [a, b] : [b, a];
    if (!validDate(month, day)) return null;
    return first === 'dmy' ? 'the ' + ordinal(day) + ' of ' + MONTHS[month - 1] + (y ? ' ' + shortYear(y) : '') : datePhrase(month, day, y);
  };
  text = developer(text);
  for (const [pattern, spoken] of ABBREVIATIONS) text = text.replace(pattern, spoken);
  text = text.replace(/\band\/or\b/gi, 'and or');

  // Ranges between money, times and decades read "to" (NeMo: "$250-$300", "2pm-5pm", "1960s-80s").
  text = text.replace(new RegExp(`(${MONEY}|${TIME}|\\d{1,2}:\\d{2}\\s?[ap]\\.?m\\b\\.?|\\b\\d{2,4}s)\\s?[-–]\\s?(?=[$£€₹¥₩]|\\d|')`, 'gi'), '$1 to ');
  // Signs and arithmetic: "-0.4kg", "1-2=5", "2+3".
  text = text.replace(/(^|[\s(])-(?=\.?\d)/g, '$1minus ');
  text = text.replace(/(\d)\s*-\s*(\d+)\s*=/g, '$1 minus $2 =');
  text = text.replace(/(\d|\b[a-z])\s*=\s*(?=\d|[a-z]\b)/g, '$1 equals ').replace(/(\d|\b[a-z])\s*\+\s*(?=\d|[a-z]\b)/g, '$1 plus ');
  // Rates: "$20/mo", "12/kg", "3 sets/week" (reply-text.cjs already rewrites most of these to "per").
  text = text.replace(new RegExp(`(\\d|\\b[a-z]{1,3})\\s?/\\s?(${UNIT_RE}|${Object.keys(PER_WORD).join('|')})\\b`, 'g'), (m, before, unit) => before + ' per ' + (PER_WORD[unit] || unitWord(unit, '1')));

  // Money.
  text = text.replace(new RegExp(`(US)?([$£€₹¥₩])\\s?(${NUM})(?:\\s?(thousand|million|billion|trillion|bn|mn|[kKmMbBtT])\\b)?`, 'g'),
    (m, us, symbol, amount, magnitude) => money(symbol, amount, magnitude).replace(/(dollars?)$/, us ? 'US $1' : '$1'));
  // Dates: ISO and slashed year-first, month names with or without a year, day-first with a month name, numeric.
  text = text.replace(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g, (m, y, mo, d) => validDate(+mo, +d) ? datePhrase(+mo, +d, y) : m);
  text = text.replace(new RegExp(`\\b(${MONTH_RE})\\.?[ -](\\d{1,2})(?:st|nd|rd|th)?\\b(,?)(?:[ -](\\d{4})\\b)?`, 'gi'),
    (m, month, day, comma, y) => +day >= 1 && +day <= 31 ? monthName(month) + ' ' + ordinal(+day) + (y ? comma + ' ' + year(y) : comma) : m);
  text = text.replace(new RegExp(`\\b(?:the )?(\\d{1,2})(?:st|nd|rd|th)?(?: of)? (${MONTH_RE})\\b\\.?(?:,? (\\d{4})\\b)?`, 'gi'),
    (m, day, month, y) => +day >= 1 && +day <= 31 ? 'the ' + ordinal(+day) + ' of ' + monthName(month) + (y ? ' ' + year(y) : '') : m);
  text = text.replace(new RegExp(`\\b(${MONTH_RE}) (\\d{4})\\b`, 'gi'), (m, month, y) => monthName(month) + ' ' + year(y));
  text = text.replace(/\b(\d{1,2})([-.])(\d{1,2})\2(\d{4})\b/g, (m, a, sep, b, y) => numericDate(+a, +b, y) ?? m);
  text = text.replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/g, (m, a, b, y) => numericDate(+a, +b, y) ?? m);
  // Decades: 1980s, 2000s, '80s, mid-80s.
  text = text.replace(/\b(1[0-9]|20)(\d)0 ?s\b/g, (m, c, d) => d === '0' ? (c === '20' ? 'two thousands' : cardinal(c) + ' hundreds') : cardinal(c) + ' ' + (d === '1' ? 'tens' : TENS[+d].replace(/y$/, 'ies')));
  text = text.replace(/(^|[\s(-])'?([2-9])0s\b/g, (m, lead, d) => (lead === '-' ? ' ' : lead) + TENS[+d].replace(/y$/, 'ies'));
  // Times: 14:10:30, 1:59 p.m. EST, 01:00, 5pm.
  const zone = z => z ? ' ' + z.replace(/\./g, '').toUpperCase() : '';
  text = text.replace(new RegExp(`\\b(\\d{1,2}):(\\d{2}):(\\d{2})\\b(?:\\s?([ap])\\.?m\\.?)?(?:\\s?((?:${ZONES})|[a-z]\\.[a-z]\\.[a-z])\\b\\.?)?`, 'gi'), (m, h, mi, s, ap, z, offset, whole) => ap || z || timeContext(whole, offset, m.length) === 'clock'
    ? plural(h, 'hour') + ' ' + plural(mi, 'minute') + ' and ' + plural(s, 'second') + (ap ? ' ' + ap.toUpperCase() + 'M' : '') + zone(z)
    : hoursMinutesSeconds(h, mi, s));
  text = text.replace(new RegExp(`\\b(\\d{1,2})[:.](\\d{2})\\s?([ap])\\.?m\\b\\.?(?:\\s?((?:${ZONES})|[a-z]\\.[a-z]\\.[a-z])\\b\\.?)?`, 'gi'), (m, h, mi, ap, z) => +h <= 12 && +mi < 60 ? clock(h, mi, ap + 'm') + zone(z) : m);
  // m:ss: a duration with a duration cue, or when it cannot be a time of day (25:30); a clock time otherwise.
  // "1:30 minutes" takes the unit word into the duration ("one minute thirty seconds").
  text = text.replace(/\b(\d{1,3}):([0-5]\d)\b(\s?(?:minutes|mins?)\b)?/g, (m, h, mi, unit, offset, whole) => {
    const context = timeContext(whole, offset, m.length);
    if (context === 'clock' && +h < 24) return clock(h, mi, '') + (unit || '');
    if (context === 'duration' || unit || +h >= 24) return minutesSeconds(h, mi, !!unit);
    return +h < 24 ? clock(h, mi, '') : m;
  });
  text = text.replace(/\b(\d{1,2})\s?([ap])\.?m\b\.?/gi, (m, h, ap) => +h >= 1 && +h <= 12 ? cardinal(String(+h)) + ' ' + ap.toUpperCase() + 'M' : m);
  // Sets by reps ("3x10", "2x8 m2"), before measurements; multipliers ("4.4x").
  text = text.replace(new RegExp(`\\b(\\d+) ?[x×] ?(\\d+)(?: ?(${UNIT_RE})(?![\\w²³]))?`, 'g'), (m, a, b, unit) => integer(a) + ' by ' + integer(b) + (unit ? ' ' + unitWord(unit, b) : ''));
  text = text.replace(new RegExp(`${FREE}(${NUM})x\\b`, 'g'), (m, n) => number(n) + ' times');
  // Fractions, with an optional unit: "4 1/2 lbs", "3/4 cup", "22/3". Dates like 10/04 and 24/7 are not fractions.
  const unitAfter = `(?: ?(${UNIT_RE})(?![\\w²³]))?`;
  text = text.replace(new RegExp(`${FREE}(\\d+) (\\d+)\\/(\\d+)${unitAfter}`, 'g'), (m, w, n, d, unit) => integer(w) + ' and ' + (n === '1' && d === '2' ? 'a half' : +d === 1 ? integer(n) + ' over one' : fraction(n, d)) + (unit ? ' ' + unitWord(unit, '2') : ''));
  text = text.replace(new RegExp(`${FREE}(\\d{1,5})\\/(\\d{1,5})(?:st|nd|rd|th)?\\b(?!\\/)${unitAfter}`, 'gi'), (m, n, d, unit) => {
    const words = n === '24' && d === '7' ? 'twenty four seven' : +n >= 1 && +n < +d ? fraction(n, d) : /^0/.test(n) || /^0/.test(d) ? numericDate(+n, +d, '') ?? integer(n) + ' ' + integer(d) : +d === 1 ? integer(n) + ' over one' : +d >= 2 ? fraction(n, d) : integer(n) + ' over ' + integer(d);
    return words + (unit ? ' ' + unitWord(unit, '2') : '');
  });
  // Percentages, temperatures and measurements (singular for exactly one), including ranges and magnitudes.
  text = text.replace(new RegExp(`${FREE}(${NUM}) ?%`, 'g'), (m, n) => number(n) + ' percent');
  text = text.replace(new RegExp(`${FREE}(${NUM}) ?[°º]\\s?([CF])\\b`, 'g'), (m, n, scale) => number(n) + (n === '1' ? ' degree ' : ' degrees ') + (scale === 'C' ? 'Celsius' : 'Fahrenheit'));
  text = text.replace(new RegExp(`${FREE}(${NUM})(?: ?[-–] ?| to )(${NUM}) ?(${UNIT_RE})(?![\\w²³])`, 'g'), (m, a, b, unit) => number(a) + ' to ' + number(b) + ' ' + unitWord(unit, b));
  text = text.replace(new RegExp(`${FREE}(${NUM})(?: (thousand|million|billion))? ?(${UNIT_RE})(?![\\w²³])(?:/(${UNIT_RE})\\b)?`, 'g'), (m, n, mag, unit, per) => number(n) + (mag ? ' ' + mag : '') + ' ' + unitWord(unit, mag ? '2' : n) + (per ? ' per ' + unitWord(per, '1') : ''));
  // Ordinals ("21st"); a mismatched suffix is read as number and letters ("21th": "twenty one th").
  text = text.replace(/\b(\d[\d,]*)(st|nd|rd|th)\b/gi, (m, n, suffix) => {
    const value = n.replace(/,/g, ''), last = Number(value) % 100, expected = last >= 11 && last <= 13 ? 'th' : ({1: 'st', 2: 'nd', 3: 'rd'})[Number(value) % 10] || 'th';
    return suffix.toLowerCase() === expected ? ordinalWords(cardinal(value)) : integer(value) + ' ' + suffix;
  });
  // Years: after a date word ("in 1994"), standing alone ("1994."), or as a year range ("1980-1986", "1960-80").
  text = text.replace(/\b(in|since|from|by|until|of|before|after|year|circa)( (?:early |late |mid )?)(1[1-9]\d\d|20\d\d)\b(?![.,]\d)/gi, (m, word, gap, y) => word + gap + year(y));
  text = text.replace(/(^|[\s(])(1[1-9]\d\d|20\d\d)[-–](\d{2}|\d{4})\b(?![-/\d])/g, (m, lead, a, b) => lead + year(a) + ' to ' + (b.length === 4 ? year(b) : cardinal(b)));
  text = text.replace(/(^|[\s(])(1[1-9]\d\d|20\d\d)(?=\s*(?:[.,;:!?)]|$))/g, (m, lead, y) => lead + year(y));
  // Numeric ranges: "8-12 reps".
  text = text.replace(new RegExp(`(^|[^\\w.-])(${NUM}) ?[-–] ?(${NUM})(?![\\d.]*[-/])`, 'g'), (m, lead, a, b) => lead + number(a) + ' to ' + number(b));
  // Symbols.
  text = text.replace(/\s*&\s*/g, ' and ').replace(/(\s)@(\s)/g, ' at ').replace(/~\s?(?=\d)/g, 'about ').replace(/≈\s?/g, 'approximately ')
    .replace(/±\s?/g, 'plus or minus ').replace(/≥\s?/g, 'at least ').replace(/≤\s?/g, 'at most ').replace(/#(?=\d)/g, 'number ')
    .replace(/(\d)\s?[°º](?![CF])/g, '$1 degrees');
  // Remaining numbers; one glued to letters is spaced off ("es3": "es three").
  text = text.replace(new RegExp(`(${NUM})`, 'g'), (n, _, offset, whole) => {
    const words = n.includes(',') && !/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(n) ? n.split(',').map(part => part && number(part)).join(', ') : number(n);
    return (/[A-Za-z]/.test(whole[offset - 1] || '') ? ' ' : '') + words + (/[A-Za-z]/.test(whole[offset + n.length] || '') ? ' ' : '');
  });
  // Lone symbols.
  text = text.replace(/(^|\s)%(?=\s|$)/g, '$1percent').replace(/(^|\s)\$(?=\s|$)/g, '$1dollar');
  // Word slashes left over (reply-text.cjs normally rewrites these already).
  text = text.replace(/(?<=[A-Za-z0-9_.])[/\\](?=[A-Za-z_.])/g, ' slash ');
  return text.replace(/[ \t]{2,}/g, ' ').replace(/ +([,.;:!?])/g, (m, p, offset, whole) => whole[offset - 1] === ' ' && p === ',' && whole[offset + m.length] === ' ' ? m : p);
}

// Same interface as the NeMo worker client (load, normalize, close), so the speech engine can use either.
class NodeNormalizer {
  load() { return Promise.resolve(); }
  normalize(text, options) { return Promise.resolve(normalize(text, options)); }
  close() {}
}

module.exports = {normalize, NodeNormalizer, inferDateOrder, cardinal, ordinal, year, decimal, money, fraction};
