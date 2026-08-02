import pg from 'pg';
const { Pool } = pg;
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000
});

pool.on('connect', () => {
    console.log('[INFO] Database connected');
});

pool.on('error', (err) => {
    console.error('[ERROR] Unexpected database error:', err.message);
});

export async function initDatabase() {
    const client = await pool.connect();
    try {
        await client.query(`
        CREATE TABLE IF NOT EXISTS member_analyses (
            id SERIAL PRIMARY KEY,
            member_id VARCHAR(255),
            member_name VARCHAR(255) NOT NULL,
            member_email VARCHAR(255),
            member_title VARCHAR(255),
            member_timezone VARCHAR(100),
            fit_score INTEGER NOT NULL,
            insights JSONB,
            recommendations JSONB,
            research_data JSONB,
            analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            sent_to_slack BOOLEAN DEFAULT FALSE,
            sent_to_slack_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        `)

        await client.query(`ALTER TABLE member_analyses ALTER COLUMN fit_score DROP NOT NULL;`);
        await client.query(`ALTER TABLE member_analyses ADD COLUMN IF NOT EXISTS analysis_status VARCHAR(20) DEFAULT 'completed';`);
        await client.query(`ALTER TABLE member_analyses ADD COLUMN IF NOT EXISTS structured_analysis JSONB;`);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_member_id ON member_analyses(member_id);
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_analyzed_at ON member_analyses(analyzed_at);
        `);

        console.log('[INFO] Database schema initialized');

    } catch (error) {
        console.error('[ERROR] Failed to initialize database:', error.message);
        throw error;
    } finally {
        client.release()
    }
}

export async function saveMemberAnalysis(memberInfo, analysis, researchData) {
    const client = await pool.connect();
    try {
        const result = await client.query(
            `INSERT INTO member_analyses (
            member_id, 
            member_name, 
            member_email, 
            member_title, 
            member_timezone,
            fit_score, 
            insights, 
            recommendations, 
            research_data,
            analysis_status,
            structured_analysis
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id`,
            [
                memberInfo.id || null,
                memberInfo.name,
                memberInfo.email || null,
                memberInfo.title || null,
                memberInfo.timezone || null,
                analysis.overallScore,
                JSON.stringify(analysis.inferences),
                JSON.stringify(analysis.recommendations),
                JSON.stringify(researchData),
                analysis.status,
                JSON.stringify(analysis)
            ]);

        console.log(`[INFO] Saved analysis to database with ID: ${result.rows[0].id}`);
        return result.rows[0].id;

    } catch (error) {
        console.error('[ERROR] Failed to save analysis to database:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

export async function markAsSentToSlack(analysisId) {
    const client = await pool.connect();
    try {
        await client.query(
            `UPDATE member_analyses
         SET sent_to_slack = TRUE,
            sent_to_slack_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`, [analysisId]
        );

    } catch (error) {
        console.error('[ERROR] Failed to mark as sent to Slack:', error.message);
        throw error;
    } finally {
        client.release()
    }
}

export async function closeDatabase() {
    await pool.end();
    console.log('[INFO] Database connection pool closed');
}


export default pool;
