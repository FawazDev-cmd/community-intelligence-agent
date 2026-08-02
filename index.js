import pkg from '@slack/bolt';
const { App } = pkg;
import { WebClient } from '@slack/web-api';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import express from 'express';
import dotenv from 'dotenv';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { initDatabase, saveMemberAnalysis, markAsSentToSlack, closeDatabase } from './db.js';
import { failedAnalysis, normalizeAnalysisResponse, validateMemberInfo } from './analysis.js';
import { buildSlackReport } from './slack-format.js';

dotenv.config();
const log = { info: (msg, ...args) => console.log(`[INFO] ${msg}`, ...args), error: (msg, ...args) => console.error(`[ERROR] ${msg}`, ...args), debug: (msg, ...args) => process.env.NODE_ENV === 'development' && console.log(`[DEBUG] ${msg}`, ...args) };

export class SlackAIAgent {
    constructor() {
        if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required to start the Community Intelligence Agent.');
        if (!process.env.GEMINI_MODEL) throw new Error('GEMINI_MODEL is required to start the Community Intelligence Agent.');
        this.app = express();
        this.slack = new App({ token: process.env.SLACK_BOT_TOKEN, signingSecret: process.env.SLACK_SIGNING_SECRET, socketMode: true, appToken: process.env.SLACK_APP_TOKEN });
        this.webClient = new WebClient(process.env.SLACK_BOT_TOKEN);
        this.llm = new ChatGoogleGenerativeAI({ model: process.env.GEMINI_MODEL, apiKey: process.env.GEMINI_API_KEY, temperature: 0.2 });
        this.setupSlackEvents();
        this.setupExpress();
    }

    setupSlackEvents() {
        this.slack.event('team_join', async ({ event }) => {
            try { await this.analyzeAndPostMember(await this.getUserInfo(event.user.id)); } catch (error) { log.error('Error processing team_join:', error.message); }
        });
        this.slack.event('member_joined_channel', async ({ event }) => {
            try { if (event.channel_type === 'C') await this.analyzeAndPostMember(await this.getUserInfo(event.user)); } catch (error) { log.error('Error processing member_joined_channel:', error.message); }
        });
        this.slack.error(async error => log.error('Slack error:', error.message));
    }

    setupExpress() {
        this.app.use(express.json());
        this.app.get('/health', (req, res) => res.json({ status: 'healthy', timestamp: new Date().toISOString() }));
        if (process.env.NODE_ENV === 'development') this.app.post('/test/analyze-member', async (req, res) => {
            const validationError = validateMemberInfo(req.body?.memberInfo);
            if (validationError) return res.status(400).json({ error: validationError });
            try { return res.json(await this.analyzeAndPostMember(req.body.memberInfo)); }
            catch (error) { log.error('Test analysis error:', error.message); return res.status(500).json({ error: 'Analysis failed' }); }
        });
        this.app.use((err, req, res, next) => { log.error('Express error:', err.message); res.status(500).json({ error: 'Internal server error' }); });
    }

    async getUserInfo(userId) {
        const user = (await this.webClient.users.info({ user: userId })).user;
        return { id: user.id, name: user.real_name || user.name, username: user.name, email: user.profile?.email, title: user.profile?.title, timezone: user.tz, profile: { firstName: user.profile?.first_name, lastName: user.profile?.last_name, statusText: user.profile?.status_text } };
    }

    async analyzeAndPostMember(memberInfo) {
        let analysisId = null;
        try {
            log.info(`Processing member: ${memberInfo.name}`);
            const researchData = await this.doBasicResearch(memberInfo);
            const analysis = await this.analyzeWithAI(memberInfo, researchData);
            analysisId = await saveMemberAnalysis(memberInfo, analysis, researchData);
            await this.postAnalysisToChannel(memberInfo, analysis);
            await markAsSentToSlack(analysisId);
            return { success: true, analysisId, analysis, timestamp: new Date().toISOString() };
        } catch (error) {
            log.error(`Error processing ${memberInfo.name}:`, error.message);
            if (analysisId) log.info(`Analysis ${analysisId} was saved but not sent to Slack`);
            throw error;
        }
    }

    async doBasicResearch(memberInfo) {
        const results = [];
        try {
            if (memberInfo.email && !this.isPersonalEmail(memberInfo.email)) {
                const companyInfo = await this.getCompanyInfo(memberInfo.email.split('@')[1]);
                if (companyInfo) results.push(companyInfo);
            }
            if (memberInfo.name) {
                const githubInfo = await this.getGitHubInfo(memberInfo.name);
                if (githubInfo) results.push(githubInfo);
            }
        } catch (error) { log.error('Research error:', error.message); }
        return results;
    }

    async getCompanyInfo(domain) {
        try {
            const response = await axios.get(`https://www.${domain}`, { timeout: 5000, headers: { 'User-Agent': 'Mozilla/5.0' } });
            const title = response.data.match(/<title>(.*?)<\/title>/i)?.[1] || `Company: ${domain}`;
            return { url: `https://www.${domain}`, title, content: `Public company website for ${domain}`, type: 'company', evidenceType: 'confirmed' };
        } catch (error) { log.debug(`Could not fetch ${domain}:`, error.message); return null; }
    }

    async getGitHubInfo(name) {
        try {
            const user = (await axios.get(`https://api.github.com/search/users?q=${encodeURIComponent(name)}`, { timeout: 5000 })).data.items?.[0];
            if (user) return { url: user.html_url, title: `Possible GitHub match: ${user.login}`, content: 'Identity is unverified; this search result may belong to another person.', type: 'github', evidenceType: 'possible_match', identityVerified: false };
        } catch (error) { log.debug('GitHub search error:', error.message); }
        return null;
    }

    async analyzeWithAI(memberInfo, researchData) {
        const prompt = ChatPromptTemplate.fromTemplate(`Assess product fit using only the supplied Slack profile and research. Do not infer protected characteristics or invent identity, company size, purchasing power, budget authority, or responsibilities. Treat possible_match research as unverified. Separate evidence from inference, state missing information, and keep recommendations concise. Product fit is advisory and always requires human review. Return JSON only, exactly matching this contract:\n{"status":"completed|incomplete|failed","categoryScores":{"technicalRelevance":0,"communityAlignment":0,"contributionPotential":0,"productFit":0},"overallScore":0,"confidence":"low|medium|high|none","evidence":[{"claim":"string","source":"string","type":"confirmed|possible_match"}],"inferences":["string"],"missingInformation":["string"],"recommendations":["string"],"manualReviewRequired":true}\nCompleted scores are integers 0-100. Use null category and overall scores, confidence none, and manualReviewRequired true for failure. Confidence reflects evidence completeness.\nCompany: {company}\nProduct: {product}\nMember: {member}\nResearch: {research}`);
        try {
            const result = await prompt.pipe(this.llm).invoke({ company: process.env.COMPANY_NAME || 'Not provided', product: process.env.COMPANY_PRODUCT || 'Not provided', member: JSON.stringify({ name: memberInfo.name, email: memberInfo.email || null, title: memberInfo.title || null }), research: JSON.stringify(researchData) });
            const analysis = normalizeAnalysisResponse(result);
            if (analysis.status === 'failed') log.error('Gemini returned malformed or invalid structured output.');
            return analysis;
        } catch (error) { log.error('Gemini analysis failed:', error.message); return failedAnalysis('Gemini analysis failed and requires manual review.'); }
    }

    async postAnalysisToChannel(member, analysis) {
        const report = buildSlackReport(member, analysis);
        await this.webClient.chat.postMessage({ channel: process.env.SLACK_PRIVATE_CHANNEL_ID, text: `New Member Analysis: ${member.name} (${report.score})`, attachments: [{ color: report.color, blocks: report.blocks }] });
        log.info(`Analysis posted to channel for ${member.name}`);
    }

    isPersonalEmail(email) { return ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com'].includes(email.split('@')[1]?.toLowerCase()); }

    async start() {
        try {
            log.info('Initializing database...');
            await initDatabase();
            const port = process.env.PORT || 3000;
            this.server = this.app.listen(port, () => log.info(`Express server running on port ${port}`));
            await this.slack.start();
            log.info('Slack AI Agent is running');
        } catch (error) { log.error('Failed to start:', error.message); process.exit(1); }
    }

    async stop() {
        log.info('Shutting down...');
        try { await this.slack.stop(); if (this.server) await new Promise(resolve => this.server.close(resolve)); await closeDatabase(); log.info('Stopped successfully'); }
        catch (error) { log.error('Shutdown error:', error.message); }
    }
}

const isMain = process.argv[1] && path.basename(process.argv[1]) === path.basename(fileURLToPath(import.meta.url));
if (isMain) {
    try {
        const agent = new SlackAIAgent();
        process.on('SIGINT', async () => { await agent.stop(); process.exit(0); });
        process.on('SIGTERM', async () => { await agent.stop(); process.exit(0); });
        agent.start();
    } catch (error) { log.error('Startup failed:', error.message); process.exit(1); }
}
