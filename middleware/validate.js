const { z } = require('zod');
const { ALLOWED_FSAS, isAllowedIntersection } = require('../utils/fsa');

function formatIssue(issues) {
    const first = issues[0];
    const field = first.path.join('.');
    let error;
    if (first.code === 'invalid_type' && first.received === 'undefined' && field) {
        error = `${field} required`;
    } else if (field) {
        error = `${field}: ${first.message}`;
    } else {
        error = first.message;
    }
    return error.charAt(0).toUpperCase() + error.slice(1);
}

function validate(schema) {
    return (req, res, next) => {
        const result = schema.safeParse(req.body);
        if (!result.success) {
            const error = formatIssue(result.error.issues);
            return res.status(400).json({ error, details: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
        }
        req.validated = result.data;
        next();
    };
}

function validateQuery(schema) {
    return (req, res, next) => {
        const result = schema.safeParse(req.query);
        if (!result.success) {
            const error = formatIssue(result.error.issues);
            return res.status(400).json({ error, details: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
        }
        req.validatedQuery = result.data;
        next();
    };
}

const fsaCode = z.string().trim().toUpperCase().refine((v) => ALLOWED_FSAS.includes(v), {
    message: `FSA must be one of ${ALLOWED_FSAS.join(', ')}`,
});

// 0 = "all clear" check-in (no smell). Excluded from heatmap counts and alert thresholds.
const SEVERITY_VALUES = [0, 1, 3, 5];
const POSITIVE_SEVERITY_VALUES = [1, 3, 5];
const ODOUR_TYPES = ['rotten-eggs', 'sewage', 'manure', 'chemical', 'other'];
const WINDOW_VALUES = ['24h', '7d', '30d', 'all'];

const schemas = {
    submitReport: z.object({
        fsa: fsaCode,
        severity: z.number().int().refine((v) => SEVERITY_VALUES.includes(v), { message: 'severity must be 0, 1, 3, or 5' }),
        odourType: z.enum(ODOUR_TYPES).optional(),
        description: z.string().trim().max(280, 'description must be 280 characters or fewer').optional(),
        intersection: z.string().refine((v) => isAllowedIntersection(v), {
            message: 'intersection must be one of the curated allow-list values',
        }).optional(),
        approxLat: z.number().finite().min(43).max(44).optional(),
        approxLng: z.number().finite().min(-80).max(-78).optional(),
        clientId: z.string().regex(/^[0-9a-f]{16,64}$/, 'clientId must be 16-64 lowercase hex chars'),
        turnstileToken: z.string().min(1).max(2048),
    }).refine((data) => (data.approxLat == null) === (data.approxLng == null), {
        message: 'approxLat and approxLng must both be provided or both omitted',
        path: ['approxLat'],
    }),

    subscribe: z.object({
        email: z.string().trim().email().max(254),
        fsas: z.array(fsaCode).min(1).max(12),
        thresholdSeverity: z.number().int().refine((v) => POSITIVE_SEVERITY_VALUES.includes(v), { message: 'thresholdSeverity must be 1, 3, or 5' }),
        turnstileToken: z.string().min(1).max(2048),
    }),

    unsubscribe: z.object({
        token: z.string().min(16).max(128),
    }),

    heatmapQuery: z.object({
        window: z.enum(WINDOW_VALUES).default('24h'),
    }),

    recentQuery: z.object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
    }),

    dotsQuery: z.object({
        window: z.enum(['24h', '7d']).default('24h'),
    }),

    timelineQuery: z.object({}).strict(),

    exportQuery: z.object({
        format: z.enum(['csv', 'json']).default('csv'),
        window: z.enum(['24h', '7d', '30d']).default('30d'),
    }),
};

module.exports = { validate, validateQuery, schemas, SEVERITY_VALUES, POSITIVE_SEVERITY_VALUES, ODOUR_TYPES, WINDOW_VALUES };
