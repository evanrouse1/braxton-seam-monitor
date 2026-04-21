'use strict';
// diagnose-platforms.js
// Run once to discover how SeamMate stores can format in SQL Server.
// Usage:  node diagnose-platforms.js
// Safe — read-only queries only, does not modify anything.

require('dotenv').config();
const sql = require('mssql');

const config = {
  server:   process.env.MSSQL_SERVER   || 'SEAMSCAN\\ONEVISIONSQL',
  database: process.env.MSSQL_DATABASE || 'Braxton_Brewing',
  user:     process.env.MSSQL_USER     || 'seam_reader',
  password: process.env.MSSQL_PASSWORD || '',
  options: {
    enableArithAbort:       true,
    trustServerCertificate: true,
    encrypt:                false,
  },
  connectionTimeout: 15_000,
  requestTimeout:    30_000,
};

function hr(label) {
  console.log('\n' + '─'.repeat(60));
  console.log('  ' + label);
  console.log('─'.repeat(60));
}

async function run() {
  console.log('Connecting to SQL Server:', config.server, '/', config.database);
  const pool = await sql.connect(config);
  console.log('Connected.\n');

  // ── 1. All tables in the database ─────────────────────────────────────────
  hr('1. ALL TABLES IN DATABASE');
  try {
    const r = await pool.request().query(`
      SELECT TABLE_NAME
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_NAME
    `);
    console.log(r.recordset.map(x => x.TABLE_NAME).join('\n'));
  } catch (e) { console.error('Error:', e.message); }

  // ── 2. Platform table — all rows ──────────────────────────────────────────
  hr('2. PLATFORM TABLE (all rows)');
  try {
    const r = await pool.request().query('SELECT * FROM Platform ORDER BY PlatformID');
    if (r.recordset.length === 0) {
      console.log('(no rows)');
    } else {
      // Print column headers then rows
      const cols = Object.keys(r.recordset[0]);
      console.log(cols.join(' | '));
      console.log(cols.map(c => '-'.repeat(Math.max(c.length, 10))).join('-+-'));
      for (const row of r.recordset) {
        console.log(cols.map(c => String(row[c] ?? '')).join(' | '));
      }
    }
  } catch (e) { console.error('Platform table error:', e.message); }

  // ── 3. Sample1 — last 30 rows: Info1, Info2, PlatformID ──────────────────
  hr('3. SAMPLE1 — last 30 scans (Info1 / Info2 / PlatformID)');
  try {
    const r = await pool.request().query(`
      SELECT TOP 30 SampleNumber, Info1, Info2, PlatformID
      FROM Sample1
      ORDER BY SampleNumber DESC
    `);
    if (r.recordset.length === 0) {
      console.log('(no rows)');
    } else {
      const cols = ['SampleNumber', 'Info1', 'Info2', 'PlatformID'];
      console.log(cols.join(' | '));
      console.log(cols.map(c => '-'.repeat(14)).join('-+-'));
      for (const row of r.recordset) {
        console.log(cols.map(c => String(row[c] ?? '')).join(' | '));
      }
    }
  } catch (e) { console.error('Sample1 query error:', e.message); }

  // ── 4. Distinct PlatformID + Info2 combinations across all samples ────────
  hr('4. DISTINCT PlatformID + Info2 combos (Sample1)');
  try {
    const r = await pool.request().query(`
      SELECT DISTINCT PlatformID, Info2
      FROM Sample1
      ORDER BY PlatformID
    `);
    for (const row of r.recordset) {
      console.log(`  PlatformID=${row.PlatformID ?? 'NULL'}  Info2=${row.Info2 ?? 'NULL'}`);
    }
  } catch (e) { console.error('Distinct query error:', e.message); }

  await pool.close();
  console.log('\nDone. Paste the output above back to Claude.\n');
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
