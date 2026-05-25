/**
 * Import applier - Pure Source-of-Truth implementation.
 *
 */

const EMPTY_IMPORT = Object.freeze({
    excludedEmails: [],
    vipUsers: [],
    emailTimeZoneMappings: {},
    emailCountries: []
});

/**
 * @param {object} currentSettings
 * @param {object} newImp
 * @param {object} previousImp
 * @param {object} [opts]
 * @param {string} [opts.mode] - 'external' | 'internal'
 * @param {() => string} [opts.now] - ISO-string factory
 * @returns {{ nextSettings: object, nextLastImport: object }}
 *
 */
export const apply = (currentSettings, newImp, previousImp = EMPTY_IMPORT, opts = {}) => {
    const mode = opts.mode || null;
    const now = opts.now || (() => new Date().toISOString());

    const next = withDefaults(newImp);

    // Comportamiento "Source-of-Truth Sync": 
    // Lo que produce la importación actual se convierte en el estado absoluto en disco.
    // Si un ítem ya no viene en la carga de soporte, desaparece del JSON automáticamente.
    const nextSettings = {
        ...currentSettings,
        excludedEmails:        [...next.excludedEmails],
        vipUsers:              next.vipUsers.map(v => ({ ...v })),
        emailTimeZoneMappings: { ...next.emailTimeZoneMappings },
        emailCountries:        next.emailCountries.map(v => ({ ...v })),
        // allowedCountries explícitamente fijado, nunca se toca por las importaciones
        allowedCountries:      currentSettings.allowedCountries || []
    };

    const nextLastImport = {
        importedAt:            now(),
        mode,
        excludedEmails:        next.excludedEmails.slice(),
        vipUsers:              next.vipUsers.map(v => ({ ...v })),
        emailTimeZoneMappings: { ...next.emailTimeZoneMappings },
        emailCountries:        next.emailCountries.map(v => ({ ...v }))
    };

    return { nextSettings, nextLastImport };
};

const withDefaults = (imp) => ({
    excludedEmails:        imp.excludedEmails        || [],
    vipUsers:              imp.vipUsers              || [],
    emailTimeZoneMappings: imp.emailTimeZoneMappings || {},
    emailCountries:        imp.emailCountries        || []
});