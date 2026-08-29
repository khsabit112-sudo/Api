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

const MAX_CONCURRENT_JOBS = 1; // ডিকম্পাইলে মেমরি বেশি লাগে, তাই ১টি রাখা নিরাপদ
let activeJobsCount = 0;
const jobQueue = [];
const jobs = {};

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'x-api-key'] }));
app.use(express.json());

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const BUILDS_DIR = path.join(__dirname, 'builds');
const BASE_APK_PATH = path.join(__dirname, 'base.apk');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(BUILDS_DIR)) fs.mkdirSync(BUILDS_DIR, { recursive: true });

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

const verifyApiKey = (req, res, next) => {
    const key = req.headers['x-api-key'] || req.query.apikey;
    if (key !== VALID_API_KEY) return res.status(403).json({ error: 'Unauthorized' });
    next();
};

app.get('/', (req, res) => res.send('API Server Active & Ready'));

app.post('/generate', verifyApiKey, (req, res, next) => {
    req.uploadJobId = uuidv4();
    next();
}, upload.fields([{ name: 'iconFile', maxCount: 1 }, { name: 'htmlFiles', maxCount: 10 }]), (req, res) => {
    const jobId = req.uploadJobId;
    const { appName } = req.body;

    jobs[jobId] = { id: jobId, appName, status: 'queued', position: jobQueue.length + 1, message: 'Queued...' };
    jobQueue.push(jobId);
    res.json({ jobId });
    processQueue();
});

function processQueue() {
    if (activeJobsCount >= MAX_CONCURRENT_JOBS || jobQueue.length === 0) return;
    const jobId = jobQueue.shift();
    const job = jobs[jobId];
    activeJobsCount++;
    job.status = 'processing';
    job.message = 'Decompiling base APK...';

    const workDir = path.join(UPLOAD_DIR, jobId);
    const decompiledDir = path.join(workDir, 'decompiled');
    const finalUnsigned = path.join(workDir, 'unsigned.apk');

    try {
        // ১. Base APK ডিকম্পাইল
        execSync(`apktool d "${BASE_APK_PATH}" -o "${decompiledDir}" -f`);

        // ২. অ্যাপের নাম পরিবর্তন (strings.xml)
        job.message = 'Configuring App Name...';
        const stringsPath = path.join(decompiledDir, 'res', 'values', 'strings.xml');
        if (fs.existsSync(stringsPath)) {
            let stringsXml = fs.readFileSync(stringsPath, 'utf8');
            stringsXml = stringsXml.replace(/<string name="app_name">.*?<\/string>/, `<string name="app_name">${job.appName}</string>`);
            fs.writeFileSync(stringsPath, stringsXml);
        }

        // ৩. HTML ফাইল assets এ যোগ করা
        job.message = 'Injecting HTML assets...';
        const assetsDir = path.join(decompiledDir, 'assets');
        if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

        const files = fs.readdirSync(workDir);
        files.forEach(f => {
            if (f.endsWith('.html') || f.endsWith('.htm')) {
                fs.copyFileSync(path.join(workDir, f), path.join(assetsDir, f));
            }
        });

        // ৪. রিকম্পাইল করা
        job.message = 'Building raw APK package...';
        execSync(`apktool b "${decompiledDir}" -o "${finalUnsigned}"`);

        // ৫. সাইন করা (Uber-APK-Signer দিয়ে)
        job.message = 'Signing final APK...';
        execSync(`java -jar /usr/local/bin/uber-apk-signer.jar --apks "${finalUnsigned}" --out "${BUILDS_DIR}" --overwrite`);

        // ফাইলের নাম জব আইডিতে সেট করা
        fs.renameSync(finalUnsigned, path.join(BUILDS_DIR, `${jobId}.apk`));

        job.status = 'done';
        job.message = 'Build complete!';
    } catch (err) {
        console.error(err);
        job.status = 'error';
        job.message = 'Compilation failed during processing.';
    } finally {
        if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
        activeJobsCount--;
        processQueue();
    }
}

app.get('/status/:jobId', verifyApiKey, (req, res) => {
    const job = jobs[req.params.jobId];
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({ status: job.status, position: job.position, message: job.message });
});

app.get('/download/:jobId', verifyApiKey, (req, res) => {
    const apkFilePath = path.join(BUILDS_DIR, `${req.params.jobId}.apk`);
    if (!fs.existsSync(apkFilePath)) return res.status(404).send('Not found');
    res.download(apkFilePath, `${jobs[req.params.jobId]?.appName || 'app'}.apk`);
});

app.listen(PORT, () => console.log(`Compiler running on ${PORT}`));
