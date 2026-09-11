// Classification + channel routing. Operates on a normalized job:
//   { id, title, company, locations: string[], url, postedAt, category? }

// --- Role level ------------------------------------------------------------

// Seniority markers.
//
// `staff` is deliberately narrow: "Member of Technical Staff" is the standard
// ENTRY title at the AI labs, so a bare \bstaff\b rejects exactly the roles this
// exists to find.
//
// A numeric level must either follow a role noun ("Engineer II" — which also
// keeps "Java 8 Developer" and "Python 3 Engineer" out of it) or END the title
// ("Software Engineer L5"). A free-floating /(l|t)[4-9]/ rejected "Software
// Engineer, L4 Autonomy Team" and "Perception Engineer - T5 Stack", where the
// token names a team or product; bare `t` is too ambiguous to match at all.
const SENIOR =
  /\b(senior|sr\.?|principal|lead(?!\s*generation)|manager|director|head\s+of|architect|distinguished|fellow|vp|president|executive|leader)\b|\bstaff\s+(software\s+)?(engineer|developer|scientist|researcher)\b|\b(engineer|developer|analyst|scientist|programmer|consultant)\s*(ii+|iv|vi*|[2-9])\b|\b(l|level)[- ]?[4-9]\)?\s*$|\b\d{2,}\+?\s*years?\b/i;

// The season/year clause is order-agnostic: real titles carry both
// "Summer 2027" and "2027 Summer".
const INTERN =
  /\b(intern(ship)?s?|co[\s-]?op|placement\s*(year|student)|(summer|winter|fall|spring)\s*20\d\d|20\d\d\s*(summer|winter|fall|spring)|apprentice(ship)?|working\s*student|praktikum|student\s*(worker|assistant|position)|undergraduate\s*research)\b/i;

// Gig/data-labelling spam that floods entry-level feeds.
const GIG =
  /\b(freelance|contract(or)?|part[\s-]?time|1099|gig\b|ai\s*trainer|data\s*(annotat|label)|tutor|survey|crowdsource|per[\s-]?diem|temp(orary)?\b|volunteer)\b/i;

const CLEARANCE =
  /\b(ts\/sci|top\s*secret|active\s*(security\s*)?clearance|polygraph|\bpoly\b|secret\s*clearance|us\s*citizen(ship)?\s*(is\s*)?required)\b/i;

// --- US eligibility: sponsorship + security clearance ----------------------
//
// Rule: exclude only on an EXPLICIT statement that sponsorship is not provided,
// or that a clearance is required. Silence includes the job. Every pattern below
// was written against sentences harvested from the live feeds, because the
// obvious regexes are wrong in ways only real postings reveal.
//
// Two categories of false positive have to be handled or this drops real jobs:
//
//  1. APPLICATION FORM QUESTIONS. A scraped board page carries the form as well
//     as the description: "Will you now or in the future require sponsorship for
//     employment visa status (e.g., H-1B)?" (Palantir, IMC Trading, Hatch IT)
//     and "Are you eligible to obtain the security clearance specified in the
//     job description?" (Palantir) are questions PUT TO THE CANDIDATE, not
//     statements of policy. Interrogatives are dropped wholesale.
//
//  2. PAGE CHROME. Stripping a whole document picks up nav and search widgets:
//     Huntington Ingalls' careers page yields "Clearance Required All" from a
//     filter dropdown. description.js prefers JSON-LD to avoid this; the
//     requirement patterns below are also anchored to verbs so a bare dropdown
//     label cannot match.

/**
 * Sentence split that keeps the terminator, so questions stay identifiable.
 *
 * Deliberately does NOT split on ":". Postings are full of "Label: value" runs
 * ("Minimum Clearance Required to Start: None"), and splitting there severs the
 * label from the value — which flipped CACI's explicitly clearance-FREE role
 * into "clearance required".
 *
 * Abbreviations are normalised first, because the periods inside "U.S." are not
 * sentence ends: splitting on them turned "U.S. Citizenship is required" into
 * "U." / "S." / "Citizenship is required", and no pattern can match across that.
 */
const ABBREV = [
  [/\bU\.\s*S\.\s*A\./gi, 'USA'],
  [/\bU\.\s*S\./gi, 'US'],
  [/\be\.\s*g\./gi, 'eg'],
  [/\bi\.\s*e\./gi, 'ie'],
  [/\betc\./gi, 'etc'],
  [/\bInc\./gi, 'Inc'],
  [/\bSt\./gi, 'St'],
  [/\bNo\./gi, 'No'],
  [/\bw\/\s*poly\b/gi, 'with polygraph'],
];

function sentences(text) {
  let s = String(text || '');
  for (const [re, to] of ABBREV) s = s.replace(re, to);
  return s
    .split(/(?<=[.!?;])\s+|\n+|(?=\s*[•·]\s)/)
    .map((x) => x.trim())
    .filter(Boolean);
}

const IS_QUESTION = /\?\s*$/;

// "sponsor" alone is far too broad. JHU APL's postings talk about "government
// sponsors" and "the research sponsor"; Prelim advertises "a sponsored 401K".
// The word only counts in an immigration context.
//
// Plurals matter: "We do not sponsor visas" is a real and common phrasing, and
// `\bvisa\b` does not match "visas".
const VISA_CONTEXT =
  /\b(visas?|immigration|h-?1b|h1-?b|green\s*cards?|work\s*(authorization|authorisation|permits?)|employment\s*eligibility|opt\b|cpt\b|tn\b|e-?3\b|work\s*status|sponsorship)\b/i;

// Explicitly WILL NOT sponsor.
const NO_SPONSOR = [
  /\b(not|unable|cannot|can'?t|won'?t|do(es)?\s*n[o']?t|will\s*not)\b[^.]{0,60}\bsponsor/i,
  /\bsponsorship\b[^.]{0,40}\b(is\s*)?(not|un)available\b/i,
  /\bno(t\s*eligible\s*for)?\s+(visa|immigration|employment)?\s*sponsorship\b/i,
  /\bwithout\b[^.]{0,40}\bsponsorship\b/i,
  /\bsponsorship\b[^.]{0,30}\bis\s*not\s*(offered|provided|available)\b/i,
  // "must be authorized to work ... without the need for employer sponsorship"
  /\b(authoriz|authoris)ed\s+to\s+work\b[^.]{0,80}\bwithout\b[^.]{0,40}\bsponsor/i,
  /\bdoes\s*not\s*(intend\s*to\s*hire|provide|offer|support)\b[^.]{0,60}\bsponsor/i,
];

// A hard US-citizenship requirement is stricter than "we do not sponsor" — no
// visa makes you eligible — so it is treated as denied sponsorship. Worded to
// need an explicit requirement: "U.S. citizens and permanent residents are
// encouraged to apply" is an EEO nicety, not a restriction.
const CITIZENSHIP_REQUIRED = [
  // `[\w\s]{0,30}` rather than `(\w+\s*){0,3}`: the nested quantifier in the
  // latter backtracks cubically on a long unbroken word run, and these patterns
  // run against third-party HTML the poller does not control. Measured at 18s
  // for a 2,000-char run — enough to stall the whole poll past the job timeout.
  /\b(u\.?s\.?|united\s*states|american)\s*citizen(ship)?\s*(is\s*)?[\w\s]{0,30}(required|mandatory)\b/i,
  /\bmust\s+be\s+(a\s+)?(u\.?s\.?|united\s*states|american)\s+citizen\b/i,
  /\brequires?\s+(u\.?s\.?|united\s*states|american)\s+citizenship\b/i,
  /\brestricted\s+to\s+(u\.?s\.?|united\s*states)\s+citizens\b/i,
];

// Explicitly WILL sponsor — checked first so "we are able to sponsor" is never
// caught by a "not ... sponsor" pattern reading across a clause boundary.
const WILL_SPONSOR = [
  /\b(open\s*to|willing\s*to|happy\s*to|able\s*to|will|do|does|can)\s+sponsor/i,
  /\bsponsorship\s+(is\s+)?(available|offered|provided|possible)\b/i,
  /\bwe\s+(offer|provide)\b[^.]{0,30}\bsponsorship\b/i,
  /\bvisa\s+support\s+(is\s+)?available\b/i,
];

/** True when the text states a hard US citizenship / ITAR "US Person" gate. */
export function citizenshipRequired(text) {
  for (const s of sentences(text)) {
    if (IS_QUESTION.test(s)) continue;
    if (CITIZENSHIP_REQUIRED.some((re) => re.test(s))) return true;
  }
  return false;
}

/** 'denied' | 'offered' | 'none' — 'none' means the posting is silent. */
export function sponsorshipStatus(text) {
  let denied = false;
  for (const s of sentences(text)) {
    if (IS_QUESTION.test(s)) continue; // application-form field, not policy
    if (CITIZENSHIP_REQUIRED.some((re) => re.test(s))) return 'denied';
    if (!VISA_CONTEXT.test(s)) continue;
    if (WILL_SPONSOR.some((re) => re.test(s))) return 'offered';
    if (NO_SPONSOR.some((re) => re.test(s))) denied = true;
  }
  return denied ? 'denied' : 'none';
}

// A SECURITY clearance specifically, and an actual requirement. Bare
// "clearance" is not enough: Noblis asks for "Ability to obtain FAA clearance"
// on an ordinary full-stack role, which is not a security clearance and must
// not exclude the job. "Learn more about the background check process for
// Security Clearances" (Sierra Nevada) and a "#clearance" hashtag (V2X) are
// also excluded, by requiring a requirement verb rather than the noun alone.
const CLEARANCE_WORD =
  /\b(security\s+clearance|clearance\s+level|clearance\s+requirements?|ts\/sci|top\s*secret|secret\s+clearance|dod\s+clearance|government\s+clearance|interim\s+secret|polygraph|active\s+(secret|clearance))\b/i;
// "may be required depending on program" (Anduril) is a conditional, not a
// requirement — it must not exclude an otherwise open role.
const CONDITIONAL = /\b(may|might|could)\s+(be\s+)?(required|need)/i;
const CLEARANCE_REQUIRED = [
  /\b(must|shall)\s+(have|hold|possess|obtain|maintain|be\s+able\s+to\s+obtain)\b[^.]{0,60}\bclearance\b/i,
  /\b(ability|able)\s+to\s+obtain\b[^.]{0,60}\bclearance\b/i,
  /\bclearance\b[^.]{0,40}\b(is\s+)?required\b/i,
  /\brequire[sd]?\b[^.]{0,40}\bclearance\b/i,
  /\bactive\b[^.]{0,30}\bclearance\b/i,
  /\b(hold|holding|possess)\s+(an?\s+)?(active|current|interim)\b[^.]{0,40}\bclearance\b/i,
  /\bclearance\s*(level)?\s*:\s*(active|current|top\s*secret|ts\/sci|secret|interim)/i,
  /\bclearance\s*requirements?\s*:/i,
  /\b(ts\/sci|top\s*secret)\b[^.]{0,40}\b(clearance|required|with\s+polygraph)\b/i,
  /\bsubject\s+to\b[^.]{0,50}\bsecurity\s+clearance\s+investigation\b/i,
  /\beligibility\s+(for|to\s+obtain)\b[^.]{0,40}\bclearance\b/i,
];
// Explicitly NOT needed. CACI ships "Minimum Clearance Required to Start: None"
// on roles that genuinely need none.
const CLEARANCE_NOT_REQUIRED = [
  /\bclearance\b[^.]{0,40}\b(not\s+required|none)\b/i,
  /\bno\s+(security\s+)?clearance\s+(is\s+)?(required|needed)\b/i,
  /\bminimum\s+clearance\s+required\s*(to\s+start)?\s*:?\s*none\b/i,
  /\bdoes\s+not\s+require\b[^.]{0,40}\bclearance\b/i,
];

/** 'required' | 'not-required' | 'none' */
export function clearanceStatus(text) {
  let required = false;
  let explicitlyNot = false;
  for (const s of sentences(text)) {
    if (IS_QUESTION.test(s)) continue;
    if (!CLEARANCE_WORD.test(s)) continue;
    if (CLEARANCE_NOT_REQUIRED.some((re) => re.test(s))) {
      explicitlyNot = true;
      continue;
    }
    if (CONDITIONAL.test(s)) continue;
    if (CLEARANCE_REQUIRED.some((re) => re.test(s))) required = true;
  }
  // A requirement stated anywhere outweighs a "none to start": CACI says both,
  // and the second sentence is "you will be required to obtain a Top Secret
  // clearance" as a condition of continued employment.
  if (required) return 'required';
  return explicitlyNot ? 'not-required' : 'none';
}

/**
 * Should a US-routed posting be alerted on?
 *
 * Excludes ONLY an explicit "we do not sponsor" (which includes a hard US
 * citizenship requirement — no visa makes you eligible for one) or an explicit
 * clearance requirement. Anything else — including a description that could not
 * be fetched — is included, so a scrape failure can never silently hide a role.
 *
 * The title is checked alongside the description because a clearance
 * requirement is often stated only there ("Software Engineer - Active TS/SCI").
 */
export function usEligibility(job) {
  // Simplify's curated tag is authoritative where present, and is the only
  // signal available for boards that refuse programmatic reads (iCIMS answers
  // HTTP 405 to any GET, which covers General Dynamics and Peraton).
  const tag = job.sponsorshipTag || '';
  if (/does\s*not\s*offer\s*sponsorship/i.test(tag)) {
    return { ok: false, reason: 'no sponsorship', sponsorship: 'denied' };
  }
  if (/citizenship\s*is\s*required/i.test(tag)) {
    return { ok: false, reason: 'US citizenship required', sponsorship: 'denied' };
  }

  const text = `${job.title || ''}. ${job.description || ''}`;
  // Reported separately from plain "no sponsorship" so the log names the real
  // barrier: an ITAR "US Person" clause (citizen / permanent resident / asylee)
  // is not the same thing as a company declining to file an H-1B.
  if (citizenshipRequired(text)) {
    return { ok: false, reason: 'US citizenship required', sponsorship: 'denied' };
  }
  const sponsorship = sponsorshipStatus(text);
  if (sponsorship === 'denied') return { ok: false, reason: 'no sponsorship', sponsorship };
  // Only consult clearance when sponsorship is unstated or offered.
  const clearance = clearanceStatus(text);
  if (clearance === 'required') return { ok: false, reason: 'clearance required', sponsorship, clearance };
  return { ok: true, sponsorship, clearance };
}

// Positive entry-level signal. Required for company ATS boards, which list every
// role a company has open — without it "Software Engineer, Database Infrastructure"
// at Stripe reads as new-grad simply because the title says neither senior nor intern.
const NEW_GRAD =
  /\b(new\s*(college\s*)?grad(uate)?s?|university\s*(grad(uate)?|hire|recruit)|campus|early\s*career|entry[\s-]*level|grad(uate)?\s*(program|scheme|rotation|rotational|engineer|developer|analyst|role)|rotational\s*program|leadership\s*development\s*program|junior|associate|apprentice\s*engineer|\b(20)2[5-9]\s*grad(uate)?s?\b|class\s*of\s*(20)?2[5-9])\b|\b(engineer|developer|analyst|scientist|programmer)\s*(i|1)\b|\((20)2[5-9]\s*(start|grad)/i;

/**
 * @param job normalized job; `newGradScoped` marks a source that is already
 *   curated to new-grad roles (the Simplify repo), where no title signal is needed.
 */
export function isNewGrad(job) {
  const t = job.title || '';
  if (INTERN.test(t) || SENIOR.test(t) || GIG.test(t)) return false;
  return job.newGradScoped === true || NEW_GRAD.test(t);
}

// --- Software role ---------------------------------------------------------
//
// An ALLOWLIST: a title must positively look like a build-software job.
//
// The previous design did the opposite — Simplify's `category` was an outright
// pass, so every row the aggregator tagged "AI/ML/Data" was alerted on no matter
// what the title said, and a blocklist was left to catch the fallout. That is
// how "Broista", "Barback", "Sales Associate", "Customer Service Representative"
// and "Research Assistant" reached the channel: a blocklist can only ever name
// the junk it has already seen. `category` is no longer a signal at all — it is
// wrong too often in both directions (real SWE roles arrive tagged "Hardware").

// Titles that read as software on sight, with no supporting domain word needed.
// Covers "Software Engineering Associate", "Software Development Graduate - AI"
// and "Graduate Programmer", none of which name a domain.
const SOFTWARE_PHRASE =
  /\bsoftware\s*(engineer|develop|dev\b|architect|programm)|\b(swe|sde|sdet)s?\b|\bprogrammer\b/i;

// Nouns that mean "you will write code". `analyst`, `scientist`, `technologist`
// and `specialist` are deliberately absent: "Data Analyst", "Business
// Intelligence Analyst", "Associate Data Scientist" and "Robot Teleoperation
// Specialist" are precisely what this filter exists to drop. `development` is
// absent too — it matches "Analytics Leadership Development Program" far more
// often than a dev job, and SOFTWARE_PHRASE already covers "Software Development".
const BUILD_NOUN = /\b(engineer(ing)?|developer|programmer|architect)\b/i;

// Domains whose engineers write code. Required ALONGSIDE a build noun, never
// sufficient alone: "Investment Banking Analyst I - Energy, Infrastructure, &
// Transition" and "Analyst I, Equity Solutions Group" both used to pass on
// `infrastructure` / `solutions` while `analyst` still counted as an engineering
// noun. `solutions` is gone for that reason; `sql` stays so "SQL Server
// Developer" survives. `product` is absent because at a chip maker "Product
// Engineer" is a hardware job (Texas Instruments, Micron, Renesas all post one)
// and a software one always says so elsewhere in the title.
const SOFTWARE_DOMAIN =
  /\b(software|full[\s-]?stack|front[\s-]?end|frontend|back[\s-]?end|backend|web|mobile|ios|android|game|graphics|compiler|kernel|operating\s*systems?|distributed|platform|infrastructure|cloud|devops|sre|site\s*reliability|embedded|firmware|application|api|sql|database|data|machine\s*learning|deep\s*learning|ml|ai|artificial\s*intelligence|agentic|llm|algorithm(s)?|robotic(s)?|autonomy|autonomous|perception|comput(er|ational)|systems?|security|cyber|network(ing)?|qa|quality\s*assurance|automation|performance|forward\s*deployed|research|technology|quant(itative)?|simulation)\b/i;

// A title may name the language instead of the domain — "Java Developer",
// ".Net Developer", "Graduate C++ Developer" — which is a build noun with no
// domain word at all. Those ~37 live postings reached the channel through the
// old `category` pass and would otherwise be silently lost by the allowlist.
// Not folded into SOFTWARE_DOMAIN because `c++` and `c#` cannot sit inside a
// `\b(...)\b` wrapper: the trailing \b after `+` demands a word character, so
// "Graduate C++ Developer" would never match.
const SOFTWARE_LANG =
  /\bjava\b|\bjavascript\b|\btypescript\b|\bpython\b|\bgolang\b|\bruby\b|\brails\b|\bphp\b|\bscala\b|\bkotlin\b|\bswift\b|\brust\b|\bperl\b|\bcobol\b|\bfortran\b|\babap\b|\bangular\b|\breact\b|\bnode(\.js)?\b|\bsalesforce\b|\bservicenow\b|\bpega\b|\bsap\b|\bmainframe\b|c\+\+|c#|\.net\b|\bdotnet\b/i;

// A build noun beside a software domain can still describe a non-coding job.
// "Engineering Technician - Abuse Test & Engineering" and "Systems
// Engineer/Analyst" both pair correctly; the qualifier is what disqualifies them.
// `operations specialist` is spelled out rather than a bare `specialist` so that
// "Software Engineering TRAIL Operations Specialist" is rejected without also
// rejecting a genuine "Software Development Specialist".
const NOT_BUILDING =
  /\btechnician\b|\boperations\s*specialist\b|\b(engineer(ing)?|developer)\s*\/\s*(analyst|scientist)\b|\b(analyst|scientist)\s*\/\s*(engineer(ing)?|developer)\b/i;

export function isSweRole(job) {
  const t = job.title || '';
  if (NOT_BUILDING.test(t)) return false;
  if (SOFTWARE_PHRASE.test(t)) return true;
  return BUILD_NOUN.test(t) && (SOFTWARE_DOMAIN.test(t) || SOFTWARE_LANG.test(t));
}

export function needsClearance(job) {
  return CLEARANCE.test(job.title || '');
}

// --- Country routing -------------------------------------------------------
// Order matters. US state codes/names are matched before Canadian city names so
// "Vancouver, WA", "London, KY", "Waterloo, IA" and "Ontario, CA" (California)
// do not leak into the Canada channel.

const CA_PROVINCE = /(^|,)\s*(ON|BC|QC|AB|MB|SK|NS|NB|NL|PE|PEI|YT|NT|NU)\s*(,|$)/;
const CA_PROVINCE_NAME =
  /\b(ontario|british columbia|quebec|québec|alberta|manitoba|saskatchewan|nova scotia|new brunswick|newfoundland|prince edward island|yukon|nunavut|northwest territories)\b/i;
const CA_CITY =
  /\b(toronto|vancouver|montr[eé]al|montreal|ottawa|calgary|edmonton|winnipeg|halifax|saskatoon|regina|mississauga|brampton|markham|burnaby|kitchener|waterloo|guelph|kelowna|gatineau|laval|sherbrooke|oakville|oshawa|burlington|whitehorse|yellowknife|iqaluit|moncton|fredericton|charlottetown)\b/i;

const US_STATE_CODE =
  /,\s*(A[LKZR]|C[AOT]|DE|DC|FL|GA|HI|I[DLNA]|K[SY]|LA|M[EDAINSOT]|N[EVHJMYCD]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[TA]|W[AVIY])\s*(,|$)/;
const US_STATE_NAME =
  /^\s*(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|puerto rico)\s*$/i;
const US_SHORTHAND =
  /^\s*(nyc|sf|south sf|la|bay area|dmv|remote in (the )?us(a)?|us remote|united states|usa)\s*$/i;

const NON_NA =
  /\b(uk|united kingdom|england|scotland|wales|ireland|india|germany|france|spain|italy|portugal|poland|netherlands|belgium|sweden|norway|denmark|finland|switzerland|austria|czech|romania|hungary|greece|turkey|israel|uae|dubai|singapore|australia|new zealand|japan|korea|china|hong kong|taiwan|vietnam|thailand|philippines|indonesia|malaysia|brazil|argentina|chile|colombia|mexico|costa rica|south africa|nigeria|kenya|egypt|emea|apac|latam)\b/i;

// US cities, checked LAST — after the Canadian and non-North-American tests, so
// an ambiguous name resolves the safe way: "London, UK" is already OTHER and
// "Waterloo, ON" already CA by the time this runs.
//
// Without this there was no US city list at all (only CA_CITY), so a board that
// names cities without a state code routed NOWHERE: `countryOf` returned
// UNKNOWN, `channelsFor` returned [], and poll.js seeds a channel-less job as
// "decided" — silently discarding it forever with no retry. That is what
// happened to Stripe's "Software Engineer, New Grad", whose location string is
// the bare "San Francisco, Seattle, New York".
//
// Names shared with a Canadian or UK city are deliberately EXCLUDED (london,
// vancouver, waterloo, cambridge, richmond, windsor, hamilton, kingston,
// victoria, manchester, birmingham, durham, york), because those only reach
// this line when the string carries no country or state at all — exactly the
// case where guessing US would be wrong.
const US_CITY =
  /\b(san francisco|south san francisco|palo alto|mountain view|sunnyvale|santa clara|san jose|san mateo|redwood city|menlo park|cupertino|fremont|oakland|berkeley|emeryville|foster city|san bruno|pleasanton|culver city|el segundo|santa monica|los angeles|san diego|irvine|pasadena|sacramento|seattle|bellevue|redmond|kirkland|tacoma|portland|beaverton|hillsboro|boise|denver|boulder|colorado springs|salt lake city|provo|lehi|phoenix|scottsdale|tempe|chandler|tucson|albuquerque|las vegas|reno|austin|dallas|plano|irving|houston|san antonio|fort worth|oklahoma city|tulsa|wichita|omaha|des moines|minneapolis|st\.? paul|milwaukee|madison|chicago|evanston|naperville|indianapolis|columbus|cincinnati|cleveland|detroit|ann arbor|grand rapids|st\.? louis|kansas city|nashville|memphis|knoxville|huntsville|birmingham, al|atlanta|charlotte|raleigh|durham, nc|greensboro|charleston|savannah|jacksonville|orlando|tampa|miami|fort lauderdale|boston|somerville|waltham|burlington, ma|worcester|providence|hartford|stamford|new haven|new york|new york city|brooklyn|queens|manhattan|bronx|jersey city|hoboken|newark|princeton|trenton|philadelphia|pittsburgh|harrisburg|allentown|baltimore|annapolis|washington, ?d\.?c\.?|arlington, va|alexandria, va|reston|herndon|mclean|tysons|bethesda|rockville|silver spring|buffalo|rochester, ny|syracuse|albany, ny|bentonville|little rock|louisville|lexington, ky|new orleans|baton rouge|jackson, ms|billings|cheyenne|fargo|sioux falls|anchorage|honolulu|richland, wa|dayton|akron|toledo|fort collins|santa barbara|san luis obispo|ventura|bakersfield|fresno|long beach|anaheim|riverside|chattanooga|greenville|columbia, sc|melbourne, fl|boca raton|naples, fl|sarasota)\b/i;

export function countryOf(location = '') {
  const l = String(location).trim();
  if (!l) return 'UNKNOWN';
  if (/\bcanada\b/i.test(l)) return 'CA';
  if (US_SHORTHAND.test(l) || US_STATE_NAME.test(l)) return 'US';
  if (/\b(u\.?s\.?a?\.?|united states)\b/i.test(l)) return 'US';
  if (US_STATE_CODE.test(l)) return 'US';           // before CA_CITY: "Vancouver, WA"
  if (CA_PROVINCE.test(l) || CA_PROVINCE_NAME.test(l)) return 'CA';
  if (NON_NA.test(l)) return 'OTHER';
  if (CA_CITY.test(l)) return 'CA';
  if (US_CITY.test(l)) return 'US';                 // after CA_CITY and NON_NA
  if (/\bremote\b/i.test(l)) return 'US';           // bare "Remote" skews US in these feeds
  return 'UNKNOWN';
}

// A job may list several locations; return every channel it belongs in.
// A structured country field from the ATS wins — but only when it is actually
// populated. 1Password's Ashby board leaves addressCountry as "" on 39 of 62
// postings, one of them a Canada-eligible remote role, so an empty value must
// fall through to the location strings rather than routing the job nowhere.
export function channelsFor(job) {
  if (job.country === 'US' || job.country === 'CA') return [job.country];
  const locs = job.locations || [];
  const seen = new Set(locs.map(countryOf));
  // countryOf returns a single country, so "Remote - US or Canada" resolves to
  // CA alone and never reaches #usa. Dual-eligible strings belong in both.
  for (const l of locs) {
    if (/\bcanada\b/i.test(l) && /\b(u\.?s\.?a?\.?|united states|america)\b/i.test(l)) {
      seen.add('US');
      seen.add('CA');
    }
  }
  return ['US', 'CA'].filter((c) => seen.has(c));
}
