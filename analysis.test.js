import test from 'node:test';
import assert from 'node:assert/strict';
import { failedAnalysis, normalizeAnalysisResponse } from './analysis.js';
import { buildSlackReport } from './slack-format.js';

const valid = { status: 'completed', categoryScores: { technicalRelevance: 80, communityAlignment: 70, contributionPotential: 90, productFit: 60 }, overallScore: 1, confidence: 'medium', evidence: [{ claim: 'Public profile found', source: 'company.example', type: 'confirmed' }], inferences: ['May benefit from onboarding'], missingInformation: ['Budget authority'], recommendations: ['Ask about goals'], manualReviewRequired: true };

test('normalizes valid structured Gemini JSON and derives overall score', () => {
    const result = normalizeAnalysisResponse(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``);
    assert.equal(result.status, 'completed');
    assert.equal(result.overallScore, 75);
});

test('malformed output produces a failed result with no score', () => {
    const result = normalizeAnalysisResponse('not json');
    assert.equal(result.status, 'failed');
    assert.equal(result.overallScore, null);
    assert.deepEqual(Object.values(result.categoryScores), [null, null, null, null]);
});

test('numeric scores are clamped but non-numeric scores fail safely', () => {
    const clamped = normalizeAnalysisResponse(JSON.stringify({ ...valid, categoryScores: { ...valid.categoryScores, technicalRelevance: 120 } }));
    assert.equal(clamped.categoryScores.technicalRelevance, 100);
    const invalid = normalizeAnalysisResponse(JSON.stringify({ ...valid, categoryScores: { ...valid.categoryScores, technicalRelevance: '80' } }));
    assert.equal(invalid.status, 'failed');
    assert.equal(invalid.overallScore, null);
});

test('failed Slack report says Not available rather than 50', () => {
    const report = buildSlackReport({ name: 'Test Member' }, failedAnalysis());
    const text = JSON.stringify(report.blocks);
    assert.match(text, /Analysis status:\* Failed/);
    assert.match(text, /Score:\* Not available/);
    assert.doesNotMatch(text, /50\/100/);
});

test('possible GitHub matches are clearly marked unverified', () => {
    const analysis = { ...valid, overallScore: 75, evidence: [{ claim: 'Possible GitHub profile', source: 'github.com/example', type: 'possible_match' }] };
    const text = JSON.stringify(buildSlackReport({ name: 'Test Member' }, analysis).blocks);
    assert.match(text, /Possible matches \(identity unverified\)/);
});
