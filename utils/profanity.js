// Coarse-grained profanity/slur filter for free-text submissions
// (currently just /api/reports description).
//
// **WARNING — this file contains slur and profanity terms in plaintext** so
// the matching logic stays auditable. They live here, on purpose, and not
// scattered through the route file.
//
// Behavior: returns category flags ('slur', 'profanity') for any text
// containing matches. Callers strip the description from the stored report
// (rating still counts toward the heatmap, comment is dropped) — see
// routes/reports.js.
//
// Two-tier matching:
//
//   STRICT: word boundary on BOTH sides. Used for slurs that collide with
//   legitimate English words ('spic'/'spicy', 'retard'/'retardant',
//   'chink'/'chink-in-the-armor', 'fag'/'fag-end', 'gook' alone). Misses
//   inflections like 'retarded' as a tradeoff — rare in real abuse, common
//   in legit text.
//
//   PREFIX: word boundary at start only, catches inflections
//   ('niggers', 'faggots', 'fucking', 'shitty'). Used where no common
//   English word begins with the slur/profanity stem.
//
// Bypass tradeoffs: handles case folding and common leet substitutions
// (1→i, 0→o, 3→e, 4/@→a, $/5→s, 7→t, !/|→i). Does NOT handle spaced-out
// variants ('n i g g e r'), unicode lookalikes, or zero-width joiners.
// Determined attackers always evade — goal is keeping the public feed
// clean from drive-by trolls, not making abusive language unsubmittable.

// Strict-boundary slurs — match the word ALONE, not as a prefix. Required
// for any slur that collides with a legitimate English word.
const SLURS_STRICT = [
    'chink',     // collides with 'chink in the armor', 'chink of light'
    'spic',      // collides with 'spice', 'spicy', 'spices'
    'retard',    // collides with 'retardant' (fire-retardant smell)
    'fag',       // collides with 'fagged out', 'fag-end'
    'gook',      // pre-empt 'gooky'-type FPs even if rare
    'dyke',      // collides with surnames (Van Dyke) and geographic usage
];

// Prefix slurs — catch inflections. Safe because no common English word
// begins with these stems.
const SLURS_PREFIX = [
    'nigger', 'nigga',
    'faggot',
    'kike',
    'wetback',
    'tranny',
];

// Prefix profanity — catch inflections ('fucking', 'shitty', 'assholes').
// Known accepted FP: 'shitake' (mushroom). 'motherfuck' is included as its
// own stem because the boundary in 'motherfucker' is at the start of
// 'mother', not 'fuck' — \bfuck wouldn't match it.
const PROFANITY_PREFIX = [
    'fuck',
    'shit',
    'cunt',
    'asshole',
    'motherfuck',
    'bitch',
];

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// `(?!)` is a negative lookahead that can never succeed — used as a
// guard so an accidentally emptied list builds a never-matches regex
// instead of `\b(?:)` which matches at every word boundary.
const NEVER_MATCH = /(?!)/;

function buildStrictRegex(words) {
    if (!words.length) return NEVER_MATCH;
    const e = words.map(escapeRegex);
    return new RegExp(`\\b(?:${e.join('|')})\\b`, 'i');
}

function buildPrefixRegex(words) {
    if (!words.length) return NEVER_MATCH;
    const e = words.map(escapeRegex);
    return new RegExp(`\\b(?:${e.join('|')})`, 'i');
}

const SLUR_STRICT_RE = buildStrictRegex(SLURS_STRICT);
const SLUR_PREFIX_RE = buildPrefixRegex(SLURS_PREFIX);
const PROFANITY_RE = buildPrefixRegex(PROFANITY_PREFIX);

// In-word leet substitution. Catches 'n1gger', 'f@ggot', 'M0therfucker'
// where a leet char stands in for a letter inside a word. Non-word
// punctuation like '@' becomes a letter, which can erase a word
// boundary that the original punctuation provided — boundaryPreserve()
// is the counterpart that handles that case.
function normalize(text) {
    return String(text)
        .toLowerCase()
        .replace(/[1!|]/g, 'i')
        .replace(/0/g, 'o')
        .replace(/3/g, 'e')
        .replace(/[4@]/g, 'a')
        .replace(/[$5]/g, 's')
        .replace(/7/g, 't');
}

// Boundary-preserving leet substitution. Non-word punctuation (`!`, `|`,
// `@`, `$`) is replaced with a space so the word boundary survives, and
// only digit-leet (1, 0, 3, 4, 5, 7) is substituted in place. Catches
// '@nigger', '!fuck', '$shit', and combos like '@n1gger' that bypass
// the in-word pass.
function boundaryPreserve(text) {
    return String(text)
        .toLowerCase()
        .replace(/[!|@$]/g, ' ')
        .replace(/1/g, 'i')
        .replace(/0/g, 'o')
        .replace(/3/g, 'e')
        .replace(/4/g, 'a')
        .replace(/5/g, 's')
        .replace(/7/g, 't');
}

function flagProfanity(text) {
    if (!text || typeof text !== 'string') return [];
    const a = normalize(text);
    const b = boundaryPreserve(text);
    const flags = [];
    const isSlur = (s) => SLUR_STRICT_RE.test(s) || SLUR_PREFIX_RE.test(s);
    if (isSlur(a) || isSlur(b)) flags.push('slur');
    if (PROFANITY_RE.test(a) || PROFANITY_RE.test(b)) flags.push('profanity');
    return flags;
}

module.exports = { flagProfanity };
