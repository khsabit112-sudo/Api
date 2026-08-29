const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

const VALID_API_KEY = "FFX_SECRET_API_KEY_2026";

const MAX_CONCURRENT_JOBS = 2;
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

// ফোল্ডার প্রস্তুতি
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const BUILDS_DIR = path.join(__dirname, 'builds');
const BASE_APK_PATH = path.join(__dirname, 'base.apk');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(BUILDS_DIR)) fs.mkdirSync(BUILDS_DIR, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const jobId = req.uploadJobId;
        const jobFolder = path.join(UPLOAD_DIR, jobId);
        if (!fs.existsSync(jobFolder)) fs.mkdirSync(jobFolder, { recursive: true });
        cb(null, jobFolder);
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 25 * 1024 * 1024 }
});

const verifyApiKey = (req, res, next) => {
    const key = req.headers['x-api-key'] || req.query.apikey;
    if (!key || key !== VALID_API_KEY) {
        return res.status(403).json({ error: 'Unauthorized: Invalid API Key' });
    }
    next();
};

// ── Health Check ──
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

// ── /generate ──
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
        appName: appName,
        status: 'queued',
        position: jobQueue.length + 1,
        message: 'Awaiting build slot.',
        createdAt: Date.now()
    };

    jobQueue.push(jobId);
    res.status(200).json({ jobId });
    processNextQueueJob();
});

function processNextQueueJob() {
    if (activeJobsCount >= MAX_CONCURRENT_JOBS || jobQueue.length === 0) {
        return;
    }

    const currentJobId = jobQueue.shift();
    const job = jobs[currentJobId];
    if (!job) return;

    activeJobsCount++;
    job.status = 'processing';
    job.position = 0;
    job.message = 'Decompressing binary APK container...';

    jobQueue.forEach((id, index) => {
        if (jobs[id]) jobs[id].position = index + 1;
    });

    executeBuildPipeline(currentJobId, job.appName);
}

function executeBuildPipeline(jobId, appName) {
    const job = jobs[jobId];
    const jobFolder = path.join(UPLOAD_DIR, jobId);
    const outputApkPath = path.join(BUILDS_DIR, `${jobId}.apk`);

    setTimeout(() => {
        job.message = 'Injecting HTML pages into asset pipeline...';
    }, 1500);

    setTimeout(() => {
        try {
            if (!fs.existsSync(BASE_APK_PATH)) {
                throw new Error("base.apk not found on server root! Please upload base.apk to GitHub.");
            }

            const stats = fs.statSync(BASE_APK_PATH);
            if (stats.size < 10000) {
                throw new Error("base.apk file is too small or corrupted! Upload a valid APK.");
            }

            const zip = new AdmZip(BASE_APK_PATH);

            // আপলোড করা সব HTML ফাইল assets ফোল্ডারে পাঠানো
            const uploadedFiles = fs.readdirSync(jobFolder);
            uploadedFiles.forEach((fileName) => {
                const filePath = path.join(jobFolder, fileName);
                const fileData = fs.readFileSync(filePath);

                if (fileName.endsWith('.html') || fileName.endsWith('.htm')) {
                    zip.addFile(`assets/${fileName}`, fileData);
                } else if (fileName.endsWith('.png')) {
                    zip.addFile(`res/drawable/app_icon.png`, fileData);
                }
            });

            // সিগনেচার সরানো
            const entries = zip.getEntries();
            entries.forEach((entry) => {
                if (entry.entryName.startsWith("META-INF/")) {
                    zip.deleteFile(entry.entryName);
                }
            });

            zip.writeZip(outputApkPath);
            job.message = 'APK package assembled successfully.';
            
            // কাজ শেষ
            setTimeout(() => {
                job.status = 'done';
                job.message = 'Build complete and ready for download.';

                if (fs.existsSync(jobFolder)) {
                    fs.rmSync(jobFolder, { recursive: true, force: true });
                }

                activeJobsCount--;
                processNextQueueJob();
            }, 2000);

        } catch (err) {
            console.error("Pipeline Error:", err);
            job.status = 'error';
            job.message = err.message || 'Build pipeline crashed';

            if (fs.existsSync(jobFolder)) {
                fs.rmSync(jobFolder, { recursive: true, force: true });
            }

            activeJobsCount--;
            processNextQueueJob();
        }
    }, 3500);
}

// ── /status/:jobId ──
app.get('/status/:jobId', verifyApiKey, (req, res) => {
    const { jobId } = req.params;
    const job = jobs[jobId];

    if (!job) {
        return res.status(404).json({ error: 'Job not found or expired' });
    }

    res.json({
        status: job.status,
        position: job.position,
        message: job.message
    });
});

// ── /download/:jobId ──
app.get('/download/:jobId', verifyApiKey, (req, res) => {
    const { jobId } = req.params;
    const job = jobs[jobId];
    const apkFilePath = path.join(BUILDS_DIR, `${jobId}.apk`);

    if (!fs.existsSync(apkFilePath)) {
        return res.status(404).send('APK File not found or expired.');
    }

    const downloadName = job ? `${job.appName.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.apk` : 'app.apk';
    res.download(apkFilePath, downloadName);
});

// গ্লোবাল এরর হ্যান্ডলার যাতে সার্ভার শাটডাউন না হয়
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
});

app.listen(PORT, () => {
    console.log(`Render Compiler Worker running on port ${PORT}`);
});
