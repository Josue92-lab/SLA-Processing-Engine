/**
 * Country-name → ISO-3166 alpha-2 normalization for the import layer.
 *
 * Why it lives here and NOT in `domain/countryResolver.js`:
 *   - This is a normalization concern of the import source, not a runtime
 *     behavior of the SLA engine. `domain/` stays pure and unaware.
 *
 * Inputs observed in the real exports:
 *   - Analyst file uses ISO-2 ("CL", "PE", "BR").
 *   - VIP file uses full English names ("Brazil", "Chile", "Peru").
 * Additionally we accept common Spanish and Portuguese variants
 * ("Brasil", "Perú", "México", "Panamá"). Matching is case-insensitive
 * and accent-tolerant where it costs us nothing.
 *
 * Pure module. No side effects on import. Unknown inputs return `null`;
 * the caller decides whether to emit a warning.
 */

// ISO-2 code set we accept by passthrough. The importer will still emit the
// value; `allowedCountries` in the settings layer is what gates what actually
// shows up in SLA outputs. Keeping this set broad is intentional.
const ISO2_PASSTHROUGH = /^[A-Z]{2}$/;

/**
 * name (lowercased, unaccented) -> ISO-2
 * EN + ES + PT variants for LAM + a handful of commonly-seen countries.
 * Extend conservatively. Unknown names must remain unknown (warning in plan).
 */
const NAME_TO_ISO2 = Object.freeze({
    // Argentina
    'argentina': 'AR',

    // Brazil
    'brazil': 'BR',
    'brasil': 'BR',

    // Chile
    'chile': 'CL',

    // Colombia
    'colombia': 'CO',

    // Costa Rica
    'costa rica': 'CR',

    // Ecuador
    'ecuador': 'EC',

    // El Salvador
    'el salvador': 'SV',
    'salvador':    'SV',

    // Guatemala
    'guatemala': 'GT',

    // Honduras
    'honduras': 'HN',

    // Mexico
    'mexico': 'MX',
    'mejico': 'MX',

    // Nicaragua
    'nicaragua': 'NI',

    // Panama
    'panama': 'PA',

    // Paraguay
    'paraguay': 'PY',

    // Peru
    'peru': 'PE',

    // Puerto Rico
    'puerto rico': 'PR',

    // Dominican Republic
    'dominican republic':  'DO',
    'republica dominicana': 'DO',
    'rep dominicana':       'DO',

    // Uruguay
    'uruguay': 'UY',

    // Venezuela
    'venezuela': 'VE',

    // Bolivia
    'bolivia': 'BO',

    // United States
    'united states':       'US',
    'united states of america': 'US',
    'usa':                 'US',
    'estados unidos':      'US',

    // Canada
    'canada': 'CA'
});

/**
 * Remove combining diacritical marks (NFD decomposition + \p{M} strip).
 * Keeps the caller's original string untouched.
 */
const stripDiacritics = (s) => s.normalize('NFD').replace(/\p{M}/gu, '');

/**
 * Normalize a country cell value (either an ISO-2 code or a country name)
 * into an ISO-2 code.
 *
 * @param {string|number|null|undefined} value - raw cell value
 * @returns {string|null} ISO-2 uppercase, or null if unresolvable
 */
export const normalizeCountry = (value) => {
    if (value === null || value === undefined) return null;
    const raw = String(value).trim();
    if (raw === '') return null;

    // ISO-2 fast path (case-insensitive). Must be exactly two ASCII letters.
    const upper = raw.toUpperCase();
    if (ISO2_PASSTHROUGH.test(upper)) return upper;

    // Name path: lowercase, strip diacritics, collapse internal whitespace.
    const key = stripDiacritics(raw.toLowerCase()).replace(/\s+/g, ' ').trim();
    return NAME_TO_ISO2[key] || null;
};

/**
 * Test helper: exposes the known alias table size so tests can detect
 * accidental regressions when the table is edited.
 */
export const _knownAliasCount = () => Object.keys(NAME_TO_ISO2).length;
