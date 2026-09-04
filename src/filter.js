// Classification + channel routing. Operates on a normalized job:
//   { id, title, company, locations: string[], url, postedAt, category? }

// --- Role level ------------------------------------------------------------

// Seniority markers. Numeric levels must follow a role noun so "Java 8 Developer"
// and "Python 3 Engineer" are not mistaken for level-8 roles.
const SENIOR =
  /\b(senior|sr\.?|staff|principal|lead(?!\s*generation)|manager|director|head\s+of|architect|distinguished|fellow|vp|president|executive|leader)\b|\b(engineer|developer|analyst|scientist|programmer|consultant)\s*(ii+|iv|vi*|[2-9])\b|\b(l|level|t)[- ]?[4-9]\b|\b\d{2,}\+?\s*years?\b/i;

const INTERN =
  /\b(intern(ship)?s?|co[\s-]?op|placement\s*(year|student)|summer\s*20\d\d|winter\s*20\d\d|fall\s*20\d\d|spring\s*20\d\d|apprentice(ship)?|working\s*student|praktikum|student\s*(worker|assistant|position)|undergraduate\s*research)\b/i;

// Gig/data-labelling spam that floods entry-level feeds.
const GIG =
  /\b(freelance|contract(or)?|part[\s-]?time|1099|gig\b|ai\s*trainer|data\s*(annotat|label)|tutor|survey|crowdsource|per[\s-]?diem|temp(orary)?\b|volunteer)\b/i;

const CLEARANCE =
  /\b(ts\/sci|top\s*secret|active\s*(security\s*)?clearance|polygraph|\bpoly\b|secret\s*clearance|us\s*citizen(ship)?\s*(is\s*)?required)\b/i;

// A SWE title needs BOTH an engineering noun and a technical domain. Matching a
// domain word alone let "Regulatory Counsel, AI Regulation" and "Designer, Web,
// Presence & Platform" through as software roles.
const ENG_NOUN =
  /\b(engineer(ing)?|developer|programmer|scientist|analyst|sde|swe|technologist)\b/i;
const SWE_DOMAIN =
  /\b(software|swe|sde|full[\s-]?stack|front[\s-]?end|back[\s-]?end|web|mobile|ios|android|platform|infrastructure|devops|sre|site\s*reliability|embedded|firmware|compiler|distributed|database|network(ing)?|security|cloud|data|machine\s*learning|deep\s*learning|ml|ai|artificial\s*intelligence|research|quant(itative)?|comput(er|ational)|systems?|solutions?|qa|test|automation|application)\b/i;

// Simplify's `category` values worth alerting on by default.
const DEFAULT_CATEGORIES =
  /^(software|software engineering|ai\/ml\/data|data science, ai & machine learning)$/i;

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

export function isSweRole(job, { categories = DEFAULT_CATEGORIES } = {}) {
  if (job.category && categories.test(job.category)) return true;
  const t = job.title || '';
  return ENG_NOUN.test(t) && SWE_DOMAIN.test(t);
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
  const seen = new Set((job.locations || []).map(countryOf));
  return ['US', 'CA'].filter((c) => seen.has(c));
}
