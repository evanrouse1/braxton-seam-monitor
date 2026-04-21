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

  // ── 1. ALL columns in Sample1 (show every field on one recent row) ─────────
  hr('1. ALL COLUMNS IN SAMPLE1 (most recent row)');
  try {
    const r = await pool.request().query('SELECT TOP 1 * FROM Sample1 ORDER BY SampleNumber DESC');
    if (r.recordset.length === 0) { console.log('(no rows)'); }
    else {
      const row  = r.recordset[0];
      const cols = Object.keys(row);
      for (const c of cols) console.log(`  ${c.padEnd(30)} = ${JSON.stringify(row[c])}`);
    }
  } catch (e) { console.error('Error:', e.message); }

  // ── 2. All columns in Sample1 — column names + types from schema ──────────
  hr('2. SAMPLE1 COLUMN SCHEMA');
  try {
    const r = await pool.request().query(`
      SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = 'Sample1'
      ORDER BY ORDINAL_POSITION
    `);
    for (const row of r.recordset) {
      console.log(`  ${row.COLUMN_NAME.padEnd(30)} ${row.DATA_TYPE}${row.CHARACTER_MAXIMUM_LENGTH ? '('+row.CHARACTER_MAXIMUM_LENGTH+')' : ''}`);
    }
  } catch (e) { console.error('Error:', e.message); }

  // ── 3. Last 10 rows — every column ────────────────────────────────────────
  hr('3. SAMPLE1 — last 10 rows (ALL columns)');
  try {
    const r = await pool.request().query('SELECT TOP 10 * FROM Sample1 ORDER BY SampleNumber DESC');
    if (r.recordset.length === 0) { console.log('(no rows)'); }
    else {
      const cols = Object.keys(r.recordset[0]);
      console.log(cols.map(c => c.substring(0,18).padEnd(18)).join(' | '));
      console.log(cols.map(() => '-'.repeat(18)).join('-+-'));
      for (const row of r.recordset) {
        console.log(cols.map(c => String(row[c] ?? '').substring(0,18).padEnd(18)).join(' | '));
      }
    }
  } catch (e) { console.error('Error:', e.message); }

  // ── 4. MeasurementType 50 — what is it? ───────────────────────────────────
  hr('4. VALUE1 — MeasurementType=50 (first 10 rows)');
  try {
    const r = await pool.request().query(`
      SELECT TOP 10 SampleNumber, StationNumber, MeasurementType, Value1, Value2, Value3
      FROM Value1
      WHERE MeasurementType = 50
      ORDER BY SampleNumber DESC
    `);
    if (r.recordset.length === 0) { console.log('(no rows — MeasurementType 50 not present)'); }
    else {
      for (const row of r.recordset) {
        console.log(`  Sample=${row.SampleNumber} Station=${row.StationNumber} V1=${row.Value1} V2=${row.Value2} V3=${row.Value3}`);
      }
    }
  } catch (e) { console.error('Error:', e.message); }

  // ── 5. All distinct MeasurementTypes in Value1 ────────────────────────────
  hr('5. ALL DISTINCT MeasurementTypes IN Value1');
  try {
    const r = await pool.request().query(`
      SELECT DISTINCT MeasurementType FROM Value1 ORDER BY MeasurementType
    `);
    console.log(r.recordset.map(x => x.MeasurementType).join(', '));
  } catch (e) { console.error('Error:', e.message); }

  await pool.close();
  console.log('\nDone. Paste the output above back to Claude.\n');
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
