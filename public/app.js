const urlEl = document.getElementById("url");
const typeEl = document.getElementById("type");
const qualityEl = document.getElementById("quality");
const logEl = document.getElementById("log");
const downloadBtn = document.getElementById("downloadBtn");

const progressBar = document.getElementById("progressBar");
const progressText = document.getElementById("progressText");

let debounceTimer = null;
let lastUrlLoaded = "";

/* ------------------------ QUALITIES AUTO-LOAD ------------------------ */

function setLoadingQualities(isLoading) {
    qualityEl.disabled = true;
    qualityEl.innerHTML = `<option>${isLoading ? "Loading qualities…" : "Paste URL to load qualities…"}</option>`;
}

async function fetchQualities(url) {
    setLoadingQualities(true);
    if (logEl) logEl.textContent = ""; // keep empty (log disabled)

    try {
        const res = await fetch("/api/formats", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url })
        });

        const data = await res.json();
        if (!data.ok) {
            setLoadingQualities(false);
            return;
        }

        const type = typeEl.value;
        const formats = type === "mp3" ? data.audio : data.video;

        qualityEl.innerHTML = "";

        for (const f of formats) {
            const opt = document.createElement("option");
            opt.value = f.id;
            opt.textContent = f.label;

            if (type !== "mp3") {
                opt.dataset.hasAudio = f.hasAudio ? "1" : "0";
            }

            qualityEl.appendChild(opt);
        }

        if (formats.length === 0) {
            qualityEl.innerHTML = `<option>No formats found</option>`;
            qualityEl.disabled = true;
        } else {
            qualityEl.disabled = false;
        }
    } catch (e) {
        setLoadingQualities(false);
    }
}

function maybeAutoLoad() {
    const url = urlEl.value.trim();
    if (!url || url === lastUrlLoaded) return;

    lastUrlLoaded = url;
    fetchQualities(url);
}

urlEl.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(maybeAutoLoad, 600);
});

typeEl.addEventListener("change", () => {
    const url = urlEl.value.trim();
    if (url) fetchQualities(url);
});

/* ------------------------ PROGRESS UI ------------------------ */

function resetProgress() {
    if (progressBar) progressBar.style.width = "0%";
    if (progressText) progressText.textContent = "";
}

function setProgress(pct, speed, eta) {
    if (progressBar) progressBar.style.width = `${pct}%`;
    if (progressText) {
        const s = speed ? ` • ${speed}` : "";
        const e = eta ? ` • ETA ${eta}` : "";
        progressText.textContent = `${pct.toFixed(1)}%${s}${e}`;
    }
}

/* ------------------------ DOWNLOAD ------------------------ */

async function download() {
    const url = urlEl.value.trim();
    const type = typeEl.value;
    const format = qualityEl.disabled ? "" : qualityEl.value;

    if (!url) {
        alert("Paste a URL first.");
        return;
    }

    let hasAudio = true;
    if (type !== "mp3" && !qualityEl.disabled) {
        const selectedOpt = qualityEl.options[qualityEl.selectedIndex];
        hasAudio = selectedOpt?.dataset.hasAudio === "1";
    }

    downloadBtn.disabled = true;
    resetProgress();

    if (progressText) progressText.textContent = "Started downloading…";

    try {
        const res = await fetch("/api/download", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url, type, format, hasAudio })
        });

        const data = await res.json();
        if (!data.ok || !data.jobId) {
            if (progressText) progressText.textContent = "Failed to start download.";
            downloadBtn.disabled = false;
            return;
        }

        const jobId = data.jobId;
        const ev = new EventSource(`/api/progress/${jobId}`);

        ev.onmessage = (msg) => {
            const e = JSON.parse(msg.data);

            if (e.type === "progress") {
                setProgress(e.percent || 0, e.speed || "", e.eta || "");
            }

            if (e.type === "done") {
                if (progressBar) progressBar.style.width = "100%";
                if (progressText) progressText.textContent = "Complete ✅";
                ev.close();
                downloadBtn.disabled = false;
            }

            if (e.type === "error") {
                if (progressText) progressText.textContent = "Download failed.";
                ev.close();
                downloadBtn.disabled = false;
            }
        };

        ev.onerror = () => {
            if (progressText) progressText.textContent = "Lost connection.";
            ev.close();
            downloadBtn.disabled = false;
        };

    } catch (err) {
        if (progressText) progressText.textContent = "Download error.";
        downloadBtn.disabled = false;
    }
}
