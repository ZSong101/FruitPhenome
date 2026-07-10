// For local testing, change to http://localhost:8000/process_single
//let API_URL = "https://crabbly-watermelonphenotyping.hf.space/process_single";
//let API_URL = "https://fruit-proxy-cv71.onrender.com/proxy_process";
let API_URL = "https://PPAL-SongLab-UGA-watermelon-proxy.hf.space/proxy_process";

const SINGLE_REQUEST_TIMEOUT_MS = 60000; // 1 minute
const BULK_REQUEST_TIMEOUT_MS = 40000;
const BULK_TIMEOUT_MESSAGE = "Taking longer than 40 seconds. Moving on.";
const BULK_RETRY_MESSAGE = "Taking longer than 40 seconds. Trying again...";
const BULK_SERVER_RETRY_MESSAGE = "Server unavailable or warming up. Trying again...";
const STOP_CONFIRM_MS = 3500;
const PROD_WARMUP_TIMEOUT_MS = 40000;
const PROD_WARMUP_INTERVAL_MS = 45 * 60 * 1000;
const PROD_WARMUP_RECENT_MS = 10 * 60 * 1000;
const TARGET_HASH = "9139eb3676d5dfafced7613f044d86d9e7c84f40a04c83ddce062878621315d0";
const DEVTEST_TARGET_HASH = "ae1860180228042c8481b07ac784542baf6acc14cdda4b8941555e70d67932b8";

let currentPassword = ""; // Stores the password in memory after a successful login
let currentUsername = ""; // Stores user identity
let currentSessionId = "";
let queuePollingIntervalId = null;
let storedDataStatusHideTimer = null;
let productionWarmupIntervalId = null;
let productionWarmupPromise = null;
let productionWarmupPromiseKey = "";
let productionWarmupLastAt = 0;
let productionWarmupLastKey = "";

function makeClientId(prefix = "id") {
    if (window.crypto?.randomUUID) return `${prefix}_${window.crypto.randomUUID()}`;
    return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function proxyBaseUrl() {
    return API_URL.replace(/\/(proxy_process|process_single).*$/, "");
}

function usesProxyApi() {
    return API_URL.includes("/proxy_process");
}

function batchStageUrl() {
    return `${proxyBaseUrl()}/${usesProxyApi() ? "proxy_batch_stage" : "batch_stage"}`;
}

function processJobsUrl(rest = "") {
    return `${proxyBaseUrl()}/${usesProxyApi() ? "proxy_process_jobs" : "process_jobs"}${rest}`;
}

function previewUrlBase() {
    return `${proxyBaseUrl()}/${usesProxyApi() ? "proxy_preview" : "preview"}`;
}

function clearSessionUrl() {
    return `${proxyBaseUrl()}/${usesProxyApi() ? "proxy_preview_session_clear" : "preview_session/clear"}`;
}

function warmupUrl() {
    return `${proxyBaseUrl()}/${usesProxyApi() ? "proxy_warmup" : "warmup"}`;
}

function compatibilityUrl() {
    return `${proxyBaseUrl()}/${usesProxyApi() ? "proxy_compatibility" : "compatibility_check"}`;
}

function flushQueueUrl() {
    return `${proxyBaseUrl()}/${usesProxyApi() ? "proxy_flush_queue" : "flush_queue"}`;
}

function isDevUser() {
    return currentUsername.trim().toLowerCase() === "devtest";
}

function setStoredDataStatus(message, state = "loading", autoHideMs = 0) {
    const banner = document.getElementById("stored-data-status");
    const text = document.getElementById("stored-data-status-text");
    if (!banner || !text) return;
    if (storedDataStatusHideTimer) {
        clearTimeout(storedDataStatusHideTimer);
        storedDataStatusHideTimer = null;
    }
    text.innerText = message || "";
    banner.classList.toggle("visible", Boolean(message));
    banner.classList.toggle("ready", state === "ready");
    banner.classList.toggle("warning", state === "warning");
    if (autoHideMs > 0) {
        storedDataStatusHideTimer = setTimeout(() => {
            banner.classList.remove("visible", "ready", "warning");
            text.innerText = "";
            storedDataStatusHideTimer = null;
        }, autoHideMs);
    }
}

function safeClientToken(value) {
    return String(value || "").replace(/[^0-9A-Za-z_.-]+/g, "_").slice(0, 64).replace(/^[_\-.]+|[_\-.]+$/g, "") || "row";
}

function setLastUpdatedStamp() {
    const stamp = document.getElementById("last-updated-stamp");
    if (!stamp) return;

    const modified = new Date(document.lastModified);
    if (Number.isNaN(modified.getTime())) {
        stamp.innerText = "Last updated: unavailable";
        return;
    }

    const date = new Intl.DateTimeFormat("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric"
    }).format(modified);
    const time = new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short"
    }).format(modified);
    stamp.innerText = `Last updated: ${date} at ${time}`;
}

function activateTab(targetId) {
    const analysisTarget = targetId === "single-panel" || targetId === "bulk-panel";
    const labelingTarget = targetId === "labeling-panel";
    if (analysisTarget && !wizardCompleted) {
        targetId = "settings-panel";
        showWizardStep(wizardStep || 1);
    } else if (labelingTarget && !selectedFruit()) {
        targetId = "settings-panel";
        showWizardStep(1);
    } else if (analysisTarget) {
        analysisTabsClicked = true;
    }

    document.querySelectorAll(".tab-button").forEach(button => {
        const active = button.dataset.tabTarget === targetId;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", active ? "true" : "false");
    });

    document.querySelectorAll(".tab-panel").forEach(panel => {
        panel.classList.toggle("active", panel.id === targetId);
    });

    updateAnalysisTabAvailability();
}

function initAppTabs() {
    const buttons = document.querySelectorAll(".tab-button");
    if (!buttons.length) return;

    buttons.forEach(button => {
        button.addEventListener("click", () => activateTab(button.dataset.tabTarget));
        button.addEventListener("keydown", (event) => {
            if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
            event.preventDefault();
            const ordered = Array.from(buttons);
            const direction = event.key === "ArrowRight" ? 1 : -1;
            const next = ordered[(ordered.indexOf(button) + direction + ordered.length) % ordered.length];
            next.focus();
            activateTab(next.dataset.tabTarget);
        });
    });
}

setLastUpdatedStamp();
initAppTabs();

const ARUCO_PRINT_CODES = [
    { label: "4x4", file: "4x4_1000-0.svg", sizeMm: 10 },
    { label: "5x5", file: "5x5_1000-0.svg", sizeMm: 50 },
    { label: "6x6", file: "6x6_1000-0.svg", sizeMm: 100 }
];

function setArucoPdfStatus(message, isError = false) {
    const status = document.getElementById("aruco-pdf-status");
    if (!status) return;
    status.innerText = message || "";
    status.classList.toggle("error", Boolean(isError));
}

function loadPdfImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`Could not load ${src}`));
        img.src = src;
    });
}

async function rasterizeSquareForPdf(src, pixelSize = 900) {
    const img = await loadPdfImage(src);
    const canvas = document.createElement("canvas");
    canvas.width = pixelSize;
    canvas.height = pixelSize;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, pixelSize, pixelSize);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, pixelSize, pixelSize);
    return canvas.toDataURL("image/png");
}

async function rasterizeLogoForPdf(src) {
    const img = await loadPdfImage(src);
    const maxWidth = 900;
    const scale = Math.min(1, maxWidth / Math.max(1, img.naturalWidth || img.width));
    const width = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
    const height = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    const refIdx = ((height - 1) * width + (width - 1)) * 4;
    const ref = [data[refIdx], data[refIdx + 1], data[refIdx + 2], data[refIdx + 3]];
    const tolerance = 36;
    for (let i = 0; i < data.length; i += 4) {
        const alpha = data[i + 3];
        const colorDistance = Math.hypot(data[i] - ref[0], data[i + 1] - ref[1], data[i + 2] - ref[2]);
        if (alpha < 10 || (ref[3] > 10 && colorDistance <= tolerance)) {
            data[i] = 255;
            data[i + 1] = 255;
            data[i + 2] = 255;
            data[i + 3] = 255;
        }
    }
    ctx.putImageData(imageData, 0, 0);
    return { dataUrl: canvas.toDataURL("image/png"), width, height };
}

function drawPdfDimensionGuide(pdf, x, y, sizeMm, label) {
    const guideY = y + sizeMm + 4;
    pdf.setDrawColor(65, 75, 82);
    pdf.setLineWidth(0.25);
    pdf.line(x, guideY, x + sizeMm, guideY);
    pdf.line(x, guideY - 2, x, guideY + 2);
    pdf.line(x + sizeMm, guideY - 2, x + sizeMm, guideY + 2);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(8);
    pdf.setTextColor(30, 42, 50);
    pdf.text(`${label}: ${sizeMm} mm x ${sizeMm} mm`, x + sizeMm / 2, guideY + 5.2, { align: "center" });
}

function drawPdfScissorsIcon(pdf, x, y, scale = 1) {
    const s = scale;
    pdf.setDrawColor(120, 130, 138);
    pdf.setFillColor(255, 255, 255);
    pdf.setLineWidth(0.2);
    pdf.circle(x, y - s, 0.62 * s, "S");
    pdf.circle(x, y + s, 0.62 * s, "S");
    pdf.line(x + 0.72 * s, y - 0.18 * s, x + 3.1 * s, y - 1.7 * s);
    pdf.line(x + 0.72 * s, y + 0.18 * s, x + 3.1 * s, y + 1.7 * s);
    pdf.line(x + 2.9 * s, y - 1.7 * s, x + 3.55 * s, y - 2.05 * s);
    pdf.line(x + 2.9 * s, y + 1.7 * s, x + 3.55 * s, y + 2.05 * s);
}

function drawPdfMarker(pdf, marker, dataUrl, x, y) {
    const cutPaddingMm = 3;
    const cutX = x - cutPaddingMm;
    const cutY = y - cutPaddingMm;
    const cutSize = marker.sizeMm + cutPaddingMm * 2;
    if (typeof pdf.setLineDashPattern === "function") {
        pdf.setLineDashPattern([1.5, 1.2], 0);
    }
    pdf.setDrawColor(120, 130, 138);
    pdf.setLineWidth(0.22);
    pdf.rect(cutX, cutY, cutSize, cutSize);
    if (typeof pdf.setLineDashPattern === "function") {
        pdf.setLineDashPattern([], 0);
    }
    drawPdfScissorsIcon(pdf, cutX + 1.6, cutY - 1.7, 0.85);
    pdf.addImage(dataUrl, "PNG", x, y, marker.sizeMm, marker.sizeMm);
    pdf.setDrawColor(30, 42, 50);
    pdf.setLineWidth(0.25);
    pdf.rect(x, y, marker.sizeMm, marker.sizeMm);
    drawPdfDimensionGuide(pdf, x, y, marker.sizeMm, marker.label);
}

function drawPdfInstructionList(pdf, items, x, y, width) {
    const fontSize = 7.8;
    const lineHeightMm = 3.45;
    let cursorY = y;

    items.forEach(item => {
        const level = item.level || 0;
        const indent = level === 0 ? 0 : 7;
        const bulletX = x + indent;
        const textX = bulletX + 3.2;
        const availableWidth = Math.max(20, width - indent - 3.2);
        const lines = pdf.splitTextToSize(item.text, availableWidth);

        pdf.setFont("helvetica", item.bold ? "bold" : "normal");
        pdf.setFontSize(fontSize);
        pdf.setTextColor(30, 42, 50);
        pdf.text("-", bulletX, cursorY);
        pdf.text(lines, textX, cursorY);
        cursorY += lines.length * lineHeightMm + (level === 0 ? 1.05 : 0.45);
    });

    return cursorY;
}

async function buildArucoPrintSheetPdf() {
    const jsPDF = window.jspdf?.jsPDF;
    if (!jsPDF) throw new Error("PDF library failed to load. Refresh the page and try again.");

    const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "letter", precision: 12 });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const margin = 14;
    const platformName = "Specialty Crop Fruit Phenotyping Platform";
    const siteUrl = "https://zsong101.github.io/FruitPhenome/";

    pdf.setProperties({
        title: "ArUco Calibration Codes",
        subject: "Printable ArUco size calibration sheet",
        creator: platformName
    });

    let titleX = margin;
    try {
        const logo = await rasterizeLogoForPdf("lab_logo.png");
        const logoW = 36;
        const logoH = logoW * (logo.height / Math.max(1, logo.width));
        pdf.addImage(logo.dataUrl, "PNG", margin, 7, logoW, logoH);
        titleX = margin + logoW + 4;
    } catch (error) {
        console.warn(error);
    }

    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(10);
    pdf.setTextColor(30, 42, 50);
    pdf.text("Specialty Crop Fruit\nPhenotyping Platform", titleX, 10.5);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(8);
    pdf.setTextColor(70, 82, 90);
    pdf.text(siteUrl, pageW - margin, 10.5, { align: "right" });

    pdf.setFont("helvetica", "bolditalic");
    pdf.setFontSize(10);
    pdf.setTextColor(30, 42, 50);
    const instructionsY = 28;
    pdf.text("Using this ArUco code reference sheet:", margin, instructionsY);

    const instructions = [
        {
            text: "Download and print this document on standard US Letter paper (8.5 x 11 in)."
        },
        {
            level: 1,
            text: "In the print dialog, choose Custom Scale: 100% (or Actual Size)."
        },
        {
            level: 1,
            text: "Turn off Fit to Page and Shrink to Printable Area."
        },
        {
            text: "After printing, use calipers to verify that the black marker square matches the size printed below it."
        },
        {
            level: 1,
            text: "If it does not, recheck the print settings. You can also record the actual measurement for post-processing correction."
        },
        {
            text: "Choose ONLY ONE code below, using the size closest to your fruit.",
            bold: true
        },
        {
            level: 1,
            text: "Examples: watermelon - 100 mm; pepper - 50 mm; cherry - 10 mm."
        },
        {
            text: "Cut along the dashed line and keep all padding inside it. Do not cut into the black code; leaving extra padding is fine."
        },
        {
            text: "Keep the code clearly visible in every image. Place it upright as a square, rather than rotated like a diamond."
        },
        {
            text: "Keep the code flat and flush. If helpful, attach it to a rigid, flat surface such as a table or small card."
        },
        {
            text: "Place the code at the same imaging plane or distance as the fruit surface to improve measurement accuracy."
        }
    ];
    const instructionsBottomY = drawPdfInstructionList(
        pdf,
        instructions,
        margin + 1,
        instructionsY + 5.4,
        pageW - margin * 2 - 1
    );

    const markerImages = await Promise.all(ARUCO_PRINT_CODES.map(async marker => ({
        marker,
        dataUrl: await rasterizeSquareForPdf(marker.file, Math.max(520, Math.round(marker.sizeMm * 16)))
    })));

    const markerGapMm = 9;
    const markerSpanMm = ARUCO_PRINT_CODES.reduce((sum, marker) => sum + marker.sizeMm, 0)
        + markerGapMm * (ARUCO_PRINT_CODES.length - 1);
    const markerStartX = (pageW - markerSpanMm) / 2;
    const largestMarkerMm = Math.max(...ARUCO_PRINT_CODES.map(marker => marker.sizeMm));
    const markerTopY = Math.max(96, instructionsBottomY + 7);
    const markerBottomY = markerTopY + largestMarkerMm;
    let markerX = markerStartX;
    markerImages.forEach(({ marker, dataUrl }) => {
        const markerY = markerBottomY - marker.sizeMm;
        drawPdfMarker(pdf, marker, dataUrl, markerX, markerY);
        markerX += marker.sizeMm + markerGapMm;
    });

    const timestamp = new Intl.DateTimeFormat("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short"
    }).format(new Date());
    pdf.setFontSize(8);
    pdf.setTextColor(90, 104, 114);
    pdf.text(timestamp, pageW - margin, pageH - 8, { align: "right" });

    return pdf;
}

async function generateArucoPrintSheetPdf() {
    const pdf = await buildArucoPrintSheetPdf();
    pdf.save("aruco_calibration_codes.pdf");
}

function setupArucoPdfDownload() {
    const button = document.getElementById("download-aruco-pdf-btn");
    if (!button) return;
    button.addEventListener("click", async () => {
        button.disabled = true;
        setArucoPdfStatus("Generating PDF...");
        try {
            await generateArucoPrintSheetPdf();
            setArucoPdfStatus("PDF downloaded.");
            setTimeout(() => setArucoPdfStatus(""), 2500);
        } catch (error) {
            console.error(error);
            setArucoPdfStatus(error.message || "PDF generation failed.", true);
        } finally {
            button.disabled = false;
        }
    });
}

async function sha256(message) {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

function saveSession() {
    try {
        sessionStorage.setItem("fp_session", JSON.stringify({
            p: currentPassword,
            u: currentUsername,
            s: currentSessionId,
            t: Date.now()
        }));
    } catch (_) { /* private browsing or quota */ }
}

function loadSavedSession() {
    try {
        const raw = sessionStorage.getItem("fp_session");
        if (!raw) return null;
        const data = JSON.parse(raw);
        if (!data.p || !data.u || (Date.now() - data.t) > SESSION_MAX_AGE_MS) {
            sessionStorage.removeItem("fp_session");
            return null;
        }
        return data;
    } catch (_) {
        return null;
    }
}

async function enterApp() {
    document.getElementById("login-view").style.display = "none";
    document.getElementById("app-view").style.display = "block";
    updateDevQueueToolsVisibility();
    startQueuePolling();
    startProductionWarmupPolling();
    setStoredDataStatus("Loading saved data: fruit models, model versions, and processing batches...");
    const expertsLoaded = await loadExperts();
    setStoredDataStatus("Loading saved processing batches...");
    const jobsLoaded = await restoreLatestPersistentJob();
    if (expertsLoaded && jobsLoaded) {
        setStoredDataStatus("Saved models, model versions, and processing batches loaded.", "ready", 3500);
    } else {
        setStoredDataStatus("Some saved data could not be loaded. Refresh or try again if something looks missing.", "warning", 6000);
    }
}

// Auto-restore session on page load
(async () => {
    const saved = loadSavedSession();
    if (saved) {
        const expectedHash = saved.u.trim().toLowerCase() === "devtest" ? DEVTEST_TARGET_HASH : TARGET_HASH;
        if (await sha256(saved.p) === expectedHash) {
            currentPassword = saved.p;
            currentUsername = saved.u;
            currentSessionId = saved.s;
            console.log(`Session restored for ${currentUsername}.`);
            await enterApp();
        }
    }
})();

// --- NEW LOGIN LISTENER ---
document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pwd = document.getElementById("login-password").value;
    const uname = document.getElementById("login-name").value.trim();
    const errorDiv = document.getElementById("login-error");

    const digest = await sha256(pwd);
    const expectedHash = uname.trim().toLowerCase() === "devtest" ? DEVTEST_TARGET_HASH : TARGET_HASH;
    if (digest === expectedHash) {
        currentPassword = pwd;
        currentUsername = uname;
        currentSessionId = makeClientId("session");
        saveSession();
        console.log(`Logged in as ${currentUsername}. Sending traffic via Proxy.`);

        // Track unique login name
        if (typeof gtag === 'function') {
            gtag('event', 'user_login', {
                'event_category': 'Authentication',
                'username': currentUsername
            });
        }

        await enterApp();
    } else {
        errorDiv.innerText = "Incorrect password.";
    }
});

document.getElementById("toggle-password-btn")?.addEventListener("click", function () {
    const pwd = document.getElementById("login-password");
    const showing = pwd.type === "text";
    pwd.type = showing ? "password" : "text";
    this.textContent = showing ? "Show" : "Hide";
    this.setAttribute("aria-label", showing ? "Show password" : "Hide password");
});

function hasLineOptionList(settings) {
    return Boolean(settings?.lineOptions && settings.lineOptions.trim());
}

function checkboxChecked(id, fallback = false) {
    const el = document.getElementById(id);
    return el ? Boolean(el.checked) : fallback;
}

function positiveNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function settingsUseMetricUnits(settings = null) {
    const snapshot = settings || getAnalysisSettingsSnapshot();
    return Boolean(snapshot.useColorChecker || positiveNumber(snapshot.scaleValue));
}

function shouldRequestLineOcr(previewIds = [], settings = null) {
    const snapshot = settings || getAnalysisSettingsSnapshot();
    const explicitOcrOutputRequested = previewIds.includes("image_line_ocr_base64")
        || previewIds.includes("image_ocr_dbnet_base64")
        || previewIds.includes("image_combined_base64")
        || (typeof visibleColumnIds !== "undefined" && (
            visibleColumnIds.has("line")
            || visibleColumnIds.has("line_confidence")
            || visibleColumnIds.has("line_orientation")
        ));
    if (explicitOcrOutputRequested) return true;
    if (!snapshot.readLabels) return false;
    return hasLineOptionList(snapshot);
}

function processUrl(previewIds = [], includeLineOcr = false) {
    const params = new URLSearchParams();
    params.set("include_image", previewIds.length > 0 ? "true" : "false");
    if (previewIds.length > 0) params.set("preview_types", previewIds.join(","));
    if (includeLineOcr) params.set("include_line_ocr", "true");
    return `${API_URL}?${params.toString()}`;
}

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;"
    }[ch]));
}

function isNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}

function fmt(value, digits = 1) {
    return isNumber(value) ? value.toFixed(digits) : "N/A";
}

function measurementUnit(data) {
    if (data.measurement_unit) return data.measurement_unit;
    return "cm";
}
 
function areaUnit(data) {
    if (data.area_unit === "cm2") return "cm²";
    if (data.area_unit === "px2") return "px²";
    return "cm²";
}

function rowNotes(data) {
    const notes =[];
    if (Array.isArray(data.warnings)) notes.push(...data.warnings);
    if (data.rind_source && data.rind_source !== "whole_mask_overlap") {
        notes.push(`rind: ${data.rind_source}`);
    }
    return notes.join(" | ");
}

function processingLogText(itemOrData) {
    const item = itemOrData && "data" in itemOrData ? itemOrData : null;
    const data = item ? (item.data || {}) : (itemOrData || {});
    const entries = [];

    if (item?.message) entries.push(item.message);
    else if (data.success === false && data.message) entries.push(`Error: ${data.message}`);

    const notes = rowNotes(data);
    if (notes) entries.push(notes);

    return [...new Set(entries.filter(Boolean))].join(" | ");
}

function renderProcessingLogCell(item) {
    const log = processingLogText(item);
    const className = `processing-log-cell${item.success === false ? " error-log" : ""}`;
    return `<td class="${className}">${log ? escapeHtml(log) : `<span class="muted">N/A</span>`}</td>`;
}

function sliderNumber(id, fallback) {
    const el = document.getElementById(id);
    const value = Number(el?.value);
    return Number.isFinite(value) ? value : fallback;
}

function selectedFruit() {
    return document.getElementById("fruit-select")?.value || "";
}

// Fruit types that have a trained expert in the registry. Seeded with
// watermelon so validation works before /experts loads; refreshed after login
// and after onboarding a new fruit.
let knownFruitTypes = new Set(["watermelon"]);
let knownExperts = [];

function isKnownFruit(value) {
    return knownFruitTypes.has(String(value || "").trim().toLowerCase());
}

function expertsUrl() {
    return `${proxyBaseUrl()}/${usesProxyApi() ? "proxy_experts" : "experts"}`;
}

function rebuildFruitOptions(experts) {
    const select = document.getElementById("fruit-select");
    if (!select) return;
    const previous = select.value;
    const trained = Array.isArray(experts) ? experts : [];
    knownExperts = trained.slice();
    knownFruitTypes = new Set(trained.map(e => String(e.fruit_type || "").trim().toLowerCase()).filter(Boolean));
    if (knownFruitTypes.size === 0) knownFruitTypes.add("watermelon");

    const options = ['<option value="" selected disabled>Select fruit...</option>'];
    const seen = new Set();
    trained.forEach(e => {
        const ft = String(e.fruit_type || "").trim();
        if (!ft || seen.has(ft.toLowerCase())) return;
        seen.add(ft.toLowerCase());
        const label = e.label || (ft.charAt(0).toUpperCase() + ft.slice(1).replace(/_/g, " "));
        options.push(`<option value="${ft}">${label}</option>`);
    });
    if (!seen.has("watermelon")) {
        options.splice(1, 0, '<option value="watermelon">Watermelon</option>');
        knownFruitTypes.add("watermelon");
    }
    // "Other" triggers the new-fruit onboarding flow (handled elsewhere).
    options.push('<option value="other">Other (train a new fruit)</option>');
    select.innerHTML = options.join("\n");
    if (previous && (knownFruitTypes.has(previous.toLowerCase()) || previous === "other")) {
        select.value = previous;
    }
    updateAnalysisTabAvailability();
    rebuildModelVersionOptions(select.value);
}

function rebuildModelVersionOptions(fruitType = selectedFruit()) {
    const row = document.getElementById("model-version-row");
    const select = document.getElementById("model-version-select");
    if (!row || !select) return;
    const fruit = String(fruitType || "").trim().toLowerCase();
    const versions = knownExperts
        .filter(expert => String(expert.fruit_type || "").trim().toLowerCase() === fruit)
        .sort((a, b) => Number(b.version || 0) - Number(a.version || 0));
    row.style.display = versions.length ? "block" : "none";
    select.innerHTML = versions.map(expert => {
        const suffix = expert.is_default ? " (latest/default)" : " (archived)";
        return `<option value="${escapeHtml(expert.id)}">${escapeHtml(`v${expert.version}${suffix}`)}</option>`;
    }).join("");
    const defaultExpert = versions.find(expert => expert.is_default) || versions[0];
    if (defaultExpert) select.value = defaultExpert.id;
}

window.refreshExperts = function () { return loadExperts(); };

async function loadExperts() {
    const fruitSelect = document.getElementById("fruit-select");
    const modelSelect = document.getElementById("model-version-select");
    const modelRow = document.getElementById("model-version-row");
    if (fruitSelect && !fruitSelect.value) {
        fruitSelect.innerHTML = '<option value="" selected disabled>Loading saved fruit models...</option>';
    }
    if (modelSelect && modelRow && modelRow.style.display !== "none") {
        modelSelect.innerHTML = '<option value="">Loading model versions...</option>';
    }
    try {
        const url = `${expertsUrl()}?username=${encodeURIComponent(currentUsername || "")}&password=${encodeURIComponent(currentPassword || "")}`;
        const response = await fetch(url);
        const data = await response.json();
        if (data && data.success && Array.isArray(data.experts)) {
            rebuildFruitOptions(data.experts);
            return true;
        } else if (fruitSelect && !fruitSelect.querySelector("option[value='watermelon']")) {
            rebuildFruitOptions([]);
        }
        return false;
    } catch (err) {
        console.warn("Could not load experts; keeping default fruit options.", err);
        if (fruitSelect && !fruitSelect.querySelector("option[value='watermelon']")) {
            rebuildFruitOptions([]);
        }
        return false;
    }
}

function requireWalkthroughComplete(statusEl) {
    const fruitSelect = document.getElementById("fruit-select");
    const fruitStatus = document.getElementById("fruit-select-status");
    if (wizardCompleted && isKnownFruit(fruitSelect?.value)) {
        fruitSelect.classList.remove("input-error");
        fruitStatus?.classList.remove("visible");
        return true;
    }

    if (statusEl) {
        statusEl.innerText = "Complete the Analysis Setup walkthrough on the Main tab before processing.";
    }
    activateTab("settings-panel");
    const targetStep = isKnownFruit(fruitSelect?.value) ? wizardStep : 1;
    showWizardStep(targetStep);
    validateWizardStep(targetStep);
    return false;
}

function getAnalysisSettingsSnapshot() {
    return {
        fruit: selectedFruit(),
        expertId: document.getElementById("model-version-select")?.value || "",
        readLabels: checkboxChecked("read-labels-input", false),
        readQr: checkboxChecked("read-qr-input", false),
        useColorChecker: checkboxChecked("use-color-checker-input", true),
        lineOptions: document.getElementById("line-options-input")?.value || "",
        scaleValue: (document.getElementById("scale-value-input")?.value || "").trim(),
        scaleUnit: document.getElementById("scale-unit-select")?.value || "cm_per_px",
        traditionalSettings: {
            proximal_width_percent: sliderNumber("trad-proximal-width-input", 10),
            distal_width_percent: sliderNumber("trad-distal-width-input", 10),
            angle_sample_percent: sliderNumber("trad-angle-span-input", 5),
            end_indentation_percent: sliderNumber("trad-end-band-input", 25)
        }
    };
}

function appendAnalysisSettings(formData, settings) {
    const snapshot = settings || getAnalysisSettingsSnapshot();
    formData.append("fruit_type", snapshot.fruit || "");
    formData.append("expert_id", snapshot.expertId || "");
    formData.append("read_labels", snapshot.readLabels ? "true" : "false");
    formData.append("read_qr", snapshot.readQr ? "true" : "false");
    formData.append("use_color_checker", snapshot.useColorChecker ? "true" : "false");
    formData.append("line_options", snapshot.lineOptions || "");
    formData.append("scale_value", snapshot.scaleValue || "");
    formData.append("scale_unit", snapshot.scaleUnit || "cm_per_px");
    formData.append("traditional_settings", JSON.stringify(snapshot.traditionalSettings || {}));
}

function productionWarmupPayload(settings = null) {
    const snapshot = settings || getAnalysisSettingsSnapshot();
    return {
        password: currentPassword,
        username: currentUsername,
        fruit_type: snapshot.fruit || "",
        expert_id: snapshot.expertId || ""
    };
}

function productionWarmupKey(payload) {
    return `${payload.fruit_type || ""}::${payload.expert_id || ""}`;
}

function canWarmProduction() {
    return Boolean(currentPassword) && !isDevUser();
}

async function warmProductionBackend(options = {}) {
    const {
        settings = null,
        force = false,
        statusEl = null,
        statusText = "Warming up production server..."
    } = options;
    if (!canWarmProduction()) return { success: true, skipped: true };

    const now = Date.now();
    const payload = productionWarmupPayload(settings);
    const key = productionWarmupKey(payload);
    if (!force && productionWarmupLastAt && productionWarmupLastKey === key && now - productionWarmupLastAt < PROD_WARMUP_RECENT_MS) {
        return { success: true, skipped: true, recent: true };
    }
    if (productionWarmupPromise) {
        if (productionWarmupPromiseKey === key) return productionWarmupPromise;
        await productionWarmupPromise;
    }

    if (statusEl && statusText) statusEl.innerText = statusText;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PROD_WARMUP_TIMEOUT_MS);
    productionWarmupPromiseKey = key;
    productionWarmupPromise = fetch(warmupUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
        cache: "no-store"
    })
        .then(async response => {
            const text = await response.text();
            let data = {};
            try {
                data = text ? JSON.parse(text) : {};
            } catch (err) {
                data = { success: false, message: `Warmup returned non-JSON response (${response.status})` };
            }
            if (!response.ok || data.success === false) {
                throw new Error(data.message || `Warmup failed (${response.status})`);
            }
            productionWarmupLastAt = Date.now();
            productionWarmupLastKey = key;
            return data;
        })
        .catch(error => {
            console.warn("Production warmup failed; continuing with normal processing.", error);
            return { success: false, message: error.message || "Warmup failed." };
        })
        .finally(() => {
            clearTimeout(timeoutId);
            productionWarmupPromise = null;
            productionWarmupPromiseKey = "";
        });

    return productionWarmupPromise;
}

function startProductionWarmupPolling() {
    if (productionWarmupIntervalId) {
        clearInterval(productionWarmupIntervalId);
        productionWarmupIntervalId = null;
    }
    if (!canWarmProduction()) return;
    warmProductionBackend({ force: true, statusText: "" });
    productionWarmupIntervalId = setInterval(() => {
        warmProductionBackend({ force: true, statusText: "" });
    }, PROD_WARMUP_INTERVAL_MS);
}

function updateSettingsSliderLabels() {
    [
        ["trad-proximal-width-input", "trad-proximal-width-value"],
        ["trad-distal-width-input", "trad-distal-width-value"],
        ["trad-angle-span-input", "trad-angle-span-value"],
        ["trad-end-band-input", "trad-end-band-value"]
    ].forEach(([inputId, valueId]) => {
        const input = document.getElementById(inputId);
        const out = document.getElementById(valueId);
        if (input && out) out.innerText = `${Number(input.value).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
    });
}

function setupAnalysisSettingsControls() {
    setupArucoPdfDownload();
    updateSettingsSliderLabels();
    document.querySelectorAll("#analysis-settings-fieldset input[type='range']").forEach(input => {
        input.addEventListener("input", updateSettingsSliderLabels);
    });
    ["read-labels-input", "read-qr-input", "use-color-checker-input"].forEach(id => {
        document.getElementById(id)?.addEventListener("change", () => {
            const allFeatures = document.getElementById("mode-all-features-input");
            if (allFeatures) allFeatures.checked = false;
            applyAnalysisColumnPreset();
        });
    });
    ["scale-value-input", "scale-unit-select"].forEach(id => {
        document.getElementById(id)?.addEventListener("input", () => {
            applyMetricColumnUnitLabels();
            renderColumnPicker();
            renderColumnHelp();
            syncVisibleOutputs();
        });
        document.getElementById(id)?.addEventListener("change", () => {
            applyMetricColumnUnitLabels();
            renderColumnPicker();
            renderColumnHelp();
            syncVisibleOutputs();
        });
    });
    ["mode-standard-input", "mode-smoothing-input", "mode-legacy-ta-input", "mode-visual-comparison-input", "mode-all-features-input"].forEach(id => {
        document.getElementById(id)?.addEventListener("change", () => {
            if (id === "mode-all-features-input" && checkboxChecked(id, false)) {
                ["read-labels-input", "read-qr-input", "use-color-checker-input", "mode-standard-input", "mode-smoothing-input", "mode-legacy-ta-input", "mode-visual-comparison-input"].forEach(otherId => {
                    const input = document.getElementById(otherId);
                    if (input) input.checked = true;
                });
            } else if (id !== "mode-all-features-input") {
                const allFeatures = document.getElementById("mode-all-features-input");
                if (allFeatures) allFeatures.checked = false;
            }
            applyAnalysisColumnPreset();
        });
    });
    document.getElementById("fruit-select")?.addEventListener("change", (event) => {
        const value = event.target.value;
        updateAnalysisTabAvailability();
        rebuildModelVersionOptions(value);
        if (value === "other") {
            event.target.classList.remove("input-error");
            document.getElementById("fruit-select-status")?.classList.remove("visible");
            if (window.FruitOnboarding && typeof window.FruitOnboarding.start === "function") {
                window.FruitOnboarding.start();
            }
            return;
        }
        const invalid = !isKnownFruit(value);
        event.target.classList.toggle("input-error", invalid);
        document.getElementById("fruit-select-status")?.classList.toggle("visible", invalid);
    });
}

// --- ANALYSIS SETUP WALKTHROUGH (WIZARD) ---
const WIZARD_SUMMARY_STEP = 6;
const WIZARD_ALL_STEPS = [
    { step: 1, label: "Fruit" },
    { step: 2, label: "Scale & Calibration" },
    { step: 3, label: "Labels & Codes" },
    { step: 4, label: "Features" },
    { step: 5, label: "Manual Settings", requiresLegacy: true },
    { step: WIZARD_SUMMARY_STEP, label: "Review" }
];
const WIZARD_MANUAL_SETTINGS_STEP = WIZARD_ALL_STEPS.find(item => item.requiresLegacy).step;
let wizardStep = 1;
let wizardCompleted = false;
let wizardEditingFromSummary = false;
let wizardEditManualWasVisible = true;
let analysisTabsClicked = false;

function updateAnalysisTabAvailability() {
    const ready = Boolean(wizardCompleted);
    ["single-tab", "bulk-tab"].forEach(id => {
        const button = document.getElementById(id);
        if (!button) return;
        button.classList.toggle("setup-locked", !ready);
        button.classList.toggle("setup-ready-highlight", ready && !analysisTabsClicked);
        button.setAttribute("aria-disabled", ready ? "false" : "true");
        button.title = ready ? "" : "Complete the Analysis Setup first.";
    });
    const labelingButton = document.getElementById("labeling-tab");
    if (labelingButton) {
        const labelingReady = Boolean(selectedFruit());
        labelingButton.classList.toggle("setup-locked", !labelingReady);
        labelingButton.setAttribute("aria-disabled", labelingReady ? "false" : "true");
        labelingButton.title = labelingReady ? "" : "Select a fruit type on the Main tab first.";
    }
}

function wizardStepElements() {
    return [...document.querySelectorAll("#analysis-settings-card .wizard-step")];
}

function legacyFeaturesSelected() {
    return checkboxChecked("mode-legacy-ta-input", false) || checkboxChecked("mode-all-features-input", false) || hasVisibleColumnInGroup("traditional");
}

function activeWizardSteps() {
    return WIZARD_ALL_STEPS.filter(item => !item.requiresLegacy || legacyFeaturesSelected());
}

function activeWizardStepNumbers() {
    return activeWizardSteps().map(item => item.step);
}

function coerceWizardStep(step, direction = 1) {
    const steps = activeWizardStepNumbers();
    const requested = Number(step) || 1;
    if (steps.includes(requested)) return requested;
    if (direction < 0) {
        return [...steps].reverse().find(candidate => candidate < requested) || steps[0];
    }
    return steps.find(candidate => candidate > requested) || steps[steps.length - 1];
}

function nextWizardStep(current) {
    const steps = activeWizardStepNumbers();
    const idx = steps.indexOf(current);
    return idx >= 0 && idx < steps.length - 1 ? steps[idx + 1] : steps[steps.length - 1];
}

function previousWizardStep(current) {
    const steps = activeWizardStepNumbers();
    const idx = steps.indexOf(current);
    return idx > 0 ? steps[idx - 1] : steps[0];
}

function finalWizardInputStep() {
    const steps = activeWizardStepNumbers();
    return steps[Math.max(0, steps.length - 2)];
}

function renderWizardIndicator() {
    const indicator = document.getElementById("wizard-step-indicator");
    if (!indicator) return;
    const steps = activeWizardSteps();
    indicator.innerHTML = steps.map((item, idx) => {
        const step = item.step;
        const done = step !== wizardStep && (wizardCompleted || step < wizardStep);
        const state = step === wizardStep ? "current" : (done ? "done" : "");
        return `<span class="wizard-indicator-item ${state}"><span class="wizard-dot">${done ? "&#10003;" : idx + 1}</span>${escapeHtml(item.label)}</span>`;
    }).join("");
}

function updateWizardNav() {
    const nav = document.querySelector("#analysis-settings-card .wizard-nav");
    const backBtn = document.getElementById("wizard-back-btn");
    const nextBtn = document.getElementById("wizard-next-btn");
    if (!nav || !backBtn || !nextBtn) return;
    const onSummary = wizardStep === WIZARD_SUMMARY_STEP;
    nav.style.display = onSummary ? "none" : "flex";
    backBtn.style.visibility = (wizardStep === 1 || wizardEditingFromSummary) ? "hidden" : "visible";
    nextBtn.innerText = wizardEditingFromSummary ? "Done" : (wizardStep === finalWizardInputStep() ? "Finish" : "Next");
    const locked = isAnalysisSettingsLocked();
    backBtn.disabled = locked;
    nextBtn.disabled = locked;
}

function showWizardStep(step, { fromEdit = false } = {}) {
    wizardStep = coerceWizardStep(step, Number(step) < wizardStep ? -1 : 1);
    wizardEditingFromSummary = fromEdit && wizardStep !== WIZARD_SUMMARY_STEP;
    wizardStepElements().forEach(el => el.classList.toggle("active", Number(el.dataset.step) === wizardStep));
    if (wizardStep === WIZARD_SUMMARY_STEP) {
        wizardCompleted = true;
        renderWizardSummary();
    }
    renderWizardIndicator();
    updateWizardNav();
    updateAnalysisTabAvailability();
}

function refreshWizardForSettings() {
    const steps = activeWizardStepNumbers();
    if (!steps.includes(wizardStep)) {
        showWizardStep(coerceWizardStep(wizardStep));
        return;
    }
    if (wizardStep === WIZARD_SUMMARY_STEP) {
        renderWizardSummary();
    }
    renderWizardIndicator();
    updateWizardNav();
    updateAnalysisTabAvailability();
}

function validateWizardStep(step) {
    if (step !== 1) return true;
    const fruitSelect = document.getElementById("fruit-select");
    const valid = isKnownFruit(fruitSelect?.value);
    fruitSelect?.classList.toggle("input-error", !valid);
    document.getElementById("fruit-select-status")?.classList.toggle("visible", !valid);
    if (!valid) setTimeout(() => fruitSelect?.focus(), 0);
    return valid;
}

function wizardNext() {
    if (!validateWizardStep(wizardStep)) return;
    if (wizardEditingFromSummary) {
        // If this edit just revealed the Manual Settings step (e.g. Legacy
        // Features were checked while editing Features), visit it before
        // returning to the summary.
        const manualNowVisible = activeWizardStepNumbers().includes(WIZARD_MANUAL_SETTINGS_STEP);
        if (manualNowVisible && !wizardEditManualWasVisible && wizardStep !== WIZARD_MANUAL_SETTINGS_STEP) {
            wizardEditManualWasVisible = true;
            showWizardStep(WIZARD_MANUAL_SETTINGS_STEP, { fromEdit: true });
            return;
        }
        showWizardStep(WIZARD_SUMMARY_STEP);
        return;
    }
    if (wizardStep === finalWizardInputStep()) {
        showWizardStep(WIZARD_SUMMARY_STEP);
        return;
    }
    showWizardStep(nextWizardStep(wizardStep));
}

function wizardBack() {
    if (wizardStep > 1) showWizardStep(previousWizardStep(wizardStep));
}

function wizardSummaryRows() {
    const settings = getAnalysisSettingsSnapshot();
    const fruitSelect = document.getElementById("fruit-select");
    const fruitText = fruitSelect?.value
        ? (fruitSelect.selectedOptions?.[0]?.text || fruitSelect.value)
        : "Not selected";

    const scaleBits = [settings.scaleValue
        ? `Manual scale override: ${settings.scaleValue} ${settings.scaleUnit === "px_per_cm" ? "pixels/cm" : "cm/pixel"}`
        : "No manual scale override"];
    scaleBits.push(settings.useColorChecker ? "ColorChecker present (color + scale)" : "No ColorChecker");

    const labelBits = [settings.readLabels ? "Read on-screen labels" : "No on-screen label reading"];
    if (settings.readLabels) {
        const lineCount = (settings.lineOptions || "").split(",").map(v => v.trim()).filter(Boolean).length;
        labelBits.push(lineCount ? `${lineCount} possible Line ID${lineCount === 1 ? "" : "s"}` : "No Line ID list");
    }
    labelBits.push(settings.readQr ? "Read QR Data" : "No QR code reading");

    let featureNames = [];
    if (checkboxChecked("mode-all-features-input", false)) {
        featureNames = ["All features"];
    } else {
        if (checkboxChecked("mode-standard-input", true)) featureNames.push("Standard");
        if (checkboxChecked("mode-smoothing-input", true)) featureNames.push("Smoothing");
        if (checkboxChecked("mode-legacy-ta-input", false)) featureNames.push("Legacy (TA)");
        if (checkboxChecked("mode-visual-comparison-input", false)) featureNames.push("Visual comparison");
    }

    const rows = [
        { step: 1, label: "Fruit", value: fruitText || "Not selected" },
        { step: 2, label: "Scale & calibration", value: scaleBits.join(" - ") },
        { step: 3, label: "Labels & codes", value: labelBits.join(" - ") },
        { step: 4, label: "Features", value: featureNames.join(", ") || "None selected" }
    ];
    if (legacyFeaturesSelected()) {
        const trad = settings.traditionalSettings || {};
        rows.push({
            step: 5,
            label: "Manual settings",
            value: `Proximal ${trad.proximal_width_percent}% / Distal ${trad.distal_width_percent}% / Angle span ${trad.angle_sample_percent}% / Indent band ${trad.end_indentation_percent}%`
        });
    }
    return rows;
}

function renderWizardSummary() {
    const container = document.getElementById("wizard-summary");
    if (!container) return;
    container.innerHTML = wizardSummaryRows().map(row => `
        <div class="wizard-summary-row">
            <span class="wizard-summary-label">${escapeHtml(row.label)}</span>
            <span class="wizard-summary-value">${escapeHtml(row.value)}</span>
            <button type="button" class="wizard-edit-btn" data-step="${row.step}">Edit</button>
        </div>`).join("");
}

// --- DATA COMPATIBILITY CHECK (advisory OOD check against the active model) ---
const COMPAT_MAX_FILES = 5;
const COMPAT_VERDICT_LABELS = {
    compatible: "Compatible",
    borderline: "Borderline",
    incompatible: "Incompatible"
};

function renderCompatibilityResults(data) {
    const summaryEl = document.getElementById("compat-summary");
    const resultsEl = document.getElementById("compat-results");
    if (!summaryEl || !resultsEl) return;

    const rows = (data.results || []).map(item => {
        if (!item.success) {
            return `<div class="compat-result-row">
                <span class="compat-result-name">${escapeHtml(item.filename || "image")}</span>
                <span class="compat-result-distance">${escapeHtml(item.message || "Failed")}</span>
                <span class="compat-badge error">Error</span>
            </div>`;
        }
        const verdict = item.verdict || "error";
        return `<div class="compat-result-row">
            <span class="compat-result-name">${escapeHtml(item.filename || "image")}</span>
            <span class="compat-result-distance">distance ${Number(item.distance).toFixed(3)}</span>
            <span class="compat-badge ${escapeHtml(verdict)}">${escapeHtml(COMPAT_VERDICT_LABELS[verdict] || verdict)}</span>
        </div>`;
    });
    resultsEl.innerHTML = rows.join("");

    const verdicts = (data.results || []).filter(item => item.success).map(item => item.verdict);
    const ctaBtn = document.getElementById("compat-create-dataset-btn");
    if (ctaBtn) {
        const needsLabeling = verdicts.includes("incompatible") || verdicts.includes("borderline");
        ctaBtn.style.display = needsLabeling ? "inline-block" : "none";
    }
    summaryEl.classList.remove("ok", "warn", "bad");
    if (!verdicts.length) {
        summaryEl.innerText = "No images could be checked.";
        summaryEl.classList.add("warn");
    } else if (verdicts.includes("incompatible")) {
        summaryEl.innerText = "Some images look very different from this model's training data. Results may be unreliable, but you can still proceed.";
        summaryEl.classList.add("bad");
    } else if (verdicts.includes("borderline")) {
        summaryEl.innerText = "Some images look a little unusual compared to this model's training data. Results are likely fine, but review them carefully.";
        summaryEl.classList.add("warn");
    } else {
        summaryEl.innerText = "Your images look compatible with this model's training data.";
        summaryEl.classList.add("ok");
    }
    summaryEl.classList.add("visible");
}

function setupCompatibilityCheck() {
    const button = document.getElementById("compat-check-btn");
    const input = document.getElementById("compat-files");
    const status = document.getElementById("compat-status");
    const summaryEl = document.getElementById("compat-summary");
    const resultsEl = document.getElementById("compat-results");
    const createDatasetBtn = document.getElementById("compat-create-dataset-btn");
    if (!button || !input) return;

    createDatasetBtn?.addEventListener("click", async () => {
        const files = [...(input.files || [])].slice(0, COMPAT_MAX_FILES);
        if (!files.length) {
            if (status) status.innerText = "Choose your sample images first.";
            return;
        }
        if (!window.LabelingStudio) {
            if (status) status.innerText = "Labeling Studio is not available.";
            return;
        }
        createDatasetBtn.disabled = true;
        try {
            await window.LabelingStudio.createDatasetFromFiles("Compatibility samples", files);
        } finally {
            createDatasetBtn.disabled = false;
        }
    });

    button.addEventListener("click", async () => {
        const files = [...(input.files || [])].slice(0, COMPAT_MAX_FILES);
        if (!files.length) {
            if (status) status.innerText = "Choose 1-5 sample images first.";
            return;
        }

        button.disabled = true;
        if (status) status.innerText = `Checking ${files.length} image${files.length === 1 ? "" : "s"}...`;
        if (resultsEl) resultsEl.innerHTML = "";
        summaryEl?.classList.remove("visible");

        try {
            const formData = new FormData();
            files.forEach(file => formData.append("files", file));
            formData.append("password", currentPassword);
            formData.append("username", currentUsername);
            const response = await fetch(compatibilityUrl(), { method: "POST", body: formData });
            if (!response.ok) throw new Error(`Server responded with ${response.status}`);
            const data = await response.json();
            if (!data.success) throw new Error(data.message || "Compatibility check failed.");
            renderCompatibilityResults(data);
            if (status) status.innerText = "";
        } catch (err) {
            if (status) status.innerText = `Compatibility check failed: ${err.message}`;
        } finally {
            button.disabled = isAnalysisSettingsLocked();
        }
    });
}

function initSettingsWizard() {
    document.getElementById("wizard-back-btn")?.addEventListener("click", wizardBack);
    document.getElementById("wizard-next-btn")?.addEventListener("click", wizardNext);
    document.getElementById("wizard-summary")?.addEventListener("click", (event) => {
        const editBtn = event.target.closest?.(".wizard-edit-btn");
        if (!editBtn || isAnalysisSettingsLocked()) return;
        wizardEditManualWasVisible = activeWizardStepNumbers().includes(WIZARD_MANUAL_SETTINGS_STEP);
        showWizardStep(Number(editBtn.dataset.step), { fromEdit: true });
    });
    showWizardStep(1);
}

async function postImage(file, previewIds = [], timeoutMs = SINGLE_REQUEST_TIMEOUT_MS, maxRetries = 1, externalSignal = null, settings = null, includeLineOcr = null, rowId = null, requestedColumnIdsOverride = null, sessionIdOverride = null) {
    const requestSettings = settings || getAnalysisSettingsSnapshot();
    const requestColumnIds = requestedColumnIdsOverride || selectedColumnIdsForRequest();
    const runLineOcr = includeLineOcr ?? shouldRequestLineOcr(previewIds, requestSettings);
    const formData = new FormData();
    formData.append("password", currentPassword);
    formData.append("username", currentUsername); 
    formData.append("file", file);
    formData.append("session_id", sessionIdOverride || currentSessionId);
    if (rowId) formData.append("row_id", rowId);
    formData.append("requested_columns", JSON.stringify(requestColumnIds));
    appendAnalysisSettings(formData, requestSettings);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (externalSignal?.aborted) throw new Error("Batch stopped");

        const controller = new AbortController();
        let timedOut = false;
        const timeoutId = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);
        const abortFromExternal = () => controller.abort();
        externalSignal?.addEventListener("abort", abortFromExternal, { once: true });

        try {
            const response = await fetch(processUrl(previewIds, runLineOcr), {
                method: "POST",
                body: formData,
                signal: controller.signal
            });

            const text = await response.text();
            clearTimeout(timeoutId);
            
            let data;
            try {
                data = text ? JSON.parse(text) : {};
            } catch (err) {
                const snippet = text ? text.slice(0, 180) : "empty response";
                throw new Error(`HTTP ${response.status}: non-JSON response (${snippet})`);
            }

            if (!response.ok) {
                const responseError = new Error(data.message || `HTTP ${response.status}`);
                responseError.retryable = Boolean(data.retryable) || [502, 503, 504].includes(response.status);
                throw responseError;
            }

            if (data.success === false && data.retryable) {
                const retryableError = new Error(data.message || "Server temporarily unavailable.");
                retryableError.retryable = true;
                throw retryableError;
            }

            return data;

        } catch (err) {
            clearTimeout(timeoutId);
            externalSignal?.removeEventListener("abort", abortFromExternal);

            if (externalSignal?.aborted) {
                throw new Error("Batch stopped");
            }
            
            const isTimeout = timedOut || err.name === "AbortError" || err.message === "Timeout";
            
            // If we are out of retries, throw the error
            if (attempt === maxRetries) {
                if (isTimeout) {
                    const timeoutError = new Error(timeoutMs === BULK_REQUEST_TIMEOUT_MS ? BULK_TIMEOUT_MESSAGE : `Timed out after ${Math.round(timeoutMs / 1000)}s`);
                    timeoutError.timedOut = true;
                    throw timeoutError;
                }
                throw err;
            }
            
            // Otherwise, wait 2 seconds and retry
            console.warn(`Attempt ${attempt + 1} failed for ${file.name}. Retrying...`);
            await new Promise(r => setTimeout(r, 2000));
        } finally {
            clearTimeout(timeoutId);
            externalSignal?.removeEventListener("abort", abortFromExternal);
        }
    }
}

async function postBulkImage(file, previewIds, externalSignal = null, settings = null, includeLineOcr = null, rowId = null, requestedColumnIdsOverride = null) {
    return postImage(file, previewIds, BULK_REQUEST_TIMEOUT_MS, 0, externalSignal, settings, includeLineOcr, rowId, requestedColumnIdsOverride);
}

function isBulkTimeoutError(err) {
    return Boolean(err?.timedOut) || err?.message === BULK_TIMEOUT_MESSAGE;
}

function isBulkRetryableError(err) {
    return isBulkTimeoutError(err) || Boolean(err?.retryable);
}

function bulkRetryMessage(err) {
    return isBulkTimeoutError(err) ? BULK_RETRY_MESSAGE : BULK_SERVER_RETRY_MESSAGE;
}

function previewCell(data) {
    if (data.image_base64) {
        return `<img src="data:image/jpeg;base64,${data.image_base64}" class="thumb preview-img">`;
    }
    return `<span class="muted">Disabled</span>`;
}

function valueOrNull(value) {
    return value === undefined ? null : value;
}

function metricColumn(id, label, field, digits = 3, options = {}) {
    return {
        id,
        label,
        histLabel: options.histLabel || label,
        csvLabel: options.csvLabel || label,
        digits,
        histogram: options.histogram !== false,
        histogramOverflow: options.histogramOverflow,
        csv: options.csv !== false,
        cellClass: options.cellClass || "",
        display: options.display,
        csvValue: options.csvValue,
        get: options.get || ((data) => valueOrNull(data[field]))
    };
}

function pixelUnitLabel(label) {
    return String(label)
        .replaceAll("cm²", "px²")
        .replaceAll("cm2", "px²")
        .replaceAll("cm", "px");
}

function cmMetricColumn(id, label, field, digits = (item) => item.digits, options = {}) {
    const histLabel = options.histLabel || label;
    const csvLabel = options.csvLabel || label;
    const column = metricColumn(id, label, field, digits, {
        ...options,
        histLabel,
        csvLabel,
        get: (data, item) => (item.isCm || item.allowPixelMetrics || measurementUnit(data) === "px")
            ? valueOrNull(data[field])
            : null
    });
    column.unitSensitive = true;
    column.cmLabel = label;
    column.pxLabel = options.pxLabel || pixelUnitLabel(label);
    column.cmHistLabel = histLabel;
    column.pxHistLabel = options.pxHistLabel || pixelUnitLabel(histLabel);
    column.cmCsvLabel = csvLabel;
    column.pxCsvLabel = options.pxCsvLabel || pixelUnitLabel(csvLabel);
    return column;
}

function previewContextAttributes(data, field, adjustable = false) {
    return [
        `data-preview-type="${escapeHtml(field)}"`,
        `data-session-id="${escapeHtml(data?.session_id || "")}"`,
        `data-row-id="${escapeHtml(data?.row_id || "")}"`,
        `data-filename="${escapeHtml(data?.filename || "")}"`,
        adjustable ? `data-adjustable="true"` : ""
    ].filter(Boolean).join(" ");
}

function previewColumn(id, label, field, options = {}) {
    return {
        id,
        label,
        histogram: false,
        csv: false,
        adjustable: Boolean(options.adjustable),
        cellClass: options.adjustable ? "adjustable-preview-cell" : "",
        get: () => null,
        html: (item) => {
            const contextAttrs = previewContextAttributes(item.data, field, options.adjustable);
            if (item.data?.[field]) {
                const fullUrl = previewFetchUrl(item.data, field, "full");
                return `<img src="data:image/jpeg;base64,${item.data[field]}" data-full-src="${escapeHtml(fullUrl || `data:image/jpeg;base64,${item.data[field]}`)}" ${contextAttrs} class="thumb preview-img">`;
            }
            const thumbUrl = previewFetchUrl(item.data, field, "thumb");
            const fullUrl = previewFetchUrl(item.data, field, "full");
            if (thumbUrl) {
                return `<img src="${escapeHtml(thumbUrl)}" data-full-src="${escapeHtml(fullUrl || thumbUrl)}" ${contextAttrs} class="thumb preview-img">`;
            }
            return itemHasPendingColumn(item, id)
                ? `<span class="muted">Computing...</span>`
                : `<span class="muted">-</span>`;
        }
    };
}

const COLUMN_GROUPS = [
    {
        id: "experimental",
        label: "Experimental",
        children: [
            {
                id: "experimental_raw",
                label: "Cleanup Features",
                columns: [
                    cmMetricColumn("raw_width", "Width (cm)", "raw_width", undefined, { histLabel: "Width (cm)" }),
                    cmMetricColumn("raw_height", "Height (cm)", "raw_height", undefined, { histLabel: "Height (cm)" }),
                    cmMetricColumn("raw_perimeter", "Perim (cm)", "raw_perimeter", undefined, { histLabel: "Perim (cm)" }),
                    cmMetricColumn("raw_flesh_width", "F.Width (cm)", "raw_flesh_width", undefined, { histLabel: "F.Width (cm)" }),
                    cmMetricColumn("raw_flesh_height", "F.Height (cm)", "raw_flesh_height", undefined, { histLabel: "F.Height (cm)" }),
                    cmMetricColumn("raw_flesh_perimeter", "F.Perim (cm)", "raw_flesh_perimeter", undefined, { histLabel: "F.Perim (cm)" }),
                    cmMetricColumn("raw_rind_thick", "Rind Thick (cm)", "raw_rind_thick", undefined, { histLabel: "Rind Thick (cm)" }),
                    metricColumn("raw_rind_ratio", "Rind Ratio", "raw_rind_ratio", 3, { histLabel: "Rind Ratio" }),
                    cmMetricColumn("raw_total_area", "Tot Area (cm²)", "raw_total_area", undefined, { histLabel: "Total Area (cm²)" }),
                    cmMetricColumn("raw_flesh_area", "Flesh Area (cm²)", "raw_flesh_area", undefined, { histLabel: "Flesh Area (cm²)" }),
                    metricColumn("raw_flesh_ratio", "Flesh Ratio", "raw_flesh_ratio", 3, { histLabel: "Flesh Ratio" }),
                    metricColumn("raw_elongation", "Elong", "raw_elongation", 3, { histLabel: "Elongation" }),
                    metricColumn("raw_asym", "Asym", "raw_asym", 3, { histLabel: "Asymmetry" }),
                    metricColumn("raw_flesh_asym", "F.Asym", "raw_flesh_asym", 3, { histLabel: "Flesh Asym" }),
                    metricColumn("raw_circ", "Circ", "raw_circ", 3, { histLabel: "Circularity" })
                ]
            },
            {
                id: "experimental_smoothed",
                label: "Smoothed Features",
                columns: [
                    metricColumn("r2_rind", "R² Rind", "r2_rind", 4, { csvLabel: "R2 Rind" }),
                    metricColumn("r2_flesh", "R² Flesh", "r2_flesh", 4, { csvLabel: "R2 Flesh" }),
                    cmMetricColumn("sm_width", "Width (Sm) (cm)", "sm_width", undefined, { histLabel: "Width (Sm) (cm)" }),
                    cmMetricColumn("sm_height", "Height (Sm) (cm)", "sm_height", undefined, { histLabel: "Height (Sm) (cm)" }),
                    cmMetricColumn("sm_perimeter", "Perim (Sm) (cm)", "sm_perimeter", undefined, { histLabel: "Perim (Sm) (cm)" }),
                    cmMetricColumn("sm_flesh_width", "F.Width (Sm) (cm)", "sm_flesh_width", undefined, { histLabel: "F.Width (Sm) (cm)" }),
                    cmMetricColumn("sm_flesh_height", "F.Height (Sm) (cm)", "sm_flesh_height", undefined, { histLabel: "F.Height (Sm) (cm)" }),
                    cmMetricColumn("sm_flesh_perimeter", "F.Perim (Sm) (cm)", "sm_flesh_perimeter", undefined, { histLabel: "F.Perim (Sm) (cm)" }),
                    cmMetricColumn("sm_rind_thick", "Rind Thick (Sm) (cm)", "sm_rind_thick", undefined, { histLabel: "Rind Thick (Sm) (cm)" }),
                    metricColumn("sm_rind_ratio", "Rind Ratio (Sm)", "sm_rind_ratio", 3, { histLabel: "Rind Ratio (Sm)" }),
                    cmMetricColumn("sm_total_area", "Tot Area (Sm) (cm²)", "sm_total_area", undefined, { histLabel: "Total Area (Sm) (cm²)" }),
                    cmMetricColumn("sm_flesh_area", "Flesh Area (Sm) (cm²)", "sm_flesh_area", undefined, { histLabel: "Flesh Area (Sm) (cm²)" }),
                    metricColumn("sm_flesh_ratio", "Flesh Ratio (Sm)", "sm_flesh_ratio", 3, { histLabel: "Flesh Ratio (Sm)" }),
                    metricColumn("sm_elongation", "Elong (Sm)", "sm_elongation", 3, { histLabel: "Elongation (Sm)" }),
                    metricColumn("sm_asym", "Asym (Sm)", "sm_asym", 3, { histLabel: "Asymmetry (Sm)" }),
                    metricColumn("sm_flesh_asym", "F.Asym (Sm)", "sm_flesh_asym", 3, { histLabel: "Flesh Asym (Sm)" }),
                    metricColumn("sm_circ", "Circ (Sm)", "sm_circ", 3, { histLabel: "Circularity (Sm)" }),
                    metricColumn("sm_proximal_angle", "Prox Angle (Sm) (deg)", "sm_proximal_angle", 1, { histLabel: "Proximal Angle (Sm) (deg)" }),
                    metricColumn("sm_distal_angle", "Dist Angle (Sm) (deg)", "sm_distal_angle", 1, { histLabel: "Distal Angle (Sm) (deg)" }),
                    metricColumn("midline_curvature", "Midline Curve", "midline_curvature", 4)
                ]
            },
            {
                id: "experimental_color",
                label: "Color Calibration",
                columns: [
                    metricColumn("color_calibration_confidence", "Cal Confidence", "color_calibration_confidence", 3, { histLabel: "Color Calibration Confidence", csvLabel: "Color Calibration Confidence" }),
                    metricColumn("delta_e_initial", "Init ΔE", "delta_e_initial", 2, { histLabel: "Initial ΔE" }),
                    metricColumn("delta_e_final", "Final ΔE", "delta_e_final", 2, { histLabel: "Final ΔE" })
                ]
            }
        ]
    },
    {
        id: "traditional",
        label: "Traditional (TA)",
        children: [
            {
                id: "traditional_shape_index",
                label: "Shape Index (TA)",
                columns: [
                    metricColumn("trad_shape_index_i", "fs I H/W (TA)", "trad_shape_index_i", 3),
                    metricColumn("trad_shape_index_ii", "fs II Hm/Wm (TA)", "trad_shape_index_ii", 3),
                    metricColumn("trad_triangle", "Triangle w1/w2 (TA)", "trad_triangle", 3)
                ]
            },
            {
                id: "traditional_eccentric",
                label: "Eccentricity & Asymmetry (TA)",
                columns: [
                    metricColumn("trad_obovoid", "Obovoid (TA)", "trad_obovoid", 3),
                    metricColumn("trad_ovoid", "Ovoid (TA)", "trad_ovoid", 3),
                    metricColumn("trad_horizontal_asymmetry", "Horiz Asym (TA)", "trad_horizontal_asymmetry", 4),
                    metricColumn("trad_vertical_asymmetry", "Vert Asym (TA)", "trad_vertical_asymmetry", 4)
                ]
            },
            {
                id: "traditional_end_shape",
                label: "End Shape (TA)",
                columns: [
                    metricColumn("trad_distal_angle", "Distal Angle (TA) (deg)", "trad_distal_angle", 1),
                    metricColumn("trad_distal_blockiness", "Distal Blockiness (TA)", "trad_distal_blockiness", 3),
                    metricColumn("trad_distal_indentation_area", "Distal Indent Area (TA)", "trad_distal_indentation_area", 4),
                    metricColumn("trad_proximal_angle", "Proximal Angle (TA) (deg)", "trad_proximal_angle", 1),
                    metricColumn("trad_proximal_blockiness", "Proximal Blockiness (TA)", "trad_proximal_blockiness", 3),
                    metricColumn("trad_proximal_shoulder_height", "Shoulder Height (TA)", "trad_proximal_shoulder_height", 4),
                    metricColumn("trad_proximal_indentation_area", "Proximal Indent Area (TA)", "trad_proximal_indentation_area", 4)
                ]
            },
            {
                id: "traditional_fit",
                label: "Common Shape Fit (TA)",
                columns: [
                    metricColumn("trad_circular_r2", "Circular R² (TA)", "trad_circular_r2", 4, { csvLabel: "Circular R2 (TA)" }),
                    metricColumn("trad_ellipsoid_r2", "Ellipsoid R² (TA)", "trad_ellipsoid_r2", 4, { csvLabel: "Ellipsoid R2 (TA)" }),
                    metricColumn("trad_taperness", "Heart Taperness (TA)", "trad_taperness", 3),
                    metricColumn("trad_heart", "Heart Score (TA)", "trad_heart", 3),
                    metricColumn("trad_rectangularity", "Rectangularity (TA)", "trad_rectangularity", 4)
                ]
            }
        ]
    },
    {
        id: "previews",
        label: "Previews",
        children: [
            {
                id: "previews_standard",
                label: "Standard Previews",
                columns: [
                    previewColumn("image_ocr_dbnet_base64", "Preview (OCR DBNet)", "image_ocr_dbnet_base64"),
                    previewColumn("image_pre_calibration_base64", "Preview (Pre-Cal)", "image_pre_calibration_base64"),
                    previewColumn("image_raw_base64", "Preview (Raw)", "image_raw_base64")
                ]
            },
            {
                id: "previews_adjustable",
                label: "Adjustable Feature Previews",
                columns: [
                    previewColumn("image_combined_base64", "Preview (Combined)", "image_combined_base64", { adjustable: true }),
                    previewColumn("image_cleanup_hybrid_base64", "Preview (Cleanup)", "image_cleanup_hybrid_base64", { adjustable: true }),
                    previewColumn("image_sm_base64", "Preview (Smooth)", "image_sm_base64", { adjustable: true }),
                    previewColumn("image_traditional_base64", "Preview (Traditional) (TA)", "image_traditional_base64", { adjustable: true })
                ]
            }
        ]
    },
    {
        id: "run_info",
        label: "Run Info",
        columns: [
            metricColumn("line", "Line", "line", 0, { histogram: false }),
            metricColumn("line_confidence", "Line Confidence", "line_confidence", 2),
            metricColumn("line_orientation", "Orientation", "line_orientation", 0, { histogram: false, get: (data) => valueOrNull(data.line_orientation) }),
            metricColumn("qr_data", "QR Data", "qr_data", 0, { histogram: false }),
            metricColumn("processing_ms", "Time (ms)", "processing_ms", 0, {
                histogramOverflow: BULK_REQUEST_TIMEOUT_MS,
                display: (value, item) => item.data?.processing_ms_timeout ? `>${BULK_REQUEST_TIMEOUT_MS}` : (isNumber(value) ? fmt(value, 0) : "N/A"),
                csvValue: (value, item) => item.data?.processing_ms_timeout ? `>${BULK_REQUEST_TIMEOUT_MS}` : value
            })
        ]
    }
];

const GROUP_HELP_TEXT = {
    experimental: "Measurements derived from the model masks and the app's post-processing pipeline. These are the main outputs for this watermelon workflow.",
    experimental_raw: "Cleanup features are measured from the cleaned segmentation masks after artifact removal and mask smoothing. These values are not from the original raw YOLO masks.",
    experimental_smoothed: "Smoothed features are measured from the fitted perimeter and flesh functions. They are useful when you want less sensitivity to jagged mask edges.",
    experimental_color: "Color calibration diagnostics describe whether the ColorChecker-based correction was reliable and how much the patch colors changed. Use the middle Passport page, the 24-patch target that looks like the reference image in Analysis Settings.",
    traditional: "Traditional (TA) features are boundary-based morphology descriptors modeled after Tomato Analyzer fruit shape measurements. All features marked with (TA) are derived from Tomato Analyzer.",
    traditional_shape_index: "Shape index features (TA) describe whether the fruit is elongated, squat, triangular, or balanced in height and width.",
    traditional_eccentric: "Eccentricity and asymmetry features (TA) describe whether the widest portion is shifted toward one end and how asymmetric the shape is across horizontal or vertical axes.",
    traditional_end_shape: "End-shape features (TA) describe proximal and distal tip angles, blockiness, and indentation using the user-adjustable settings in Analysis Settings.",
    traditional_fit: "Common-shape fit features (TA) compare the cleaned fruit boundary to simple geometric or named fruit-shape templates.",
    previews: "Preview columns return diagnostic images. They are excluded from histograms and CSV downloads.",
    previews_standard: "Standard previews show OCR, calibration, and raw model outputs requested for each image.",
    previews_adjustable: "Adjustable feature previews are highlighted in pale purple. Open Combined, Cleanup, Smooth, or Traditional (TA) previews to repaint masks, constrain and refit smoothing curves, or visually adjust traditional measurement controls.",
    run_info: "Run information columns describe OCR metadata, QR code data, and processing time rather than fruit morphology."
};

const GROUP_HELP_HTML = {
    traditional: `Traditional (TA) features are boundary-based morphology descriptors modeled after <a href="https://vanderknaaplab.uga.edu/tomato-analyzer/" target="_blank" rel="noopener noreferrer">Tomato Analyzer</a> fruit shape measurements. All features marked with (TA) are derived from Tomato Analyzer.`
};

const COLUMN_HELP_TEXT = {
    raw_width: "Maximum cleaned fruit width in centimeters, measured along the flesh-derived width axis when available. This uses the cleaned mask that feeds the main feature calculations.",
    raw_height: "Maximum cleaned fruit height in centimeters, measured perpendicular to the width axis. It reflects the target cut-face region after mask cleanup.",
    raw_perimeter: "Perimeter length of the cleaned whole-fruit boundary in centimeters. This is sensitive to the cleaned contour but not to the later function fit.",
    raw_flesh_width: "Width of the combined flesh region in centimeters along the same width axis used for the fruit. It estimates the exposed edible area across the cut face.",
    raw_flesh_height: "Height of the combined flesh region in centimeters along the fruit height axis. It summarizes the vertical extent of the two flesh masks.",
    raw_flesh_perimeter: "Perimeter of the cleaned combined flesh boundary in centimeters. It is useful for checking how smooth or fragmented the flesh segmentation is.",
    raw_rind_thick: "Estimated rind thickness in centimeters, calculated from the difference between fruit width and flesh width. It is a two-sided average rather than a local rind measurement.",
    raw_rind_ratio: "Estimated rind thickness relative to fruit width. Larger values indicate proportionally thicker rind around the cut face.",
    raw_total_area: "Area of the cleaned target fruit or cut-face mask in square centimeters. This is the primary face-area measurement.",
    raw_flesh_area: "Area of the cleaned combined flesh masks in square centimeters. It excludes rind and background pixels.",
    raw_flesh_ratio: "Flesh area divided by total target fruit area. Values closer to 1 mean more of the detected face is flesh.",
    raw_elongation: "Shape elongation estimated from the cleaned fruit contour. Larger values indicate a longer, narrower shape.",
    raw_asym: "Left/right imbalance of the cleaned fruit region split by the estimated flesh midline. Values near 0 indicate stronger symmetry.",
    raw_flesh_asym: "Left/right imbalance of the cleaned flesh masks split by the estimated flesh midline. This helps flag uneven or poorly paired flesh masks.",
    raw_circ: "Circularity of the cleaned fruit contour based on area and perimeter. Values closer to 1 are more circular.",
    r2_rind: "Fit quality for the smoothed rind perimeter function. Higher values mean the fitted curve follows the cleaned rind contour more closely.",
    r2_flesh: "Fit quality for the smoothed flesh function. Higher values mean the fitted curve follows the cleaned flesh boundary more closely.",
    sm_width: "Fruit width in centimeters measured from the smoothed perimeter function. This reduces sensitivity to small segmentation irregularities.",
    sm_height: "Fruit height in centimeters measured from the smoothed perimeter function. It is the smoothed counterpart to the cleanup height.",
    sm_perimeter: "Perimeter length in centimeters of the smoothed fitted fruit boundary. It is usually less jagged than the cleanup perimeter.",
    sm_flesh_width: "Flesh width in centimeters measured from the smoothed flesh fit. This is useful when flesh mask edges are fragile.",
    sm_flesh_height: "Flesh height in centimeters measured from the smoothed flesh fit. It summarizes the fitted vertical flesh extent.",
    sm_flesh_perimeter: "Perimeter length in centimeters of the smoothed flesh fit. It reduces local noise from the raw flesh mask boundary.",
    sm_rind_thick: "Estimated rind thickness in centimeters using smoothed fruit and flesh widths. It is the smoothed counterpart to cleanup rind thickness.",
    sm_rind_ratio: "Smoothed rind thickness relative to smoothed fruit width. Larger values indicate proportionally thicker rind.",
    sm_total_area: "Area in square centimeters enclosed by the smoothed fruit function. It is a regularized estimate of total face area.",
    sm_flesh_area: "Area in square centimeters enclosed by the smoothed flesh function. It is a regularized estimate of exposed flesh area.",
    sm_flesh_ratio: "Smoothed flesh area divided by smoothed total fruit area. It is the fitted counterpart to cleanup flesh ratio.",
    sm_elongation: "Elongation estimated from the smoothed fruit contour. It is less sensitive to mask bumps than cleanup elongation.",
    sm_asym: "Asymmetry of the smoothed fruit region about the estimated midline. Lower values indicate a more balanced fitted shape.",
    sm_flesh_asym: "Asymmetry of the smoothed flesh region about the estimated midline. It helps identify uneven flesh halves after smoothing.",
    sm_circ: "Circularity of the smoothed fruit boundary. Values closer to 1 indicate a more circular fitted fruit shape.",
    sm_proximal_angle: "Endpoint angle in degrees at the smoothed proximal divot. The angle is derived from the fitted endpoint geometry rather than the raw boundary.",
    sm_distal_angle: "Endpoint angle in degrees at the smoothed distal divot. It is intended to preserve tip curvature that ordinary smoothing can flatten.",
    midline_curvature: "Curvature score for the estimated flesh midline. Larger values indicate a more curved midline between the two flesh halves.",
    color_calibration_confidence: "Overall confidence score for ColorChecker-based calibration using the middle 24-patch Passport page. Low values suggest that scale or color correction should be inspected.",
    delta_e_initial: "Average ColorChecker color error before correction. Smaller values mean the uncorrected image already matched the middle-page reference more closely.",
    delta_e_final: "Average ColorChecker color error after correction. Smaller values indicate a better final match to the reference patches.",
    trad_shape_index_i: "Tomato Analyzer (TA) fruit shape index I, calculated as maximum height divided by maximum width. Values above 1 are elongated and values below 1 are squat.",
    trad_shape_index_ii: "Tomato Analyzer (TA) fruit shape index II, calculated as mid-height divided by mid-width. It is a center-cross-section version of the height-to-width ratio.",
    trad_triangle: "Tomato Analyzer (TA) proximal width divided by distal width using the selected end-width positions. Values above 1 mean the proximal end is wider than the distal end.",
    trad_obovoid: "Tomato Analyzer (TA) score for bottom-heavy shape based on where the widest width occurs. It increases when the widest point is shifted toward the distal half.",
    trad_ovoid: "Tomato Analyzer (TA) score for top-heavy shape based on where the widest width occurs. It increases when the widest point is shifted toward the proximal half.",
    trad_horizontal_asymmetry: "Tomato Analyzer (TA) average vertical midpoint shift across fruit columns relative to the horizontal center. Larger values indicate stronger top-bottom asymmetry.",
    trad_vertical_asymmetry: "Tomato Analyzer (TA) average horizontal midpoint shift across fruit rows relative to the vertical center. Larger values indicate stronger left-right asymmetry.",
    trad_distal_angle: "Tomato Analyzer (TA) boundary-based distal endpoint angle in degrees, using the selected angle sample span. It describes whether the distal tip is pointed, flat, convex, or concave relative to the fruit center.",
    trad_distal_blockiness: "Tomato Analyzer (TA) distal-end width divided by mid-width. Larger values indicate a boxier distal end.",
    trad_distal_indentation_area: "Tomato Analyzer (TA) distal indentation area divided by total fruit area. Higher values indicate a larger concavity or notch at the distal end.",
    trad_proximal_angle: "Tomato Analyzer (TA) boundary-based proximal endpoint angle in degrees, using the selected angle sample span. It describes the stem-end shape relative to the fruit center.",
    trad_proximal_blockiness: "Tomato Analyzer (TA) proximal-end width divided by mid-width. Larger values indicate a boxier proximal end.",
    trad_proximal_shoulder_height: "Tomato Analyzer (TA) relative shoulder height around the proximal indentation. Higher values indicate deeper shoulders around the proximal notch.",
    trad_proximal_indentation_area: "Tomato Analyzer (TA) proximal indentation area divided by total fruit area. Higher values indicate a larger stem-end concavity.",
    trad_circular_r2: "Tomato Analyzer (TA) regression-style fit precision for a circle fit to the fruit boundary. Values closer to 1 indicate a more circle-like shape.",
    trad_ellipsoid_r2: "Tomato Analyzer (TA) regression-style fit precision for an ellipse fit to the fruit boundary. Values closer to 1 indicate a more ellipse-like shape.",
    trad_taperness: "Tomato Analyzer (TA) heart-shape taperness component based on average width above and below the widest point. It increases when the two ends taper differently.",
    trad_heart: "Tomato Analyzer (TA) composite heart-shape score combining widest-point position, taperness, and proximal shoulder height. Larger values indicate a more heart-like outline by this descriptor.",
    trad_rectangularity: "Tomato Analyzer (TA) ratio of maximum inscribed rectangle area to minimum enclosing rectangle area. Values closer to 1 indicate a more rectangular fruit outline.",
    image_ocr_dbnet_base64: "Diagnostic OCR preview showing DBNet text boxes, candidate reads, confidences, and selected Line when OCR is requested. It helps diagnose Line detection errors.",
    image_pre_calibration_base64: "Image before color calibration, with ColorChecker overlay when available. Use it to verify the detected board is the middle 24-patch Passport page shown in Analysis Settings.",
    image_raw_base64: "Raw model-output preview retained for diagnosis. It shows the original predicted masks before cleanup is used for measurement.",
    image_combined_base64: "Purple combined preview showing the main diagnostic overlays in one place: selected OCR read, QR code, ArUco scale marker, cleaned masks, flesh midline, smoothed contours, and smoothed endpoint geometry. It intentionally excludes Traditional (TA) feature overlays.",
    image_cleanup_hybrid_base64: "Cleanup preview showing processed masks, raw mask outlines, axes, midline, and ColorChecker overlay. Open it and choose Adjust Features to repaint the masks, recalculate the row, and save a correction for model fine-tuning.",
    image_sm_base64: "Smoothed preview showing fitted fruit and flesh curves plus endpoint angle geometry. Open it and choose Adjust Features to repaint masks or drag weighted rind/flesh curve anchors; saving refits all smoothing parameters together.",
    image_traditional_base64: "Traditional (TA) preview showing Tomato Analyzer-style overlays such as axes, widths, angles, circle, ellipse, and indentation areas. Open it and choose Adjust Features to repaint masks or drag the proximal width, distal width, angle-span, and indentation-band controls.",
    line: "Short Line ID detected from text in the image, optionally constrained by the Possible Lines list. It may contain letters, numbers, dashes, or underscores.",
    line_confidence: "Confidence score for the selected Line read or matched Line option. Lower values should be checked manually.",
    line_orientation: "Image rotation inferred from the selected OCR read and used for mask generation when text is detected. A value of 0 means no rotation was applied.",
    qr_data: "Decoded QR code payload when a QR code is present in the image. QR boxes are also drawn on generated preview images.",
    processing_ms: "Cumulative backend processing time for the image in milliseconds, including any on-demand feature or preview processing added after the row first appears. Timeout rows are shown as greater than the configured timeout value."
};

function collectColumns(group, parentId = null) {
    const direct = (group.columns || []).map(column => ({ ...column, groupId: group.id || parentId }));
    const nested = (group.children || []).flatMap(child => collectColumns(child, group.id || parentId));
    return [...direct, ...nested];
}

function collectGroups(groups, map = new Map()) {
    groups.forEach(group => {
        map.set(group.id, group);
        if (group.children) collectGroups(group.children, map);
    });
    return map;
}

function columnsForGroup(group) {
    if (!group) return [];
    return orderedColumns(collectColumns(group));
}

const ALL_COLUMNS = COLUMN_GROUPS.flatMap(group => collectColumns(group));
const ALL_COLUMN_IDS = ALL_COLUMNS.map(column => column.id);
const COLUMN_BY_ID = new Map(ALL_COLUMNS.map(column => [column.id, column]));
const COLUMN_GROUP_MAP = collectGroups(COLUMN_GROUPS);
let visibleColumnIds = new Set(ALL_COLUMNS.map(column => column.id));
let columnOrderIds = [...ALL_COLUMN_IDS];
let draggedColumnId = null;
let latestSingleData = null;
let latestSinglePreviewIds = [];

const ALWAYS_DEFAULT_COLUMN_IDS = ["processing_ms"];
const OCR_COLUMN_IDS = ["line", "line_confidence", "line_orientation"];
const QR_COLUMN_IDS = ["qr_data"];
const RAW_STAGE_COLUMN_IDS = new Set(columnIdsForGroup("experimental_raw"));
const SMOOTH_STAGE_COLUMN_IDS = new Set(columnIdsForGroup("experimental_smoothed"));
const TRADITIONAL_STAGE_COLUMN_IDS = new Set(columnIdsForGroup("traditional"));
const COLOR_STAGE_COLUMN_IDS = new Set(columnIdsForGroup("experimental_color"));
const PREVIEW_STAGE_COLUMN_IDS = new Set(columnIdsForGroup("previews"));
const OCR_STAGE_COLUMN_IDS = new Set([...OCR_COLUMN_IDS, "image_ocr_dbnet_base64", "image_line_ocr_base64", "image_combined_base64"]);
const QR_STAGE_COLUMN_IDS = new Set([...QR_COLUMN_IDS, "image_combined_base64"]);

function columnIdsForGroup(groupId) {
    const group = COLUMN_GROUP_MAP.get(groupId);
    return group ? columnsForGroup(group).map(column => column.id) : [];
}

function addColumnIds(target, ids) {
    ids.forEach(id => {
        if (COLUMN_BY_ID.has(id)) target.add(id);
    });
}

function applyMetricColumnUnitLabels(settings = null) {
    const useCm = settingsUseMetricUnits(settings || getAnalysisSettingsSnapshot());
    ALL_COLUMNS.forEach(column => {
        if (!column.unitSensitive) return;
        column.label = useCm ? column.cmLabel : column.pxLabel;
        column.histLabel = useCm ? column.cmHistLabel : column.pxHistLabel;
        column.csvLabel = useCm ? column.cmCsvLabel : column.pxCsvLabel;
    });
}

function removeColumnIds(target, ids) {
    ids.forEach(id => target.delete(id));
}

function hasVisibleColumnInGroup(groupId) {
    return columnIdsForGroup(groupId).some(id => visibleColumnIds.has(id));
}

function columnSelectionState(ids) {
    const validIds = ids.filter(id => COLUMN_BY_ID.has(id));
    const selectedCount = validIds.filter(id => visibleColumnIds.has(id)).length;
    return {
        any: selectedCount > 0,
        all: validIds.length > 0 && selectedCount === validIds.length,
        partial: selectedCount > 0 && selectedCount < validIds.length
    };
}

function setCheckboxVisualState(id, state) {
    const input = document.getElementById(id);
    if (!input) return;
    input.checked = Boolean(state.any);
    input.indeterminate = Boolean(state.partial);
}

function setBinaryCheckboxVisualState(id, checked) {
    const input = document.getElementById(id);
    if (!input) return;
    input.checked = Boolean(checked);
    input.indeterminate = false;
}

function setAllFeaturesVisualState() {
    const input = document.getElementById("mode-all-features-input");
    if (!input) return;
    const state = columnSelectionState(ALL_COLUMN_IDS);
    input.checked = Boolean(state.all);
    input.indeterminate = Boolean(state.partial);
}

function syncAnalysisModeCheckboxesFromColumns() {
    setCheckboxVisualState("mode-standard-input", columnSelectionState(columnIdsForGroup("experimental_raw")));
    setCheckboxVisualState("mode-smoothing-input", columnSelectionState(columnIdsForGroup("experimental_smoothed")));
    setCheckboxVisualState("mode-legacy-ta-input", columnSelectionState(columnIdsForGroup("traditional")));
    setCheckboxVisualState("mode-visual-comparison-input", columnSelectionState(columnIdsForGroup("previews_standard")));
    setBinaryCheckboxVisualState("read-labels-input", columnSelectionState([...OCR_STAGE_COLUMN_IDS]).any);
    setBinaryCheckboxVisualState("read-qr-input", columnSelectionState([...QR_STAGE_COLUMN_IDS]).any);
    setBinaryCheckboxVisualState("use-color-checker-input", columnSelectionState([...COLOR_STAGE_COLUMN_IDS, "image_pre_calibration_base64"]).any);
    setAllFeaturesVisualState();
}

function updateDependentSettingsAvailability() {
    const locked = isAnalysisSettingsLocked();
    const lineEnabled = checkboxChecked("read-labels-input", false) || columnSelectionState([...OCR_STAGE_COLUMN_IDS]).any;
    const traditionalEnabled = checkboxChecked("mode-legacy-ta-input", false) || hasVisibleColumnInGroup("traditional");

    const lineBlock = document.getElementById("line-settings-block");
    const lineInput = document.getElementById("line-options-input");
    if (lineBlock) lineBlock.classList.toggle("disabled", !lineEnabled);
    if (lineInput) lineInput.disabled = locked || !lineEnabled;

    const tradBlock = document.getElementById("traditional-settings-block");
    if (tradBlock) tradBlock.classList.toggle("disabled", !traditionalEnabled);
    ["trad-proximal-width-input", "trad-distal-width-input", "trad-angle-span-input", "trad-end-band-input"].forEach(id => {
        const input = document.getElementById(id);
        if (input) input.disabled = locked || !traditionalEnabled;
    });
}

function applyAnalysisColumnPreset({ sync = true } = {}) {
    const settings = getAnalysisSettingsSnapshot();
    applyMetricColumnUnitLabels(settings);

    const nextVisible = new Set();
    addColumnIds(nextVisible, ALWAYS_DEFAULT_COLUMN_IDS);

    if (checkboxChecked("mode-all-features-input", false)) {
        addColumnIds(nextVisible, ALL_COLUMN_IDS);
    } else {
        if (settings.useColorChecker) {
            addColumnIds(nextVisible, columnIdsForGroup("experimental_color"));
        }
        if (settings.readLabels) {
            addColumnIds(nextVisible, OCR_COLUMN_IDS);
        }
        if (settings.readQr) {
            addColumnIds(nextVisible, QR_COLUMN_IDS);
        }
        if (checkboxChecked("mode-standard-input", true)) {
            addColumnIds(nextVisible, columnIdsForGroup("experimental_raw"));
        }
        if (checkboxChecked("mode-smoothing-input", true)) {
            addColumnIds(nextVisible, columnIdsForGroup("experimental_smoothed"));
        }
        if (checkboxChecked("mode-legacy-ta-input", false)) {
            addColumnIds(nextVisible, columnIdsForGroup("traditional"));
        }
        if (checkboxChecked("mode-visual-comparison-input", false)) {
            addColumnIds(nextVisible, columnIdsForGroup("previews_standard"));
        }
    }

    if (!settings.useColorChecker && !checkboxChecked("mode-all-features-input", false)) {
        removeColumnIds(nextVisible, columnIdsForGroup("experimental_color"));
    }

    if (!settings.readLabels && !checkboxChecked("mode-all-features-input", false)) {
        removeColumnIds(nextVisible, OCR_COLUMN_IDS);
    }

    if (!settings.readQr && !checkboxChecked("mode-all-features-input", false)) {
        removeColumnIds(nextVisible, QR_COLUMN_IDS);
    }

    if (settings.readLabels && checkboxChecked("mode-visual-comparison-input", false)) {
        addColumnIds(nextVisible, OCR_COLUMN_IDS);
    }

    visibleColumnIds = nextVisible;
    updateColumnPickerChecks();
    updateDependentSettingsAvailability();
    refreshWizardForSettings();
    if (sync) syncVisibleOutputs();
}

function orderedColumns(columns) {
    const ids = new Set(columns.map(column => column.id));
    return columnOrderIds
        .filter(id => ids.has(id))
        .map(id => COLUMN_BY_ID.get(id))
        .filter(Boolean);
}

function reorderColumnIds(draggedId, targetId, insertAfter = false) {
    if (!draggedId || !targetId || draggedId === targetId) return false;
    if (!COLUMN_BY_ID.has(draggedId) || !COLUMN_BY_ID.has(targetId)) return false;

    const nextOrder = columnOrderIds.filter(id => id !== draggedId);
    let targetIndex = nextOrder.indexOf(targetId);
    if (targetIndex < 0) return false;
    if (insertAfter) targetIndex += 1;
    nextOrder.splice(targetIndex, 0, draggedId);
    columnOrderIds = nextOrder;
    return true;
}

function draggableColumnElement(event) {
    return event.target.closest(".column-option, .draggable-column-header");
}

function shouldInsertColumnAfter(event, element) {
    const rect = element.getBoundingClientRect();
    if (element.classList.contains("draggable-column-header")) {
        return event.clientX > rect.left + rect.width / 2;
    }
    return event.clientY > rect.top + rect.height / 2;
}

function clearColumnDragState() {
    document.querySelectorAll(".column-dragging, .column-drop-target").forEach(element => {
        element.classList.remove("column-dragging", "column-drop-target");
    });
}

function handleColumnDragStart(event) {
    if (event.target.closest("input, button")) return;
    const element = draggableColumnElement(event);
    if (!element?.dataset.columnId) return;

    draggedColumnId = element.dataset.columnId;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggedColumnId);
    element.classList.add("column-dragging");
}

function handleColumnDragOver(event) {
    const element = draggableColumnElement(event);
    if (!element?.dataset.columnId || !draggedColumnId || element.dataset.columnId === draggedColumnId) return;

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    document.querySelectorAll(".column-drop-target").forEach(target => target.classList.remove("column-drop-target"));
    element.classList.add("column-drop-target");
}

function handleColumnDrop(event) {
    const element = draggableColumnElement(event);
    const sourceId = event.dataTransfer.getData("text/plain") || draggedColumnId;
    if (!element?.dataset.columnId || !sourceId) return;

    event.preventDefault();
    const didReorder = reorderColumnIds(sourceId, element.dataset.columnId, shouldInsertColumnAfter(event, element));
    draggedColumnId = null;
    clearColumnDragState();
    if (didReorder) {
        renderColumnPicker();
        renderColumnHelp();
        syncVisibleOutputs();
    }
}

function handleColumnDragEnd() {
    draggedColumnId = null;
    clearColumnDragState();
}

function setupColumnDragAndDrop() {
    const containers = [
        document.getElementById("main-column-menu"),
        document.getElementById("column-menu"),
        document.getElementById("single-column-menu"),
        document.querySelector("#bulk-table thead")
    ].filter(Boolean);

    containers.forEach(container => {
        container.addEventListener("dragstart", handleColumnDragStart);
        container.addEventListener("dragover", handleColumnDragOver);
        container.addEventListener("drop", handleColumnDrop);
        container.addEventListener("dragend", handleColumnDragEnd);
    });
}

function visibleColumns() {
    return orderedColumns(ALL_COLUMNS).filter(column => visibleColumnIds.has(column.id));
}

function visiblePreviewColumns() {
    return visibleColumns().filter(column => column.id.startsWith("image_"));
}

function selectedPreviewIds() {
    return visiblePreviewColumns().map(column => column.id);
}

function selectedColumnIdsForRequest() {
    const ids = new Set([...visibleColumnIds, ...ALWAYS_DEFAULT_COLUMN_IDS]);
    return ALL_COLUMN_IDS.filter(id => ids.has(id));
}

function stageForColumnId(id) {
    if (OCR_STAGE_COLUMN_IDS.has(id)) return "ocr";
    if (QR_STAGE_COLUMN_IDS.has(id)) return "qr";
    if (COLOR_STAGE_COLUMN_IDS.has(id) || id === "image_pre_calibration_base64") return "color";
    if (SMOOTH_STAGE_COLUMN_IDS.has(id) || id === "image_sm_base64") return "smoothing";
    if (TRADITIONAL_STAGE_COLUMN_IDS.has(id) || id === "image_traditional_base64") return "traditional";
    if (RAW_STAGE_COLUMN_IDS.has(id) || id === "image_raw_base64" || id === "image_cleanup_hybrid_base64") return "cleanup";
    return null;
}

function itemCompletedStages(item) {
    return new Set(Array.isArray(item?.data?.completed_stages) ? item.data.completed_stages : []);
}

function itemHasPendingColumn(item, columnId) {
    const stage = stageForColumnId(columnId);
    return Boolean(
        item?.pendingColumnIds instanceof Set && item.pendingColumnIds.has(columnId)
        || (stage && item?.pendingStages instanceof Set && item.pendingStages.has(stage))
    );
}

function columnHasUsableValue(item, columnId) {
    if (isPreviewColumnId(columnId)) {
        return Boolean(item?.data?.[columnId] || item?.data?.preview_refs?.[columnId]?.available);
    }
    if (columnId === "processing_ms") {
        return item?.data?.processing_ms !== null && item?.data?.processing_ms !== undefined;
    }
    const column = COLUMN_BY_ID.get(columnId);
    if (!column) return true;
    const value = columnValue(column, item);
    if (columnId === "qr_data") {
        return itemCompletedStages(item).has("qr") || !(value === null || value === undefined || value === "");
    }
    return !(value === null || value === undefined || value === "");
}

function previewFetchUrl(data, previewType, size = "thumb") {
    if (!data?.session_id || !data?.row_id) return "";
    if (!data.preview_refs?.[previewType]?.available) return "";
    const params = new URLSearchParams({
        username: currentUsername,
        password: currentPassword,
        size,
        _t: String(data.updated_at || "")
    });
    return `${previewUrlBase()}/${encodeURIComponent(data.session_id)}/${encodeURIComponent(data.row_id)}/${encodeURIComponent(previewType)}?${params.toString()}`;
}

function columnValue(column, item) {
    try {
        return column.get ? column.get(item.data || {}, item) : null;
    } catch (err) {
        return null;
    }
}

function columnDigits(column, item) {
    return typeof column.digits === "function" ? column.digits(item) : (column.digits ?? 1);
}

function columnHelpText(column) {
    return COLUMN_HELP_TEXT[column.id] || "This column is part of the selected fruit analysis output.";
}

function columnHelpIcon(column) {
    return `<span class="column-help-icon" title="${escapeHtml(columnHelpText(column))}" aria-label="${escapeHtml(columnHelpText(column))}">?</span>`;
}

function renderColumnPicker() {
    applyMetricColumnUnitLabels();
    const menus = [
        document.getElementById("main-column-menu"),
        document.getElementById("column-menu"),
        document.getElementById("single-column-menu")
    ].filter(Boolean);
    if (!menus.length) return;

    const renderGroup = (group, depth = 0) => `
        <details class="column-group column-depth-${depth} ${group.id === "previews_adjustable" ? "adjustable-preview-group" : ""}" data-group-id="${group.id}" open>
            <summary>
                <label>
                    <input type="checkbox" class="column-group-checkbox" data-group-id="${group.id}">
                    ${escapeHtml(group.label)}
                </label>
            </summary>
            <div class="column-children">
                ${(group.children || []).map(child => renderGroup(child, depth + 1)).join("")}
                ${group.columns && group.columns.length ? `<div class="column-options">
                    ${orderedColumns(group.columns).map(column => `
                    <label class="column-option ${column.adjustable ? "adjustable-preview-option" : ""}" draggable="true" data-column-id="${column.id}">
                        <span class="column-drag-handle" aria-hidden="true">::</span>
                        <input type="checkbox" class="column-checkbox" data-column-id="${column.id}">
                        <span>${escapeHtml(column.label)}</span>
                        ${columnHelpIcon(column)}
                    </label>
                    `).join("")}
                </div>` : ""}
            </div>
        </details>
    `;

    const html = COLUMN_GROUPS.map(group => renderGroup(group)).join("");
    menus.forEach(menu => {
        menu.innerHTML = html;
    });

    updateColumnPickerChecks();
}

function renderColumnHelp() {
    applyMetricColumnUnitLabels();
    const root = document.getElementById("column-help");
    if (!root) return;

    const renderEntries = (columns = []) => orderedColumns(columns).map(column => `
        <details class="help-entry">
            <summary>${escapeHtml(column.label)}</summary>
            <p>${escapeHtml(COLUMN_HELP_TEXT[column.id] || "This column is part of the selected fruit analysis output.")}</p>
        </details>
    `).join("");

    const renderGroup = (group, depth = 0) => {
        const groupText = GROUP_HELP_TEXT[group.id] || "";
        const groupHtml = GROUP_HELP_HTML[group.id] || (groupText ? escapeHtml(groupText) : "");
        return `
            <details class="help-group help-depth-${depth} ${group.id === "previews_adjustable" ? "adjustable-preview-group" : ""}" open>
                <summary>${escapeHtml(group.label)}</summary>
                ${groupHtml ? `<p class="help-group-text">${groupHtml}</p>` : ""}
                <div class="help-children">
                    ${(group.children || []).map(child => renderGroup(child, depth + 1)).join("")}
                    ${group.columns && group.columns.length ? renderEntries(group.columns) : ""}
                </div>
            </details>
        `;
    };

    root.innerHTML = COLUMN_GROUPS.map(group => renderGroup(group)).join("");
}

function updateColumnPickerChecks() {
    document.querySelectorAll(".column-checkbox").forEach(input => {
        input.checked = visibleColumnIds.has(input.dataset.columnId);
    });

    document.querySelectorAll(".column-group-checkbox").forEach(input => {
        const group = COLUMN_GROUP_MAP.get(input.dataset.groupId);
        const columns = group ? columnsForGroup(group) : [];
        const selectedCount = columns.filter(column => visibleColumnIds.has(column.id)).length;
        input.checked = columns.length > 0 && selectedCount === columns.length;
        input.indeterminate = selectedCount > 0 && selectedCount < columns.length;
    });
    syncAnalysisModeCheckboxesFromColumns();
}

function captureBatchScrollAnchor() {
    const table = document.getElementById("bulk-table");
    if (!table || table.style.display === "none") return { active: false };

    const tableWrap = table.closest(".table-wrap");
    const doc = document.documentElement;
    const scrollHeight = Math.max(doc.scrollHeight, document.body.scrollHeight);
    const viewportBottom = window.scrollY + window.innerHeight;
    const tableRect = table.getBoundingClientRect();
    const tableTop = window.scrollY + tableRect.top;
    const tableBottom = window.scrollY + tableRect.bottom;
    const bottomOffset = scrollHeight - viewportBottom;
    const nearPageBottom = bottomOffset < 12;
    const aboveTable = viewportBottom <= tableTop + 12;
    const belowTable = window.scrollY >= tableBottom - 12;
    const horizontal = tableWrap ? {
        scrollLeft: tableWrap.scrollLeft,
        rightOffset: Math.max(0, tableWrap.scrollWidth - tableWrap.clientWidth - tableWrap.scrollLeft),
        atRight: tableWrap.scrollWidth - tableWrap.clientWidth - tableWrap.scrollLeft < 4
    } : null;

    if (nearPageBottom) {
        return {
            active: true,
            mode: "page-bottom",
            bottomOffset: Math.max(0, bottomOffset),
            horizontal
        };
    }

    if (aboveTable) {
        return {
            active: true,
            mode: "fixed",
            scrollY: window.scrollY,
            horizontal
        };
    }

    if (belowTable) {
        const charts = document.getElementById("histograms-container");
        if (charts) {
            return {
                active: true,
                mode: "below-table-content",
                selector: "#histograms-container",
                viewportTop: charts.getBoundingClientRect().top,
                scrollY: window.scrollY,
                horizontal
            };
        }
        return {
            active: true,
            mode: "below-table",
            scrollY: window.scrollY,
            tableHeight: tableRect.height,
            horizontal
        };
    }

    const rows = Array.from(table.querySelectorAll("tbody tr[data-row-index]"));
    const viewportCenter = window.innerHeight / 2;
    const visibleRows = rows
        .map(row => ({ row, rect: row.getBoundingClientRect() }))
        .filter(({ rect }) => rect.bottom >= 0 && rect.top <= window.innerHeight);

    if (visibleRows.length > 0) {
        visibleRows.sort((a, b) => (
            Math.abs((a.rect.top + a.rect.height / 2) - viewportCenter)
            - Math.abs((b.rect.top + b.rect.height / 2) - viewportCenter)
        ));
        const anchorRow = visibleRows[0];
        return {
            active: true,
            mode: "row",
            rowIndex: anchorRow.row.dataset.rowIndex,
            rowViewportTop: anchorRow.rect.top,
            fallbackTableOffset: window.scrollY - tableTop,
            horizontal
        };
    }

    return {
        active: true,
        mode: "table-offset",
        tableOffset: window.scrollY - tableTop,
        scrollY: window.scrollY,
        horizontal
    };
}

function restoreBatchScrollAnchor(anchor) {
    if (!anchor?.active) return;
    const apply = () => {
        const table = document.getElementById("bulk-table");
        const tableWrap = table?.closest(".table-wrap");
        if (tableWrap && anchor.horizontal) {
            if (anchor.horizontal.atRight) {
                const maxScrollLeft = Math.max(0, tableWrap.scrollWidth - tableWrap.clientWidth);
                tableWrap.scrollLeft = Math.max(0, maxScrollLeft - anchor.horizontal.rightOffset);
            } else {
                tableWrap.scrollLeft = anchor.horizontal.scrollLeft || 0;
            }
        }

        if (anchor.mode === "page-bottom") {
            const doc = document.documentElement;
            const nextScrollHeight = Math.max(doc.scrollHeight, document.body.scrollHeight);
            window.scrollTo({ top: Math.max(0, nextScrollHeight - window.innerHeight - (anchor.bottomOffset || 0)), behavior: "auto" });
            return;
        }
        if (anchor.mode === "fixed") {
            window.scrollTo({ top: anchor.scrollY, behavior: "auto" });
            return;
        }
        if (anchor.mode === "below-table") {
            if (!table) return;
            const nextHeight = table.getBoundingClientRect().height;
            window.scrollTo({ top: Math.max(0, anchor.scrollY + nextHeight - (anchor.tableHeight || 0)), behavior: "auto" });
            return;
        }
        if (anchor.mode === "below-table-content") {
            const target = document.querySelector(anchor.selector);
            if (target) {
                const nextTop = target.getBoundingClientRect().top;
                window.scrollTo({ top: Math.max(0, window.scrollY + nextTop - anchor.viewportTop), behavior: "auto" });
            } else {
                window.scrollTo({ top: anchor.scrollY, behavior: "auto" });
            }
            return;
        }
        if (anchor.mode === "row") {
            const row = table?.querySelector(`tbody tr[data-row-index="${anchor.rowIndex}"]`);
            if (row) {
                const nextTop = row.getBoundingClientRect().top;
                window.scrollTo({ top: Math.max(0, window.scrollY + nextTop - anchor.rowViewportTop), behavior: "auto" });
                return;
            }
            if (table) {
                const tableTop = window.scrollY + table.getBoundingClientRect().top;
                window.scrollTo({ top: Math.max(0, tableTop + (anchor.fallbackTableOffset || 0)), behavior: "auto" });
            }
            return;
        }
        if (anchor.mode === "table-offset" && table) {
            const tableTop = window.scrollY + table.getBoundingClientRect().top;
            window.scrollTo({ top: Math.max(0, tableTop + (anchor.tableOffset || 0)), behavior: "auto" });
        }
    };
    requestAnimationFrame(() => {
        apply();
        requestAnimationFrame(apply);
        setTimeout(apply, 120);
    });
}

function requestHistogramRebuild(container, options = {}) {
    const target = container || document.getElementById("histograms-container");
    const delay = options.debounce ? 350 : 0;
    const scrollAnchor = options.scrollAnchor || null;
    const rebuild = () => {
        rebuildHistograms(target);
        if (scrollAnchor) restoreBatchScrollAnchor(scrollAnchor);
    };
    if (histogramDebounceTimer) {
        clearTimeout(histogramDebounceTimer);
        histogramDebounceTimer = null;
    }
    if (delay <= 0) {
        rebuild();
        return;
    }
    histogramDebounceTimer = setTimeout(() => {
        histogramDebounceTimer = null;
        rebuild();
    }, delay);
}

function refreshBatchOutputs(chartsContainer, options = {}) {
    const anchor = captureBatchScrollAnchor();
    renderBulkTable();
    document.querySelectorAll("#bulk-table img.preview-img").forEach(img => {
        if (!img.complete) {
            img.addEventListener("load", () => restoreBatchScrollAnchor(anchor), { once: true });
            img.addEventListener("error", () => restoreBatchScrollAnchor(anchor), { once: true });
        }
    });
    requestHistogramRebuild(chartsContainer || document.getElementById("histograms-container"), {
        debounce: Boolean(options.debounceHistograms),
        scrollAnchor: anchor
    });
    restoreBatchScrollAnchor(anchor);
    updateBatchJumpControls();
}

function syncVisibleOutputs() {
    applyMetricColumnUnitLabels();
    refreshBatchOutputs(document.getElementById("histograms-container"));
    renderCurrentSingleAnalysis();
    scheduleMissingStageRequest();
}

function setupColumnControls() {
    applyAnalysisColumnPreset({ sync: false });
    renderColumnPicker();
    renderColumnHelp();

    [
        ["main-column-menu-button", "main-column-menu-panel"],
        ["column-menu-button", "column-menu-panel"],
        ["single-column-menu-button", "single-column-menu-panel"]
    ].forEach(([buttonId, panelId]) => {
        const button = document.getElementById(buttonId);
        const panel = document.getElementById(panelId);
        if (!button || !panel) return;
        button.addEventListener("click", () => {
            panel.classList.toggle("open");
            button.setAttribute("aria-expanded", panel.classList.contains("open") ? "true" : "false");
        });
        document.addEventListener("click", (event) => {
            if (!panel.contains(event.target) && event.target !== button) {
                panel.classList.remove("open");
                button.setAttribute("aria-expanded", "false");
            }
        });
    });

    const handleMenuClick = (event) => {
        if (event.target.closest(".column-help-icon")) {
            event.preventDefault();
            event.stopPropagation();
        }
    };

    const handleMenuChange = (event) => {
        const target = event.target;
        if (target.classList.contains("column-group-checkbox")) {
            const group = COLUMN_GROUP_MAP.get(target.dataset.groupId);
            columnsForGroup(group).forEach(column => {
                if (target.checked) visibleColumnIds.add(column.id);
                else visibleColumnIds.delete(column.id);
            });
        } else if (target.classList.contains("column-checkbox")) {
            if (target.checked) visibleColumnIds.add(target.dataset.columnId);
            else visibleColumnIds.delete(target.dataset.columnId);
        }

        const allFeatures = document.getElementById("mode-all-features-input");
        if (allFeatures) allFeatures.checked = false;
        updateColumnPickerChecks();
        updateDependentSettingsAvailability();
        refreshWizardForSettings();
        syncVisibleOutputs();
    };

    ["main-column-menu", "column-menu", "single-column-menu"].forEach(menuId => {
        const menu = document.getElementById(menuId);
        menu?.addEventListener("click", handleMenuClick);
        menu?.addEventListener("change", handleMenuChange);
    });

    setupColumnDragAndDrop();
}

function renderSingleMetricCard(title, columns, item) {
    applyMetricColumnUnitLabels();
    const metricColumns = columns.filter(column => !column.html && visibleColumnIds.has(column.id));
    if (metricColumns.length === 0) return "";

    return `
        <div class="result-card">
            <h3>${escapeHtml(title)}</h3>
            ${metricColumns.map(column => `
                <div class="metric-row">
                    <span>${columnHelpIcon(column)} ${escapeHtml(column.label)}</span>
                    <strong>${renderCell(column, item)}</strong>
                </div>
            `).join("")}
        </div>
    `;
}

function renderSingleMetricGroups(group, item, ancestry = []) {
    const title = [...ancestry, group.label].join(" / ");
    const ownCard = group.columns ? renderSingleMetricCard(title, orderedColumns(group.columns), item) : "";
    const childCards = (group.children || []).map(child => renderSingleMetricGroups(child, item, [...ancestry, group.label])).join("");
    return ownCard + childCards;
}

function renderSinglePreviewCards(data, previewIds) {
    const previewGroup = COLUMN_GROUP_MAP.get("previews");
    const previews = previewGroup
        ? columnsForGroup(previewGroup).filter(column => previewIds.includes(column.id))
        : [];
    if (previews.length === 0) return "";

    return previews.map(column => {
        const imageData = data[column.id];
        const thumbUrl = previewFetchUrl(data, column.id, "thumb");
        const fullUrl = previewFetchUrl(data, column.id, "full");
        const contextAttrs = previewContextAttributes(data, column.id, column.adjustable);
        return `
            <div class="result-card single-preview-card ${column.adjustable ? "adjustable-preview-card" : ""}">
                <h3>${escapeHtml(column.label)}</h3>
                ${imageData
                    ? `<img src="data:image/jpeg;base64,${imageData}" data-full-src="${escapeHtml(fullUrl || `data:image/jpeg;base64,${imageData}`)}" ${contextAttrs} class="preview-img single-preview-img">`
                    : thumbUrl
                        ? `<img src="${escapeHtml(thumbUrl)}" data-full-src="${escapeHtml(fullUrl || thumbUrl)}" ${contextAttrs} class="preview-img single-preview-img">`
                        : `<span class="muted">Preview unavailable</span>`}
            </div>
        `;
    }).join("");
}

function renderSingleAnalysis(data, previewIds = []) {
    const isCm = measurementUnit(data) === "cm";
    const item = {
        file_name: data.filename || "",
        data,
        included: true,
        isCm,
        allowPixelMetrics: true,
        digits: isCm ? 2 : 0,
        notes: rowNotes(data),
        success: true
    };

    const metricCards = COLUMN_GROUPS
        .filter(group => group.id !== "previews")
        .map(group => renderSingleMetricGroups(group, item))
        .join("");
    const log = processingLogText(item);
    const logCard = log
        ? `<div class="result-card"><h3>Processing Log</h3><p class="processing-log-cell">${escapeHtml(log)}</p></div>`
        : "";

    return `
        ${logCard}
        ${metricCards}
        ${renderSinglePreviewCards(data, previewIds)}
    `;
}

function renderCurrentSingleAnalysis() {
    if (!latestSingleData) return;
    const resultDiv = document.getElementById("single-result");
    if (!resultDiv) return;
    const previewIds = selectedPreviewIds().filter(id => latestSinglePreviewIds.includes(id));
    if (latestSingleData.success) {
        resultDiv.innerHTML = renderSingleAnalysis(latestSingleData, previewIds);
        return;
    }

    const log = processingLogText(latestSingleData);
    const notesHtml = log
        ? `<div class="result-card"><h3>Processing Log</h3><p class="processing-log-cell">${escapeHtml(log)}</p></div>`
        : "";
    resultDiv.innerHTML = `${notesHtml}${renderSinglePreviewCards(latestSingleData, previewIds)}`;
}

function setSingleProcessingState(isRunning) {
    const processBtn = document.getElementById("process-single-btn");
    const stopBtn = document.getElementById("stop-single-btn");
    const fileInput = document.getElementById("single-file");
    if (processBtn) processBtn.disabled = Boolean(isRunning);
    if (fileInput) fileInput.disabled = Boolean(isRunning);
    if (stopBtn) {
        stopBtn.style.display = isRunning ? "inline-flex" : "none";
        if (!isRunning) resetStopConfirmation(stopBtn);
    }
    if (isRunning) setProgressBar("single-progress", 0, { visible: true });
}

function updateSingleProgress(run) {
    if (!run?.running || run.stopRequested) return;
    const elapsed = Date.now() - run.progressStartedAt;
    const fraction = Math.min(0.5, (elapsed / SINGLE_REQUEST_TIMEOUT_MS) * 0.5);
    setProgressBar("single-progress", fraction, { visible: true });
}

function startSingleProgress(run) {
    run.progressStartedAt = Date.now();
    updateSingleProgress(run);
    run.progressTimer = setInterval(() => updateSingleProgress(run), 250);
}

function finishSingleProgress(run, { stopped = false } = {}) {
    if (run?.progressTimer) {
        clearInterval(run.progressTimer);
        run.progressTimer = null;
    }
    if (stopped) {
        setProgressBar("single-progress", 0, { visible: false });
    } else {
        setProgressBar("single-progress", 1, { visible: true });
    }
}

async function stopActiveSingleRun() {
    if (!activeSingleRun?.running) return;
    const jobId = activeSingleRun.persistentJobId;
    activeSingleRun.stopRequested = true;
    activeSingleRun.abortController?.abort();
    if (jobId) {
        await controlProcessJobById(jobId, "stop");
    }
}

document.getElementById("single-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const file = document.getElementById("single-file").files[0];
    const status = document.getElementById("single-status");
    const resultDiv = document.getElementById("single-result");
    if (!file || activeSingleRun?.running) return;

    if (!requireWalkthroughComplete(status)) {
        resultDiv.innerHTML = "";
        return;
    }

    const requestSettings = getAnalysisSettingsSnapshot();
    const run = {
        abortController: new AbortController(),
        running: true,
        stopRequested: false,
        sessionId: makeClientId("single")
    };
    activeSingleRun = run;
    status.innerText = "Processing...";
    resultDiv.innerHTML = "";
    latestSingleData = null;
    latestSinglePreviewIds = [];
    setSingleProcessingState(true);
    startSingleProgress(run);

    try {
        await warmProductionBackend({
            settings: requestSettings,
            statusEl: status,
            statusText: "Warming up production server..."
        });
        if (run.stopRequested || activeSingleRun !== run) return;
        status.innerText = "Processing...";

        const requestedPreviewIds = selectedPreviewIds();
        status.innerText = "Uploading image...";
        const job = await createPersistentSingleJob(
            file,
            requestSettings,
            requestedPreviewIds,
            run.abortController.signal
        );
        run.persistentJobId = job?.job_id || "";
        if (job?.session_id) run.sessionId = job.session_id;
        if (run.stopRequested || activeSingleRun !== run) return;

        const data = await waitForSinglePersistentJob(run.persistentJobId, run, status);
        if (run.stopRequested || activeSingleRun !== run) return;
        
        if (data.success) {
            status.innerText = "Success";
            latestSingleData = data;
            latestSinglePreviewIds = requestedPreviewIds;

            // Send event to Google Analytics
            if (typeof gtag === 'function') {
                gtag('event', 'processed_single_image', {
                    'event_category': 'Phenotyping',
                    'success': true,
                    'username': currentUsername
                });
            }

            resultDiv.innerHTML = renderSingleAnalysis(data, requestedPreviewIds);
        } else {
            latestSingleData = data;
            latestSinglePreviewIds = requestedPreviewIds;
            status.innerText = `Error: ${data.message}`;
            const log = processingLogText(data);
            const notesHtml = log
                ? `<div class="result-card"><h3>Processing Log</h3><p class="processing-log-cell">${escapeHtml(log)}</p></div>`
                : "";
            resultDiv.innerHTML = `${notesHtml}${renderSinglePreviewCards(data, requestedPreviewIds)}`;
        }
    } catch (err) {
        if (run.stopRequested || err.message === "Batch stopped") {
            status.innerText = "Single image processing stopped.";
            return;
        }
        latestSingleData = null;
        latestSinglePreviewIds = [];
        status.innerText = `API request failed: ${err.message}`;
    } finally {
        if (activeSingleRun === run) {
            finishSingleProgress(run, { stopped: run.stopRequested });
            activeSingleRun = null;
            setSingleProcessingState(false);
        }
    }
});

document.getElementById("stop-single-btn")?.addEventListener("click", (event) => {
    if (!requireSecondStopClick(event.currentTarget)) return;
    resetStopConfirmation(event.currentTarget);
    stopActiveSingleRun().catch(err => {
        const status = document.getElementById("single-status");
        if (status) status.innerText = `Stop failed: ${err.message}`;
    });
});

let globalBatchResults = []; // Stores all row data for dynamic toggling
let activeBatch = null;
let activeSingleRun = null;
let batchRunCounter = 0;
let persistentJobPollId = null;
const BATCH_PAUSE_MS = 50;
const BATCH_WARMUP_COUNT = 2;
const VIRTUAL_TABLE_THRESHOLD = 80;
const VIRTUAL_TABLE_BUFFER_ROWS = 10;
const VIRTUAL_TABLE_ROW_HEIGHT = 46;
const VIRTUAL_TABLE_PREVIEW_ROW_HEIGHT = 186;
let virtualTableRenderQueued = false;
let histogramDebounceTimer = null;
let histogramCharts = [];

setupColumnControls();
setupAnalysisSettingsControls();
initSettingsWizard();
setupCompatibilityCheck();
setupBatchJumpControls();
updateDevQueueToolsVisibility();

function formatDuration(ms) {
    const elapsedSec = Math.floor(ms / 1000);
    const h = String(Math.floor(elapsedSec / 3600)).padStart(2, '0');
    const m = String(Math.floor((elapsedSec % 3600) / 60)).padStart(2, '0');
    const s = String(elapsedSec % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
}

function setProgressBar(progressId, fraction = 0, { visible = true, indeterminate = false } = {}) {
    const wrap = document.getElementById(progressId);
    if (!wrap) return;
    const bar = wrap.querySelector(".progress-bar");
    wrap.classList.toggle("visible", Boolean(visible));
    wrap.setAttribute("aria-hidden", visible ? "false" : "true");
    if (!bar) return;
    bar.classList.toggle("indeterminate", Boolean(indeterminate));
    if (indeterminate) {
        bar.style.width = "";
    } else {
        const pct = Math.max(0, Math.min(100, Number(fraction || 0) * 100));
        bar.style.width = `${pct}%`;
    }
}

function resetStopConfirmation(button) {
    if (!button) return;
    if (button.stopConfirmTimer) {
        clearTimeout(button.stopConfirmTimer);
        button.stopConfirmTimer = null;
    }
    button.dataset.confirmingStop = "false";
    button.classList.remove("confirming-stop");
    if (button.dataset.stopBaseText) button.innerText = button.dataset.stopBaseText;
}

function requireSecondStopClick(button, confirmText = "Click again to stop") {
    if (!button) return true;
    if (button.dataset.confirmingStop === "true") return true;
    button.dataset.stopBaseText = button.dataset.stopBaseText || button.innerText;
    button.dataset.confirmingStop = "true";
    button.classList.add("confirming-stop");
    button.innerText = confirmText;
    if (button.stopConfirmTimer) clearTimeout(button.stopConfirmTimer);
    button.stopConfirmTimer = setTimeout(() => resetStopConfirmation(button), STOP_CONFIRM_MS);
    return false;
}

function makeBatchState(files, settings, requestLineOcr) {
    return {
        id: ++batchRunCounter,
        files: Array.from(files),
        settings,
        requestLineOcr,
        sessionId: currentSessionId,
        rowIds: [],
        nextIndex: 0,
        completed: 0,
        successCount: 0,
        failureCount: 0,
        pixelScaleCount: 0,
        elapsedMs: 0,
        serverElapsedMs: 0,
        runStartedAt: null,
        timerInterval: null,
        onDemandRunning: false,
        onDemandStartedAt: null,
        onDemandTotal: 0,
        onDemandCompleted: 0,
        onDemandAbortController: null,
        onDemandStopRequested: false,
        abortController: null,
        running: false,
        finished: false,
        warmupComplete: false,
        stopRequested: false,
        stopReason: null,
        uploading: false,
        uploadProgress: null
    };
}

function persistentRowItem(row) {
    const data = row.result || {
        filename: row.filename,
        row_id: row.row_id,
        warnings: row.message ? [row.message] : []
    };
    if (row.result) {
        const item = batchResultItem({ name: row.filename }, data);
        item.success = data.success !== false;
        item.included = true;
        if (!item.success) {
            item.message = `Error: ${data.message || row.message || "Processing failed"}`;
            item.notes = [item.message, rowNotes(data)].filter(Boolean).join(" | ");
            item.allowPixelMetrics = false;
        }
        return item;
    }
    return {
        file_name: row.filename,
        data,
        included: true,
        isCm: false,
        allowPixelMetrics: false,
        digits: 0,
        notes: row.message || "Queued.",
        success: false,
        retrying: true,
        message: row.status === "processing" ? "Processing..." : "Queued..."
    };
}

function applyPersistentJob(job, { restored = false } = {}) {
    if (!job) return;
    const rows = job.rows || [];
    const priorByRow = new Map(globalBatchResults.map(item => [item.data?.row_id, item]));
    const batch = activeBatch?.persistentJobId === job.job_id
        ? activeBatch
        : makeBatchState(rows.map(row => ({ name: row.filename })), job.settings || {}, false);
    batch.id = job.job_id;
    batch.persistentJobId = job.job_id;
    batch.sessionId = job.session_id || job.job_id;
    batch.files = rows.map(row => ({ name: row.filename }));
    batch.rowIds = rows.map(row => row.row_id);
    batch.completed = Number(job.completed || 0);
    batch.nextIndex = batch.completed;
    batch.successCount = Number(job.success_count || 0);
    batch.failureCount = Number(job.failure_count || 0);
    const serverElapsedMs = Number(job.elapsed_ms || 0);
    const wasRunning = Boolean(batch.running);
    const serverElapsedChanged = batch.serverElapsedMs !== serverElapsedMs;
    batch.serverElapsedMs = serverElapsedMs;
    batch.elapsedMs = serverElapsedMs;
    batch.running = ["uploading", "queued", "running", "stopping"].includes(job.status);
    batch.finished = job.status === "completed";
    batch.stopRequested = job.status === "stopping";
    if (batch.running) {
        if (!wasRunning || !batch.runStartedAt || serverElapsedChanged) {
            batch.runStartedAt = Date.now();
        }
        startBatchLiveTimer(batch);
    } else {
        batch.runStartedAt = null;
        stopBatchLiveTimer(batch);
    }
    activeBatch = batch;
    currentSessionId = batch.sessionId;
    if (job.settings?.fruit) {
        const fruitSelect = document.getElementById("fruit-select");
        if (fruitSelect && [...fruitSelect.options].some(option => option.value === job.settings.fruit)) {
            fruitSelect.value = job.settings.fruit;
            rebuildModelVersionOptions(job.settings.fruit);
            const versionSelect = document.getElementById("model-version-select");
            if (versionSelect && job.settings.expertId && [...versionSelect.options].some(option => option.value === job.settings.expertId)) {
                versionSelect.value = job.settings.expertId;
            }
            wizardCompleted = true;
            updateAnalysisTabAvailability();
        }
    }
    globalBatchResults = rows.map(row => {
        const item = persistentRowItem(row);
        const prior = priorByRow.get(row.row_id);
        if (prior?.includeTouched) {
            item.included = prior.included;
            item.includeTouched = true;
        }
        return item;
    });

    const table = document.getElementById("bulk-table");
    const timer = document.getElementById("batch-timer");
    const status = document.getElementById("bulk-status");
    const charts = document.getElementById("histograms-container");
    if (table) table.style.display = "table";
    document.getElementById("bulk-section")?.classList.add("bulk-card");
    if (timer) {
        if (batch.running) {
            updateBatchTimer(batch);
        } else {
            timer.style.display = "block";
            timer.innerText = `Total Time: ${formatDuration(batch.elapsedMs)}`;
        }
    }
    if (status) {
        const prefix = restored ? "Restored persistent job. " : "";
        const warming = batch.running && batch.completed === 0 && ["queued", "running"].includes(job.status);
        status.innerText = warming
            ? `${prefix}Warming up server and processing the first image...`
            : `${prefix}${job.message || `Job ${job.status}.`}`;
    }
    updateBatchControls(batch);
    updateBatchProgress(batch);
    refreshBatchOutputs(charts, { debounceHistograms: batch.running });
    updateBatchJumpControls();
    if (restored) activateTab("bulk-panel");
}

async function fetchPersistentJob(jobId, signal = null) {
    const params = new URLSearchParams({
        username: currentUsername,
        password: currentPassword,
        _t: Date.now().toString()
    });
    const response = await fetch(`${processJobsUrl(`/${encodeURIComponent(jobId)}`)}?${params}`, { cache: "no-store", signal });
    const data = await response.json();
    if (!response.ok || data.success === false) throw new Error(data.message || `HTTP ${response.status}`);
    return data.job;
}

function startPersistentJobPolling(jobId) {
    if (persistentJobPollId) clearInterval(persistentJobPollId);
    const poll = async () => {
        try {
            const job = await fetchPersistentJob(jobId);
            applyPersistentJob(job);
            if (["completed", "stopped", "failed"].includes(job.status)) {
                clearInterval(persistentJobPollId);
                persistentJobPollId = null;
                refreshSavedJobSelector(job.job_id).catch(() => {});
            }
        } catch (err) {
            console.warn("Could not refresh persistent processing job.", err);
        }
    };
    poll();
    persistentJobPollId = setInterval(poll, 2500);
}

async function createPersistentBatchJob(files, settings) {
    const fileList = Array.from(files);
    const initResponse = await fetch(processJobsUrl("/init"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            password: currentPassword,
            username: currentUsername,
            filenames: fileList.map(file => file.name),
            settings,
            requested_columns: selectedColumnIdsForRequest(),
            preview_types: selectedPreviewIds()
        })
    });
    const initData = await initResponse.json();
    if (!initResponse.ok || initData.success === false) throw new Error(initData.message || `HTTP ${initResponse.status}`);
    const job = initData.job;
    const rows = job.rows || [];
    const chunkSize = 8;
    for (let start = 0; start < fileList.length; start += chunkSize) {
        const chunkFiles = fileList.slice(start, start + chunkSize);
        const chunkRows = rows.slice(start, start + chunkSize);
        const form = new FormData();
        form.append("password", currentPassword);
        form.append("username", currentUsername);
        form.append("row_ids", JSON.stringify(chunkRows.map(row => row.row_id)));
        chunkFiles.forEach(file => form.append("files", file));
        const uploadResponse = await fetch(processJobsUrl(`/${encodeURIComponent(job.job_id)}/files`), {
            method: "POST",
            body: form
        });
        const uploadData = await uploadResponse.json();
        if (!uploadResponse.ok || uploadData.success === false) {
            throw new Error(uploadData.message || `Upload failed (${uploadResponse.status})`);
        }
        const status = document.getElementById("bulk-status");
        if (status) status.innerText = `Uploading batch to persistent storage: ${Math.min(start + chunkFiles.length, fileList.length)}/${fileList.length}`;
        const uploadFraction = Math.min(start + chunkFiles.length, fileList.length) / fileList.length;
        if (activeBatch && !activeBatch.persistentJobId) {
            activeBatch.uploading = true;
            activeBatch.uploadProgress = uploadFraction;
            updateBatchProgress(activeBatch);
        } else {
            setProgressBar("bulk-progress", uploadFraction, { visible: true });
        }
    }
    const startResponse = await fetch(processJobsUrl(`/${encodeURIComponent(job.job_id)}/start`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: currentPassword, username: currentUsername })
    });
    const startData = await startResponse.json();
    if (!startResponse.ok || startData.success === false) throw new Error(startData.message || `HTTP ${startResponse.status}`);
    if (activeBatch && !activeBatch.persistentJobId) {
        activeBatch.uploading = false;
        activeBatch.uploadProgress = null;
    }
    applyPersistentJob(startData.job);
    await refreshSavedJobSelector(job.job_id);
    startPersistentJobPolling(job.job_id);
}

async function createPersistentSingleJob(file, settings, previewIds, signal = null) {
    const singleSettings = { ...(settings || {}), job_kind: "single" };
    const form = new FormData();
    form.append("password", currentPassword);
    form.append("username", currentUsername);
    form.append("settings_json", JSON.stringify(singleSettings));
    form.append("requested_columns", JSON.stringify(selectedColumnIdsForRequest()));
    form.append("preview_types", JSON.stringify(previewIds || []));
    form.append("files", file);

    const response = await fetch(processJobsUrl(), {
        method: "POST",
        body: form,
        signal
    });
    const data = await response.json();
    if (!response.ok || data.success === false) {
        throw new Error(data.message || `HTTP ${response.status}`);
    }
    return data.job;
}

function singleStatusFromJob(job, row) {
    if (!job) return "Processing...";
    if (job.status === "uploading") return "Uploading image...";
    if (job.status === "queued") return "Queued for processing...";
    if (row?.status === "processing" || job.status === "running") return "Processing...";
    if (job.status === "stopping") return "Stopping...";
    return job.message || `Job ${job.status}`;
}

async function waitForSinglePersistentJob(jobId, run, statusEl) {
    while (true) {
        if (run.stopRequested) throw new Error("Batch stopped");
        const job = await fetchPersistentJob(jobId, run.abortController?.signal || null);
        const row = (job.rows || [])[0] || {};
        if (statusEl) statusEl.innerText = singleStatusFromJob(job, row);

        if (["completed", "stopped", "failed"].includes(job.status)) {
            if (job.status === "stopped" || run.stopRequested) throw new Error("Batch stopped");
            if (job.status === "failed") throw new Error(job.message || "Single image processing failed.");
            const result = row.result || null;
            if (result) return result;
            if (row.success === false) {
                return {
                    success: false,
                    filename: row.filename || "",
                    session_id: job.session_id || job.job_id,
                    row_id: row.row_id || "",
                    message: row.message || "Single image processing failed.",
                    warnings: row.message ? [row.message] : []
                };
            }
            throw new Error(row.message || "Single image processing finished without a result.");
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

async function refreshSavedJobSelector(selectedJobId = "") {
    const select = document.getElementById("saved-job-select");
    if (!currentUsername || !currentPassword) return [];
    if (select) {
        select.innerHTML = `<option value="">Loading saved processing jobs...</option>`;
        select.disabled = true;
    }
    const params = new URLSearchParams({
        username: currentUsername,
        password: currentPassword,
        _t: Date.now().toString()
    });
    try {
        const response = await fetch(`${processJobsUrl()}?${params}`, { cache: "no-store" });
        const data = await response.json();
        const jobs = data.success && Array.isArray(data.jobs)
            ? data.jobs.filter(job => (job.settings || {}).job_kind !== "single")
            : [];
        if (select) {
            select.innerHTML = jobs.length
                ? jobs.map(job => {
                    const created = job.created_at ? new Date(job.created_at).toLocaleString() : job.job_id;
                    const label = `${created} · ${job.status} · ${job.completed || 0}/${job.row_count || 0}`;
                    return `<option value="${escapeHtml(job.job_id)}">${escapeHtml(label)}</option>`;
                }).join("")
                : `<option value="">No saved jobs found</option>`;
            const target = selectedJobId || activeBatch?.persistentJobId || jobs[0]?.job_id || "";
            if (target) select.value = target;
        }
        return jobs;
    } catch (err) {
        if (select) {
            select.innerHTML = `<option value="">Could not load saved jobs</option>`;
        }
        throw err;
    } finally {
        if (select) select.disabled = false;
    }
}

async function restoreLatestPersistentJob() {
    if (!currentUsername || !currentPassword) return true;
    try {
        const jobs = await refreshSavedJobSelector();
        const latest = jobs[0];
        if (!latest) return true;
        const job = await fetchPersistentJob(latest.job_id);
        applyPersistentJob(job, { restored: true });
        if (["queued", "running", "stopping"].includes(job.status)) {
            startPersistentJobPolling(job.job_id);
        }
        return true;
    } catch (err) {
        console.warn("Could not restore persistent processing history.", err);
        return false;
    }
}

async function controlProcessJobById(jobId, action) {
    if (!jobId) return false;
    const response = await fetch(processJobsUrl(`/${encodeURIComponent(jobId)}/${action}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: currentUsername, password: currentPassword })
    });
    const data = await response.json();
    if (!response.ok || data.success === false) throw new Error(data.message || `HTTP ${response.status}`);
    return true;
}

async function controlPersistentJob(action) {
    if (!activeBatch?.persistentJobId) return false;
    const ok = await controlProcessJobById(activeBatch.persistentJobId, action);
    startPersistentJobPolling(activeBatch.persistentJobId);
    return ok;
}

function batchRowId(batch, index, file) {
    if (!batch.rowIds[index]) {
        batch.rowIds[index] = `batch_${batch.id}_row_${index}_${safeClientToken(file?.name || index)}`;
    }
    return batch.rowIds[index];
}

function isActiveBatch(batch) {
    return activeBatch && batch && activeBatch.id === batch.id;
}

function batchElapsedMs(batch) {
    if (!batch) return 0;
    const runningMs = batch.running && batch.runStartedAt ? Date.now() - batch.runStartedAt : 0;
    const onDemandMs = !batch.running && batch.onDemandRunning && batch.onDemandStartedAt
        ? Date.now() - batch.onDemandStartedAt
        : 0;
    return batch.elapsedMs + runningMs + onDemandMs;
}

function startBatchLiveTimer(batch) {
    if (!batch) return;
    if (batch.timerInterval) clearInterval(batch.timerInterval);
    batch.timerInterval = setInterval(() => {
        if (!isActiveBatch(batch)) {
            clearInterval(batch.timerInterval);
            batch.timerInterval = null;
            return;
        }
        if (batch.running || batch.onDemandRunning) {
            updateBatchTimer(batch);
            updateBatchProgress(batch);
        }
    }, 500);
}

function stopBatchLiveTimer(batch) {
    if (!batch?.timerInterval) return;
    clearInterval(batch.timerInterval);
    batch.timerInterval = null;
}

function updateBatchTimer(batch) {
    const timerDiv = document.getElementById("batch-timer");
    if (!timerDiv || !batch) return;

    const elapsedMs = batchElapsedMs(batch);
    let etaStr = "Calculating...";
    if (!batch.running && batch.onDemandRunning && batch.onDemandTotal > 0) {
        if (batch.onDemandCompleted > 0 && batch.onDemandCompleted < batch.onDemandTotal) {
            const onDemandElapsed = Date.now() - batch.onDemandStartedAt;
            const timePerRow = onDemandElapsed / batch.onDemandCompleted;
            etaStr = formatDuration(timePerRow * (batch.onDemandTotal - batch.onDemandCompleted));
        }
    } else if (batch.completed > 0 && batch.completed < batch.files.length) {
        const timePerImg = elapsedMs / batch.completed;
        etaStr = formatDuration(timePerImg * (batch.files.length - batch.completed));
    }
    timerDiv.style.display = "block";
    timerDiv.innerText = `Elapsed: ${formatDuration(elapsedMs)} | ETA: ${etaStr}`;
}

function updateBatchProgress(batch) {
    if (!batch) {
        setProgressBar("bulk-progress", 0, { visible: false });
        return;
    }

    if (batch.onDemandRunning && batch.onDemandTotal > 0) {
        setProgressBar("bulk-progress", batch.onDemandCompleted / batch.onDemandTotal, { visible: true });
        return;
    }

    if (batch.uploading && Number.isFinite(Number(batch.uploadProgress))) {
        setProgressBar("bulk-progress", Number(batch.uploadProgress), { visible: true });
        return;
    }

    const total = Math.max(batch.files?.length || 0, 1);
    const completed = batch.finished ? total : Math.min(batch.completed || 0, total);
    const shouldShow = Boolean(batch.running || batch.completed > 0 || batch.finished);
    let activeFraction = 0;
    if (batch.running && !batch.finished && completed < total) {
        const currentMs = batch.runStartedAt ? Date.now() - batch.runStartedAt : 0;
        if (completed > 0) {
            const avgMs = Math.max(1000, batch.elapsedMs / completed);
            activeFraction = Math.min(0.92, currentMs / avgMs);
        } else {
            activeFraction = Math.min(0.85, currentMs / Math.max(1000, BULK_REQUEST_TIMEOUT_MS));
        }
    }
    setProgressBar("bulk-progress", (completed + activeFraction) / total, { visible: shouldShow });
}

function startOnDemandBatchTimer(batch, totalRows) {
    if (!batch || totalRows <= 0) return;
    batch.onDemandRunning = true;
    batch.onDemandStartedAt = Date.now();
    batch.onDemandTotal = totalRows;
    batch.onDemandCompleted = 0;
    updateBatchTimer(batch);
    updateBatchProgress(batch);
    if (!batch.running) {
        startBatchLiveTimer(batch);
    }
}

function finishOnDemandBatchTimer(batch) {
    if (!batch || !batch.onDemandRunning) return;
    if (!batch.running) {
        batch.elapsedMs = batchElapsedMs(batch);
        stopBatchLiveTimer(batch);
    }
    batch.onDemandRunning = false;
    batch.onDemandStartedAt = null;
    batch.onDemandTotal = 0;
    batch.onDemandCompleted = 0;
    const timerDiv = document.getElementById("batch-timer");
    if (timerDiv && !batch.running) {
        timerDiv.style.display = "block";
        timerDiv.innerText = `Total Time: ${formatDuration(batch.elapsedMs)}`;
    }
    updateBatchProgress(batch);
}

function updateBatchControls(batch) {
    const processBtn = document.getElementById("process-batch-btn");
    const stopBtn = document.getElementById("stop-batch-btn");
    const resumeBtn = document.getElementById("resume-batch-btn");
    const downloadBtn = document.getElementById("download-csv-btn");
    if (!stopBtn || !resumeBtn || !downloadBtn) return;

    const ownsUi = isActiveBatch(batch);
    const busy = Boolean(batch.running || batch.onDemandRunning);
    if (processBtn) processBtn.disabled = ownsUi && busy;
    stopBtn.style.display = ownsUi && busy ? "inline-flex" : "none";
    if (!(ownsUi && busy)) resetStopConfirmation(stopBtn);
    resumeBtn.style.display = ownsUi && !busy && !batch.finished && batch.nextIndex < batch.files.length ? "inline-flex" : "none";
    downloadBtn.style.display = ownsUi && !busy && batch.successCount > 0 ? "inline-flex" : "none";
    updateAnalysisSettingsLock();
}

function isAnalysisSettingsLocked() {
    return Boolean(activeBatch && (activeBatch.running || activeBatch.onDemandRunning));
}

function updateAnalysisSettingsLock() {
    const card = document.getElementById("analysis-settings-card");
    const fieldset = document.getElementById("analysis-settings-fieldset");
    const fruitSelect = document.getElementById("fruit-select");
    const locked = isAnalysisSettingsLocked();
    if (fieldset) fieldset.disabled = locked;
    if (fruitSelect) fruitSelect.disabled = locked;
    if (card) card.classList.toggle("settings-locked", locked);
    document.querySelectorAll(".wizard-edit-btn").forEach(btn => { btn.disabled = locked; });
    updateWizardNav();
    updateDependentSettingsAvailability();
}

function stopActiveBatch(reason = "stopped") {
    if (!activeBatch || (!activeBatch.running && !activeBatch.onDemandRunning)) return;
    const batch = activeBatch;
    if (batch.running) {
        batch.stopRequested = true;
        batch.stopReason = reason;
    }
    if (batch.onDemandRunning) {
        batch.onDemandStopRequested = true;
    }
    if (batch.abortController) {
        batch.abortController.abort();
    }
    if (batch.onDemandAbortController) {
        batch.onDemandAbortController.abort();
    }
    if (reason === "replaced") {
        stopBatchLiveTimer(batch);
        batch.elapsedMs = batchElapsedMs(batch);
        batch.running = false;
        batch.onDemandRunning = false;
        batch.onDemandStartedAt = null;
        batch.onDemandAbortController = null;
        updateAnalysisSettingsLock();
        updateBatchProgress(batch);
        return;
    }
    updateBatchControls(batch);
    updateBatchProgress(batch);
}

function updateDevQueueToolsVisibility() {
    const tools = document.getElementById("dev-queue-tools");
    if (!tools) return;
    tools.classList.toggle("visible", isDevUser());
}

async function flushDevQueue() {
    const button = document.getElementById("flush-dev-queue-btn");
    const status = document.getElementById("flush-dev-queue-status");
    if (!isDevUser()) {
        if (status) status.innerText = "Only devtest can flush the dev queue.";
        return;
    }
    if (button && !requireSecondStopClick(button, "Click again to flush")) return;
    if (button) {
        resetStopConfirmation(button);
        button.disabled = true;
    }
    if (status) status.innerText = "Flushing dev queue...";
    stopActiveBatch("replaced");
    try {
        const response = await fetch(flushQueueUrl(), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: currentPassword, username: currentUsername })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.success === false) {
            throw new Error(data.message || `HTTP ${response.status}`);
        }
        if (status) status.innerText = data.message || "Dev queue flush requested.";
        startQueuePolling();
    } catch (err) {
        if (status) status.innerText = `Flush failed: ${err.message}`;
    } finally {
        if (button) button.disabled = false;
    }
}

function finishBatch(batch, mode) {
    if (!isActiveBatch(batch)) return;

    stopBatchLiveTimer(batch);
    batch.elapsedMs = batchElapsedMs(batch);
    batch.running = false;
    batch.runStartedAt = null;
    if (batch.onDemandRunning && !batch.timerInterval) {
        startBatchLiveTimer(batch);
    }

    const status = document.getElementById("bulk-status");
    const timerDiv = document.getElementById("batch-timer");
    const chartsContainer = document.getElementById("histograms-container");
    const remaining = Math.max(batch.files.length - batch.nextIndex, 0);
    const excludedText = "";

    if (timerDiv) {
        if (batch.onDemandRunning) {
            updateBatchTimer(batch);
        } else {
            timerDiv.style.display = "block";
            timerDiv.innerText = `Total Time: ${formatDuration(batch.elapsedMs)}`;
        }
    }

    if (mode === "complete") {
        batch.finished = true;
        status.innerText = `Batch complete: ${batch.successCount} succeeded, ${batch.failureCount} failed, ${batch.completed} attempted.${excludedText}`;
    } else {
        status.innerText = `Batch stopped: ${batch.successCount} succeeded, ${batch.failureCount} failed, ${batch.completed} attempted, ${remaining} remaining.${excludedText}`;
    }

    if (typeof gtag === 'function') {
        gtag('event', mode === "complete" ? 'processed_bulk_batch' : 'stopped_bulk_batch', {
            'event_category': 'Phenotyping',
            'images_attempted': batch.completed,
            'images_succeeded': batch.successCount
        });
    }

    updateBatchControls(batch);
    updateBatchProgress(batch);
    requestHistogramRebuild(chartsContainer);
}

function batchResultItem(file, data) {
    const isCm = measurementUnit(data) === "cm";
    const digits = isCm ? 1 : 0;
    const notes = rowNotes(data);
    return { file_name: file.name, data, included: true, isCm, allowPixelMetrics: true, digits, notes, success: true };
}

function setBatchResultItem(item, replaceIndex = null) {
    if (replaceIndex !== null && replaceIndex >= 0 && replaceIndex < globalBatchResults.length) {
        globalBatchResults[replaceIndex] = item;
        return replaceIndex;
    }
    globalBatchResults.push(item);
    return globalBatchResults.length - 1;
}

function addBatchResult(batch, file, data, replaceIndex = null) {
    if (data.success) {
        batch.successCount++;
        if (Number(data.processing_ms) > BULK_REQUEST_TIMEOUT_MS) {
            data.processing_ms_timeout = true;
        }
        const item = batchResultItem(file, data);
        if (!item.isCm) batch.pixelScaleCount++;

        setBatchResultItem(item, replaceIndex);
    } else {
        batch.failureCount++;
        const msg = `Error: ${data.message || "Unknown error"}`;
        const failureData = {
            ...data,
            filename: data.filename || file.name,
            warnings: Array.isArray(data.warnings) ? data.warnings : [],
            processing_ms: data.processing_ms ?? null,
            processing_ms_timeout: Boolean(data.processing_ms_timeout)
        };
        const notes = [msg, rowNotes(failureData)].filter(Boolean).join(" | ");
        setBatchResultItem({
            file_name: file.name,
            data: failureData,
            included: false,
            isCm: false,
            allowPixelMetrics: false,
            digits: 0,
            notes,
            success: false,
            includeFailedMetrics: false,
            message: msg
        }, replaceIndex);
    }
}

function addBatchRetrying(file, message = BULK_RETRY_MESSAGE) {
    const data = {
        filename: file.name,
        warnings: [message],
        processing_ms: BULK_REQUEST_TIMEOUT_MS + 1,
        processing_ms_timeout: message === BULK_RETRY_MESSAGE
    };
    globalBatchResults.push({
        file_name: file.name,
        data,
        included: true,
        isCm: false,
        allowPixelMetrics: true,
        digits: 0,
        notes: message,
        success: false,
        retrying: true,
        includeFailedMetrics: true,
        message
    });
    return globalBatchResults.length - 1;
}

function removeBatchPlaceholder(index) {
    if (index !== null && index >= 0 && index < globalBatchResults.length && globalBatchResults[index]?.retrying) {
        globalBatchResults.splice(index, 1);
    }
}

function addBatchFailure(batch, file, err, replaceIndex = null) {
    batch.failureCount++;
    const isTimeout = isBulkTimeoutError(err);
    const msg = isTimeout ? BULK_TIMEOUT_MESSAGE : (err?.retryable ? err.message : `API Error: ${err.message}`);
    const data = {
        filename: file.name,
        warnings: [msg],
        processing_ms: isTimeout ? BULK_REQUEST_TIMEOUT_MS + 1 : null,
        processing_ms_timeout: isTimeout
    };
    setBatchResultItem({
        file_name: file.name,
        data,
        included: isTimeout,
        isCm: false,
        allowPixelMetrics: true,
        digits: 0,
        notes: msg,
        success: false,
        includeFailedMetrics: isTimeout,
        message: msg
    }, replaceIndex);
}

let missingStageTimer = null;
let missingStageInFlight = false;
let missingStageQueued = false;
let stagedEndpointUnavailable = false;

function isPreviewColumnId(id) {
    return PREVIEW_STAGE_COLUMN_IDS.has(id);
}

function stageAllowedBySettings(stage, settings) {
    return true;
}

function itemNeedsColumn(item, columnId, batch) {
    if (!item?.data?.session_id || !item?.data?.row_id || item.retrying) return false;
    if (item.unavailableColumnIds instanceof Set && item.unavailableColumnIds.has(columnId)) return false;
    const stage = stageForColumnId(columnId);
    if (!stage || !stageAllowedBySettings(stage, batch?.settings || getAnalysisSettingsSnapshot())) return false;

    if (columnId === "processing_ms") return false;
    return !columnHasUsableValue(item, columnId);
}

function missingColumnsForItem(item, batch, columnIds) {
    return columnIds.filter(id => itemNeedsColumn(item, id, batch));
}

async function postBatchStage(rowIds, requestedColumnIds, batch, signal = null) {
    const response = await fetch(batchStageUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
            password: currentPassword,
            username: currentUsername,
            session_id: batch.sessionId || currentSessionId,
            row_ids: rowIds,
            requested_columns: requestedColumnIds,
            settings: batch.settings || getAnalysisSettingsSnapshot()
        })
    });
    const text = await response.text();
    const data = text ? (() => {
        try { return JSON.parse(text); }
        catch { return { message: text.slice(0, 180) }; }
    })() : {};
    if (!response.ok || data.success === false) {
        const err = new Error(data.message || `HTTP ${response.status}`);
        err.status = response.status;
        throw err;
    }
    return data;
}

function fileForBatchItem(batch, item) {
    const rowId = item?.data?.row_id;
    const index = rowId ? batch.rowIds.indexOf(rowId) : -1;
    if (index >= 0 && batch.files[index]) return batch.files[index];
    return batch.files.find(file => file.name === item.file_name || file.name === item.data?.filename) || null;
}

async function fallbackReprocessChunk(chunk, requestedIds, batch, signal = null) {
    const previewIds = requestedIds.filter(isPreviewColumnId);
    for (const { item } of chunk) {
        if (signal?.aborted) throw new Error("Batch stopped");
        const file = fileForBatchItem(batch, item);
        if (!file) {
            throw new Error("Cached source unavailable and original file could not be matched.");
        }
        const runLineOcr = shouldRequestLineOcr(previewIds, batch.settings)
            || requestedIds.some(id => OCR_STAGE_COLUMN_IDS.has(id));
        const data = await postImage(
            file,
            previewIds,
            BULK_REQUEST_TIMEOUT_MS,
            0,
            signal,
            batch.settings,
            runLineOcr,
            item.data?.row_id,
            requestedIds
        );
        mergeStagePatch({
            ...data,
            stage_processing_ms: data.stage_processing_ms ?? data.processing_ms ?? null,
            session_id: data.session_id || item.data?.session_id,
            row_id: item.data?.row_id || data.row_id
        });
    }
}

function mergeStagePatch(rowPatch) {
    const rowId = rowPatch?.row_id;
    if (!rowId) return;
    const item = globalBatchResults.find(candidate => candidate.data?.row_id === rowId);
    if (!item) return;

    const previousProcessingMs = Number(item.data?.processing_ms);
    const extraProcessingMs = Number(rowPatch.stage_processing_ms);
    const patch = { ...rowPatch };
    if (Number.isFinite(extraProcessingMs) && extraProcessingMs > 0) {
        const baseProcessingMs = Number.isFinite(previousProcessingMs) ? previousProcessingMs : 0;
        patch.processing_ms = Math.round(baseProcessingMs + extraProcessingMs);
    }

    item.data = { ...(item.data || {}), ...patch };
    item.success = item.data.success !== false;
    item.isCm = measurementUnit(item.data) === "cm";
    item.digits = item.isCm ? 1 : 0;
    item.notes = rowNotes(item.data);
}

function markUnavailableMissingColumns(item, requestedIds) {
    const missing = requestedIds.filter(id => itemNeedsColumn(item, id, activeBatch));
    if (missing.length === 0) return;
    if (!(item.unavailableColumnIds instanceof Set)) item.unavailableColumnIds = new Set();
    missing.forEach(id => item.unavailableColumnIds.add(id));
    const labels = missing
        .map(id => COLUMN_BY_ID.get(id)?.label || id)
        .slice(0, 4)
        .join(", ");
    const suffix = missing.length > 4 ? `, +${missing.length - 4} more` : "";
    const warning = `Selected outputs unavailable: ${labels}${suffix}.`;
    const warnings = Array.isArray(item.data?.warnings) ? item.data.warnings : [];
    if (!warnings.includes(warning)) {
        item.data = {
            ...(item.data || {}),
            warnings: [...warnings, warning]
        };
        item.notes = rowNotes(item.data);
    }
}

function rebuildPendingStages(item) {
    const pendingIds = item.pendingColumnIds instanceof Set ? item.pendingColumnIds : new Set();
    item.pendingStages = new Set([...pendingIds].map(stageForColumnId).filter(Boolean));
}

function markPendingColumns(item, columnIds) {
    const ids = (columnIds || []).filter(Boolean);
    if (ids.length === 0) return;
    item.pendingColumnIds = new Set([...(item.pendingColumnIds || []), ...ids]);
    rebuildPendingStages(item);
}

function clearPendingColumns(item, columnIds = null) {
    if (!(item.pendingColumnIds instanceof Set)) {
        item.pendingColumnIds = new Set();
        item.pendingStages = new Set();
        return;
    }
    if (Array.isArray(columnIds)) {
        columnIds.forEach(id => item.pendingColumnIds.delete(id));
    } else {
        item.pendingColumnIds.clear();
    }
    rebuildPendingStages(item);
}

function markCurrentlyMissingColumnsPending(batch, requestedIds) {
    const entries = globalBatchResults
        .map(item => ({ item, missing: missingColumnsForItem(item, batch, requestedIds) }))
        .filter(entry => entry.missing.length > 0);
    entries.forEach(({ item, missing }) => markPendingColumns(item, missing));
    return entries;
}

function scheduleMissingStageRequest() {
    if (!activeBatch || globalBatchResults.length === 0) return;
    clearTimeout(missingStageTimer);
    missingStageTimer = setTimeout(runMissingStageRequest, 150);
}

async function runMissingStageRequest() {
    const batch = activeBatch;
    if (!batch) return;

    const requestedIds = selectedColumnIdsForRequest();
    if (missingStageInFlight) {
        markCurrentlyMissingColumnsPending(batch, requestedIds);
        missingStageQueued = true;
        refreshBatchOutputs(document.getElementById("histograms-container"), { debounceHistograms: true });
        return;
    }

    const entries = markCurrentlyMissingColumnsPending(batch, requestedIds);
    if (entries.length === 0) return;

    missingStageInFlight = true;
    batch.onDemandStopRequested = false;
    batch.onDemandAbortController = new AbortController();
    startOnDemandBatchTimer(batch, entries.length);
    updateBatchControls(batch);
    refreshBatchOutputs(document.getElementById("histograms-container"), { debounceHistograms: true });

    try {
        const chunkSize = 4;
        for (let i = 0; i < entries.length; i += chunkSize) {
            if (!isActiveBatch(batch) || batch.onDemandStopRequested || batch.onDemandAbortController?.signal.aborted) break;
            const chunk = entries.slice(i, i + chunkSize);
            const chunkRequestedIds = Array.from(new Set(chunk.flatMap(entry => entry.missing)));
            try {
                if (stagedEndpointUnavailable) {
                    await fallbackReprocessChunk(chunk, chunkRequestedIds, batch, batch.onDemandAbortController.signal);
                } else {
                    const rowIds = chunk.map(entry => entry.item.data.row_id);
                    const response = await postBatchStage(rowIds, chunkRequestedIds, batch, batch.onDemandAbortController.signal);
                    (response.rows || []).forEach(mergeStagePatch);
                }
                chunk.forEach(({ item }) => {
                    clearPendingColumns(item, chunkRequestedIds);
                    markUnavailableMissingColumns(item, chunkRequestedIds);
                });
            } catch (err) {
                const stopped = batch.onDemandStopRequested || err.name === "AbortError" || err.message === "Batch stopped";
                if (stopped) {
                    chunk.forEach(({ item }) => {
                        clearPendingColumns(item, chunkRequestedIds);
                    });
                    break;
                }
                if (err.status === 404 && !stagedEndpointUnavailable) {
                    stagedEndpointUnavailable = true;
                    try {
                        await fallbackReprocessChunk(chunk, chunkRequestedIds, batch, batch.onDemandAbortController.signal);
                        chunk.forEach(({ item }) => {
                            clearPendingColumns(item, chunkRequestedIds);
                            markUnavailableMissingColumns(item, chunkRequestedIds);
                        });
                    } catch (fallbackErr) {
                        chunk.forEach(({ item }) => {
                            clearPendingColumns(item, chunkRequestedIds);
                            markUnavailableMissingColumns(item, chunkRequestedIds);
                            const warnings = Array.isArray(item.data?.warnings) ? item.data.warnings : [];
                            item.data = {
                                ...(item.data || {}),
                                warnings: [...warnings, `On-demand fallback failed: ${fallbackErr.message}`]
                            };
                            item.notes = rowNotes(item.data);
                        });
                    }
                } else {
                    chunk.forEach(({ item }) => {
                        clearPendingColumns(item, chunkRequestedIds);
                        markUnavailableMissingColumns(item, chunkRequestedIds);
                        const warnings = Array.isArray(item.data?.warnings) ? item.data.warnings : [];
                        item.data = {
                            ...(item.data || {}),
                            warnings: [...warnings, `On-demand stage request failed: ${err.message}`]
                        };
                        item.notes = rowNotes(item.data);
                    });
                }
            }
            batch.onDemandCompleted = Math.min(batch.onDemandTotal, batch.onDemandCompleted + chunk.length);
            updateBatchTimer(batch);
            updateBatchProgress(batch);
            refreshBatchOutputs(document.getElementById("histograms-container"), { debounceHistograms: true });
        }
    } finally {
        finishOnDemandBatchTimer(batch);
        batch.onDemandAbortController = null;
        missingStageInFlight = false;
        refreshBatchOutputs(document.getElementById("histograms-container"));
        updateBatchControls(batch);
        if (missingStageQueued) {
            missingStageQueued = false;
            scheduleMissingStageRequest();
        }
    }
}

function warningBadge(notes) {
    return notes
        ? `<span title="${escapeHtml(notes)}" style="display:inline-block; width:18px; height:18px; background:#ffc107; color:#000; border-radius:50%; text-align:center; line-height:18px; font-weight:bold; cursor:help; margin-left:5px; font-size:12px;">!</span>`
        : "";
}

function renderTableHeader() {
    applyMetricColumnUnitLabels();
    const table = document.getElementById("bulk-table");
    const thead = table.querySelector("thead");
    thead.innerHTML = `
        <tr>
            <th>
                <span class="column-title-wrap">
                    <span>Include</span>
                    <span class="column-help-icon" title="Checked rows are included in histograms and CSV export. Rows are selected by default; uncheck a row to temporarily exclude it without deleting the result.">?</span>
                </span>
            </th>
            <th>Filename</th>
            <th class="processing-log-cell">
                <span class="column-title-wrap">
                    <span>Processing Log</span>
                    <span class="column-help-icon" title="Warnings and errors produced while processing this image. If no warnings or errors were reported, this shows N/A.">?</span>
                </span>
            </th>
            ${visibleColumns().map(column => `
                <th class="draggable-column-header ${column.adjustable ? "adjustable-preview-header" : ""}" draggable="true" data-column-id="${column.id}">
                    <span class="column-title-wrap">
                        <span>${escapeHtml(column.label)}</span>
                        ${columnHelpIcon(column)}
                    </span>
                </th>
            `).join("")}
        </tr>
    `;
}

function renderCell(column, item) {
    if (column.html) {
        try {
            return column.html(item);
        } catch (err) {
            console.warn(`Could not render column ${column.id}`, err);
            return `<span class="muted">-</span>`;
        }
    }

    const value = columnValue(column, item);
    if ((value === null || value === undefined || value === "") && itemHasPendingColumn(item, column.id)) {
        return `<span class="muted">Computing...</span>`;
    }
    if (column.display) {
        return escapeHtml(column.display(value, item));
    }
    if (isNumber(value)) {
        return escapeHtml(fmt(value, columnDigits(column, item)));
    }
    if (value === null || value === undefined || value === "") {
        return `<span class="muted">N/A</span>`;
    }
    return escapeHtml(value);
}

function histogramPreviewValues(column) {
    const values = [];
    globalBatchResults.forEach(item => {
        if (!item.included || (!item.success && !item.includeFailedMetrics)) return;
        const value = columnValue(column, item);
        if (isNumber(value)) values.push(value);
    });
    return values;
}

function miniHistogramSvg(column) {
    if (column.histogram === false) return `<span class="muted">-</span>`;

    const numericValues = histogramPreviewValues(column);
    if (numericValues.length === 0) {
        return `<span class="mini-histogram-empty">No data</span>`;
    }

    const overflowThreshold = column.histogramOverflow;
    const overflowValues = overflowThreshold !== undefined ? numericValues.filter(v => v > overflowThreshold) : [];
    const values = overflowThreshold !== undefined ? numericValues.filter(v => v <= overflowThreshold) : numericValues.slice();
    const counts = [];

    if (values.length > 0) {
        values.sort((a, b) => a - b);
        let min = values[0];
        let max = values[values.length - 1];
        if (max === min) {
            min -= Math.max(Math.abs(min) * 0.05, 0.5);
            max += Math.max(Math.abs(max) * 0.05, 0.5);
        }
        const binCount = Math.max(4, Math.min(10, Math.ceil(Math.sqrt(values.length))));
        const binWidth = (max - min) / binCount || 1;
        for (let i = 0; i < binCount; i++) counts.push(0);
        values.forEach(value => {
            let idx = Math.floor((value - min) / binWidth);
            if (idx >= binCount) idx = binCount - 1;
            if (idx < 0) idx = 0;
            counts[idx]++;
        });
    }

    if (overflowValues.length > 0) counts.push(overflowValues.length);
    if (counts.length === 0) counts.push(0);

    const width = 92;
    const height = 34;
    const pad = 3;
    const gap = 1.5;
    const maxCount = Math.max(...counts, 1);
    const barW = Math.max(2, (width - pad * 2 - gap * (counts.length - 1)) / counts.length);
    const bars = counts.map((count, idx) => {
        const barH = count <= 0 ? 1 : Math.max(2, (height - pad * 2) * (count / maxCount));
        const x = pad + idx * (barW + gap);
        const y = height - pad - barH;
        const fill = overflowThreshold !== undefined && overflowValues.length > 0 && idx === counts.length - 1
            ? "#df7b39"
            : "#4f9bd5";
        return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="1" fill="${fill}"></rect>`;
    }).join("");

    return `<svg class="mini-histogram" viewBox="0 0 ${width} ${height}" role="img" aria-label="Distribution preview for ${escapeHtml(column.histLabel || column.label)}">
        <rect x="0" y="0" width="${width}" height="${height}" rx="4" fill="#eef6fb"></rect>
        ${bars}
    </svg>`;
}

function renderHistogramPreviewFooter(columns) {
    const table = document.getElementById("bulk-table");
    const tfoot = table.querySelector("tfoot");
    if (!tfoot) return;

    tfoot.innerHTML = `
        <tr class="histogram-preview-row">
            <td></td>
            <td class="histogram-preview-label">Distribution previews, see proper histograms below.</td>
            <td></td>
            ${columns.map(column => `<td class="${column.adjustable ? "adjustable-preview-cell" : ""}">${miniHistogramSvg(column)}</td>`).join("")}
        </tr>
    `;
}

function virtualRowHeightEstimate(columns) {
    return columns.some(column => column.id.startsWith("image_"))
        ? VIRTUAL_TABLE_PREVIEW_ROW_HEIGHT
        : VIRTUAL_TABLE_ROW_HEIGHT;
}

function virtualTableRange(table, columns) {
    const total = globalBatchResults.length;
    if (total <= VIRTUAL_TABLE_THRESHOLD || !table || table.style.display === "none") {
        return { start: 0, end: total, top: 0, bottom: 0, rowHeight: virtualRowHeightEstimate(columns), virtualized: false };
    }

    const rowHeight = virtualRowHeightEstimate(columns);
    const tableTop = window.scrollY + table.getBoundingClientRect().top;
    const viewportTop = window.scrollY;
    const viewportBottom = viewportTop + window.innerHeight;
    const rawStart = Math.floor((viewportTop - tableTop) / rowHeight) - VIRTUAL_TABLE_BUFFER_ROWS;
    const start = Math.max(0, Math.min(total - 1, rawStart));
    const visibleCount = Math.max(
        1,
        Math.ceil((viewportBottom - tableTop) / rowHeight) - start + VIRTUAL_TABLE_BUFFER_ROWS
    );
    const end = Math.min(total, start + visibleCount);

    return {
        start,
        end,
        top: start * rowHeight,
        bottom: Math.max(0, (total - end) * rowHeight),
        rowHeight,
        virtualized: true
    };
}

function appendVirtualSpacer(tbody, height, colSpan) {
    if (height <= 0) return;
    const spacer = document.createElement("tr");
    spacer.className = "virtual-spacer-row";
    spacer.innerHTML = `<td colspan="${colSpan}" style="height:${Math.round(height)}px; padding:0; border:0; background:transparent;"></td>`;
    tbody.appendChild(spacer);
}

function renderBulkRow(item, idx, columns) {
    const tr = document.createElement("tr");
    tr.dataset.rowIndex = String(idx);
    const columnCells = columns.map(column => `<td class="${escapeHtml(column.cellClass || "")}">${renderCell(column, item)}</td>`).join("");

    if (item.success) {
        if (!item.included) tr.classList.add("excluded-row");
        tr.innerHTML = `
            <td><input type="checkbox" ${item.included ? "checked" : ""} class="toggle-checkbox" data-idx="${idx}"></td>
            <td>${escapeHtml(item.data?.filename || item.file_name)}
                ${warningBadge(item.notes)}
            </td>
            ${renderProcessingLogCell(item)}
            ${columnCells}
        `;
    } else if (item.retrying) {
        tr.classList.add("retry-row");
        if (!item.included) tr.classList.add("excluded-row");
        tr.innerHTML = `
            <td><input type="checkbox" ${item.included ? "checked" : ""} class="toggle-checkbox" data-idx="${idx}"></td>
            <td>${escapeHtml(item.file_name)}${warningBadge(item.notes)}</td>
            ${renderProcessingLogCell(item)}
            ${columnCells}
        `;
    } else {
        tr.classList.add("error-row");
        const includeCell = item.includeFailedMetrics
            ? `<input type="checkbox" ${item.included ? "checked" : ""} class="toggle-checkbox" data-idx="${idx}">`
            : "-";
        tr.innerHTML = `
            <td>${includeCell}</td>
            <td>${escapeHtml(item.file_name)}${warningBadge(item.notes)}</td>
            ${renderProcessingLogCell(item)}
            ${columnCells}
        `;
    }
    return tr;
}

function scheduleVirtualTableRender() {
    if (virtualTableRenderQueued) return;
    virtualTableRenderQueued = true;
    requestAnimationFrame(() => {
        virtualTableRenderQueued = false;
        const table = document.getElementById("bulk-table");
        if (!table || table.style.display === "none" || globalBatchResults.length <= VIRTUAL_TABLE_THRESHOLD) return;
        renderBulkTable();
    });
}

function renderBulkTable() {
    const table = document.getElementById("bulk-table");
    const tbody = table.querySelector("tbody");
    const columns = visibleColumns();
    const range = virtualTableRange(table, columns);
    const colSpan = columns.length + 3;

    renderTableHeader();
    tbody.innerHTML = "";
    appendVirtualSpacer(tbody, range.top, colSpan);

    for (let idx = range.start; idx < range.end; idx++) {
        tbody.appendChild(renderBulkRow(globalBatchResults[idx], idx, columns));
    }

    appendVirtualSpacer(tbody, range.bottom, colSpan);
    table.classList.toggle("virtualized-table", range.virtualized);
    renderHistogramPreviewFooter(columns);
}

function setupBatchJumpControls() {
    document.querySelectorAll("#batch-jump-controls").forEach(element => element.remove());

    const controls = document.createElement("div");
    controls.id = "batch-jump-controls";
    controls.className = "batch-jump-controls";
    controls.setAttribute("aria-label", "Page navigation");

    const topBtn = document.createElement("button");
    topBtn.type = "button";
    topBtn.id = "batch-jump-top";
    topBtn.textContent = "↑";
    topBtn.setAttribute("aria-label", "Scroll to top");
    topBtn.title = "Scroll to top";
    topBtn.addEventListener("click", scrollToPageTop);

    const bottomBtn = document.createElement("button");
    bottomBtn.type = "button";
    bottomBtn.id = "batch-jump-bottom";
    bottomBtn.textContent = "↓";
    bottomBtn.setAttribute("aria-label", "Scroll to bottom");
    bottomBtn.title = "Scroll to bottom";
    bottomBtn.addEventListener("click", scrollToPageBottom);

    controls.append(topBtn, bottomBtn);
    document.body.appendChild(controls);
    updateBatchJumpControls();
}

function pinBatchJumpControls(controls) {
    controls.style.position = "fixed";
    controls.style.right = "18px";
    controls.style.bottom = "18px";
    controls.style.left = "auto";
    controls.style.top = "auto";
    controls.style.zIndex = "1200";
    controls.style.gap = "8px";
    controls.style.alignItems = "center";
    controls.style.transform = "none";
}

function styleBatchJumpButton(button, disabled) {
    if (!button) return;
    button.textContent = button.id === "batch-jump-top" ? "↑" : "↓";
    button.style.width = "38px";
    button.style.height = "38px";
    button.style.borderRadius = "999px";
    button.style.border = "1px solid rgba(116, 130, 140, 0.55)";
    button.style.background = "rgba(238, 243, 247, 0.72)";
    button.style.color = "#1f343f";
    button.style.fontSize = "19px";
    button.style.fontWeight = "800";
    button.style.lineHeight = "1";
    button.style.display = "inline-flex";
    button.style.alignItems = "center";
    button.style.justifyContent = "center";
    button.style.padding = "0";
    button.style.boxShadow = disabled ? "none" : "0 6px 18px rgba(30, 44, 55, 0.13)";
    button.style.cursor = disabled ? "default" : "pointer";
    button.style.opacity = disabled ? "0.28" : "0.78";
    button.style.backdropFilter = "blur(4px)";
}

function updateBatchJumpControls() {
    let controls = document.getElementById("batch-jump-controls");
    if (!controls) return;
    if (controls.parentElement !== document.body) {
        document.body.appendChild(controls);
    }
    pinBatchJumpControls(controls);
    const shouldShow = globalBatchResults.length > 0 || Boolean(activeBatch?.running || activeBatch?.onDemandRunning);
    controls.classList.toggle("visible", shouldShow);
    controls.style.display = shouldShow ? "inline-flex" : "none";

    const topBtn = document.getElementById("batch-jump-top");
    const bottomBtn = document.getElementById("batch-jump-bottom");
    const doc = document.documentElement;
    const maxScroll = Math.max(0, Math.max(doc.scrollHeight, document.body.scrollHeight) - window.innerHeight);
    const atTop = window.scrollY <= 2;
    const atBottom = window.scrollY >= maxScroll - 2;
    if (topBtn) topBtn.disabled = atTop;
    if (bottomBtn) bottomBtn.disabled = atBottom;
    styleBatchJumpButton(topBtn, atTop);
    styleBatchJumpButton(bottomBtn, atBottom);
}

function scrollToPageTop() {
    window.scrollTo({ top: 0, behavior: "smooth" });
}

function scrollToPageBottom() {
    const doc = document.documentElement;
    const maxScroll = Math.max(0, Math.max(doc.scrollHeight, document.body.scrollHeight) - window.innerHeight);
    window.scrollTo({ top: maxScroll, behavior: "smooth" });
}

function startBulkSoftTimeoutNotice(batch, status, message) {
    return setTimeout(() => {
        if (!isActiveBatch(batch) || batch.stopRequested) return;
        if (status) status.innerText = message;
    }, BULK_REQUEST_TIMEOUT_MS);
}

window.addEventListener("scroll", () => {
    scheduleVirtualTableRender();
    updateBatchJumpControls();
}, { passive: true });
window.addEventListener("resize", () => {
    scheduleVirtualTableRender();
    updateBatchJumpControls();
}, { passive: true });

async function warmUpBatch(batch, status) {
    if (batch.warmupComplete || batch.nextIndex !== 0 || batch.files.length === 0) return;

    const warmupCount = Math.min(BATCH_WARMUP_COUNT, batch.files.length);
    for (let i = 0; i < warmupCount; i++) {
        if (!isActiveBatch(batch) || batch.stopRequested) break;

        const file = batch.files[i];
        status.innerText = `Warming up server (${i + 1}/${warmupCount})... (Won't take more than 80 seconds)`;
        batch.abortController = new AbortController();
        const softTimer = startBulkSoftTimeoutNotice(batch, status, `Warming up server (${i + 1}/${warmupCount}) is taking longer than 40 seconds...`);

        try {
            await postBulkImage(file, [], batch.abortController.signal, batch.settings, false, null, ["processing_ms"]);
        } catch (err) {
            if (!isActiveBatch(batch)) return;
            if (batch.stopRequested || err.message === "Batch stopped") break;
            console.warn(`Warmup request ignored for ${file.name}: ${err.message}`);
        } finally {
            clearTimeout(softTimer);
            batch.abortController = null;
        }

        if (i + 1 < warmupCount) {
            await new Promise(r => setTimeout(r, BATCH_PAUSE_MS));
        }
    }

    if (isActiveBatch(batch) && !batch.stopRequested) {
        batch.warmupComplete = true;
    }
}

async function runBatch(batch) {
    const status = document.getElementById("bulk-status");
    const chartsContainer = document.getElementById("histograms-container");

    batch.running = true;
    batch.finished = false;
    batch.stopRequested = false;
    batch.stopReason = null;
    batch.runStartedAt = Date.now();
    updateBatchTimer(batch);
    updateBatchControls(batch);
    updateBatchProgress(batch);

    startBatchLiveTimer(batch);

    await warmUpBatch(batch, status);

    while (batch.nextIndex < batch.files.length) {
        if (!isActiveBatch(batch) || batch.stopRequested) break;

        const index = batch.nextIndex;
        const file = batch.files[index];
        const rowId = batchRowId(batch, index, file);
        status.innerText = `${batch.completed > 0 ? "Processing" : "Starting"} image ${index + 1} of ${batch.files.length}...`;
        const previewIds = selectedPreviewIds();
        const runLineOcr = batch.requestLineOcr || shouldRequestLineOcr(previewIds, batch.settings);

        batch.abortController = new AbortController();
        const softTimer = startBulkSoftTimeoutNotice(batch, status, `Image ${index + 1} of ${batch.files.length}: taking longer than 40 seconds, still waiting for the current request...`);
        try {
            const data = await postBulkImage(file, previewIds, batch.abortController.signal, batch.settings, runLineOcr, rowId);
            clearTimeout(softTimer);
            batch.abortController = null;
            if (!isActiveBatch(batch)) return;
            if (batch.stopRequested) break;
            addBatchResult(batch, file, data);
        } catch (err) {
            clearTimeout(softTimer);
            batch.abortController = null;
            if (!isActiveBatch(batch)) return;
            if (batch.stopRequested || err.message === "Batch stopped") break;

            if (!isBulkRetryableError(err) || isBulkTimeoutError(err)) {
                addBatchFailure(batch, file, err);
            } else {
                const retryMessage = bulkRetryMessage(err);
                const retryIndex = addBatchRetrying(file, retryMessage);
                status.innerText = `Image ${index + 1} of ${batch.files.length}: ${retryMessage}`;
                refreshBatchOutputs(chartsContainer, { debounceHistograms: true });

                if (batch.stopRequested) {
                    removeBatchPlaceholder(retryIndex);
                    refreshBatchOutputs(chartsContainer, { debounceHistograms: true });
                    break;
                }

                batch.abortController = new AbortController();
                try {
                    const retryData = await postBulkImage(file, previewIds, batch.abortController.signal, batch.settings, runLineOcr, rowId);
                    batch.abortController = null;
                    if (!isActiveBatch(batch)) return;
                    if (batch.stopRequested) {
                        removeBatchPlaceholder(retryIndex);
                        refreshBatchOutputs(chartsContainer, { debounceHistograms: true });
                        break;
                    }
                    addBatchResult(batch, file, retryData, retryIndex);
                } catch (retryErr) {
                    batch.abortController = null;
                    if (!isActiveBatch(batch)) return;
                    if (batch.stopRequested || retryErr.message === "Batch stopped") {
                        removeBatchPlaceholder(retryIndex);
                        refreshBatchOutputs(chartsContainer, { debounceHistograms: true });
                        break;
                    }
                    addBatchFailure(batch, file, retryErr, retryIndex);
                }
            }
        }

        batch.completed++;
        batch.nextIndex = index + 1;
        updateBatchProgress(batch);
        refreshBatchOutputs(chartsContainer, { debounceHistograms: true });

        if (batch.nextIndex < batch.files.length) {
            await new Promise(r => setTimeout(r, BATCH_PAUSE_MS));
        }
    }

    if (!isActiveBatch(batch)) return;

    if (batch.nextIndex >= batch.files.length) {
        finishBatch(batch, "complete");
    } else {
        finishBatch(batch, "stopped");
    }
}

document.getElementById("bulk-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const files = document.getElementById("bulk-files").files;
    if (!files || files.length === 0) return;
    const status = document.getElementById("bulk-status");
    if (!requireWalkthroughComplete(status)) return;

    if (activeBatch?.running) {
        status.innerText = "Stop the current persistent job before starting another batch.";
        return;
    }

    const table = document.getElementById("bulk-table");
    const chartsContainer = document.getElementById("histograms-container");
    const timerDiv = document.getElementById("batch-timer");
    const batchSettings = getAnalysisSettingsSnapshot();
    chartsContainer.innerHTML = "";
    table.style.display = "table";
    document.getElementById("bulk-section").classList.add("bulk-card");
    if (timerDiv) {
        timerDiv.style.display = "block";
        timerDiv.innerText = "Elapsed: 00:00:00 | ETA: Calculating...";
    }
    setProgressBar("bulk-progress", 0, { visible: true });

    globalBatchResults = [];
    renderBulkTable();
    updateBatchJumpControls();
    status.innerText = "Warming up production server...";
    activeBatch = makeBatchState(Array.from(files), batchSettings, shouldRequestLineOcr(selectedPreviewIds(), batchSettings));
    activeBatch.running = true;
    activeBatch.uploading = true;
    activeBatch.uploadProgress = 0;
    activeBatch.runStartedAt = Date.now();
    updateBatchControls(activeBatch);
    updateBatchTimer(activeBatch);
    updateBatchProgress(activeBatch);
    startBatchLiveTimer(activeBatch);
    try {
        await warmProductionBackend({
            settings: batchSettings,
            statusEl: status,
            statusText: "Warming up production server..."
        });
        if (!activeBatch || activeBatch.stopRequested) return;
        status.innerText = "Uploading batch to persistent backend storage...";
        await createPersistentBatchJob(files, batchSettings);
    } catch (err) {
        status.innerText = `Could not create persistent processing job: ${err.message}`;
        if (activeBatch && !activeBatch.persistentJobId) {
            stopBatchLiveTimer(activeBatch);
            activeBatch.running = false;
            activeBatch.uploading = false;
            activeBatch.runStartedAt = null;
            updateBatchControls(activeBatch);
        }
        setProgressBar("bulk-progress", 0, { visible: false });
    }
});

document.getElementById("stop-batch-btn").addEventListener("click", async () => {
    const stopBtn = document.getElementById("stop-batch-btn");
    if (!requireSecondStopClick(stopBtn)) return;
    resetStopConfirmation(stopBtn);
    if (activeBatch?.persistentJobId) {
        try {
            await controlPersistentJob("stop");
        } catch (err) {
            document.getElementById("bulk-status").innerText = `Stop failed: ${err.message}`;
        }
        return;
    }
    stopActiveBatch("stopped");
});

document.getElementById("resume-batch-btn").addEventListener("click", async () => {
    if (!activeBatch || activeBatch.running || activeBatch.finished) return;
    if (activeBatch.persistentJobId) {
        try {
            await controlPersistentJob("resume");
        } catch (err) {
            document.getElementById("bulk-status").innerText = `Resume failed: ${err.message}`;
        }
        return;
    }
    await runBatch(activeBatch);
});

document.getElementById("flush-dev-queue-btn")?.addEventListener("click", flushDevQueue);
document.getElementById("saved-job-select")?.addEventListener("change", async (event) => {
    const jobId = event.target.value;
    if (!jobId) return;
    try {
        const job = await fetchPersistentJob(jobId);
        applyPersistentJob(job, { restored: true });
        if (["queued", "running", "stopping"].includes(job.status)) startPersistentJobPolling(job.job_id);
    } catch (err) {
        document.getElementById("bulk-status").innerText = `Could not restore saved job: ${err.message}`;
    }
});

// --- ROW TOGGLE LISTENER ---
// Listen to the table body. If a checkbox is clicked, update state and instantly rebuild histograms.
document.querySelector("#bulk-table tbody").addEventListener("change", (e) => {
    if (e.target.classList.contains("toggle-checkbox")) {
        const idx = e.target.getAttribute("data-idx");
        const tr = e.target.closest("tr");
        
        globalBatchResults[idx].included = e.target.checked;
        globalBatchResults[idx].includeTouched = true;
        if (e.target.checked) {
            tr.classList.remove("excluded-row");
        } else {
            tr.classList.add("excluded-row");
        }
        
        // Dynamically update the charts
        renderHistogramPreviewFooter(visibleColumns());
        requestHistogramRebuild(document.getElementById("histograms-container"));
    }
});

// --- DYNAMIC HISTOGRAM BUILDER ---
function destroyHistogramCharts() {
    histogramCharts.forEach(chart => {
        try { chart.destroy(); } catch (err) { console.warn("Could not destroy histogram chart", err); }
    });
    histogramCharts = [];
}

function rebuildHistograms(container) {
    applyMetricColumnUnitLabels();
    destroyHistogramCharts();
    container.innerHTML = ""; // Clear old charts
    if (globalBatchResults.length === 0) return;

    const histogramColumns = visibleColumns().filter(column => column.histogram !== false);
    const batchData = Object.fromEntries(histogramColumns.map(column => [column.histLabel || column.label, []]));

    // Only pull data from rows that are checked (included: true)
    globalBatchResults.forEach(item => {
        if (!item.included || (!item.success && !item.includeFailedMetrics)) return;
        histogramColumns.forEach(column => {
            const value = columnValue(column, item);
            if (isNumber(value)) {
                const key = column.histLabel || column.label;
                batchData[key].push(value);
            }
        });
    });

    drawHistograms(
        histogramColumns.map(column => ({
            column,
            title: column.histLabel || column.label,
            values: batchData[column.histLabel || column.label] || []
        })),
        container
    );
}

function drawHistograms(histogramSeries, container) {
    const deSeries = histogramSeries.filter(series => series.title.includes("ΔE"));
    let allDE =[];
    deSeries.forEach(series => {
        if (series.values) allDE.push(...series.values.filter(isNumber));
    });

    let deMin = 0, deMax = 1, deNumBins = 10, deBinWidth = 0.1, deMaxY = null;
    if (allDE.length > 0) {
        allDE.sort((a, b) => a - b);
        deMin = allDE[0];
        deMax = allDE[allDE.length - 1];
        if (deMin === deMax) { deMin *= 0.9; deMax *= 1.1; }
        if (deMin === deMax && deMin === 0) { deMax = 1; }
        const pad = (deMax - deMin) * 0.02;
        deMin -= pad; deMax += pad;

        deNumBins = Math.max(8, Math.min(20, Math.ceil(Math.sqrt(allDE.length || 1))));
        deBinWidth = (deMax - deMin) / deNumBins || 1;

        let maxCount = 0;
        deSeries.forEach(series => {
            const vals = series.values ? series.values.filter(isNumber) :[];
            const counts = new Array(deNumBins).fill(0);
            vals.forEach(val => {
                let idx = Math.floor((val - deMin) / deBinWidth);
                if (idx >= deNumBins) idx = deNumBins - 1;
                if (idx < 0) idx = 0;
                counts[idx]++;
            });
            maxCount = Math.max(maxCount, Math.max(...counts));
        });
        deMaxY = maxCount + Math.ceil(maxCount * 0.1);
    }

    let chartCount = 0;
    for (const series of histogramSeries) {
        const title = series.title;
        const overflowThreshold = series.column.histogramOverflow;
        const numericValues = series.values.filter(isNumber);
        const overflowValues = overflowThreshold !== undefined ? numericValues.filter(v => v > overflowThreshold) : [];
        const values = overflowThreshold !== undefined ? numericValues.filter(v => v <= overflowThreshold) : numericValues;
        if (values.length === 0 && overflowValues.length === 0) continue;

        let min, max, numBins, binWidth, maxY;
        const isDE = title.includes("ΔE");

        if (values.length === 0) {
            min = 0; max = 1; numBins = 0; binWidth = 1; maxY = null;
        } else if (isDE && allDE.length > 0) {
            min = deMin; max = deMax; numBins = deNumBins; binWidth = deBinWidth; maxY = deMaxY;
        } else {
            values.sort((a, b) => a - b);
            min = values[0];
            max = values[values.length - 1];
            if (max === min) { min *= 0.9; max *= 1.1; }
            if (max === min && min === 0) { max = 1; }
            const padding = (max - min) * 0.02;
            min -= padding; max += padding;
            numBins = Math.max(8, Math.min(20, Math.ceil(Math.sqrt(values.length))));
            binWidth = (max - min) / numBins || 1;
            maxY = null;
        }

        const counts = new Array(numBins).fill(0);
        const labels =[];

        let precision = 1;
        if (binWidth < 0.005) precision = 4;
        else if (binWidth < 0.05) precision = 3;
        else if (binWidth < 0.5) precision = 2;

        for (let i = 0; i < numBins; i++) {
            labels.push(`${(min + i * binWidth).toFixed(precision)} - ${(min + (i + 1) * binWidth).toFixed(precision)}`);
        }

        values.forEach(val => {
            let idx = Math.floor((val - min) / binWidth);
            if (idx >= numBins) idx = numBins - 1;
            if (idx < 0) idx = 0;
            counts[idx]++;
        });

        if (overflowValues.length > 0) {
            labels.push(`>${overflowThreshold}`);
            counts.push(overflowValues.length);
        }

        const wrapper = document.createElement("div");
        wrapper.className = "chart-box";
        const canvas = document.createElement("canvas");
        wrapper.appendChild(canvas);
        container.appendChild(wrapper);

        const chartOptions = {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false }, title: { display: true, text: title, font: { size: 16 } } },
            scales: {
                x: { ticks: { maxRotation: 45, minRotation: 0 } },
                y: { beginAtZero: true, title: { display: true, text: "Frequency" }, ticks: { stepSize: 1 } }
            }
        };

        if (maxY !== null) chartOptions.scales.y.max = maxY;

        const chart = new Chart(canvas, {
            type: "bar",
            data: {
                labels: labels,
                datasets: [{ label: title, data: counts, backgroundColor: "rgba(54, 162, 235, 0.6)", borderColor: "rgba(54, 162, 235, 1)", borderWidth: 1 }]
            },
            options: chartOptions
        });
        histogramCharts.push(chart);
        chartCount++;
    }

    if (chartCount === 0) {
        container.innerHTML = `<p class="muted">No numeric values available for histograms.</p>`;
    }
}

// --- CSV DOWNLOAD HANDLER ---
function csvEscape(value) {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

document.getElementById("download-csv-btn").addEventListener("click", () => {
    if (activeBatch?.running || activeBatch?.onDemandRunning) return;
    applyMetricColumnUnitLabels();
    const columns = visibleColumns().filter(column => column.csv !== false);
    const header = ["Filename", "Processing Log", ...columns.map(column => column.csvLabel || column.label)];
    const rows = [header.map(csvEscape).join(",")];

    globalBatchResults.forEach(item => {
        if (!item.included || (!item.success && !item.includeFailedMetrics)) return;
        const values = [item.data.filename || item.file_name, processingLogText(item) || "N/A"];
        columns.forEach(column => {
            const value = columnValue(column, item);
            const csvValue = column.csvValue ? column.csvValue(value, item) : value;
            values.push(isNumber(csvValue) ? csvValue : (csvValue || ""));
        });
        rows.push(values.map(csvEscape).join(","));
    });

    const csvString = rows.join("\n");
    const blob = new Blob([csvString], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.setAttribute('hidden', '');
    a.setAttribute('href', url);
    
    const now = new Date();
    const dateStr = now.toISOString().replace(/T/, '_').replace(/:/g, '-').slice(0, 19);
    
    a.setAttribute('download', `phenotype_data_${dateStr}.csv`);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
});

// --- LIGHTBOX HANDLER ---
const lightbox = document.getElementById("lightbox");
const lightboxImg = document.getElementById("lightbox-img");
const lightboxClose = document.getElementById("lightbox-close");
const lightboxStatus = document.getElementById("lightbox-status");
const lightboxAdjustBtn = document.getElementById("lightbox-adjust-btn");
const lightboxZoomControls = document.getElementById("lightbox-zoom-controls");
const lightboxZoomOut = document.getElementById("lightbox-zoom-out");
const lightboxZoomReset = document.getElementById("lightbox-zoom-reset");
const lightboxZoomIn = document.getElementById("lightbox-zoom-in");
let lightboxPreviewContext = null;
let lightboxTransform = { scale: 1, x: 0, y: 0 };
let lightboxDrag = null;

function renderLightboxTransform() {
    const { scale, x, y } = lightboxTransform;
    lightboxImg.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    lightboxImg.classList.toggle("zoomed", scale > 1.001);
    if (lightboxZoomReset) lightboxZoomReset.innerText = `${Math.round(scale * 100)}%`;
}

function resetLightboxTransform() {
    lightboxTransform = { scale: 1, x: 0, y: 0 };
    lightboxDrag = null;
    lightboxImg.classList.remove("dragging");
    renderLightboxTransform();
}

function setLightboxScale(nextScale) {
    const scale = Math.max(0.5, Math.min(8, Number(nextScale) || 1));
    lightboxTransform.scale = scale;
    if (scale <= 1) {
        lightboxTransform.x = 0;
        lightboxTransform.y = 0;
    }
    renderLightboxTransform();
}

function closeLightbox() {
    lightbox.style.display = "none";
    lightboxPreviewContext = null;
    lightboxImg.onload = null;
    lightboxImg.onerror = null;
    lightboxImg.src = "";
    lightboxImg.style.display = "none";
    if (lightboxStatus) {
        lightboxStatus.innerText = "";
        lightboxStatus.style.display = "none";
    }
    if (lightboxAdjustBtn) lightboxAdjustBtn.style.display = "none";
    lightboxZoomControls?.classList.remove("visible");
    resetLightboxTransform();
}

function openLightbox(fullSrc, fallbackSrc = "", previewContext = null) {
    const primarySrc = fullSrc || fallbackSrc;
    if (!primarySrc) return;

    lightbox.style.display = "flex";
    resetLightboxTransform();
    lightboxPreviewContext = previewContext;
    if (lightboxAdjustBtn) {
        lightboxAdjustBtn.style.display = previewContext?.adjustable ? "inline-flex" : "none";
    }
    lightboxImg.style.display = "none";
    lightboxImg.onload = null;
    lightboxImg.onerror = null;
    lightboxImg.src = "";
    if (lightboxStatus) {
        lightboxStatus.innerText = "Loading...";
        lightboxStatus.style.display = "block";
    }

    lightboxImg.onload = () => {
        if (lightboxStatus) {
            lightboxStatus.innerText = "";
            lightboxStatus.style.display = "none";
        }
        lightboxImg.style.display = "block";
        lightboxZoomControls?.classList.add("visible");
        resetLightboxTransform();
    };

    lightboxImg.onerror = () => {
        lightboxImg.style.display = "none";
        lightboxZoomControls?.classList.remove("visible");
        if (lightboxStatus) {
            lightboxStatus.innerText = "Preview failed to load.";
            lightboxStatus.style.display = "block";
        }
    };

    lightboxImg.src = primarySrc;
}

// Listen for clicks on ANY image with the 'preview-img' class
document.body.addEventListener("click", (e) => {
    if (e.target && e.target.classList.contains("preview-img")) {
        openLightbox(e.target.dataset.fullSrc || "", e.target.src || "", {
            previewType: e.target.dataset.previewType || "",
            sessionId: e.target.dataset.sessionId || "",
            rowId: e.target.dataset.rowId || "",
            filename: e.target.dataset.filename || "",
            adjustable: e.target.dataset.adjustable === "true"
        });
    }
});

lightboxAdjustBtn?.addEventListener("click", () => {
    if (!lightboxPreviewContext?.adjustable) return;
    window.PreviewAdjustments?.open(lightboxPreviewContext);
});

lightboxZoomOut?.addEventListener("click", (event) => {
    event.stopPropagation();
    setLightboxScale(lightboxTransform.scale / 1.25);
});

lightboxZoomIn?.addEventListener("click", (event) => {
    event.stopPropagation();
    setLightboxScale(lightboxTransform.scale * 1.25);
});

lightboxZoomReset?.addEventListener("click", (event) => {
    event.stopPropagation();
    resetLightboxTransform();
});

lightboxImg.addEventListener("wheel", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setLightboxScale(lightboxTransform.scale * (event.deltaY < 0 ? 1.16 : 1 / 1.16));
}, { passive: false });

lightboxImg.addEventListener("pointerdown", (event) => {
    if (lightboxTransform.scale <= 1.001 || event.button !== 0) return;
    event.preventDefault();
    lightboxImg.setPointerCapture(event.pointerId);
    lightboxDrag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: lightboxTransform.x,
        originY: lightboxTransform.y
    };
    lightboxImg.classList.add("dragging");
});

lightboxImg.addEventListener("pointermove", (event) => {
    if (!lightboxDrag || lightboxDrag.pointerId !== event.pointerId) return;
    lightboxTransform.x = lightboxDrag.originX + event.clientX - lightboxDrag.startX;
    lightboxTransform.y = lightboxDrag.originY + event.clientY - lightboxDrag.startY;
    renderLightboxTransform();
});

function endLightboxDrag(event) {
    if (!lightboxDrag || lightboxDrag.pointerId !== event.pointerId) return;
    lightboxDrag = null;
    lightboxImg.classList.remove("dragging");
}

lightboxImg.addEventListener("pointerup", endLightboxDrag);
lightboxImg.addEventListener("pointercancel", endLightboxDrag);
lightboxImg.addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (lightboxTransform.scale > 1.001) resetLightboxTransform();
    else setLightboxScale(2);
});

// Close when clicking the X
lightboxClose.addEventListener("click", closeLightbox);

// Close when clicking the dark background outside the image
lightbox.addEventListener("click", (e) => {
    if (e.target === lightbox) {
        closeLightbox();
    }
});

const MASK_ADJUSTMENT_COLUMNS = [
    ...RAW_STAGE_COLUMN_IDS,
    ...SMOOTH_STAGE_COLUMN_IDS,
    ...TRADITIONAL_STAGE_COLUMN_IDS,
    "image_combined_base64",
    "image_cleanup_hybrid_base64",
    "image_sm_base64",
    "image_traditional_base64"
];
const TRADITIONAL_ADJUSTMENT_COLUMNS = [
    ...TRADITIONAL_STAGE_COLUMN_IDS,
    "image_traditional_base64"
];
const SMOOTHING_ADJUSTMENT_COLUMNS = [
    ...SMOOTH_STAGE_COLUMN_IDS,
    "image_combined_base64",
    "image_sm_base64"
];

function applySingleAdjustmentPatch(rowPatch) {
    if (!latestSingleData || latestSingleData.row_id !== rowPatch?.row_id) return false;
    const previousMs = Number(latestSingleData.processing_ms);
    const extraMs = Number(rowPatch.stage_processing_ms);
    const patch = { ...rowPatch };
    if (Number.isFinite(extraMs) && extraMs > 0) {
        patch.processing_ms = Math.round((Number.isFinite(previousMs) ? previousMs : 0) + extraMs);
    }
    latestSingleData = { ...latestSingleData, ...patch };
    renderCurrentSingleAnalysis();
    return true;
}

async function recomputeAdjustedRows(sessionId, rowIds, requestedColumns, settingsOverride = null) {
    const knownIds = Array.from(new Set(rowIds || [])).filter(rowId => (
        (latestSingleData?.row_id === rowId && latestSingleData?.success !== false)
        || globalBatchResults.some(item => item.data?.row_id === rowId && item.success && !item.retrying)
    ));
    if (!knownIds.length) return [];
    const batch = activeBatch?.sessionId === sessionId
        ? activeBatch
        : {
            sessionId,
            settings: getAnalysisSettingsSnapshot(),
            running: false,
            onDemandRunning: false,
            elapsedMs: 0
        };
    if (settingsOverride) {
        batch.settings = { ...(batch.settings || {}), traditionalSettings: { ...settingsOverride } };
        if (activeBatch?.sessionId === sessionId) activeBatch.settings = batch.settings;
    }

    const ownsBatchUi = activeBatch === batch;
    if (ownsBatchUi) {
        batch.onDemandStopRequested = false;
        batch.onDemandAbortController = new AbortController();
        startOnDemandBatchTimer(batch, knownIds.length);
        updateBatchControls(batch);
    }
    const patches = [];
    try {
        for (const rowId of knownIds) {
            if (ownsBatchUi && (batch.onDemandStopRequested || batch.onDemandAbortController?.signal.aborted)) break;
            const response = await postBatchStage(
                [rowId],
                requestedColumns,
                batch,
                ownsBatchUi ? batch.onDemandAbortController.signal : null
            );
            (response.rows || []).forEach(rowPatch => {
                if (!applySingleAdjustmentPatch(rowPatch)) mergeStagePatch(rowPatch);
                patches.push(rowPatch);
            });
            if (ownsBatchUi) {
                batch.onDemandCompleted = Math.min(batch.onDemandTotal, batch.onDemandCompleted + 1);
                updateBatchTimer(batch);
                updateBatchProgress(batch);
                refreshBatchOutputs(document.getElementById("histograms-container"), { debounceHistograms: true });
            }
        }
    } finally {
        if (ownsBatchUi) {
            finishOnDemandBatchTimer(batch);
            batch.onDemandAbortController = null;
            updateBatchControls(batch);
            refreshBatchOutputs(document.getElementById("histograms-container"));
        }
        renderCurrentSingleAnalysis();
    }
    return patches;
}

window.PhenotypeAdjustmentsHost = {
    apiBase: () => `${proxyBaseUrl()}/${usesProxyApi() ? "proxy_adjustments" : "adjustments"}`,
    credentials: () => ({ username: currentUsername, password: currentPassword }),
    closeLightbox,
    recomputeMasks: (sessionId, rowIds) => recomputeAdjustedRows(sessionId, rowIds, MASK_ADJUSTMENT_COLUMNS),
    recomputeTraditional: (sessionId, rowIds, settings) => recomputeAdjustedRows(
        sessionId,
        rowIds,
        TRADITIONAL_ADJUSTMENT_COLUMNS,
        settings
    ),
    recomputeSmoothing: (sessionId, rowIds) => recomputeAdjustedRows(
        sessionId,
        rowIds,
        SMOOTHING_ADJUSTMENT_COLUMNS
    )
};

function clearPreviewSessionBeacon() {
    if (!currentSessionId) return;
    const payload = JSON.stringify({
        session_id: currentSessionId,
        username: currentUsername
    });
    const blob = new Blob([payload], { type: "application/json" });
    navigator.sendBeacon?.(clearSessionUrl(), blob);
}

// Persistent processing sessions are retained server-side across refreshes,
// browser closure, and device changes. They are no longer cleared on pagehide.

// --- LIVE QUEUE POLLING ---
function startQueuePolling() {
    if (queuePollingIntervalId) clearInterval(queuePollingIntervalId);
    const baseUrl = API_URL.split("/proxy_process")[0];
    
    const poll = async () => {
        if (document.hidden) return;
        // --- FIX: Added '&_t=' cache buster so the browser fetches fresh data every time ---
        const statusEndpoint = `${baseUrl}/proxy_status?username=${encodeURIComponent(currentUsername)}&_t=${Date.now()}`;
        
        try {
            // --- FIX: Explicitly told the fetch command not to use cached memory ---
            const res = await fetch(statusEndpoint, { cache: "no-store" });
            if (!res.ok) return; 
            
            const data = await res.json();
            const statusDiv = document.getElementById("server-status");
            const isDev = currentUsername.toLowerCase() === 'devtest';
            const envName = isDev ? "Development Environment" : "Production Environment";
            
            const active = data.active_requests || 0;
            const max = data.max_concurrent || 2;
            const coresInUse = Number.isFinite(Number(data.cores_in_use))
                ? Math.max(0, Math.min(max, Number(data.cores_in_use)))
                : Math.min(active, max);
            const queued = Number.isFinite(Number(data.queued_requests))
                ? Math.max(0, Number(data.queued_requests))
                : Math.max(0, active - max);
            
            if (coresInUse < max && queued === 0) {
                statusDiv.innerHTML = `Server Ready | <strong>${envName}</strong> (Cores in use: ${coresInUse}/${max})`;
                statusDiv.style.color = "#155724";
                statusDiv.style.backgroundColor = "#d4edda";
            } else {
                const queueText = queued > 0 ? ` - ${queued} in queue` : "";
                statusDiv.innerHTML = `Processing | <strong>${envName}</strong> (Cores in use: ${coresInUse}/${max})${queueText}`;
                statusDiv.style.color = "#856404";
                statusDiv.style.backgroundColor = "#fff3cd";
            }
        } catch (err) {
            // Silently ignore network blips during polling
        }
    };

    poll();
    queuePollingIntervalId = setInterval(poll, 15000); 
}
