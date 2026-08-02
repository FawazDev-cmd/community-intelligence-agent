const labels = { technicalRelevance: 'Technical relevance', communityAlignment: 'Community alignment', contributionPotential: 'Contribution potential', productFit: 'Product fit' };
const titleCase = value => value.charAt(0).toUpperCase() + value.slice(1);
const list = values => values.slice(0, 5).map(value => `- ${value}`).join('\n');

export function buildSlackReport(member, analysis, timestamp = new Date().toISOString()) {
    const score = analysis.overallScore === null ? 'Not available' : `${analysis.overallScore}/100`;
    const color = analysis.overallScore === null ? '#808080' : analysis.overallScore >= 80 ? '#36a64f' : analysis.overallScore >= 60 ? '#ffb84d' : analysis.overallScore >= 40 ? '#ff9500' : '#ff4444';
    const fields = [`*Analysis status:* ${titleCase(analysis.status)}`, `*Score:* ${score}`, `*Confidence:* ${titleCase(analysis.confidence)}`, `*Manual review required:* ${analysis.manualReviewRequired ? 'Yes' : 'No'}`];
    const blocks = [
        { type: 'header', text: { type: 'plain_text', text: `New Member: ${member.name}` } },
        { type: 'section', fields: fields.map(text => ({ type: 'mrkdwn', text })) },
        { type: 'section', text: { type: 'mrkdwn', text: `*Category scores:*\n${Object.entries(analysis.categoryScores).map(([key, value]) => `- ${labels[key]}: ${value === null ? 'Not available' : `${value}/100`}`).join('\n')}` } }
    ];
    const add = (heading, values) => values.length && blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${heading}:*\n${list(values)}` } });
    add('Confirmed/public evidence', analysis.evidence.filter(item => item.type === 'confirmed').map(item => `${item.claim} Ã¢â‚¬â€ ${item.source}`));
    add('Possible matches (identity unverified)', analysis.evidence.filter(item => item.type === 'possible_match').map(item => `${item.claim} Ã¢â‚¬â€ ${item.source}`));
    add('Model inferences', analysis.inferences);
    add('Missing information', analysis.missingInformation);
    add('Recommendations', analysis.recommendations);
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Analyzed: ${timestamp}` }] });
    return { color, blocks, score };
}
