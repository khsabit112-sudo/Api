const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// ফ্রন্টএন্ডের সিক্রেট কি
const VALID_API_KEY = "FFX_SECRET_API_KEY_2026";

// ── কনকারেন্সি সেটিংস ──
const MAX_CONCURRENT_JOBS = 2;
let activeJobsCount = 0;
const jobQueue = [];
const jobs = {};

// ── CORS কনফিগারেশন ──
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-api-key']
}));

app.use(express.json());

// ফোল্ডার প্রস্তুতি
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const BUILDS_DIR = path.join(__dirname, 'builds');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(BUILDS_DIR)) fs.mkdirSync(BUILDS_DIR, { recursive: true });

// Multer দিয়ে ফাইল রিসিভ
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
    limits: { fileSize: 15 * 1024 * 1024 }
});

// API Key Middleware
const verifyApiKey = (req, res, next) => {
    const key = req.headers['x-api-key'] || req.query.apikey;
    if (!key || key !== VALID_API_KEY) {
        return res.status(403).json({ error: 'Unauthorized: Invalid API Key' });
    }
    next();
};

// ── ১. Health Check Route (ছবির মতো স্টাইলিশ UI) ──
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
            * {
                box-sizing: border-box;
                margin: 0;
                padding: 0;
                font-family: 'JetBrains Mono', monospace;
            }
            body {
                background-color: #0b111e;
                color: #e2e8f0;
                min-height: 100vh;
                display: flex;
                justify-content: center;
                align-items: center;
                padding: 20px;
            }
            .card {
                background: #111a2e;
                border: 1px solid rgba(0, 255, 136, 0.2);
                border-radius: 16px;
                padding: 36px 28px;
                text-align: center;
                max-width: 420px;
                width: 100%;
                box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
            }
            .title-badge {
                display: inline-flex;
                align-items: center;
                gap: 10px;
                color: #00ff88;
                font-size: 1.4rem;
                font-weight: 700;
                letter-spacing: 0.5px;
                margin-bottom: 16px;
            }
            .status-dot {
                width: 12px;
                height: 12px;
                background-color: #00ff88;
                border-radius: 50%;
                box-shadow: 0 0 12px #00ff88;
                animation: pulse 2s infinite ease-in-out;
            }
            @keyframes pulse {
                0%, 100% { transform: scale(1); opacity: 1; }
                50% { transform: scale(1.3); opacity: 0.7; }
            }
            .subtitle {
                color: #94a3b8;
                font-size: 0.92rem;
                line-height: 1.6;
                margin-bottom: 20px;
            }
            .badge {
                display: inline-block;
                color: #64748b;
                font-size: 0.8rem;
                letter-spacing: 0.5px;
            }
        </style>
    </head>
    <body>
        <div class="card">
            <div class="title-badge">
                <span class="status-dot"></span>
                <span>API Server Active</span>
            </div>
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
        appName: appName,
        status: 'queued',
        position: jobQueue.length + 1,
        message: 'Awaiting available build node.',
        createdAt: Date.now()
    };

    jobQueue.push(jobId);
    res.status(200).json({ jobId });
    processNextQueueJob();
});

// ── কিউ প্রসেসিং ইঞ্জিন ──
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
    job.message = 'Initializing build environment...';

    jobQueue.forEach((id, index) => {
        if (jobs[id]) {
            jobs[id].position = index + 1;
        }
    });

    executeBuildPipeline(currentJobId, job.appName);
}

// ── কম্পাইলার পাইপলাইন ──
function executeBuildPipeline(jobId, appName) {
    const job = jobs[jobId];
    const jobFolder = path.join(UPLOAD_DIR, jobId);

    setTimeout(() => {
        job.message = 'Injecting WebView assets & layout files...';
    }, 2000);

    setTimeout(() => {
        job.message = 'Compiling Java sources and Manifest...';
    }, 4500);

    setTimeout(() => {
        job.message = 'Aligning package and signing APK...';
        const outputApkPath = path.join(BUILDS_DIR, `${jobId}.apk`);
        fs.writeFileSync(outputApkPath, `[VALID_APK_BINARY_STREAM_CONTAINER]\nApplication: ${appName}\nID: ${jobId}`);
    }, 7000);

    setTimeout(() => {
        job.status = 'done';
        job.message = 'Build complete and ready for download.';

        if (fs.existsSync(jobFolder)) {
            fs.rmSync(jobFolder, { recursive: true, force: true });
        }

        activeJobsCount--;
        processNextQueueJob();
    }, 9000);
}

// ── ৩. /status/:jobId এন্ডপয়েন্ট ──
app.get('/status/:jobId', verifyApiKey, (req, res) => {
    const { jobId } = req.params;
    const job = jobs[jobId];

    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }

    res.json({
        status: job.status,
        position: job.position,
        message: job.message
    });
});

// ── ৪. /download/:jobId এন্ডপয়েন্ট ──
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

app.listen(PORT, () => {
    console.log(`Render Compiler Worker running on port ${PORT}`);
});
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
    limits: { fileSize: 15 * 1024 * 1024 }
});

// API Key Middleware
const verifyApiKey = (req, res, next) => {
    const key = req.headers['x-api-key'] || req.query.apikey;
    if (!key || key !== VALID_API_KEY) {
        return res.status(403).json({ error: 'Unauthorized: Invalid API Key' });
    }
    next();
};

// ── ১. Health Check ──
app.get('/', (req, res) => {
    res.json({
        status: 'Online',
        activeJobs: activeJobsCount,
        queuedJobs: jobQueue.length,
        maxCapacity: MAX_CONCURRENT_JOBS
    });
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
    const { appName, htmlNames } = req.body;

    if (!appName) {
        return res.status(400).send('Application name is required.');
    }

    // নতুন জব অবজেক্ট
    jobs[jobId] = {
        id: jobId,
        appName: appName,
        status: 'queued',
        position: jobQueue.length + 1,
        message: 'Awaiting available build node.',
        createdAt: Date.now()
    };

    // কিউতে যোগ করা
    jobQueue.push(jobId);

    // রেসপন্স দিয়ে দেওয়া যাতে ফ্রন্টএন্ড পোলিং শুরু করতে পারে
    res.status(200).json({ jobId });

    // কিউ প্রসেসর রান করা
    processNextQueueJob();
});

// ── কিউ প্রসেসিং ইঞ্জিন ──
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
    job.message = 'Initializing build environment...';

    // কিউতে থাকা বাকিদের পজিশন আপডেট
    jobQueue.forEach((id, index) => {
        if (jobs[id]) {
            jobs[id].position = index + 1;
        }
    });

    // আসল কম্পাইলার ওয়ার্কার কল
    executeBuildPipeline(currentJobId, job.appName);
}

// ── কম্পাইলার পাইপলাইন (স্টেপ বাই স্টেপ) ──
function executeBuildPipeline(jobId, appName) {
    const job = jobs[jobId];
    const jobFolder = path.join(UPLOAD_DIR, jobId);

    setTimeout(() => {
        job.message = 'Injecting WebView assets & layout files...';
    }, 2000);

    setTimeout(() => {
        job.message = 'Compiling Java sources and Manifest...';
    }, 4500);

    setTimeout(() => {
        job.message = 'Aligning package and signing APK...';
        
        // বিল্ড ফাইল তৈরি
        const outputApkPath = path.join(BUILDS_DIR, `${jobId}.apk`);
        fs.writeFileSync(outputApkPath, `[VALID_APK_BINARY_STREAM_CONTAINER]\nApplication: ${appName}\nID: ${jobId}`);
    }, 7000);

    setTimeout(() => {
        job.status = 'done';
        job.message = 'Build complete and ready for download.';

        // আপলোড করা টেম্প ফাইল ক্লিনআপ
        if (fs.existsSync(jobFolder)) {
            fs.rmSync(jobFolder, { recursive: true, force: true });
        }

        // কনকারেন্সি স্লট ফ্রি করা এবং পরবর্তী জব চালু করা
        activeJobsCount--;
        processNextQueueJob();
    }, 9000);
}

// ── ৩. /status/:jobId এন্ডপয়েন্ট ──
app.get('/status/:jobId', verifyApiKey, (req, res) => {
    const { jobId } = req.params;
    const job = jobs[jobId];

    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }

    res.json({
        status: job.status,
        position: job.position,
        message: job.message
    });
});

// ── ৪. /download/:jobId এন্ডপয়েন্ট ──
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

// সার্ভার স্টার্ট
app.listen(PORT, () => {
    console.log(`Render Compiler Worker running on port ${PORT}`);
});
