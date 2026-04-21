// seam-monitor.js — Braxton Brewing Can Seam Monitor (SQL Server → Railway)
'use strict';

require('dotenv').config();

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const axios   = require('axios');
const sql     = require('mssql');
const AdmZip  = require('adm-zip');
const Jimp    = require('jimp');
const { google } = require('googleapis');

// ─── Configuration ────────────────────────────────────────────────────────────

const RAILWAY_INGEST_URL    = process.env.RAILWAY_INGEST_URL    || '';
const RAILWAY_WATERMARK_URL = process.env.RAILWAY_WATERMARK_URL || '';
const INGEST_SECRET         = process.env.INGEST_SECRET         || '';
const IMAGES_BASE_PATH      = process.env.IMAGES_BASE_PATH      || 'C:\\SeamMate\\Images';
const POLL_INTERVAL_MS      = parseInt(process.env.POLL_INTERVAL_MS || '30000', 10);
const INCLUDE_IMAGES        = (process.env.INCLUDE_IMAGES || 'true') !== 'false';

// Line setup → can format map.  Key = LineSetupNumber from SeamMate SQL.
// 202x413 = Standard 12oz  202x602 = Sleek 12oz  202x603 = Standard 16oz  202x707 = Standard 19.2oz
// Example: LINE_SETUP_FORMAT_MAP={"12316":"202x603","12315":"202x602","12314":"202x413","12313":"202x707"}
// Fallback if a setup number is not in the map:
const DEFAULT_CAN_FORMAT = process.env.DEFAULT_CAN_FORMAT || '202x603';
let LINE_SETUP_FORMAT_MAP = {};
try {
  LINE_SETUP_FORMAT_MAP = JSON.parse(process.env.LINE_SETUP_FORMAT_MAP || '{}');
} catch {
  log('WARN', 'Could not parse LINE_SETUP_FORMAT_MAP — using default');
}

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(level, message, data = null) {
  const ts  = new Date().toISOString();
  const sym = { INFO: '·', WARN: '⚠', ERROR: '✗', OK: '✓' }[level] || '·';
  console.log(`[${ts}] ${sym} ${message}`);
  if (data) console.log(JSON.stringify(data, null, 2));
}

// ─── SQL Server ───────────────────────────────────────────────────────────────

const MSSQL_CONFIG = {
  server:   process.env.MSSQL_SERVER   || 'SEAMSCAN\\ONEVISIONSQL',
  database: process.env.MSSQL_DATABASE || 'Braxton_Brewing',
  user:     process.env.MSSQL_USER     || 'seam_reader',
  password: process.env.MSSQL_PASSWORD || '',
  options: {
    enableArithAbort:       true,
    trustServerCertificate: true,
    encrypt:                false, // SQL Server 2008 R2 — disable TLS
  },
  pool: { max: 5, min: 0, idleTimeoutMillis: 30_000 },
  connectionTimeout: 15_000,
  requestTimeout:    30_000,
};

let sqlPool = null;

async function getSqlPool() {
  if (sqlPool && sqlPool.connected) return sqlPool;
  log('INFO', `Connecting to SQL Server: ${MSSQL_CONFIG.server}\\${MSSQL_CONFIG.database}`);
  sqlPool = await sql.connect(MSSQL_CONFIG);
  log('OK', 'SQL Server connected');
  return sqlPool;
}

// ─── Measurement Type Map ─────────────────────────────────────────────────────

const MTYPE = {
  3:  'countersink',
  4:  'thickness',
  8:  'bodyHook',
  10: 'coverHook',
  13: 'overlap',   // Overlap % — use this, not type 12 (raw inches)
  15: 'seamHeight',
};

// ─── Spec Limits ──────────────────────────────────────────────────────────────

const SPECS = {
  'Standard 12oz': {
    countersink: { min: 0.265, max: 0.275 },
    thickness:   { min: 0.042, max: 0.046 },
    seamHeight:  { min: 0.095, max: 0.101 },
    bodyHook:    { min: 0.055, max: 0.075 },
    coverHook:   { min: 0.053, max: 0.080 },
    overlap:     { min: 50, practicalMin: 55, max: 90 },
  },
  'Sleek 12oz': {
    countersink: { min: 0.265, max: 0.275 },
    thickness:   { min: 0.042, max: 0.046 },
    seamHeight:  { min: 0.095, max: 0.101 },
    bodyHook:    { min: 0.055, max: 0.075 },
    coverHook:   { min: 0.053, max: 0.080 },
    overlap:     { min: 50, practicalMin: 55, max: 90 },
  },
  'Standard 16oz': {
    countersink: { min: 0.267, max: 0.273 },
    thickness:   { min: 0.042, max: 0.046 },
    seamHeight:  { min: 0.095, max: 0.101 },
    bodyHook:    { min: 0.055, max: 0.075 },
    coverHook:   { min: 0.053, max: 0.075 },
    overlap:     { min: 50, practicalMin: 55, max: 90 },
  },
  'Standard 19.2oz': {
    countersink: { min: 0.265, max: 0.275 },
    thickness:   { min: 0.042, max: 0.046 },
    seamHeight:  { min: 0.095, max: 0.101 },
    bodyHook:    { min: 0.055, max: 0.075 },
    coverHook:   { min: 0.053, max: 0.080 },
    overlap:     { min: 50, practicalMin: 55, max: 90 },
  },
};

const CAN_FORMAT_MAP = {
  '202x413': 'Standard 12oz',
  '202x602': 'Sleek 12oz',
  '202x603': 'Standard 16oz',
  '202x707': 'Standard 19.2oz',
};

function getSpecsForFormat(canFormat) {
  const canSize = CAN_FORMAT_MAP[canFormat];
  if (!canSize) return { canSize: `Unknown (${canFormat || 'N/A'})`, specs: SPECS['Standard 12oz'] };
  return { canSize, specs: SPECS[canSize] };
}

function checkValues(values, spec, label) {
  const failures = [];
  (values || []).forEach((v, i) => {
    if (v == null) return;
    if (v < spec.min)  failures.push({ label: `${label} ${i + 1}`, value: v, issue: 'low',  limit: spec.min });
    if (v > spec.max)  failures.push({ label: `${label} ${i + 1}`, value: v, issue: 'high', limit: spec.max });
  });
  return failures;
}

function buildRootCause(failures, overlapValues, specs) {
  const causes = [];
  const isLow  = (lbl) => failures.some(f => f.label.startsWith(lbl) && f.issue === 'low');
  const isHigh = (lbl) => failures.some(f => f.label.startsWith(lbl) && f.issue === 'high');

  if (isLow('Overlap') && isHigh('Seam Height')) {
    causes.push('Tighten 1st op roll toward chuck (low overlap + high seam height)');
  } else if (isLow('Overlap')) {
    causes.push('Tighten 1st op roll toward chuck (low overlap)');
  }
  if (isLow('Body Hook'))   causes.push('Check pin height and lifter spring pressure (short body hook)');
  if (isHigh('Body Hook'))  causes.push('Pin height too low (long body hook)');
  if (isLow('Cover Hook'))  causes.push('1st op roll too loose or worn (short cover hook)');
  if (isHigh('Cover Hook')) causes.push('1st op roll too tight (long cover hook)');

  const marginal = (overlapValues || []).some(
    v => v != null && v >= specs.overlap.min && v < specs.overlap.practicalMin
  );
  if (marginal && !isLow('Overlap') && causes.length === 0) {
    causes.push('Monitor closely — overlap is marginal (50–55%); consider tightening 1st op roll slightly');
  }
  return causes.join('; ');
}

function analyzeHead(headData, canFormat) {
  const { canSize, specs } = getSpecsForFormat(canFormat);
  const failures = [
    ...checkValues(headData.countersink, specs.countersink, 'Countersink'),
    ...checkValues(headData.thickness,   specs.thickness,   'Thickness'),
    ...checkValues(headData.seamHeight,  specs.seamHeight,  'Seam Height'),
    ...checkValues(headData.bodyHook,    specs.bodyHook,    'Body Hook'),
    ...checkValues(headData.coverHook,   specs.coverHook,   'Cover Hook'),
    ...checkValues(headData.overlap,     specs.overlap,     'Overlap'),
  ];
  const marginalOverlap = (headData.overlap || []).some(
    v => v != null && v >= specs.overlap.min && v < specs.overlap.practicalMin
  );
  const overallStatus = failures.length > 0 ? 'Fail' : marginalOverlap ? 'Marginal' : 'Pass';
  const rootCause = buildRootCause(failures, headData.overlap, specs);
  return { canSize, overallStatus, failures, marginalOverlap, rootCause };
}

// ─── Date / Time Helpers ──────────────────────────────────────────────────────

function parseDate(sampleDate) {
  // sampleDate = int YYYYMMDD e.g. 20260420
  const s = String(sampleDate).padStart(8, '0');
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function parseTime(pullTime) {
  // pullTime = int HHMM e.g. 902 → '09:02', 1430 → '14:30'
  const s = String(pullTime).padStart(4, '0');
  return `${s.slice(0, 2)}:${s.slice(2, 4)}`;
}

// ─── Google Drive ─────────────────────────────────────────────────────────────

let _drive = null;

function getDrive() {
  if (_drive) return _drive;
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!keyJson) return null;
  try {
    const credentials = JSON.parse(keyJson);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    _drive = google.drive({ version: 'v3', auth });
    return _drive;
  } catch {
    return null;
  }
}

async function uploadImageToDrive(localPath, filename, folderId) {
  const drive = getDrive();
  if (!drive) { log('WARN', 'Drive not configured — skipping image upload'); return null; }

  try {
    const res = await drive.files.create({
      requestBody: {
        name:    filename,
        parents: folderId ? [folderId] : undefined,
      },
      media: {
        mimeType: 'image/jpeg',
        body:     fs.createReadStream(localPath),
      },
      fields: 'id',
      supportsAllDrives: true,
    });

    const fileId = res.data.id;
    await drive.permissions.create({
      fileId,
      resource: { role: 'reader', type: 'anyone' },
      supportsAllDrives: true,
    });

    return `https://drive.google.com/file/d/${fileId}/view`;
  } catch (err) {
    log('WARN', `Drive upload failed for ${filename}: ${err.message}`);
    return null;
  }
}

// ─── Image Handling ───────────────────────────────────────────────────────────

function buildDateTimeFolder(sampleDate, pullTime) {
  // Reconstruct the D[year]_ [month]_[day]_T[hour]_[minute] pattern
  // Note: month and day are NOT zero-padded in SeamMate folder names
  const s  = String(sampleDate).padStart(8, '0');
  const year  = s.slice(0, 4);
  const month = parseInt(s.slice(4, 6), 10);  // strip leading zero
  const day   = parseInt(s.slice(6, 8), 10);
  const t     = String(pullTime).padStart(4, '0');
  const hour  = parseInt(t.slice(0, 2), 10);
  const min   = parseInt(t.slice(2, 4), 10);
  return `D${year}_ ${month}_${day}_T${hour}_${min}`;
}

function findImageFolder(sampleDate, pullTime) {
  // Scan all line folders in IMAGES_BASE_PATH for a subfolder
  // matching the date/time pattern
  const targetFolder = buildDateTimeFolder(sampleDate, pullTime);

  if (!fs.existsSync(IMAGES_BASE_PATH)) {
    log('WARN', `Images base path not found: ${IMAGES_BASE_PATH}`);
    return null;
  }

  const lineEntries = fs.readdirSync(IMAGES_BASE_PATH, { withFileTypes: true });
  for (const lineEntry of lineEntries) {
    if (!lineEntry.isDirectory()) continue;
    const linePath    = path.join(IMAGES_BASE_PATH, lineEntry.name);
    const dtEntries   = fs.readdirSync(linePath, { withFileTypes: true });
    const match       = dtEntries.find(
      e => e.isDirectory() && e.name === targetFolder
    );
    if (match) {
      return path.join(linePath, match.name);
    }
  }

  // Fuzzy fallback: match on date only (in case time is off by a minute)
  const s      = String(sampleDate).padStart(8, '0');
  const year   = s.slice(0, 4);
  const month  = parseInt(s.slice(4, 6), 10);
  const day    = parseInt(s.slice(6, 8), 10);
  const prefix = `D${year}_ ${month}_${day}_T`;

  for (const lineEntry of lineEntries) {
    if (!lineEntry.isDirectory()) continue;
    const linePath  = path.join(IMAGES_BASE_PATH, lineEntry.name);
    const dtEntries = fs.readdirSync(linePath, { withFileTypes: true });
    const match     = dtEntries.find(
      e => e.isDirectory() && e.name.startsWith(prefix)
    );
    if (match) {
      return path.join(linePath, match.name);
    }
  }

  log('WARN', `No image folder found for date ${sampleDate} time ${pullTime} (target: ${targetFolder})`);
  return null;
}

async function convertAndUploadImages(sampleDate, pullTime, headNumber, sampleNumber) {
  if (!INCLUDE_IMAGES) return { slot1: null, slot2: null, slot3: null };

  const imageFolder = findImageFolder(sampleDate, pullTime);
  if (!imageFolder) return { slot1: null, slot2: null, slot3: null };

  const folderId = process.env.GOOGLE_DRIVE_IMAGES_FOLDER_ID || null;
  const result   = { slot1: null, slot2: null, slot3: null };

  for (let slot = 1; slot <= 3; slot++) {
    const zipName  = `F_Seam_Head_${headNumber}_Slot_${slot}.zip`;
    const zipPath  = path.join(imageFolder, zipName);

    if (!fs.existsSync(zipPath)) {
      log('INFO', `Image not found: ${zipName}`);
      continue;
    }

    const tmpDir  = path.join(__dirname, 'tmp');
    const dibPath = path.join(tmpDir, `scan_${sampleNumber}_h${headNumber}_s${slot}.dib`);
    const jpgPath = path.join(tmpDir, `scan_${sampleNumber}_h${headNumber}_s${slot}.jpg`);

    try {
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

      // Extract Video.dib from ZIP
      const zip  = new AdmZip(zipPath);
      const entry = zip.getEntry('Video.dib');
      if (!entry) {
        log('WARN', `Video.dib not found in ${zipName}`);
        continue;
      }
      fs.writeFileSync(dibPath, entry.getData());

      // Convert .dib (BMP) → JPEG using Jimp
      const image = await Jimp.read(dibPath);
      await image.quality(85).writeAsync(jpgPath);

      // Upload to Google Drive
      const driveFilename = `seam_${sampleNumber}_head${headNumber}_slot${slot}.jpg`;
      const url = await uploadImageToDrive(jpgPath, driveFilename, folderId);
      result[`slot${slot}`] = url;

      log('OK', `Image uploaded: Head ${headNumber} Slot ${slot} → ${url || 'no url'}`);
    } catch (err) {
      log('WARN', `Image conversion failed (Head ${headNumber} Slot ${slot}): ${err.message}`);
    } finally {
      try { if (fs.existsSync(dibPath)) fs.unlinkSync(dibPath); } catch {}
      try { if (fs.existsSync(jpgPath)) fs.unlinkSync(jpgPath); } catch {}
    }
  }

  return result;
}

// ─── Can Format Lookup ────────────────────────────────────────────────────────

function getCanFormat(lineSetupNumber) {
  const key = String(lineSetupNumber);
  return LINE_SETUP_FORMAT_MAP[key] || DEFAULT_CAN_FORMAT;
}

// ─── SQL Polling ──────────────────────────────────────────────────────────────

const LINE_MAP = {
  Sample1: 'CFT',
  Sample2: 'IHCWildGoose',
  Sample3: 'Crowler',
};

// Watermark: highest SampleNumber already sent to Railway per table
const watermark = { Sample1: 0, Sample2: 0, Sample3: 0 };

async function fetchWatermarkFromRailway() {
  if (!RAILWAY_WATERMARK_URL || !INGEST_SECRET) return;
  try {
    const res = await axios.get(RAILWAY_WATERMARK_URL, {
      headers: { Authorization: `Bearer ${INGEST_SECRET}` },
      timeout: 10_000,
    });
    watermark.Sample1 = res.data.sample1LastId || 0;
    watermark.Sample2 = res.data.sample2LastId || 0;
    watermark.Sample3 = res.data.sample3LastId || 0;
    log('OK', `Watermark loaded: Sample1=${watermark.Sample1} Sample2=${watermark.Sample2} Sample3=${watermark.Sample3}`);
  } catch (err) {
    log('WARN', `Could not fetch watermark from Railway: ${err.message} — starting from 0`);
  }
}

async function pollTable(tableNum) {
  const sampleTable = `Sample${tableNum}`;
  const valueTable  = `Value${tableNum}`;
  const line        = LINE_MAP[sampleTable];
  const lastId      = watermark[sampleTable];

  const pool = await getSqlPool();

  // Fetch new sample rows
  const sampleResult = await pool.request()
    .input('lastId', sql.Int, lastId)
    .query(`
      SELECT SampleNumber, SampleDate, PullTime, PlatformID, Info1, Info2, AlertStatus
      FROM ${sampleTable}
      WHERE SampleNumber > @lastId
      ORDER BY SampleNumber ASC
    `);

  const samples = sampleResult.recordset;
  if (samples.length === 0) return;

  log('INFO', `${sampleTable}: ${samples.length} new sample(s) since #${lastId}`);

  // Fetch measurements for all new samples in one bulk query
  const sampleNums = samples.map(s => s.SampleNumber);
  const valueResult = await pool.request()
    .query(`
      SELECT SampleNumber, StationNumber, MeasurementType, Value1, Value2, Value3
      FROM ${valueTable}
      WHERE SampleNumber IN (${sampleNums.join(',')})
      AND MeasurementType IN (3, 4, 8, 10, 13, 15, 50)
    `);

  // Group values by SampleNumber → StationNumber → MeasurementType
  const valueMap = {};
  for (const row of valueResult.recordset) {
    const sn = row.SampleNumber;
    const st = row.StationNumber;
    const mt = row.MeasurementType;
    if (!valueMap[sn])       valueMap[sn]    = {};
    if (!valueMap[sn][st])   valueMap[sn][st] = {};
    valueMap[sn][st][mt] = [row.Value1, row.Value2, row.Value3];
  }

  const PUSHOVER_RECENT_MS = parseInt(process.env.PUSHOVER_RECENT_HOURS || '24', 10) * 3600_000;
  const BATCH_SIZE = parseInt(process.env.INGEST_BATCH_SIZE || '20', 10);
  let batch = [];

  for (const sample of samples) {
    const sn             = sample.SampleNumber;
    const scanDate       = parseDate(sample.SampleDate);
    const pullTime       = parseTime(sample.PullTime);
    const product        = (sample.Info1 || '').trim() || null;
    const lineSetupNumber = sample.LineSetupNumber;
    const canFormat      = getCanFormat(lineSetupNumber);

    const stationNums = Object.keys(valueMap[sn] || {}).map(Number).sort();
    if (stationNums.length === 0) stationNums.push(1);

    const sampleRecords = [];

    for (const station of stationNums) {
      const vals = (valueMap[sn] || {})[station] || {};
      const r3 = v => v == null ? null : Math.round(v * 1000) / 1000;
      const r1 = v => v == null ? null : Math.round(v * 10)   / 10;
      const headData = {
        countersink: (vals[3]  || [null, null, null]).map(r3),
        thickness:   (vals[4]  || [null, null, null]).map(r3),
        bodyHook:    (vals[8]  || [null, null, null]).map(r3),
        coverHook:   (vals[10] || [null, null, null]).map(r3),
        overlap:     (vals[13] || [null, null, null]).map(r1),
        seamHeight:  (vals[15] || [null, null, null]).map(r3),
      };
      const analysis = analyzeHead(headData, canFormat);
      const images   = await convertAndUploadImages(sample.SampleDate, sample.PullTime, station, sn);

      sampleRecords.push({
        sourceTable:   sampleTable,
        sampleNumber:  sn,
        stationNumber: station,
        line,
        scanDate,
        pullTime,
        product,
        canFormat,
        canSize:       analysis.canSize,
        alertStatus:   sample.AlertStatus || 0,
        visualDefects: 'None',
        countersink:   headData.countersink,
        thickness:     headData.thickness,
        seamHeight:    headData.seamHeight,
        bodyHook:      headData.bodyHook,
        coverHook:     headData.coverHook,
        overlap:       headData.overlap,
        overallStatus: analysis.overallStatus,
        rootCause:     analysis.rootCause,
        images,
      });
    }

    batch.push(...sampleRecords);

    // Pushover for recent scans only
    const scanTs   = new Date(scanDate).getTime();
    const isRecent = (Date.now() - scanTs) < PUSHOVER_RECENT_MS;
    if (isRecent) {
      for (const r of sampleRecords) {
        if (r.overallStatus !== 'Pass') {
          await sendPushover(
            `Seam ${r.overallStatus} — ${r.product || 'Unknown'} Head ${r.stationNumber}`,
            buildPushoverBody(r),
            r.overallStatus === 'Fail' ? 1 : 0
          );
        }
      }
    }

    // POST every BATCH_SIZE samples so data appears in the app immediately
    if (batch.length >= BATCH_SIZE) {
      const posted = await postToRailway(batch);
      if (posted) {
        watermark[sampleTable] = sn;
        log('OK', `${sampleTable}: batch posted, watermark → ${sn}`);
      }
      batch = [];
    }
  }

  // Flush remaining
  if (batch.length > 0) {
    const posted = await postToRailway(batch);
    if (posted) {
      const maxId = Math.max(...samples.map(s => s.SampleNumber));
      watermark[sampleTable] = maxId;
      log('OK', `${sampleTable}: watermark advanced to ${maxId}`);
    }
  }
}

// ─── POST to Railway ──────────────────────────────────────────────────────────

async function postToRailway(records) {
  if (!RAILWAY_INGEST_URL || !INGEST_SECRET) {
    log('WARN', 'RAILWAY_INGEST_URL or INGEST_SECRET not set — skipping POST');
    return false;
  }
  try {
    const res = await axios.post(RAILWAY_INGEST_URL, { records }, {
      headers: {
        'Authorization': `Bearer ${INGEST_SECRET}`,
        'Content-Type':  'application/json',
      },
      timeout: 30_000,
    });
    log('OK', `Ingest: ${res.data.inserted} inserted, ${res.data.updated} updated`);
    if (res.data.errors?.length) {
      log('WARN', `Ingest errors: ${res.data.errors.length}`, res.data.errors);
    }
    return true;
  } catch (err) {
    log('ERROR', `POST to Railway failed: ${err.message}`);
    return false;
  }
}

// ─── Pushover ─────────────────────────────────────────────────────────────────

async function sendPushover(title, message, priority = 0) {
  if (!process.env.PUSHOVER_APP_TOKEN || !process.env.PUSHOVER_USER_KEY) return;
  try {
    await axios.post('https://api.pushover.net/1/messages.json', {
      token:    process.env.PUSHOVER_APP_TOKEN,
      user:     process.env.PUSHOVER_USER_KEY,
      title, message, priority,
    });
    log('OK', `Pushover sent: "${title}"`);
  } catch (err) {
    log('ERROR', `Pushover failed: ${err.message}`);
  }
}

function buildPushoverBody(r) {
  const lines = [
    `Product: ${r.product || 'Unknown'}`,
    `Can: ${r.canSize} (${r.canFormat || 'N/A'})`,
    `Head: ${r.stationNumber}  |  Pull: ${r.pullTime}  |  Line: ${r.line}`,
    '',
  ];
  if (r.overallStatus !== 'Pass' && r.rootCause) {
    lines.push('CORRECTIVE ACTION:');
    lines.push(r.rootCause);
  }
  return lines.join('\n');
}

// ─── Poll Loop ────────────────────────────────────────────────────────────────

let polling = false;

async function poll() {
  if (polling) return;
  polling = true;
  try {
    await pollTable(1);
    await pollTable(2);
    await pollTable(3);
  } catch (err) {
    log('ERROR', `Poll error: ${err.message}`);
    // Reset SQL pool on connection errors so next poll reconnects
    if (err.code === 'ECONNRESET' || err.code === 'ESOCKET' || String(err).includes('ConnectionError')) {
      log('INFO', 'Resetting SQL connection pool...');
      try { await sql.close(); } catch {}
      sqlPool = null;
    }
  } finally {
    polling = false;
    setTimeout(poll, POLL_INTERVAL_MS);
  }
}

// ─── Startup ──────────────────────────────────────────────────────────────────

const REQUIRED_ENV = ['RAILWAY_INGEST_URL', 'INGEST_SECRET'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`\n✗ Missing required environment variables:\n  ${missing.join('\n  ')}\n`);
  process.exit(1);
}

(async () => {
  log('INFO', '─── Braxton Seam Monitor (SQL Mode) Starting ───');
  log('INFO', `SQL Server : ${MSSQL_CONFIG.server}`);
  log('INFO', `Railway URL: ${RAILWAY_INGEST_URL}`);
  log('INFO', `Images path: ${IMAGES_BASE_PATH}`);
  log('INFO', `Images on  : ${INCLUDE_IMAGES}`);
  log('INFO', `Poll every : ${POLL_INTERVAL_MS}ms`);

  // Connect to SQL Server
  try {
    await getSqlPool();
  } catch (err) {
    log('ERROR', `SQL Server connection failed: ${err.message}`);
    log('WARN', 'Will retry on first poll...');
    sqlPool = null;
  }

  // Fetch watermark from Railway
  await fetchWatermarkFromRailway();

  log('OK', 'Starting poll loop...');
  poll();
})();
