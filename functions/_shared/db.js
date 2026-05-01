/**
 * db.js — D1 Database operations for lab report app
 *
 * Uses Cloudflare D1 (SQLite-based) with prepare/bind/run pattern.
 * All functions take a D1 binding as the first parameter.
 */

/**
 * Get a user by username.
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {string} username
 * @returns {Promise<object|null>}
 */
export async function getUserByUsername(db, username) {
  return db.prepare(
    'SELECT id, username, password_hash, display_name, created_at FROM users WHERE username = ?'
  ).bind(username).first();
}

/**
 * Get a user by ID.
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {number} id
 * @returns {Promise<object|null>}
 */
export async function getUserById(db, id) {
  return db.prepare(
    'SELECT id, username, password_hash, display_name, created_at FROM users WHERE id = ?'
  ).bind(id).first();
}

/**
 * Create a new user.
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {string} username
 * @param {string} passwordHash
 * @returns {Promise<object>} the newly created user
 */
export async function createUser(db, username, passwordHash) {
  const result = await db.prepare(
    'INSERT INTO users (username, password_hash, display_name) VALUES (?, ?, ?)'
  ).bind(username, passwordHash, username).run();

  const newId = result.meta.last_row_id;
  return db.prepare(
    'SELECT id, username, display_name, created_at FROM users WHERE id = ?'
  ).bind(newId).first();
}

/**
 * Get reports for a user (list only, no items or analysis).
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {number} userId
 * @param {number} [limit=50]
 * @returns {Promise<Array<object>>}
 */
export async function getReportsByUser(db, userId, limit = 50) {
  const { results } = await db.prepare(
    `SELECT id, user_id, report_type, report_date, hospital_name, notes, summary, created_at
     FROM reports
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT ?`
  ).bind(userId, limit).all();
  return results;
}

/**
 * Get a single report with its lab items and AI analysis.
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {number} reportId
 * @param {number} userId — used for ownership verification
 * @returns {Promise<object|null>} report with .items array and .analysis object
 */
export async function getReportById(db, reportId, userId) {
  const report = await db.prepare(
    `SELECT id, user_id, report_type, report_date, hospital_name, notes,
            image_base64, raw_extracted, summary, created_at
     FROM reports
     WHERE id = ? AND user_id = ?`
  ).bind(reportId, userId).first();

  if (!report) return null;

  // Parse raw_extracted if it's a string
  if (typeof report.raw_extracted === 'string') {
    try {
      report.raw_extracted = JSON.parse(report.raw_extracted);
    } catch {
      // leave as-is if not valid JSON
    }
  }

  // Get lab items
  const { results: items } = await db.prepare(
    `SELECT id, item_name, value, unit, reference_range, flag, category
     FROM lab_items
     WHERE report_id = ?
     ORDER BY id ASC`
  ).bind(reportId).all();
  report.items = items;

  // Get AI analysis
  const analysis = await db.prepare(
    `SELECT id, summary, recommendations, next_checkup, trends_analysis, created_at
     FROM ai_analyses
     WHERE report_id = ?`
  ).bind(reportId).first();
  report.analysis = analysis || null;

  return report;
}

/**
 * Save a complete report (transaction: reports + lab_items + ai_analyses).
 *
 * D1 does not support multi-statement transactions natively, so statements
 * are executed sequentially. Each INSERT result provides last_row_id for
 * the next operations.
 *
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {number} userId
 * @param {string} reportType
 * @param {string} reportDate
 * @param {string} hospitalName
 * @param {string|null} imageBase64
 * @param {object|Array|null} rawExtracted — raw OCR/extraction data
 * @param {string|null} summary
 * @param {Array<object>} labItems — array of {name, value, unit, reference_range, flag, category}
 * @param {object|null} aiAnalysis — {summary, recommendations, next_checkup, trends_analysis}
 * @returns {Promise<number>} the new report ID
 */
export async function saveReport(
  db,
  userId,
  reportType,
  reportDate,
  hospitalName,
  imageBase64,
  rawExtracted,
  summary,
  labItems,
  aiAnalysis
) {
  // 1. Insert the report
  const result = await db.prepare(
    `INSERT INTO reports
       (user_id, report_type, report_date, hospital_name, image_base64, raw_extracted, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    userId,
    reportType,
    reportDate,
    hospitalName,
    imageBase64 || null,
    rawExtracted ? JSON.stringify(rawExtracted) : null,
    summary || null
  ).run();

  const reportId = result.meta.last_row_id;

  // 2. Insert lab items
  if (labItems && labItems.length > 0) {
    const insertItem = db.prepare(
      `INSERT INTO lab_items
         (report_id, item_name, value, unit, reference_range, flag, category)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const item of labItems) {
      await insertItem.bind(
        reportId,
        item.name || item.item_name || '',
        item.value || '',
        item.unit || '',
        item.reference_range || '',
        item.flag || '',
        item.category || ''
      ).run();
    }
  }

  // 3. Insert AI analysis
  if (aiAnalysis) {
    await db.prepare(
      `INSERT INTO ai_analyses
         (report_id, summary, recommendations, next_checkup, trends_analysis)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(
      reportId,
      aiAnalysis.summary || '',
      aiAnalysis.recommendations || '',
      aiAnalysis.next_checkup || '',
      aiAnalysis.trends_analysis || ''
    ).run();
  }

  return reportId;
}

/**
 * Delete a report and all its associated data (lab_items + ai_analyses).
 * D1 does not enforce foreign key cascading, so manual deletion is required.
 *
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {number} reportId
 * @param {number} userId — ownership verification
 * @returns {Promise<boolean>} true if deleted, false if not found
 */
export async function deleteReport(db, reportId, userId) {
  // First verify ownership
  const report = await db.prepare(
    'SELECT id FROM reports WHERE id = ? AND user_id = ?'
  ).bind(reportId, userId).first();

  if (!report) return false;

  // Delete in reverse FK order
  await db.prepare('DELETE FROM ai_analyses WHERE report_id = ?').bind(reportId).run();
  await db.prepare('DELETE FROM lab_items WHERE report_id = ?').bind(reportId).run();
  await db.prepare('DELETE FROM reports WHERE id = ? AND user_id = ?').bind(reportId, userId).run();

  return true;
}

/**
 * Get all reports of a given type for a user, with lab items included.
 * Used for trend analysis / data comparison across multiple reports.
 *
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {string} reportType
 * @param {number} userId
 * @returns {Promise<Array<object>>} reports with .items arrays
 */
export async function getTrendData(db, reportType, userId) {
  const { results: reports } = await db.prepare(
    `SELECT id, user_id, report_type, report_date, hospital_name, notes, summary, created_at
     FROM reports
     WHERE user_id = ? AND report_type = ?
     ORDER BY report_date ASC, created_at ASC`
  ).bind(userId, reportType).all();

  if (reports.length === 0) return [];

  // Fetch items for all reports in batch
  const reportIds = reports.map(r => r.id);
  const placeholders = reportIds.map(() => '?').join(',');

  const { results: allItems } = await db.prepare(
    `SELECT id, report_id, item_name, value, unit, reference_range, flag, category
     FROM lab_items
     WHERE report_id IN (${placeholders})
     ORDER BY report_id ASC, id ASC`
  ).bind(...reportIds).all();

  // Group items by report_id
  const itemsByReport = {};
  for (const item of allItems) {
    if (!itemsByReport[item.report_id]) {
      itemsByReport[item.report_id] = [];
    }
    itemsByReport[item.report_id].push(item);
  }

  // Attach items to each report
  for (const report of reports) {
    report.items = itemsByReport[report.id] || [];
  }

  return reports;
}
