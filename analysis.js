const KEYS = ['technicalRelevance', 'communityAlignment', 'contributionPotential', 'productFit'];

export function failedAnalysis(reason = 'Analysis could not be completed.') {
    return { status: 'failed', categoryScores: Object.fromEntries(KEYS.map(key => [key, null])), overallScore: null, confidence: 'none', evidence: [], inferences: [], missingInformation: [reason], recommendations: ['Manual review recommended.'], manualReviewRequired: true };
}

export function normalizeAnalysisResponse(response) {
    try {
        const text = typeof response === 'string' ? response : response?.content;
        if (typeof text !== 'string') throw new Error('Response is not text');
        const clean = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
        const start = clean.indexOf('{');
        const end = clean.lastIndexOf('}');
        if (start < 0 || end < start) throw new Error('No JSON object');
        const value = JSON.parse(clean.slice(start, end + 1));
        if (!['completed', 'incomplete', 'failed'].includes(value.status)) throw new Error('Invalid status');
        if (!['low', 'medium', 'high', 'none'].includes(value.confidence)) throw new Error('Invalid confidence');
        if (typeof value.manualReviewRequired !== 'boolean' || !value.categoryScores) throw new Error('Missing required field');
        const categoryScores = {};
        for (const key of KEYS) {
            const score = value.categoryScores[key];
            if ((value.status === 'failed' || value.status === 'incomplete') && score === null) categoryScores[key] = null;
            else if (value.status !== 'failed' && typeof score === 'number' && Number.isFinite(score)) categoryScores[key] = Math.round(Math.max(0, Math.min(100, score)));
            else throw new Error(`Invalid score: ${key}`);
        }
        for (const field of ['inferences', 'missingInformation', 'recommendations']) if (!Array.isArray(value[field]) || value[field].some(item => typeof item !== 'string')) throw new Error(`Invalid ${field}`);
        if (!Array.isArray(value.evidence) || value.evidence.some(item => !item || typeof item.claim !== 'string' || typeof item.source !== 'string' || !['confirmed', 'possible_match'].includes(item.type))) throw new Error('Invalid evidence');
        if (value.status === 'failed') return failedAnalysis(value.missingInformation[0]);
        if (value.confidence === 'none') throw new Error('Invalid confidence');
        const scores = Object.values(categoryScores).filter(score => score !== null);
        if (!scores.length) throw new Error('No scores');
        return { status: value.status, categoryScores, overallScore: Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length), confidence: value.confidence, evidence: value.evidence.map(item => ({ claim: item.claim.trim(), source: item.source.trim(), type: item.type })).filter(item => item.claim && item.source), inferences: value.inferences.map(item => item.trim()).filter(Boolean), missingInformation: value.missingInformation.map(item => item.trim()).filter(Boolean), recommendations: value.recommendations.map(item => item.trim()).filter(Boolean), manualReviewRequired: true };
    } catch {
        return failedAnalysis('Model output was invalid and requires manual review.');
    }
}

export function validateMemberInfo(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return 'memberInfo must be a plain object';
    if (typeof value.name !== 'string' || !value.name.trim()) return 'memberInfo.name must be a non-empty string';
    if (value.email !== undefined && typeof value.email !== 'string') return 'memberInfo.email must be a string';
    if (value.title !== undefined && typeof value.title !== 'string') return 'memberInfo.title must be a string';
    if (value.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)) return 'memberInfo.email is malformed';
    return null;
}
