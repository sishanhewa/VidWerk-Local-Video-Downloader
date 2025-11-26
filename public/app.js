// public/app.js

const urlEl = document.getElementById("url");
const typeEl = document.getElementById("type");
const qualityEl = document.getElementById("quality");
const downloadBtn = document.getElementById("downloadBtn");
const cancelBtn = document.getElementById("cancelBtn");
const showBtn = document.getElementById("showBtn");
const pasteBtn = document.getElementById("pasteBtn");
const qualitySpinner = document.getElementById("qualitySpinner");

const progressBar = document.getElementById("progressBar");
const progressText = document.getElementById("progressText");

let debounceTimer = null;
let lastUrlLoaded = "";
let currentJobId = null;
let currentEventSource = null;
let lastFilePath = null;       // for "Show in Folder"

/* ------------------------ QUALITIES AUTO-LOAD ------------------------ */

function setLoadingQualities(isLoading) {
    if (isLoading) {
        // Only reset dropdown when starting to load
        qualityEl.disabled = true;
        qualityEl.innerHTML = `<option>Loading qualities…</option>`;
    } else {
        // When done loading, DO NOT overwrite options
        qualityEl.disabled = false;
    }

    if (qualitySpinner) {
        qualitySpinner.classList.toggle("hidden", !isLoading);
    }
}

async function fetchQualities(url) {
    setLoadingQualities(true);
    setStatus("Fetching formats...");

    try {
        const res = await fetch("/api/formats", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url })
        });

        const data = await res.json();

        if (!data.ok) {
            setStatus(data.error || "Failed to load formats.");
            setLoadingQualities(false);
            return;
        }

        const type = typeEl.value;
        const formats = type === "mp3" ? data.audio : data.video;

        qualityEl.innerHTML = "";
        formats.forEach((f) => {
            const opt = document.createElement("option");
            opt.value = f.id;
            opt.textContent = f.label;           // already standardized by backend
            opt.dataset.hasAudio = f.hasAudio ? "1" : "0"; // only for video formats
            qualityEl.appendChild(opt);
        });

        qualityEl.disabled = false;
        setLoadingQualities(false); // hide spinner after formats load
        setStatus("Ready");
    } catch (e) {
        setStatus("Failed to load formats.");
        setLoadingQualities(false);
    }
}

function maybeAutoLoad() {
    const url = urlEl.value.trim();
    // avoid hitting backend on partial text
    if (!url || url === lastUrlLoaded) return;
    if (!/^https?:\/\//i.test(url)) return;

    lastUrlLoaded = url;
    fetchQualities(url);
}

async function pasteFromClipboard() {
    try {
        const text = await navigator.clipboard.readText();
        if (text) {
            const cleaned = text.trim();
            urlEl.value = cleaned;
            lastUrlLoaded = ""; // force refresh even if same link
            fetchQualities(cleaned); // immediate (no debounce)
        } else {
            urlEl.focus();
        }
    } catch (e) {
        urlEl.focus();
        alert("Clipboard access blocked. Paste manually (Ctrl+V / Cmd+V).\n\nIf this is the packaged app, macOS may require permissions.");
    }
}

pasteBtn?.addEventListener("click", pasteFromClipboard);

urlEl.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(maybeAutoLoad, 900);
});

typeEl.addEventListener("change", () => {
    const url = urlEl.value.trim();
    if (url) fetchQualities(url);
});

/* ------------------------ PROGRESS UI ------------------------ */

function resetProgress() {
    if (progressBar) progressBar.style.width = "0%";
    lastFilePath = null;
    hideShowButton();
}

function setStatus(text) {
    if (progressText) progressText.textContent = text;
}

function setProgress(pct, speed, eta) {
    const percent = Math.min(Math.max(pct || 0, 0), 100);

    if (progressBar) progressBar.style.width = `${percent}%`;

    const s = speed ? ` • ${speed}` : "";
    const e = eta ? ` • ETA ${eta}` : "";
    setStatus(`Downloading… ${percent.toFixed(1)}%${s}${e}`);
}

/* ------------------------ BUTTON STATES ------------------------ */

function showCancelButton() {
    cancelBtn.style.display = "inline-flex";
    cancelBtn.disabled = false;
}
function hideCancelButton() {
    cancelBtn.style.display = "none";
    cancelBtn.disabled = true;
}
function showShowButton() {
    showBtn.style.display = "inline-flex";
    showBtn.disabled = false;
}
function hideShowButton() {
    showBtn.style.display = "none";
    showBtn.disabled = true;
}

/* ------------------------ DOWNLOAD ------------------------ */

async function download() {
    const url = urlEl.value.trim();
    const type = typeEl.value;

    if (!url) {
        alert("Paste a video link first.");
        return;
    }

    // current selected format (if any)
    const format = qualityEl.disabled ? "" : qualityEl.value;

    // hasAudio flag for backend merge logic
    let hasAudio = true;
    if (type === "mp4" && qualityEl.selectedOptions.length) {
        hasAudio = qualityEl.selectedOptions[0].dataset.hasAudio === "1";
    }

    downloadBtn.disabled = true;
    hideShowButton();
    showCancelButton();
    resetProgress();
    setStatus("Starting download...");

    try {
        const res = await fetch("/api/download", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url, type, format, hasAudio })
        });

        const data = await res.json();
        if (!data.ok || !data.jobId) {
            setStatus(data.error || "Failed to start download.");
            downloadBtn.disabled = false;
            hideCancelButton();
            return;
        }

        currentJobId = data.jobId;

        // subscribe to SSE progress
        const ev = new EventSource(`/api/progress/${currentJobId}`);
        currentEventSource = ev;

        ev.onmessage = (msg) => {
            const e = JSON.parse(msg.data);

            if (e.type === "progress") {
                setProgress(e.percent, e.speed, e.eta);
            }

            if (e.type === "done") {
                if (progressBar) progressBar.style.width = "100%";
                setStatus("Complete ✅");

                lastFilePath = e.filePath || null;
                if (lastFilePath) showShowButton();

                ev.close();
                currentEventSource = null;
                hideCancelButton();
                downloadBtn.disabled = false;
                currentJobId = null;
            }

            if (e.type === "cancelled") {
                setStatus("Cancelled ❌");
                if (progressBar) progressBar.style.width = "0%";

                ev.close();
                currentEventSource = null;
                hideCancelButton();
                downloadBtn.disabled = false;
                currentJobId = null;
            }

            if (e.type === "error") {
                setStatus("Download failed.");
                ev.close();
                currentEventSource = null;
                hideCancelButton();
                downloadBtn.disabled = false;
                currentJobId = null;
            }
        };

        ev.onerror = () => {
            setStatus("Lost connection. Download may still be running.");
            ev.close();
            currentEventSource = null;
            hideCancelButton();
            downloadBtn.disabled = false;
            currentJobId = null;
        };

    } catch (err) {
        setStatus("Download error.");
        downloadBtn.disabled = false;
        hideCancelButton();
        currentJobId = null;
    }
}

/* ------------------------ CANCEL ------------------------ */

async function cancelDownload() {
    if (!currentJobId) return;

    cancelBtn.disabled = true;
    setStatus("Cancelling...");

    try {
        await fetch(`/api/cancel/${currentJobId}`, { method: "POST" });
    } catch {
        setStatus("Cancel failed.");
        cancelBtn.disabled = false;
    }
}

/* ------------------------ SHOW IN FOLDER ------------------------ */

async function showInFolder() {
    if (!lastFilePath) return;

    try {
        await fetch("/api/reveal", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filePath: lastFilePath })
        });
    } catch {
        // silent fail; OS should still have file in Downloads
    }
}

// Expose functions globally for inline onclick handlers
window.download = download;
window.cancelDownload = cancelDownload;
window.showInFolder = showInFolder;