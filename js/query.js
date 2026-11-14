// Understands what the user typed: strips question words ("how old is",
// "hvor gammel er"), detects Norwegian, and spots age questions.
// Pure functions, no DOM.

const QUESTION_PREFIXES = [
  // Norwegian
  /^hvor gammel (er|var)\s+/i, /^hvor gamle (er|var)\s+/i, /^hvem (er|var)\s+/i, /^hva (er|var|betyr)\s+/i,
  /^når (ble|er|var)\s+/i, /^hvor (er|ligger|bor)\s+/i, /^hvorfor\s+/i, /^hvordan\s+/i, /^fortell meg om\s+/i,
  // English
  /^how old (is|was|are)\s+/i, /^who (is|was)\s+/i, /^what (is|are|was|were)\s+/i,
  /^when (was|is|did)\s+/i, /^where (is|was|are)\s+/i, /^why (is|are|was|did)\s+/i, /^how (does|do|to)\s+/i,
  /^tell me about\s+/i,
];

const NORWEGIAN_HINTS = /\b(hvor|hvem|hva|når|hvorfor|hvordan|gammel|er|og|ikke|det|som|på|jeg|med|til|av)\b|[æøå]/i;
const AGE_Q = /^(hvor gammel|how old)\b/i;

export function analyzeQuery(raw) {
  const original = String(raw || '').replace(/\s+/g, ' ').trim();
  let core = original.replace(/[?!.]+$/, '').trim();
  let stripped = false;
  for (const re of QUESTION_PREFIXES) {
    if (re.test(core)) { core = core.replace(re, '').trim(); stripped = true; break; }
  }
  core = core.replace(/^["“«']+|["”»']+$/g, '').trim() || original;

  const words = core.split(' ').filter(Boolean);
  // Looks like a person's name: 2-4 words, each starting with a capital letter.
  const looksLikeName = words.length >= 2 && words.length <= 4 && words.every(w => /^\p{Lu}[\p{L}'’-]*$/u.test(w));

  return {
    original,
    core,
    isQuestion: stripped || /\?$/.test(original),
    isAge: AGE_Q.test(original),
    looksLikeName,
    norwegian: NORWEGIAN_HINTS.test(original),
  };
}

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9,
  october: 10, november: 11, december: 12,
  januar: 1, februar: 2, mars: 3, mai: 5, juni: 6, juli: 7, oktober: 10, desember: 12,
};

// Finds "born 12 March 1990" / "født 12. mars 1990" / "(born March 12, 1990)" in text.
// Returns { year, month?, day?, age } or null.
export function findBirthDate(text, now = new Date()) {
  const t = String(text || '').slice(0, 1500);
  const month = '(january|february|march|april|may|june|july|august|september|october|november|december|januar|februar|mars|juni|juli|oktober|desember)';
  const patterns = [
    new RegExp(`(?:born|født|f\\.)\\s*(?:on\\s*)?(\\d{1,2})\\.?\\s+${month}\\s+(\\d{4})`, 'i'),
    new RegExp(`(?:born|født|f\\.)\\s*(?:on\\s*)?${month}\\s+(\\d{1,2}),?\\s+(\\d{4})`, 'i'),
  ];
  let m = t.match(patterns[0]);
  let day; let mon; let year;
  if (m) { day = +m[1]; mon = MONTHS[m[2].toLowerCase()]; year = +m[3]; }
  else if ((m = t.match(patterns[1]))) { mon = MONTHS[m[1].toLowerCase()]; day = +m[2]; year = +m[3]; }
  else if ((m = t.match(/(?:born|født)\s+(?:in\s+|i\s+)?(\d{4})/i))) { year = +m[1]; }
  else return null;
  if (!year || year < 1850 || year > now.getFullYear()) return null;
  // A death date near the birth date means the person is not alive: no "age" to report.
  if (/\b(died|død|–|—)\s*\d{0,2}\.?\s*[A-Za-zæøå]*\s*\d{4}\)/i.test(t.slice(0, 300)) || /\b(died|døde|død)\b/i.test(t.slice(0, 300))) {
    return { year, month: mon, day, age: null, deceased: true };
  }
  let age = now.getFullYear() - year;
  if (mon && day && (now.getMonth() + 1 < mon || (now.getMonth() + 1 === mon && now.getDate() < day))) age -= 1;
  return { year, month: mon, day, age, approximate: !(mon && day) };
}
