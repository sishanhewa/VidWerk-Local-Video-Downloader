const express = require("express");
const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const { app: electronApp } = require("electron");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

/* -------------------- BINARIES -------------------- */

function getBinaries() {
    const base = electronApp.isPackaged
        ? process.resourcesPath
        : path.join(__dirname, "..");

    if (process.platform === "win32") {
        return {
            ytdlp: path.join(base, "bin", "win", "yt-dlp.exe"),
            ffmpeg: path.join(base, "bin", "win", "ffmpeg.exe"),
        };
    }

    const ytdlp = path.join(base, "bin", "mac", "yt-dlp_macos");
    const ffmpeg = path.join(base, "bin", "mac", "ffmpeg_macos");

    if (fs.existsSync(ytdlp)) fs.chmodSync(ytdlp, 0o755);
    if (fs.existsSync(ffmpeg)) fs.chmodSync(ffmpeg, 0o755);

    return { ytdlp, ffmpeg };
}

function binariesExist(res, ytdlp, ffmpeg) {
    if (!fs.existsSync(ytdlp)) {
        res.status(500).json({ ok: false, error: "yt-dlp binary missing in bin/mac or bin/win." });
        return false;
    }
    if (!fs.existsSync(ffmpeg)) {
        res.status(500).json({ ok: false, error: "ffmpeg binary missing in bin/mac or bin/win." });
        return false;
    }
    return true;
}

/* -------------------- PYINSTALLER TEMP FIX -------------------- */

function getTempEnv() {
    let tempBase;

    if (process.platform === "win32") {
        tempBase = path.join(os.tmpdir(), "yt-downloader-temp");
    } else {
        tempBase = path.join(
            os.homedir(),
            "Library",
            "Caches",
            "yt-downloader-temp"
        );
    }

    fs.mkdirSync(tempBase, { recursive: true });

    return {
        ...process.env,
        TMPDIR: tempBase,
        TEMP: tempBase,
        TMP: tempBase,
    };
}

/* -------------------- HELPERS -------------------- */

function toMiB(bytes) {
    if (!bytes || bytes <= 0) return null;
    return (bytes / (1024 * 1024)).toFixed(1);
}
function safeNum(n) {
    return typeof n === "number" && !Number.isNaN(n) ? n : null;
}

// standard tiers so UI shows normal values (720/1080/etc)
const TIERS = [144, 240, 360, 480, 720, 1080, 1440, 2160, 4320];
function normalizeHeight(h) {
    if (!h || h < 100) return 0;
    let best = TIERS[0];
    let bestDiff = Math.abs(h - best);
    for (const t of TIERS) {
        const diff = Math.abs(h - t);
        if (diff < bestDiff) {
            best = t;
            bestDiff = diff;
        }
    }
    return best;
}

/**
 * Estimate filesize if yt-dlp didn't provide it.
 * size ≈ (tbr kbps * duration sec) / 8  -> bytes
 */
function estimateBytesFromBitrateAndDuration(format, durationSec) {
    const tbr = safeNum(format.tbr); // total bitrate kbps
    if (!tbr || !durationSec) return 0;
    const bytes = (tbr * 1000 * durationSec) / 8;
    return bytes;
}

/* -------------------- FORMATS -------------------- */

app.post("/api/formats", (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ ok: false, error: "Missing url" });

    const { ytdlp, ffmpeg } = getBinaries();
    if (!binariesExist(res, ytdlp, ffmpeg)) return;

    const proc = spawn(ytdlp, ["-J", "--no-playlist", url], { env: getTempEnv() });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", d => stdout += d.toString());
    proc.stderr.on("data", d => stderr += d.toString());

    proc.on("close", code => {
        if (code !== 0) {
            return res.json({ ok: false, error: stderr || stdout });
        }

        let info;
        try {
            info = JSON.parse(stdout);
        } catch {
            return res.json({ ok: false, error: "Could not parse yt-dlp JSON output." });
        }

        const durationSec = safeNum(info.duration) || 0;
        const formats = Array.isArray(info.formats) ? info.formats : [];

        const rawVideo = [];
        const audio = [];

        for (const f of formats) {
            const id = f.format_id;
            if (!id) continue;

            const ext = (f.ext || "").toUpperCase();
            const isAudioOnly = f.vcodec === "none";
            const hasVideo = f.vcodec && f.vcodec !== "none";
            const hasAudio = f.acodec && f.acodec !== "none";

            // filesize or estimate
            let filesizeBytes = f.filesize || f.filesize_approx || 0;
            if (!filesizeBytes) {
                filesizeBytes = estimateBytesFromBitrateAndDuration(f, durationSec);
            }
            const sizeMiB = toMiB(filesizeBytes);

            // AUDIO ONLY
            if (isAudioOnly) {
                const abr = safeNum(f.abr) ? `${Math.round(f.abr)} kbps` : "audio";
                audio.push({
                    id,
                    label: `${ext} Audio (${abr})${sizeMiB ? ` • ${sizeMiB} MiB` : ""}`
                });
                continue;
            }

            // VIDEO (collect raw candidates)
            if (hasVideo) {
                const heightRaw = safeNum(f.height) || 0;
                const heightStd = normalizeHeight(heightRaw);
                const fps = safeNum(f.fps) || 0;

                rawVideo.push({
                    id,
                    ext,
                    hasAudio,
                    heightStd,
                    fps,
                    filesizeBytes,
                    sizeMiB
                });
            }
        }

        // ---------- STANDARDIZE: Pick best format per normalized resolution ----------
        const byTier = new Map();

        for (const v of rawVideo) {
            if (!v.heightStd) continue;

            const existing = byTier.get(v.heightStd);
            if (!existing) {
                byTier.set(v.heightStd, v);
                continue;
            }

            const score = (x) => {
                let s = 0;
                if (x.ext === "MP4") s += 1000;
                if (x.hasAudio) s += 100;
                if (x.filesizeBytes) s += Math.min(x.filesizeBytes / (1024 * 1024), 500);
                s += x.fps / 10;
                return s;
            };

            if (score(v) > score(existing)) {
                byTier.set(v.heightStd, v);
            }
        }

        const video = Array.from(byTier.values())
            .sort((a, b) => b.heightStd - a.heightStd)
            .map(v => ({
                id: v.id,
                hasAudio: v.hasAudio,
                height: v.heightStd,
                fps: v.fps,
                label: `${v.heightStd}p ${v.ext}${v.sizeMiB ? ` • ${v.sizeMiB} MiB` : ""}`
            }));

        audio.sort((a, b) => b.label.localeCompare(a.label));

        res.json({ ok: true, video, audio });
    });
});

/* -------------------- PROGRESS JOBS -------------------- */

const jobs = Object.create(null);

function newJob() {
    const id = crypto.randomBytes(8).toString("hex");
    jobs[id] = {
        status: "running",
        // log: [],  // 👈 log disabled
        progress: { percent: 0, speed: "", eta: "" },
        listeners: new Set()
    };
    return id;
}

function push(jobId, event) {
    const job = jobs[jobId];
    if (!job) return;
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of job.listeners) res.write(payload);
}

function closeListeners(jobId) {
    const job = jobs[jobId];
    if (!job) return;
    for (const res of job.listeners) res.end();
    job.listeners.clear();
}

// Parse yt-dlp progress lines
function parseProgress(line) {
    const m = line.match(/\[download\]\s+(\d{1,3}\.?\d*)%.*?at\s+([^\s]+).*?ETA\s+([0-9:]+)/i);
    if (!m) return null;
    return { percent: Number(m[1]), speed: m[2], eta: m[3] };
}

/* -------------------- SSE PROGRESS -------------------- */

app.get("/api/progress/:jobId", (req, res) => {
    const job = jobs[req.params.jobId];
    if (!job) return res.status(404).end();

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    job.listeners.add(res);
    push(req.params.jobId, { type: "progress", ...job.progress });

    req.on("close", () => job.listeners.delete(res));
});

/* -------------------- DOWNLOAD (ASYNC + PROGRESS) -------------------- */

app.post("/api/download", (req, res) => {
    const { url, format, type, hasAudio } = req.body;
    if (!url) return res.status(400).json({ ok: false, error: "Missing url" });

    const outputDir = path.join(os.homedir(), "Downloads");
    const { ytdlp, ffmpeg } = getBinaries();
    if (!binariesExist(res, ytdlp, ffmpeg)) return;

    const jobId = newJob();
    res.json({ ok: true, jobId });

    const args = [
        url,
        "-P", outputDir,
        "--ffmpeg-location", ffmpeg,
        "--no-playlist",
        "--newline",

        // ✅ ALWAYS unique filename per run
        "-o", "%(title)s-%(id)s-%(epoch)s.%(ext)s"
    ];

    if (type === "mp3") {
        args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
    } else if (format) {
        if (hasAudio) {
            args.push("-f", format);
        } else {
            args.push("-f", `${format}+bestaudio/best`);
            args.push("--merge-output-format", "mp4");
        }
    }

    const proc = spawn(ytdlp, args, { env: getTempEnv() });
    const job = jobs[jobId];

    proc.stdout.on("data", d => {
        for (const line of d.toString().split("\n").filter(Boolean)) {
            const p = parseProgress(line);
            if (p) {
                job.progress = p;
                push(jobId, { type: "progress", ...p });
            }
        }
    });

    proc.stderr.on("data", d => {
        const line = d.toString();
        push(jobId, { type: "errorLine", line });
    });

    proc.on("close", code => {
        if (code === 0) {
            job.status = "done";
            push(jobId, { type: "done" });
        } else {
            job.status = "error";
            push(jobId, { type: "error", message: "Download failed." });
        }
        closeListeners(jobId);
    });
});


/* -------------------- LISTEN -------------------- */

app.listen(8787, "127.0.0.1", () => {
    // console.log("Server running at http://127.0.0.1:8787"); // 👈 log commented
});
