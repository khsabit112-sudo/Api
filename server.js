/**
 * HTML-to-APK Compilation Service
 * -----------------------------------------------------------------------
 * Node.js + Express + Docker backend that decompiles a base.apk template,
 * injects a user's HTML app + icon + app name, recompiles with apktool,
 * signs with uber-apk-signer, and serves the result for download.
 *
 * Designed to run on Render's free tier (512MB RAM) -> single-slot queue.
 * -----------------------------------------------------------------------
 */

'use strict';

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fse = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const sharp = require('sharp');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 10000;
const API_KEY = process.env.API_KEY || 'FFX_SECRET_API_KEY_2026';

const ROOT_DIR = __dirname;
const BASE_APK_PATH = path.join(ROOT_DIR, 'base.apk');
const UPLOADS_DIR = path.join(ROOT_DIR, 'uploads');
const BUILDS_DIR = path.join(ROOT_DIR, 'builds');
const WORKSPACE_DIR = path.join(ROOT_DIR, 'workspace');

const APKTOOL_BIN = process.env.APKTOOL_BIN || '/usr/local/bin/apktool';
const APKTOOL_JAR = process.env.APKTOOL_JAR || '/usr/local/bin/apktool.jar';
const SIGNER_JAR = process.env.SIGNER_JAR || '/usr/local/bin/uber-apk-signer.jar';

const MIPMAP_SIZES = {
  'mipmap-mdpi': 48,
  'mipmap-hdpi': 72,
  'mipmap-xhdpi': 96,
  'mipmap-xxhdpi': 144,
  'mipmap-xxxhdpi': 192
};

fse.ensureDirSync(UPLOADS_DIR);
fse.ensureDirSync(BUILDS_DIR);
fse.ensureDirSync(WORKSPACE_DIR);

// ---------------------------------------------------------------------------
// In-memory job store + single-slot sequential queue
// ---------------------------------------------------------------------------
/**
 * Job shape:
 * {
 *   id, appName, status: 'queued'|'processing'|'done'|'error',
 *   step, progress, error, createdAt, updatedAt,
 *   apkPath, workDir
 * }
 */
const jobs = new Map();
const queue = [];
let isProcessing = false;

function createJob(appName) {
  const id = uuidv4();
  const job = {
    id,
    appName,
    status: 'queued',
    step: 'Waiting in queue…',
    progress: 0,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    apkPath: null,
    workDir: path.join(WORKSPACE_DIR, id)
  };
  jobs.set(id, job);
  return job;
}

function updateJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
}

function enqueue(job, files) {
  queue.push({ job, files });
  processQueue();
}

async function processQueue() {
  if (isProcessing) return;
  const next = queue.shift();
  if (!next) return;

  isProcessing = true;
  const { job, files } = next;

  try {
    await runBuildPipeline(job, files);
  } catch (err) {
    console.error(`[job ${job.id}] fatal pipeline error:`, err);
    updateJob(job.id, {
      status: 'error',
      step: 'Build failed',
      error: err && err.message ? err.message : String(err)
    });
  } finally {
    // Cleanup temp workspace + uploaded source files regardless of outcome
    try {
      await fse.remove(job.workDir);
    } catch (cleanupErr) {
      console.error(`[job ${job.id}] workspace cleanup failed:`, cleanupErr);
    }
    try {
      for (const f of [files.iconFile, ...(files.htmlFiles || [])]) {
        if (f && f.path) await fse.remove(f.path);
      }
    } catch (cleanupErr) {
      console.error(`[job ${job.id}] upload cleanup failed:`, cleanupErr);
    }

    isProcessing = false;
    // Process next item in queue, if any
    setImmediate(processQueue);
  }
}

// ---------------------------------------------------------------------------
// Shell helper - spawn a process, capture output, never throw uncaught
// ---------------------------------------------------------------------------
function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT_DIR,
      env: { ...process.env, ...(options.env || {}) },
      shell: false
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to start "${command}": ${err.message}`));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        console.error(`[cmd] ${command} ${args.join(' ')} exited with code ${code}`);
        console.error(`[cmd stderr] ${stderr}`);
        reject(
          new Error(
            `Command "${command} ${args.join(' ')}" exited with code ${code}. ${stderr
              .split('\n')
              .slice(-5)
              .join(' ')}`
          )
        );
      }
    });
  });
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------
function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function patchAppName(decompiledDir, appName) {
  const stringsPath = path.join(decompiledDir, 'res', 'values', 'strings.xml');
  const exists = await fse.pathExists(stringsPath);
  const safeName = escapeXml(appName);

  if (!exists) {
    // Extremely unlikely for a valid APK, but guard against a crash anyway.
    await fse.ensureDir(path.dirname(stringsPath));
    await fse.writeFile(
      stringsPath,
      `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <string name="app_name">${safeName}</string>\n</resources>\n`,
      'utf8'
    );
    return;
  }

  let xml = await fse.readFile(stringsPath, 'utf8');
  const appNamePattern = /<string name="app_name">[\s\S]*?<\/string>/;

  if (appNamePattern.test(xml)) {
    xml = xml.replace(appNamePattern, `<string name="app_name">${safeName}</string>`);
  } else {
    xml = xml.replace(
      '</resources>',
      `    <string name="app_name">${safeName}</string>\n</resources>`
    );
  }

  await fse.writeFile(stringsPath, xml, 'utf8');
}

// ---------------------------------------------------------------------------
// Asset injection
// ---------------------------------------------------------------------------
async function injectHtmlFiles(decompiledDir, htmlFiles) {
  const assetsDir = path.join(decompiledDir, 'assets');
  await fse.ensureDir(assetsDir);

  // Remove the placeholder index.html shipped in the base template so it
  // never lingers if, for some reason, nothing gets copied over it below.
  const placeholderIndex = path.join(assetsDir, 'index.html');
  if (await fse.pathExists(placeholderIndex)) {
    await fse.remove(placeholderIndex);
  }

  let hasIndex = false;
  const copiedNames = [];

  for (const file of htmlFiles) {
    const destName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
    const destPath = path.join(assetsDir, destName);
    await fse.copy(file.path, destPath);
    copiedNames.push(destName);
    if (destName.toLowerCase() === 'index.html') {
      hasIndex = true;
    }
  }

  // The WebView shell always loads "file:///android_asset/index.html".
  // If the user didn't name any uploaded file "index.html", treat the
  // FIRST uploaded HTML file as the entry point by duplicating it as
  // index.html (its original name is kept too, so internal links between
  // pages still work).
  if (!hasIndex && htmlFiles.length > 0) {
    const mainFile = htmlFiles[0];
    const indexDest = path.join(assetsDir, 'index.html');
    await fse.copy(mainFile.path, indexDest);
  }
}

async function replaceLauncherIcon(decompiledDir, iconFile) {
  if (!iconFile) return;

  const resDir = path.join(decompiledDir, 'res');
  const iconNames = ['ic_launcher.png', 'ic_launcher_round.png'];

  for (const [folder, size] of Object.entries(MIPMAP_SIZES)) {
    const folderPath = path.join(resDir, folder);
    const folderExists = await fse.pathExists(folderPath);
    if (!folderExists) continue;

    for (const iconName of iconNames) {
      const targetPath = path.join(folderPath, iconName);
      const targetExists = await fse.pathExists(targetPath);
      if (!targetExists) continue;

      try {
        await sharp(iconFile.path)
          .resize(size, size, { fit: 'cover' })
          .png()
          .toFile(targetPath + '.tmp');
        await fse.move(targetPath + '.tmp', targetPath, { overwrite: true });
      } catch (resizeErr) {
        console.error(`Icon resize failed for ${targetPath}, falling back to raw copy:`, resizeErr.message);
        await fse.copy(iconFile.path, targetPath);
      }
    }
  }

  // Also cover a flat drawable fallback, if present in the template.
  const drawableIcon = path.join(resDir, 'drawable', 'ic_launcher.png');
  if (await fse.pathExists(drawableIcon)) {
    try {
      await sharp(iconFile.path).resize(96, 96, { fit: 'cover' }).png().toFile(drawableIcon + '.tmp');
      await fse.move(drawableIcon + '.tmp', drawableIcon, { overwrite: true });
    } catch (err) {
      await fse.copy(iconFile.path, drawableIcon);
    }
  }
}

// ---------------------------------------------------------------------------
// Core build pipeline
// ---------------------------------------------------------------------------
async function runBuildPipeline(job, files) {
  const { id } = job;
  const workDir = job.workDir;
  const decompiledDir = path.join(workDir, 'decompiled');
  const unsignedApk = path.join(workDir, 'unsigned.apk');

  await fse.ensureDir(workDir);

  // Step 0: validate base.apk presence
  updateJob(id, { status: 'processing', step: 'Validating base template…', progress: 5 });
  const baseExists = await fse.pathExists(BASE_APK_PATH);
  if (!baseExists) {
    throw new Error('base.apk was not found in the service root. Place your template APK at /app/base.apk.');
  }

  // Step 1: decompile
  updateJob(id, { step: 'Decompiling base APK…', progress: 15 });
  await runCommand('java', [
    '-jar',
    APKTOOL_JAR,
    'd',
    BASE_APK_PATH,
    '-o',
    decompiledDir,
    '-f'
  ]);

  // Step 2: patch app name
  updateJob(id, { step: 'Setting application name…', progress: 35 });
  await patchAppName(decompiledDir, job.appName);

  // Step 3: inject HTML assets
  updateJob(id, { step: 'Injecting HTML app files…', progress: 45 });
  await injectHtmlFiles(decompiledDir, files.htmlFiles || []);

  // Step 4: replace icon
  if (files.iconFile) {
    updateJob(id, { step: 'Replacing launcher icon…', progress: 55 });
    await replaceLauncherIcon(decompiledDir, files.iconFile);
  }

  // Step 5: rebuild
  updateJob(id, { step: 'Recompiling APK…', progress: 70 });
  await runCommand('java', [
    '-jar',
    APKTOOL_JAR,
    'b',
    decompiledDir,
    '-o',
    unsignedApk
  ]);

  // Step 6: sign
  updateJob(id, { step: 'Signing APK…', progress: 88 });
  await runCommand('java', [
    '-jar',
    SIGNER_JAR,
    '-a',
    unsignedApk,
    '--out',
    workDir,
    '--allowResign'
  ]);

  // uber-apk-signer names the output "<input-basename>-aligned-debugSigned.apk"
  const producedFiles = await fse.readdir(workDir);
  const signedFileName = producedFiles.find(
    (f) => f.toLowerCase().includes('signed') && f.toLowerCase().endsWith('.apk')
  );

  if (!signedFileName) {
    throw new Error('Signing step completed but no signed APK was found in the output.');
  }

  const finalApkPath = path.join(BUILDS_DIR, `${id}.apk`);
  await fse.move(path.join(workDir, signedFileName), finalApkPath, { overwrite: true });

  updateJob(id, {
    status: 'done',
    step: 'Build complete',
    progress: 100,
    apkPath: finalApkPath
  });
}

// ---------------------------------------------------------------------------
// Express app setup
// ---------------------------------------------------------------------------
const app = express();

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-api-key'],
    maxAge: 86400
  })
);
app.use(express.json());

// Multer: temp storage in uploads/, sane size limits
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, unique);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 15 * 1024 * 1024, // 15MB per file
    files: 12
  },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'iconFile') {
      if (file.mimetype === 'image/png') return cb(null, true);
      return cb(new Error('iconFile must be a PNG image.'));
    }
    if (file.fieldname === 'htmlFiles') {
      const isHtml =
        file.mimetype === 'text/html' ||
        file.originalname.toLowerCase().endsWith('.html') ||
        file.originalname.toLowerCase().endsWith('.htm');
      if (isHtml) return cb(null, true);
      return cb(new Error('htmlFiles must be .html files.'));
    }
    return cb(null, true);
  }
});

function requireApiKey(req, res, next) {
  const key = req.header('x-api-key');
  if (!key || key !== API_KEY) {
    return res.status(401).json({ success: false, error: 'Unauthorized: invalid or missing x-api-key header.' });
  }
  next();
}

// ---------------------------------------------------------------------------
// GET / - dark cyber-themed status page
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  const activeJobs = [...jobs.values()]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 8);

  const rows = activeJobs
    .map((j) => {
      const statusColor =
        j.status === 'done' ? '#39ff88' : j.status === 'error' ? '#ff3b5c' : '#00e5ff';
      return `
        <tr>
          <td>${j.id.slice(0, 8)}…</td>
          <td>${escapeHtml(j.appName)}</td>
          <td style="color:${statusColor}">${j.status.toUpperCase()}</td>
          <td>${escapeHtml(j.step)}</td>
          <td>${j.progress}%</td>
        </tr>`;
    })
    .join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>HTML-to-APK Compiler // Status</title>
<style>
  :root {
    --bg: #05070d;
    --panel: #0b0f1a;
    --accent: #00e5ff;
    --accent2: #39ff88;
    --danger: #ff3b5c;
    --text: #d7e5ff;
    --muted: #6c7a99;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: radial-gradient(circle at 20% 20%, #0d1626 0%, var(--bg) 55%);
    color: var(--text);
    font-family: 'Courier New', Consolas, monospace;
    min-height: 100vh;
    padding: 32px 16px;
  }
  .wrap { max-width: 900px; margin: 0 auto; }
  h1 {
    font-size: 22px;
    letter-spacing: 2px;
    color: var(--accent);
    text-shadow: 0 0 12px rgba(0,229,255,0.6);
    margin-bottom: 4px;
  }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 24px; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 14px;
    margin-bottom: 28px;
  }
  .card {
    background: linear-gradient(160deg, var(--panel), #060a12);
    border: 1px solid rgba(0,229,255,0.25);
    border-radius: 10px;
    padding: 16px;
    box-shadow: 0 0 20px rgba(0,229,255,0.05);
  }
  .card .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 1px; }
  .card .value { color: var(--accent2); font-size: 20px; margin-top: 6px; font-weight: bold; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th {
    text-align: left;
    color: var(--muted);
    padding: 8px 6px;
    border-bottom: 1px solid rgba(0,229,255,0.2);
    text-transform: uppercase;
    font-size: 10px;
    letter-spacing: 1px;
  }
  td { padding: 8px 6px; border-bottom: 1px solid rgba(255,255,255,0.05); }
  .panel { background: var(--panel); border: 1px solid rgba(0,229,255,0.15); border-radius: 10px; padding: 16px; overflow-x: auto; }
  .pulse {
    display: inline-block; width: 9px; height: 9px; border-radius: 50%;
    background: var(--accent2); box-shadow: 0 0 8px var(--accent2);
    animation: pulse 1.6s infinite ease-in-out; margin-right: 8px;
  }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
  .footer { margin-top: 24px; color: var(--muted); font-size: 11px; text-align: center; }
  a { color: var(--accent); }
</style>
</head>
<body>
  <div class="wrap">
    <h1>&gt;&gt; HTML_TO_APK_COMPILER</h1>
    <div class="sub"><span class="pulse"></span>SERVICE ONLINE &mdash; ${new Date().toISOString()}</div>

    <div class="grid">
      <div class="card"><div class="label">Queue Length</div><div class="value">${queue.length}</div></div>
      <div class="card"><div class="label">Active Build</div><div class="value">${isProcessing ? 'YES' : 'IDLE'}</div></div>
      <div class="card"><div class="label">Total Jobs</div><div class="value">${jobs.size}</div></div>
      <div class="card"><div class="label">Concurrency</div><div class="value">1 SLOT</div></div>
    </div>

    <div class="panel">
      <table>
        <thead>
          <tr><th>Job ID</th><th>App Name</th><th>Status</th><th>Step</th><th>Progress</th></tr>
        </thead>
        <tbody>
          ${rows || '<tr><td colspan="5" style="color:var(--muted)">No jobs yet.</td></tr>'}
        </tbody>
      </table>
    </div>

    <div class="footer">POST /generate &middot; GET /status/:jobId &middot; GET /download/:jobId</div>
  </div>
</body>
</html>`;

  res.set('Content-Type', 'text/html');
  res.send(html);
});

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// POST /generate
// ---------------------------------------------------------------------------
app.post(
  '/generate',
  requireApiKey,
  (req, res, next) => {
    upload.fields([
      { name: 'iconFile', maxCount: 1 },
      { name: 'htmlFiles', maxCount: 10 }
    ])(req, res, (err) => {
      if (err) {
        return res.status(400).json({ success: false, error: err.message });
      }
      next();
    });
  },
  async (req, res) => {
    try {
      const appName = (req.body.appName || '').trim();
      if (!appName) {
        return res.status(400).json({ success: false, error: 'appName is required.' });
      }

      const htmlFiles = (req.files && req.files.htmlFiles) || [];
      if (htmlFiles.length === 0) {
        return res.status(400).json({ success: false, error: 'At least one HTML file is required.' });
      }

      const iconFile = req.files && req.files.iconFile ? req.files.iconFile[0] : null;

      const job = createJob(appName);
      enqueue(job, { htmlFiles, iconFile });

      return res.status(202).json({
        success: true,
        jobId: job.id,
        status: job.status,
        queuePosition: queue.findIndex((q) => q.job.id === job.id) + 1,
        statusUrl: `/status/${job.id}`,
        downloadUrl: `/download/${job.id}`
      });
    } catch (err) {
      console.error('POST /generate error:', err);
      return res.status(500).json({ success: false, error: 'Internal server error while queuing the job.' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /status/:jobId
// ---------------------------------------------------------------------------
app.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ success: false, error: 'Job not found.' });
  }

  const queuePosition = queue.findIndex((q) => q.job.id === job.id);

  return res.json({
    success: true,
    jobId: job.id,
    appName: job.appName,
    status: job.status,
    step: job.step,
    progress: job.progress,
    error: job.error,
    queuePosition: queuePosition >= 0 ? queuePosition + 1 : null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    downloadReady: job.status === 'done'
  });
});

// ---------------------------------------------------------------------------
// GET /download/:jobId
// ---------------------------------------------------------------------------
app.get('/download/:jobId', async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ success: false, error: 'Job not found.' });
  }

  if (job.status !== 'done' || !job.apkPath) {
    return res.status(409).json({
      success: false,
      error: `APK not ready. Current status: ${job.status}.`
    });
  }

  const exists = await fse.pathExists(job.apkPath);
  if (!exists) {
    return res.status(410).json({ success: false, error: 'Build artifact no longer exists.' });
  }

  const safeName = job.appName.replace(/[^a-zA-Z0-9._-]/g, '_') || 'app';
  res.download(job.apkPath, `${safeName}.apk`, (err) => {
    if (err) {
      console.error(`[job ${job.id}] download error:`, err);
    }
  });
});

// ---------------------------------------------------------------------------
// Fallback error handler - guarantees the server never crashes on a bad request
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error('Unhandled Express error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, error: 'Unexpected server error.' });
});

process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
});

app.listen(PORT, () => {
  console.log(`HTML-to-APK service listening on port ${PORT}`);
  console.log(`Apktool: ${APKTOOL_BIN} / ${APKTOOL_JAR}`);
  console.log(`Signer:  ${SIGNER_JAR}`);
  console.log(`Base APK expected at: ${BASE_APK_PATH}`);
});
