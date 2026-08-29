const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const VALID_API_KEY = "FFX_SECRET_API_KEY_2026";

// ডিকম্পাইলে মেমরি খরচের কারণে একসাথে ১টি বিল্ড প্রসেস চলবে
const MAX_CONCURRENT_JOBS = 1;
let activeJobsCount = 0;
const jobQueue = [];
const jobs = {};

// ── CORS সেটিংস ──
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-api-key']
}));

app.use(express.json());

// ডিরেক্টরি সেটআপ
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const BUILDS_DIR = path.join(__dirname, 'builds');
const BASE_APK_PATH = path.join(__dirname, 'base.apk');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(BUILDS_DIR)) fs.mkdirSync(BUILDS_DIR, { recursive: true });

// Multer ফাইল আপলোড কনফিগারেশন
const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const folder = path.join(UPLOAD_DIR, req.uploadJobId);
            if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
            cb(null, folder);
        },
        filename: (req, file, cb) => cb(null, file.originalname)
    }),
    limits: { fileSize: 25 * 1024 * 1024 }
});

// API Key ভেরিফিকেশন মিডলওয়্যার
const verifyApiKey = (req, res, next) => {
    const key = req.headers['x-api-key'] || req.query.apikey;
    if (!key || key !== VALID_API_KEY) {
        return res.status(403).json({ error: 'Unauthorized: Invalid API Key' });
    }
    next();
};

// ── ১. সার্ভার স্ট্যাটাস পেজ (ড্যাশবোর্ড UI) ──
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>API Server Status</title>
        <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">
        <style>
            * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'JetBrains Mono', monospace; }
            body { background-color: #0b111e; color: #e2e8f0; min-height: 100vh; display: flex; justify-content: center; align-items: center; padding: 20px; }
            .card { background: #111a2e; border: 1px solid rgba(0, 255, 136, 0.2); border-radius: 16px; padding: 36px 28px; text-align: center; max-width: 420px; width: 100%; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6); }
            .title-badge { display: inline-flex; align-items: center; gap: 10px; color: #00ff88; font-size: 1.4rem; font-weight: 700; margin-bottom: 16px; }
            .status-dot { width: 12px; height: 12px; background-color: #00ff88; border-radius: 50%; box-shadow: 0 0 12px #00ff88; animation: pulse 2s infinite ease-in-out; }
            @keyframes pulse { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.3); opacity: 0.7; } }
            .subtitle { color: #94a3b8; font-size: 0.92rem; line-height: 1.6; margin-bottom: 20px; }
            .badge { display: inline-block; color: #64748b; font-size: 0.8rem; }
        </style>
    </head>
    <body>
        <div class="card">
            <div class="title-badge"><span class="status-dot"></span><span>API Server Active</span></div>
            <p class="subtitle">This server is awake and ready for requests.</p>
            <div class="badge">Secured by FFX API Key</div>
        </div>
    </body>
    </html>
    `);
});

// ── ২. /generate এন্ডপয়েন্ট ──
app.post('/generate', verifyApiKey, (req, res, next) => {
    req.uploadJobId = uuidv4();
    next();
}, upload.fields([
    { name: 'iconFile', maxCount: 1 },
    { name: 'htmlFiles', maxCount: 10 }
]), (req, res) => {
    const jobId = req.uploadJobId;
    const { appName } = req.body;

    if (!appName) {
        return res.status(400).send('Application name is required.');
    }

    jobs[jobId] = {
        id: jobId,
        appName,
        status: 'queued',
        position: jobQueue.length + 1,
        message: 'Awaiting available build slot.',
        createdAt: Date.now()
    };

    jobQueue.push(jobId);
    res.json({ jobId });
    processNextQueueJob();
});

// ── ৩. কিউ হ্যান্ডলার ──
function processNextQueueJob() {
    if (activeJobsCount >= MAX_CONCURRENT_JOBS || jobQueue.length === 0) return;

    const jobId = jobQueue.shift();
    const job = jobs[jobId];
    if (!job) return;

    activeJobsCount++;
    job.status = 'processing';
    job.position = 0;
    job.message = 'Decompiling binary APK framework...';

    jobQueue.forEach((id, index) => {
        if (jobs[id]) jobs[id].position = index + 1;
    });

    executeBuildPipeline(jobId, job.appName);
}

// ── ৪. বিল্ড পাইপলাইন (Apktool + Signer) ──
function executeBuildPipeline(jobId, appName) {
    const job = jobs[jobId];
    const workDir = path.join(UPLOAD_DIR, jobId);
    const decompiledDir = path.join(workDir, 'decompiled');
    const finalUnsigned = path.join(workDir, 'unsigned.apk');
    const signedApkPath = path.join(BUILDS_DIR, `${jobId}.apk`);

    try {
        if (!fs.existsSync(BASE_APK_PATH)) {
            throw new Error("base.apk not found on server root!");
        }

        // ১. Base APK ডিকম্পাইল করা
        execSync(`apktool d "${BASE_APK_PATH}" -o "${decompiledDir}" -f`, { stdio: 'pipe' });

        // ২. অ্যাপের নাম পরিবর্তন (strings.xml)
        job.message = 'Configuring application branding...';
        const stringsPath = path.join(decompiledDir, 'res', 'values', 'strings.xml');
        if (fs.existsSync(stringsPath)) {
            let stringsXml = fs.readFileSync(stringsPath, 'utf8');
            if (stringsXml.includes('name="app_name"')) {
                stringsXml = stringsXml.replace(/<string name="app_name">.*?<\/string>/, `<string name="app_name">${appName}</string>`);
                fs.writeFileSync(stringsPath, stringsXml);
            }
        }

        // ৩. HTML ফাইল assets ফোল্ডারে যোগ করা
        job.message = 'Injecting WebView assets...';
        const assetsDir = path.join(decompiledDir, 'assets');
        if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

        const files = fs.readdirSync(workDir);
        files.forEach(fileName => {
            const filePath = path.join(workDir, fileName);
            if (fileName.endsWith('.html') || fileName.endsWith('.htm')) {
                fs.copyFileSync(filePath, path.join(assetsDir, fileName));
            } else if (fileName.endsWith('.png')) {
                // অ্যাপ আইকন প্রতিস্থাপন (যদি রিসোর্স ফোল্ডার থাকে)
                const drawableDir = path.join(decompiledDir, 'res', 'drawable');
                if (fs.existsSync(drawableDir)) {
                    fs.copyFileSync(filePath, path.join(drawableDir, 'app_icon.png'));
                }
            }
        });

        // ৪. রিকম্পাইল করা
        job.message = 'Compiling application binaries...';
        execSync(`apktool b "${decompiledDir}" -o "${finalUnsigned}"`, { stdio: 'pipe' });

        // ৫. সাইন করা (Uber-APK-Signer)
        job.message = 'Signing APK package...';
        execSync(`java -jar /usr/local/bin/uber-apk-signer.jar --apks "${finalUnsigned}" --out "${workDir}" --overwrite`, { stdio: 'pipe' });

        // সাইন করা ফাইলটি builds ফোল্ডারে সরানো
        fs.copyFileSync(finalUnsigned, signedApkPath);

        job.status = 'done';
        job.message = 'Build complete and signed!';
    } catch (err) {
        console.error("Pipeline Execution Error:", err);
        job.status = 'error';
        // আসল এরর আউটপুট ক্লায়েন্টে পাঠানো
        const errorOutput = err.stderr ? err.stderr.toString() : err.message;
        job.message = errorOutput || 'Compilation failed during processing.';
    } finally {
        // টেম্পোরারি ওয়ার্ক ডিরেক্টরি ডিলিট করা
        if (fs.existsSync(workDir)) {
            fs.rmSync(workDir, { recursive: true, force: true });
        }
        activeJobsCount--;
        processNextQueueJob();
    }
}

// ── ৫. /status/:jobId এন্ডপয়েন্ট ──
app.get('/status/:jobId', verifyApiKey, (req, res) => {
    const job = jobs[req.params.jobId];
    if (!job) return res.status(404).json({ error: 'Job not found or expired' });
    res.json({
        status: job.status,
        position: job.position,
        message: job.message
    });
});

// ── ৬. /download/:jobId এন্ডপয়েন্ট ──
app.get('/download/:jobId', verifyApiKey, (req, res) => {
    const { jobId } = req.params;
    const job = jobs[jobId];
    const apkFilePath = path.join(BUILDS_DIR, `${jobId}.apk`);

    if (!fs.existsSync(apkFilePath)) {
        return res.status(404).send('APK file not found or build failed.');
    }

    const downloadName = job ? `${job.appName.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.apk` : 'app.apk';
    res.download(apkFilePath, downloadName);
});

// গ্লোবাল এরর হ্যান্ডলার
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
});

app.listen(PORT, () => {
    console.log(`Render Compiler Worker running on port ${PORT}`);
});
