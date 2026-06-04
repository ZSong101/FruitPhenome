// For local testing, change to http://localhost:8000/process_single
//let API_URL = "https://crabbly-watermelonphenotyping.hf.space/process_single";
//let API_URL = "https://fruit-proxy-cv71.onrender.com/proxy_process";
let API_URL = "https://PPAL-SongLab-UGA-watermelon-proxy.hf.space/proxy_process";

const SINGLE_REQUEST_TIMEOUT_MS = 120000; // 2 minutes
const BULK_REQUEST_TIMEOUT_MS = 40000;
const BULK_TIMEOUT_MESSAGE = "Taking longer than 40 seconds. Moving on.";
const BULK_RETRY_MESSAGE = "Taking longer than 40 seconds. Trying again...";
const TARGET_HASH = "9139eb3676d5dfafced7613f044d86d9e7c84f40a04c83ddce062878621315d0";

let currentPassword = ""; // Stores the password in memory after a successful login
let currentUsername = ""; // Stores user identity
let currentSessionId = "";

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

function previewUrlBase() {
    return `${proxyBaseUrl()}/${usesProxyApi() ? "proxy_preview" : "preview"}`;
}

function clearSessionUrl() {
    return `${proxyBaseUrl()}/${usesProxyApi() ? "proxy_preview_session_clear" : "preview_session/clear"}`;
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
    document.querySelectorAll(".tab-button").forEach(button => {
        const active = button.dataset.tabTarget === targetId;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", active ? "true" : "false");
    });

    document.querySelectorAll(".tab-panel").forEach(panel => {
        panel.classList.toggle("active", panel.id === targetId);
    });
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

async function sha256(message) {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// --- NEW LOGIN LISTENER ---
document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pwd = document.getElementById("login-password").value;
    const uname = document.getElementById("login-name").value.trim();
    const errorDiv = document.getElementById("login-error");
    
    if (await sha256(pwd) === TARGET_HASH) {
        currentPassword = pwd;
        currentUsername = uname;
        currentSessionId = makeClientId("session");
        console.log(`Logged in as ${currentUsername}. Sending traffic via Proxy.`);
        document.getElementById("login-view").style.display = "none";
        document.getElementById("app-view").style.display = "block";

        // Track unique login name
        if (typeof gtag === 'function') {
            gtag('event', 'user_login', {
                'event_category': 'Authentication',
                'username': currentUsername
            });
        }
        
        startQueuePolling(); // Boot up the live dashboard
    } else {
        errorDiv.innerText = "Incorrect password.";
    }
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
    if (!snapshot.readLabels) return false;
    return previewIds.includes("image_line_ocr_base64")
        || previewIds.includes("image_ocr_dbnet_base64")
        || hasLineOptionList(snapshot)
        || (typeof visibleColumnIds !== "undefined" && (
            visibleColumnIds.has("line")
            || visibleColumnIds.has("line_confidence")
            || visibleColumnIds.has("line_orientation")
        ));
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

function requireFruitSelection(statusEl) {
    const fruitSelect = document.getElementById("fruit-select");
    const fruitStatus = document.getElementById("fruit-select-status");
    if (fruitSelect?.value === "watermelon") {
        fruitSelect.classList.remove("input-error");
        fruitStatus?.classList.remove("visible");
        return true;
    }

    if (statusEl) {
        statusEl.innerText = "Select Fruit is required. Choose fruit type on the Main tab before processing.";
    }
    fruitSelect?.classList.add("input-error");
    fruitStatus?.classList.add("visible");
    activateTab("settings-panel");
    setTimeout(() => fruitSelect?.focus(), 0);
    return false;
}

function getAnalysisSettingsSnapshot() {
    return {
        fruit: selectedFruit(),
        readLabels: checkboxChecked("read-labels-input", false),
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
    formData.append("read_labels", snapshot.readLabels ? "true" : "false");
    formData.append("use_color_checker", snapshot.useColorChecker ? "true" : "false");
    formData.append("line_options", snapshot.lineOptions || "");
    formData.append("scale_value", snapshot.scaleValue || "");
    formData.append("scale_unit", snapshot.scaleUnit || "cm_per_px");
    formData.append("traditional_settings", JSON.stringify(snapshot.traditionalSettings || {}));
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
    updateSettingsSliderLabels();
    document.querySelectorAll("#analysis-settings-fieldset input[type='range']").forEach(input => {
        input.addEventListener("input", updateSettingsSliderLabels);
    });
    ["read-labels-input", "use-color-checker-input"].forEach(id => {
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
    ["mode-smoothing-input", "mode-legacy-ta-input", "mode-visual-comparison-input", "mode-all-features-input"].forEach(id => {
        document.getElementById(id)?.addEventListener("change", () => {
            if (id === "mode-all-features-input" && checkboxChecked(id, false)) {
                ["read-labels-input", "use-color-checker-input", "mode-smoothing-input", "mode-legacy-ta-input", "mode-visual-comparison-input"].forEach(otherId => {
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
        const invalid = event.target.value !== "watermelon";
        event.target.classList.toggle("input-error", invalid);
        document.getElementById("fruit-select-status")?.classList.toggle("visible", invalid);
    });
}

async function postImage(file, previewIds = [], timeoutMs = SINGLE_REQUEST_TIMEOUT_MS, maxRetries = 1, externalSignal = null, settings = null, includeLineOcr = null, rowId = null, requestedColumnIdsOverride = null) {
    const requestSettings = settings || getAnalysisSettingsSnapshot();
    const requestColumnIds = requestedColumnIdsOverride || selectedColumnIdsForRequest();
    const runLineOcr = includeLineOcr ?? shouldRequestLineOcr(previewIds, requestSettings);
    const formData = new FormData();
    formData.append("password", currentPassword);
    formData.append("username", currentUsername); 
    formData.append("file", file);
    formData.append("session_id", currentSessionId);
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
                throw new Error(data.message || `HTTP ${response.status}`);
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
                    throw new Error(timeoutMs === BULK_REQUEST_TIMEOUT_MS ? BULK_TIMEOUT_MESSAGE : `Timed out after ${Math.round(timeoutMs / 1000)}s`);
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
    // 40 second timeout. The batch loop owns the one visible retry pass.
    return postImage(file, previewIds, BULK_REQUEST_TIMEOUT_MS, 0, externalSignal, settings, includeLineOcr, rowId, requestedColumnIdsOverride);
}

function isBulkTimeoutError(err) {
    return err?.message === BULK_TIMEOUT_MESSAGE;
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

function previewColumn(id, label, field) {
    return {
        id,
        label,
        histogram: false,
        csv: false,
        get: () => null,
        html: (item) => {
            if (item.data?.[field]) {
                return `<img src="data:image/jpeg;base64,${item.data[field]}" class="thumb preview-img">`;
            }
            const thumbUrl = previewFetchUrl(item.data, field, "thumb");
            const fullUrl = previewFetchUrl(item.data, field, "full");
            if (thumbUrl) {
                return `<img src="${escapeHtml(thumbUrl)}" data-full-src="${escapeHtml(fullUrl || thumbUrl)}" class="thumb preview-img">`;
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
                    previewColumn("image_raw_base64", "Preview (Raw)", "image_raw_base64"),
                    previewColumn("image_cleanup_hybrid_base64", "Preview (Cleanup)", "image_cleanup_hybrid_base64"),
                    previewColumn("image_sm_base64", "Preview (Smooth)", "image_sm_base64"),
                    previewColumn("image_traditional_base64", "Preview (Traditional) (TA)", "image_traditional_base64")
                ]
            }
        ]
    },
    {
        id: "run_info",
        label: "Run Info",
        columns: [
            metricColumn("line", "Line", "line", 0, { histogram: false }),
            metricColumn("line_confidence", "Line Confidence", "line_confidence", 2, { histogram: false }),
            metricColumn("line_orientation", "Orientation", "line_orientation", 0, { histogram: false, get: (data) => valueOrNull(data.line_orientation ?? 0) }),
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
    experimental_color: "Color calibration diagnostics describe whether the ColorChecker-based correction was reliable and how much the patch colors changed.",
    traditional: "Traditional (TA) features are boundary-based morphology descriptors modeled after Tomato Analyzer fruit shape measurements. All features marked with (TA) are derived from Tomato Analyzer.",
    traditional_shape_index: "Shape index features (TA) describe whether the fruit is elongated, squat, triangular, or balanced in height and width.",
    traditional_eccentric: "Eccentricity and asymmetry features (TA) describe whether the widest portion is shifted toward one end and how asymmetric the shape is across horizontal or vertical axes.",
    traditional_end_shape: "End-shape features (TA) describe proximal and distal tip angles, blockiness, and indentation using the user-adjustable settings in Analysis Settings.",
    traditional_fit: "Common-shape fit features (TA) compare the cleaned fruit boundary to simple geometric or named fruit-shape templates.",
    previews: "Preview columns return diagnostic images. They are excluded from histograms and CSV downloads.",
    previews_standard: "Standard previews show the OCR, calibration, mask cleanup, smoothing, and traditional-feature overlays requested for each image.",
    run_info: "Run information columns describe OCR metadata and processing time rather than fruit morphology."
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
    color_calibration_confidence: "Overall confidence score for ColorChecker-based calibration. Low values suggest that scale or color correction should be inspected.",
    delta_e_initial: "Average ColorChecker color error before correction. Smaller values mean the uncorrected image already matched the reference more closely.",
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
    image_pre_calibration_base64: "Image before color calibration, with ColorChecker overlay when available. It is the first visual check for checker detection and scale calibration.",
    image_raw_base64: "Raw model-output preview retained for diagnosis. It shows the original predicted masks before cleanup is used for measurement.",
    image_cleanup_hybrid_base64: "Cleanup preview showing processed masks, raw mask outlines, axes, midline, and ColorChecker overlay. These cleaned masks feed the main measurements.",
    image_sm_base64: "Smoothed preview showing fitted fruit and flesh curves plus smoothed endpoint angle geometry. It helps verify the function-fit measurements.",
    image_traditional_base64: "Traditional (TA) preview showing Tomato Analyzer-style overlays such as axes, widths, angles, circle, ellipse, and indentation areas. It helps audit the Tomato Analyzer (TA) descriptors.",
    line: "Short Line ID detected from text in the image, optionally constrained by the Possible Lines list. It may contain letters, numbers, dashes, or underscores.",
    line_confidence: "Confidence score for the selected Line read or matched Line option. Lower values should be checked manually.",
    line_orientation: "Image rotation inferred from the selected OCR read and used for mask generation when text is detected. A value of 0 means no rotation was applied.",
    processing_ms: "Total backend processing time for the image in milliseconds. Trying at less busy times of the day can change average processing time up to 2x. Timeout rows are shown as greater than the configured timeout value."
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
const RAW_STAGE_COLUMN_IDS = new Set(columnIdsForGroup("experimental_raw"));
const SMOOTH_STAGE_COLUMN_IDS = new Set(columnIdsForGroup("experimental_smoothed"));
const TRADITIONAL_STAGE_COLUMN_IDS = new Set(columnIdsForGroup("traditional"));
const COLOR_STAGE_COLUMN_IDS = new Set(columnIdsForGroup("experimental_color"));
const PREVIEW_STAGE_COLUMN_IDS = new Set(columnIdsForGroup("previews_standard"));
const OCR_STAGE_COLUMN_IDS = new Set([...OCR_COLUMN_IDS, "image_ocr_dbnet_base64", "image_line_ocr_base64"]);

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

function updateDependentSettingsAvailability() {
    const locked = isAnalysisSettingsLocked();
    const lineEnabled = checkboxChecked("read-labels-input", false);
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

    if (settings.readLabels && checkboxChecked("mode-visual-comparison-input", false)) {
        addColumnIds(nextVisible, OCR_COLUMN_IDS);
    }

    visibleColumnIds = nextVisible;
    updateColumnPickerChecks();
    updateDependentSettingsAvailability();
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

function previewFetchUrl(data, previewType, size = "thumb") {
    if (!data?.session_id || !data?.row_id) return "";
    if (!data.preview_refs?.[previewType]?.available) return "";
    const params = new URLSearchParams({
        username: currentUsername,
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
        <details class="column-group column-depth-${depth}" open>
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
                    <label class="column-option" draggable="true" data-column-id="${column.id}">
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
            <details class="help-group help-depth-${depth}" open>
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

function refreshBatchOutputs(chartsContainer) {
    const anchor = captureBatchScrollAnchor();
    renderBulkTable();
    document.querySelectorAll("#bulk-table img.preview-img").forEach(img => {
        if (!img.complete) {
            img.addEventListener("load", () => restoreBatchScrollAnchor(anchor), { once: true });
            img.addEventListener("error", () => restoreBatchScrollAnchor(anchor), { once: true });
        }
    });
    rebuildHistograms(chartsContainer || document.getElementById("histograms-container"));
    restoreBatchScrollAnchor(anchor);
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
                    <span>${escapeHtml(column.label)}</span>
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
        return `
            <div class="result-card single-preview-card">
                <h3>${escapeHtml(column.label)}</h3>
                ${imageData
                    ? `<img src="data:image/jpeg;base64,${imageData}" class="preview-img single-preview-img">`
                    : thumbUrl
                        ? `<img src="${escapeHtml(thumbUrl)}" data-full-src="${escapeHtml(fullUrl || thumbUrl)}" class="preview-img single-preview-img">`
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

document.getElementById("single-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const file = document.getElementById("single-file").files[0];
    const status = document.getElementById("single-status");
    const resultDiv = document.getElementById("single-result");

    if (!requireFruitSelection(status)) {
        resultDiv.innerHTML = "";
        return;
    }

    status.innerText = "Processing...";
    resultDiv.innerHTML = "";

    try {
        const requestedPreviewIds = selectedPreviewIds();
        const data = await postImage(file, requestedPreviewIds, SINGLE_REQUEST_TIMEOUT_MS, 0, null, getAnalysisSettingsSnapshot());  // No retries for single images
        
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
        latestSingleData = null;
        latestSinglePreviewIds = [];
        status.innerText = `API request failed: ${err.message}`;
    }
});

let globalBatchResults = []; // Stores all row data for dynamic toggling
let activeBatch = null;
let batchRunCounter = 0;
const BATCH_PAUSE_MS = 500;
const BATCH_WARMUP_COUNT = 2;

setupColumnControls();
setupAnalysisSettingsControls();

function formatDuration(ms) {
    const elapsedSec = Math.floor(ms / 1000);
    const h = String(Math.floor(elapsedSec / 3600)).padStart(2, '0');
    const m = String(Math.floor((elapsedSec % 3600) / 60)).padStart(2, '0');
    const s = String(elapsedSec % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
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
        runStartedAt: null,
        timerInterval: null,
        abortController: null,
        running: false,
        finished: false,
        warmupComplete: false,
        stopRequested: false,
        stopReason: null
    };
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
    return batch.elapsedMs + runningMs;
}

function updateBatchTimer(batch) {
    const timerDiv = document.getElementById("batch-timer");
    if (!timerDiv || !batch) return;

    const elapsedMs = batchElapsedMs(batch);
    let etaStr = "Calculating...";
    if (batch.completed > 0 && batch.completed < batch.files.length) {
        const timePerImg = elapsedMs / batch.completed;
        etaStr = formatDuration(timePerImg * (batch.files.length - batch.completed));
    }
    timerDiv.style.display = "block";
    timerDiv.innerText = `Elapsed: ${formatDuration(elapsedMs)} | ETA: ${etaStr}`;
}

function updateBatchControls(batch) {
    const stopBtn = document.getElementById("stop-batch-btn");
    const resumeBtn = document.getElementById("resume-batch-btn");
    const downloadBtn = document.getElementById("download-csv-btn");
    if (!stopBtn || !resumeBtn || !downloadBtn) return;

    const ownsUi = isActiveBatch(batch);
    stopBtn.style.display = ownsUi && batch.running ? "inline-flex" : "none";
    resumeBtn.style.display = ownsUi && !batch.running && !batch.finished && batch.nextIndex < batch.files.length ? "inline-flex" : "none";
    downloadBtn.style.display = ownsUi && !batch.running && batch.successCount > 0 ? "inline-flex" : "none";
    updateAnalysisSettingsLock();
}

function isAnalysisSettingsLocked() {
    return Boolean(activeBatch && !activeBatch.finished && activeBatch.nextIndex < activeBatch.files.length);
}

function updateAnalysisSettingsLock() {
    const card = document.getElementById("analysis-settings-card");
    const fieldset = document.getElementById("analysis-settings-fieldset");
    const fruitSelect = document.getElementById("fruit-select");
    const locked = isAnalysisSettingsLocked();
    if (fieldset) fieldset.disabled = locked;
    if (fruitSelect) fruitSelect.disabled = locked;
    if (card) card.classList.toggle("settings-locked", locked);
    updateDependentSettingsAvailability();
}

function stopActiveBatch(reason = "stopped") {
    if (!activeBatch || !activeBatch.running) return;
    const batch = activeBatch;
    batch.stopRequested = true;
    batch.stopReason = reason;
    if (batch.abortController) {
        batch.abortController.abort();
    }
    if (reason === "replaced") {
        if (batch.timerInterval) {
            clearInterval(batch.timerInterval);
            batch.timerInterval = null;
        }
        batch.elapsedMs = batchElapsedMs(batch);
        batch.running = false;
        updateAnalysisSettingsLock();
        return;
    }
    updateBatchControls(batch);
}

function finishBatch(batch, mode) {
    if (!isActiveBatch(batch)) return;

    if (batch.timerInterval) {
        clearInterval(batch.timerInterval);
        batch.timerInterval = null;
    }
    batch.elapsedMs = batchElapsedMs(batch);
    batch.running = false;
    batch.runStartedAt = null;

    const status = document.getElementById("bulk-status");
    const timerDiv = document.getElementById("batch-timer");
    const chartsContainer = document.getElementById("histograms-container");
    const remaining = Math.max(batch.files.length - batch.nextIndex, 0);
    const excludedText = "";

    if (timerDiv) {
        timerDiv.style.display = "block";
        timerDiv.innerText = `Total Time: ${formatDuration(batch.elapsedMs)}`;
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
    rebuildHistograms(chartsContainer);
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

function addBatchRetrying(file) {
    const data = {
        filename: file.name,
        warnings: [BULK_RETRY_MESSAGE],
        processing_ms: BULK_REQUEST_TIMEOUT_MS + 1,
        processing_ms_timeout: true
    };
    globalBatchResults.push({
        file_name: file.name,
        data,
        included: false,
        isCm: false,
        allowPixelMetrics: true,
        digits: 0,
        notes: BULK_RETRY_MESSAGE,
        success: false,
        retrying: true,
        includeFailedMetrics: true,
        message: BULK_RETRY_MESSAGE
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
    const msg = isTimeout ? BULK_TIMEOUT_MESSAGE : `API Error: ${err.message}`;
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

    if (isPreviewColumnId(columnId)) {
        return !(item.data?.[columnId] || item.data?.preview_refs?.[columnId]?.available);
    }

    if (columnId === "processing_ms") return false;
    return !itemCompletedStages(item).has(stage);
}

function missingColumnsForItem(item, batch, columnIds) {
    return columnIds.filter(id => itemNeedsColumn(item, id, batch));
}

async function postBatchStage(rowIds, requestedColumnIds, batch) {
    const response = await fetch(batchStageUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            password: currentPassword,
            username: currentUsername,
            session_id: batch.sessionId || currentSessionId,
            row_ids: rowIds,
            requested_columns: requestedColumnIds,
            settings: batch.settings || getAnalysisSettingsSnapshot()
        })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
        throw new Error(data.message || `HTTP ${response.status}`);
    }
    return data;
}

function mergeStagePatch(rowPatch) {
    const rowId = rowPatch?.row_id;
    if (!rowId) return;
    const item = globalBatchResults.find(candidate => candidate.data?.row_id === rowId);
    if (!item) return;

    item.data = { ...(item.data || {}), ...rowPatch };
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
}

function scheduleMissingStageRequest() {
    if (!activeBatch || globalBatchResults.length === 0) return;
    clearTimeout(missingStageTimer);
    missingStageTimer = setTimeout(runMissingStageRequest, 150);
}

async function runMissingStageRequest() {
    if (missingStageInFlight) {
        missingStageQueued = true;
        return;
    }
    const batch = activeBatch;
    if (!batch) return;

    const requestedIds = selectedColumnIdsForRequest();
    const entries = globalBatchResults
        .map(item => ({ item, missing: missingColumnsForItem(item, batch, requestedIds) }))
        .filter(entry => entry.missing.length > 0);
    if (entries.length === 0) return;

    missingStageInFlight = true;
    entries.forEach(({ item, missing }) => {
        item.pendingColumnIds = new Set([...(item.pendingColumnIds || []), ...missing]);
        item.pendingStages = new Set([...(item.pendingStages || []), ...missing.map(stageForColumnId).filter(Boolean)]);
    });
    refreshBatchOutputs(document.getElementById("histograms-container"));

    try {
        const chunkSize = 4;
        for (let i = 0; i < entries.length; i += chunkSize) {
            const chunk = entries.slice(i, i + chunkSize);
            try {
                const rowIds = chunk.map(entry => entry.item.data.row_id);
                const response = await postBatchStage(rowIds, requestedIds, batch);
                (response.rows || []).forEach(mergeStagePatch);
                chunk.forEach(({ item }) => {
                    item.pendingColumnIds = new Set();
                    item.pendingStages = new Set();
                    markUnavailableMissingColumns(item, requestedIds);
                });
            } catch (err) {
                chunk.forEach(({ item }) => {
                    item.pendingColumnIds = new Set();
                    item.pendingStages = new Set();
                    const warnings = Array.isArray(item.data?.warnings) ? item.data.warnings : [];
                    item.data = {
                        ...(item.data || {}),
                        warnings: [...warnings, `On-demand stage request failed: ${err.message}`]
                    };
                    item.notes = rowNotes(item.data);
                });
            }
            refreshBatchOutputs(document.getElementById("histograms-container"));
        }
    } finally {
        missingStageInFlight = false;
        refreshBatchOutputs(document.getElementById("histograms-container"));
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
            <th>Include</th>
            <th>Filename</th>
            <th class="processing-log-cell">
                <span class="column-title-wrap">
                    <span>Processing Log</span>
                    <span class="column-help-icon" title="Warnings and errors produced while processing this image. If no warnings or errors were reported, this shows N/A.">?</span>
                </span>
            </th>
            ${visibleColumns().map(column => `
                <th class="draggable-column-header" draggable="true" data-column-id="${column.id}">
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

function renderBulkTable() {
    const table = document.getElementById("bulk-table");
    const tbody = table.querySelector("tbody");
    const columns = visibleColumns();

    renderTableHeader();
    tbody.innerHTML = "";

    globalBatchResults.forEach((item, idx) => {
        const tr = document.createElement("tr");
        tr.dataset.rowIndex = String(idx);
        if (item.success) {
            if (!item.included) tr.classList.add("excluded-row");
            tr.innerHTML = `
                <td><input type="checkbox" ${item.included ? "checked" : ""} class="toggle-checkbox" data-idx="${idx}"></td>
                <td>${escapeHtml(item.data?.filename || item.file_name)}
                    ${warningBadge(item.notes)}
                </td>
                ${renderProcessingLogCell(item)}
                ${columns.map(column => `<td class="${escapeHtml(column.cellClass || "")}">${renderCell(column, item)}</td>`).join("")}
            `;
        } else if (item.retrying) {
            tr.classList.add("retry-row");
            tr.innerHTML = `
                <td>-</td>
                <td>${escapeHtml(item.file_name)}${warningBadge(item.notes)}</td>
                ${renderProcessingLogCell(item)}
                ${columns.map(column => `<td class="${escapeHtml(column.cellClass || "")}">${renderCell(column, item)}</td>`).join("")}
            `;
        } else {
            if (!item.included) tr.classList.add("excluded-row");
            const includeCell = item.includeFailedMetrics
                ? `<input type="checkbox" ${item.included ? "checked" : ""} class="toggle-checkbox" data-idx="${idx}">`
                : "-";
            tr.innerHTML = `
                <td>${includeCell}</td>
                <td>${escapeHtml(item.file_name)}${warningBadge(item.notes)}</td>
                ${renderProcessingLogCell(item)}
                ${columns.map(column => `<td class="${escapeHtml(column.cellClass || "")}" style="color:${item.includeFailedMetrics ? "inherit" : "red"};">${renderCell(column, item)}</td>`).join("")}
            `;
        }
        tbody.appendChild(tr);
    });
}

async function warmUpBatch(batch, status) {
    if (batch.warmupComplete || batch.nextIndex !== 0 || batch.files.length === 0) return;

    const warmupCount = Math.min(BATCH_WARMUP_COUNT, batch.files.length);
    for (let i = 0; i < warmupCount; i++) {
        if (!isActiveBatch(batch) || batch.stopRequested) break;

        const file = batch.files[i];
        status.innerText = `Warming up server (${i + 1}/${warmupCount})... (Won't take more than 80 seconds)`;
        batch.abortController = new AbortController();

        try {
            const previewIds = selectedPreviewIds();
            const runLineOcr = batch.requestLineOcr || shouldRequestLineOcr(previewIds, batch.settings);
            await postBulkImage(file, previewIds, batch.abortController.signal, batch.settings, runLineOcr);
        } catch (err) {
            if (!isActiveBatch(batch)) return;
            if (batch.stopRequested || err.message === "Batch stopped") break;
            console.warn(`Warmup request ignored for ${file.name}: ${err.message}`);
        } finally {
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

    if (batch.timerInterval) clearInterval(batch.timerInterval);
    batch.timerInterval = setInterval(() => {
        if (isActiveBatch(batch) && batch.running) updateBatchTimer(batch);
    }, 1000);

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
        try {
            const data = await postBulkImage(file, previewIds, batch.abortController.signal, batch.settings, runLineOcr, rowId);
            batch.abortController = null;
            if (!isActiveBatch(batch)) return;
            if (batch.stopRequested) break;
            addBatchResult(batch, file, data);
        } catch (err) {
            batch.abortController = null;
            if (!isActiveBatch(batch)) return;
            if (batch.stopRequested || err.message === "Batch stopped") break;

            if (!isBulkTimeoutError(err)) {
                addBatchFailure(batch, file, err);
            } else {
                const retryIndex = addBatchRetrying(file);
                status.innerText = `Image ${index + 1} of ${batch.files.length}: ${BULK_RETRY_MESSAGE}`;
                refreshBatchOutputs(chartsContainer);

                if (batch.stopRequested) {
                    removeBatchPlaceholder(retryIndex);
                    refreshBatchOutputs(chartsContainer);
                    break;
                }

                batch.abortController = new AbortController();
                try {
                    const retryData = await postBulkImage(file, previewIds, batch.abortController.signal, batch.settings, runLineOcr, rowId);
                    batch.abortController = null;
                    if (!isActiveBatch(batch)) return;
                    if (batch.stopRequested) {
                        removeBatchPlaceholder(retryIndex);
                        refreshBatchOutputs(chartsContainer);
                        break;
                    }
                    addBatchResult(batch, file, retryData, retryIndex);
                } catch (retryErr) {
                    batch.abortController = null;
                    if (!isActiveBatch(batch)) return;
                    if (batch.stopRequested || retryErr.message === "Batch stopped") {
                        removeBatchPlaceholder(retryIndex);
                        refreshBatchOutputs(chartsContainer);
                        break;
                    }
                    addBatchFailure(batch, file, retryErr, retryIndex);
                }
            }
        }

        batch.completed++;
        batch.nextIndex = index + 1;
        refreshBatchOutputs(chartsContainer);

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
    if (!requireFruitSelection(status)) return;

    stopActiveBatch("replaced");

    const table = document.getElementById("bulk-table");
    const chartsContainer = document.getElementById("histograms-container");
    const timerDiv = document.getElementById("batch-timer");
    const batchSettings = getAnalysisSettingsSnapshot();
    const batch = makeBatchState(files, batchSettings, shouldRequestLineOcr(selectedPreviewIds(), batchSettings));
    activeBatch = batch;
    updateAnalysisSettingsLock();

    chartsContainer.innerHTML = "";
    table.style.display = "table";
    document.getElementById("bulk-section").classList.add("bulk-card");
    if (timerDiv) {
        timerDiv.style.display = "block";
        timerDiv.innerText = "Elapsed: 00:00:00 | ETA: Calculating...";
    }

    globalBatchResults = [];
    renderBulkTable();
    await runBatch(batch);
});

document.getElementById("stop-batch-btn").addEventListener("click", () => {
    stopActiveBatch("stopped");
});

document.getElementById("resume-batch-btn").addEventListener("click", async () => {
    if (!activeBatch || activeBatch.running || activeBatch.finished) return;
    await runBatch(activeBatch);
});

// --- ROW TOGGLE LISTENER ---
// Listen to the table body. If a checkbox is clicked, update state and instantly rebuild histograms.
document.querySelector("#bulk-table tbody").addEventListener("change", (e) => {
    if (e.target.classList.contains("toggle-checkbox")) {
        const idx = e.target.getAttribute("data-idx");
        const tr = e.target.closest("tr");
        
        globalBatchResults[idx].included = e.target.checked;
        if (e.target.checked) {
            tr.classList.remove("excluded-row");
        } else {
            tr.classList.add("excluded-row");
        }
        
        // Dynamically update the charts
        rebuildHistograms(document.getElementById("histograms-container"));
    }
});

// --- DYNAMIC HISTOGRAM BUILDER ---
function rebuildHistograms(container) {
    applyMetricColumnUnitLabels();
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

        new Chart(canvas, {
            type: "bar",
            data: {
                labels: labels,
                datasets: [{ label: title, data: counts, backgroundColor: "rgba(54, 162, 235, 0.6)", borderColor: "rgba(54, 162, 235, 1)", borderWidth: 1 }]
            },
            options: chartOptions
        });
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

// Listen for clicks on ANY image with the 'preview-img' class
document.body.addEventListener("click", (e) => {
    if (e.target && e.target.classList.contains("preview-img")) {
        lightbox.style.display = "flex";
        lightboxImg.src = e.target.dataset.fullSrc || e.target.src;
    }
});

// Close when clicking the X
lightboxClose.addEventListener("click", () => {
    lightbox.style.display = "none";
    lightboxImg.src = "";
});

// Close when clicking the dark background outside the image
lightbox.addEventListener("click", (e) => {
    if (e.target === lightbox) {
        lightbox.style.display = "none";
        lightboxImg.src = "";
    }
});

function clearPreviewSessionBeacon() {
    if (!currentSessionId) return;
    const payload = JSON.stringify({
        session_id: currentSessionId,
        username: currentUsername
    });
    const blob = new Blob([payload], { type: "application/json" });
    navigator.sendBeacon?.(clearSessionUrl(), blob);
}

window.addEventListener("pagehide", clearPreviewSessionBeacon);

// --- LIVE QUEUE POLLING ---
function startQueuePolling() {
    const baseUrl = API_URL.split("/proxy_process")[0];
    
    setInterval(async () => {
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
            
            if (active < max) {
                statusDiv.innerHTML = `Server Ready | <strong>${envName}</strong> (Cores in use: ${active}/${max})`;
                statusDiv.style.color = "#155724";
                statusDiv.style.backgroundColor = "#d4edda";
            } else {
                const queued = active - max;
                statusDiv.innerHTML = `Processing | <strong>${envName}</strong> (Cores in use: ${max}/${max}) - ${queued} in queue`;
                statusDiv.style.color = "#856404";
                statusDiv.style.backgroundColor = "#fff3cd";
            }
        } catch (err) {
            // Silently ignore network blips during polling
        }
    }, 2000); 
}
