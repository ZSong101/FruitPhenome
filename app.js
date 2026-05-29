// For local testing, change to http://localhost:8000/process_single
//let API_URL = "https://crabbly-watermelonphenotyping.hf.space/process_single";
//let API_URL = "https://fruit-proxy-cv71.onrender.com/proxy_process";
let API_URL = "https://PPAL-SongLab-UGA-watermelon-proxy.hf.space/proxy_process";

const SINGLE_REQUEST_TIMEOUT_MS = 120000; // 2 minutes
const BULK_REQUEST_TIMEOUT_MS = 40000;
const BULK_TIMEOUT_MESSAGE = "Taking longer than 40 seconds. Moving on.";
const TARGET_HASH = "9139eb3676d5dfafced7613f044d86d9e7c84f40a04c83ddce062878621315d0";

let currentPassword = ""; // Stores the password in memory after a successful login
let currentUsername = ""; // Stores user identity

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

setLastUpdatedStamp();

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

function shouldRequestLineOcr(previewIds = [], settings = null) {
    return previewIds.includes("image_line_ocr_base64")
        || previewIds.includes("image_ocr_dbnet_base64")
        || hasLineOptionList(settings || getAnalysisSettingsSnapshot())
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

function sliderNumber(id, fallback) {
    const el = document.getElementById(id);
    const value = Number(el?.value);
    return Number.isFinite(value) ? value : fallback;
}

function getAnalysisSettingsSnapshot() {
    return {
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
}

async function postImage(file, previewIds = [], timeoutMs = SINGLE_REQUEST_TIMEOUT_MS, maxRetries = 1, externalSignal = null, settings = null, includeLineOcr = null) {
    const requestSettings = settings || getAnalysisSettingsSnapshot();
    const runLineOcr = includeLineOcr ?? shouldRequestLineOcr(previewIds, requestSettings);
    const formData = new FormData();
    formData.append("password", currentPassword);
    formData.append("username", currentUsername); 
    formData.append("file", file);
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

async function postBulkImage(file, previewIds, externalSignal = null, settings = null, includeLineOcr = null) {
    // 40 second timeout, no retry; the batch moves on promptly.
    return postImage(file, previewIds, BULK_REQUEST_TIMEOUT_MS, 0, externalSignal, settings, includeLineOcr);
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

function cmMetricColumn(id, label, field, digits = (item) => item.digits, options = {}) {
    return metricColumn(id, label, field, digits, {
        ...options,
        get: (data, item) => item.isCm ? valueOrNull(data[field]) : null
    });
}

function previewColumn(id, label, field) {
    return {
        id,
        label,
        histogram: false,
        csv: false,
        get: () => null,
        html: (item) => item.data?.[field]
            ? `<img src="data:image/jpeg;base64,${item.data[field]}" class="thumb preview-img">`
            : `<span class="muted">-</span>`
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
                    cmMetricColumn("raw_width", "Width (Cleanup, cm)", "raw_width", undefined, { histLabel: "Width - Cleanup (cm)" }),
                    cmMetricColumn("raw_height", "Height (Cleanup, cm)", "raw_height", undefined, { histLabel: "Height - Cleanup (cm)" }),
                    cmMetricColumn("raw_perimeter", "Perim (Cleanup, cm)", "raw_perimeter", undefined, { histLabel: "Perim - Cleanup (cm)" }),
                    cmMetricColumn("raw_flesh_width", "F.Width (Cleanup, cm)", "raw_flesh_width", undefined, { histLabel: "F.Width - Cleanup (cm)" }),
                    cmMetricColumn("raw_flesh_height", "F.Height (Cleanup, cm)", "raw_flesh_height", undefined, { histLabel: "F.Height - Cleanup (cm)" }),
                    cmMetricColumn("raw_flesh_perimeter", "F.Perim (Cleanup, cm)", "raw_flesh_perimeter", undefined, { histLabel: "F.Perim - Cleanup (cm)" }),
                    cmMetricColumn("raw_rind_thick", "Rind Thick (Cleanup, cm)", "raw_rind_thick", undefined, { histLabel: "Rind Thick - Cleanup (cm)" }),
                    metricColumn("raw_rind_ratio", "Rind Ratio (Cleanup)", "raw_rind_ratio", 3, { histLabel: "Rind Ratio - Cleanup" }),
                    cmMetricColumn("raw_total_area", "Tot Area (Cleanup, cm²)", "raw_total_area", undefined, { histLabel: "Total Area - Cleanup (cm²)" }),
                    cmMetricColumn("raw_flesh_area", "Flesh Area (Cleanup, cm²)", "raw_flesh_area", undefined, { histLabel: "Flesh Area - Cleanup (cm²)" }),
                    metricColumn("raw_flesh_ratio", "Flesh Rat (Cleanup)", "raw_flesh_ratio", 3, { histLabel: "Flesh Ratio - Cleanup" }),
                    metricColumn("raw_elongation", "Elong (Cleanup)", "raw_elongation", 3, { histLabel: "Elongation - Cleanup" }),
                    metricColumn("raw_asym", "Asym (Cleanup)", "raw_asym", 3, { histLabel: "Asymmetry - Cleanup" }),
                    metricColumn("raw_flesh_asym", "F.Asym (Cleanup)", "raw_flesh_asym", 3, { histLabel: "Flesh Asym - Cleanup" }),
                    metricColumn("raw_circ", "Circ (Cleanup)", "raw_circ", 3, { histLabel: "Circularity - Cleanup" })
                ]
            },
            {
                id: "experimental_smoothed",
                label: "Smoothed Features",
                columns: [
                    metricColumn("r2_rind", "R² Rind", "r2_rind", 4, { csvLabel: "R2 Rind" }),
                    metricColumn("r2_flesh", "R² Flesh", "r2_flesh", 4, { csvLabel: "R2 Flesh" }),
                    cmMetricColumn("sm_width", "Width (Sm, cm)", "sm_width", undefined, { histLabel: "Width - Sm (cm)" }),
                    cmMetricColumn("sm_height", "Height (Sm, cm)", "sm_height", undefined, { histLabel: "Height - Sm (cm)" }),
                    cmMetricColumn("sm_perimeter", "Perim (Sm, cm)", "sm_perimeter", undefined, { histLabel: "Perim - Sm (cm)" }),
                    cmMetricColumn("sm_flesh_width", "F.Width (Sm, cm)", "sm_flesh_width", undefined, { histLabel: "F.Width - Sm (cm)" }),
                    cmMetricColumn("sm_flesh_height", "F.Height (Sm, cm)", "sm_flesh_height", undefined, { histLabel: "F.Height - Sm (cm)" }),
                    cmMetricColumn("sm_flesh_perimeter", "F.Perim (Sm, cm)", "sm_flesh_perimeter", undefined, { histLabel: "F.Perim - Sm (cm)" }),
                    cmMetricColumn("sm_rind_thick", "Rind Thick (Sm, cm)", "sm_rind_thick", undefined, { histLabel: "Rind Thick - Sm (cm)" }),
                    metricColumn("sm_rind_ratio", "Rind Ratio (Sm)", "sm_rind_ratio", 3, { histLabel: "Rind Ratio - Sm" }),
                    cmMetricColumn("sm_total_area", "Tot Area (Sm, cm²)", "sm_total_area", undefined, { histLabel: "Total Area - Sm (cm²)" }),
                    cmMetricColumn("sm_flesh_area", "Flesh Area (Sm, cm²)", "sm_flesh_area", undefined, { histLabel: "Flesh Area - Sm (cm²)" }),
                    metricColumn("sm_flesh_ratio", "Flesh Rat (Sm)", "sm_flesh_ratio", 3, { histLabel: "Flesh Ratio - Sm" }),
                    metricColumn("sm_elongation", "Elong (Sm)", "sm_elongation", 3, { histLabel: "Elongation - Sm" }),
                    metricColumn("sm_asym", "Asym (Sm)", "sm_asym", 3, { histLabel: "Asymmetry - Sm" }),
                    metricColumn("sm_flesh_asym", "F.Asym (Sm)", "sm_flesh_asym", 3, { histLabel: "Flesh Asym - Sm" }),
                    metricColumn("sm_circ", "Circ (Sm)", "sm_circ", 3, { histLabel: "Circularity - Sm" }),
                    metricColumn("midline_curvature", "Midline Curve", "midline_curvature", 4)
                ]
            },
            {
                id: "experimental_color",
                label: "Color Calibration",
                columns: [
                    metricColumn("delta_e_initial", "Init ΔE", "delta_e_initial", 2, { histLabel: "Initial ΔE" }),
                    metricColumn("delta_e_final", "Final ΔE", "delta_e_final", 2, { histLabel: "Final ΔE" })
                ]
            }
        ]
    },
    {
        id: "traditional",
        label: "Traditional",
        children: [
            {
                id: "traditional_shape_index",
                label: "Shape Index",
                columns: [
                    metricColumn("trad_shape_index_i", "fs I H/W", "trad_shape_index_i", 3),
                    metricColumn("trad_shape_index_ii", "fs II Hm/Wm", "trad_shape_index_ii", 3),
                    metricColumn("trad_triangle", "Triangle w1/w2", "trad_triangle", 3)
                ]
            },
            {
                id: "traditional_eccentric",
                label: "Eccentricity & Asymmetry",
                columns: [
                    metricColumn("trad_obovoid", "Obovoid", "trad_obovoid", 3),
                    metricColumn("trad_ovoid", "Ovoid", "trad_ovoid", 3),
                    metricColumn("trad_horizontal_asymmetry", "Horiz Asym", "trad_horizontal_asymmetry", 4),
                    metricColumn("trad_vertical_asymmetry", "Vert Asym", "trad_vertical_asymmetry", 4)
                ]
            },
            {
                id: "traditional_end_shape",
                label: "End Shape",
                columns: [
                    metricColumn("trad_distal_angle", "Distal Angle (deg)", "trad_distal_angle", 1),
                    metricColumn("trad_distal_blockiness", "Distal Blockiness", "trad_distal_blockiness", 3),
                    metricColumn("trad_distal_indentation_area", "Distal Indent Area", "trad_distal_indentation_area", 4),
                    metricColumn("trad_proximal_angle", "Proximal Angle (deg)", "trad_proximal_angle", 1),
                    metricColumn("trad_proximal_blockiness", "Proximal Blockiness", "trad_proximal_blockiness", 3),
                    metricColumn("trad_proximal_shoulder_height", "Shoulder Height", "trad_proximal_shoulder_height", 4),
                    metricColumn("trad_proximal_indentation_area", "Proximal Indent Area", "trad_proximal_indentation_area", 4)
                ]
            },
            {
                id: "traditional_fit",
                label: "Common Shape Fit",
                columns: [
                    metricColumn("trad_circular_r2", "Circular R²", "trad_circular_r2", 4, { csvLabel: "Circular R2" }),
                    metricColumn("trad_ellipsoid_r2", "Ellipsoid R²", "trad_ellipsoid_r2", 4, { csvLabel: "Ellipsoid R2" }),
                    metricColumn("trad_taperness", "Heart Taperness", "trad_taperness", 3),
                    metricColumn("trad_heart", "Heart Score", "trad_heart", 3),
                    metricColumn("trad_rectangularity", "Rectangularity", "trad_rectangularity", 4)
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
                    previewColumn("image_traditional_base64", "Preview (Traditional)", "image_traditional_base64")
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
let columnOrderIds = loadColumnOrderIds();
let draggedColumnId = null;
let latestSingleData = null;
let latestSinglePreviewIds = [];

function loadColumnOrderIds() {
    const fallback = [...ALL_COLUMN_IDS];
    try {
        const parsed = JSON.parse(localStorage.getItem("watermelonColumnOrder") || "[]");
        if (!Array.isArray(parsed)) return fallback;
        const saved = parsed.filter(id => ALL_COLUMN_IDS.includes(id));
        const missing = ALL_COLUMN_IDS.filter(id => !saved.includes(id));
        return [...saved, ...missing];
    } catch (err) {
        return fallback;
    }
}

function saveColumnOrderIds() {
    try {
        localStorage.setItem("watermelonColumnOrder", JSON.stringify(columnOrderIds));
    } catch (err) {
        // Non-critical: column order still works for the current session.
    }
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
    saveColumnOrderIds();
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
        syncVisibleOutputs();
    }
}

function handleColumnDragEnd() {
    draggedColumnId = null;
    clearColumnDragState();
}

function setupColumnDragAndDrop() {
    const containers = [
        document.getElementById("column-menu"),
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

function renderColumnPicker() {
    const menu = document.getElementById("column-menu");
    if (!menu) return;

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
                    </label>
                    `).join("")}
                </div>` : ""}
            </div>
        </details>
    `;

    menu.innerHTML = COLUMN_GROUPS.map(group => renderGroup(group)).join("");

    updateColumnPickerChecks();
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

    const doc = document.documentElement;
    const scrollHeight = Math.max(doc.scrollHeight, document.body.scrollHeight);
    const viewportBottom = window.scrollY + window.innerHeight;
    const tableRect = table.getBoundingClientRect();
    const tableTop = window.scrollY + tableRect.top;
    const tableBottom = window.scrollY + tableRect.bottom;
    const bottomOffset = scrollHeight - viewportBottom;
    const nearPageBottom = bottomOffset < 180;
    const aboveTable = window.scrollY < tableTop - 20;
    const alreadyBelowTable = window.scrollY > tableBottom - 20;

    if (nearPageBottom) {
        return {
            active: true,
            mode: "page-bottom",
            bottomOffset: Math.max(0, bottomOffset)
        };
    }

    return {
        active: aboveTable || nearPageBottom || alreadyBelowTable,
        mode: aboveTable ? "fixed" : "bottom",
        scrollY: window.scrollY,
        scrollHeight
    };
}

function restoreBatchScrollAnchor(anchor) {
    if (!anchor?.active) return;
    const apply = () => {
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
        const doc = document.documentElement;
        const nextScrollHeight = Math.max(doc.scrollHeight, document.body.scrollHeight);
        const heightDelta = nextScrollHeight - anchor.scrollHeight;
        if (heightDelta !== 0) {
            window.scrollTo({ top: Math.max(0, anchor.scrollY + heightDelta), behavior: "auto" });
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
    refreshBatchOutputs(document.getElementById("histograms-container"));
    renderCurrentSingleAnalysis();
}

function setupColumnControls() {
    renderColumnPicker();

    const button = document.getElementById("column-menu-button");
    const panel = document.getElementById("column-menu-panel");
    if (button && panel) {
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
    }

    document.getElementById("column-menu")?.addEventListener("change", (event) => {
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

        updateColumnPickerChecks();
        syncVisibleOutputs();
    });

    setupColumnDragAndDrop();
}

setupColumnControls();
setupAnalysisSettingsControls();

function renderSingleMetricCard(title, columns, item) {
    const metricColumns = columns.filter(column => !column.html);
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
        return `
            <div class="result-card single-preview-card">
                <h3>${escapeHtml(column.label)}</h3>
                ${imageData
                    ? `<img src="data:image/jpeg;base64,${imageData}" class="preview-img single-preview-img">`
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

    return `
        ${metricCards}
        ${renderSinglePreviewCards(data, previewIds)}
    `;
}

function renderCurrentSingleAnalysis() {
    if (!latestSingleData?.success) return;
    const resultDiv = document.getElementById("single-result");
    if (!resultDiv) return;
    const previewIds = selectedPreviewIds().filter(id => latestSinglePreviewIds.includes(id));
    resultDiv.innerHTML = renderSingleAnalysis(latestSingleData, previewIds);
}

document.getElementById("single-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const file = document.getElementById("single-file").files[0];
    const status = document.getElementById("single-status");
    const resultDiv = document.getElementById("single-result");

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
            latestSingleData = null;
            latestSinglePreviewIds = [];
            const notes = rowNotes(data);
            status.innerText = `Error: ${data.message}`;
            resultDiv.innerHTML = notes ? `<p><strong>Notes:</strong> ${escapeHtml(notes)}</p>` : "";
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

function formatDuration(ms) {
    const elapsedSec = Math.floor(ms / 1000);
    const m = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
    const s = String(elapsedSec % 60).padStart(2, '0');
    return `${m}:${s}`;
}

function makeBatchState(files, settings, requestLineOcr) {
    return {
        id: ++batchRunCounter,
        files: Array.from(files),
        settings,
        requestLineOcr,
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
        stopRequested: false,
        stopReason: null
    };
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
    stopBtn.style.display = ownsUi && batch.running ? "inline-block" : "none";
    resumeBtn.style.display = ownsUi && !batch.running && !batch.finished && batch.nextIndex < batch.files.length ? "inline-block" : "none";
    downloadBtn.style.display = ownsUi && !batch.running && batch.successCount > 0 ? "inline-block" : "none";
    updateAnalysisSettingsLock();
}

function isAnalysisSettingsLocked() {
    return Boolean(activeBatch && !activeBatch.finished && activeBatch.nextIndex < activeBatch.files.length);
}

function updateAnalysisSettingsLock() {
    const card = document.getElementById("analysis-settings-card");
    const fieldset = document.getElementById("analysis-settings-fieldset");
    const locked = isAnalysisSettingsLocked();
    if (fieldset) fieldset.disabled = locked;
    if (card) card.classList.toggle("settings-locked", locked);
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

function addBatchResult(batch, file, data) {
    if (data.success) {
        batch.successCount++;
        const isCm = measurementUnit(data) === "cm";
        const digits = isCm ? 1 : 0;
        const notes = rowNotes(data);
        if (!isCm) batch.pixelScaleCount++;

        globalBatchResults.push({ file_name: file.name, data, included: true, isCm, digits, notes, success: true });
    } else {
        batch.failureCount++;
        const msg = `Error: ${data.message || "Unknown error"}`;
        globalBatchResults.push({
            file_name: file.name,
            data: {
                filename: file.name,
                warnings: [msg],
                processing_ms: null,
                processing_ms_timeout: false
            },
            included: false,
            isCm: false,
            allowPixelMetrics: false,
            digits: 0,
            notes: msg,
            success: false,
            includeFailedMetrics: false,
            message: msg
        });
    }
}

function addBatchFailure(batch, file, err) {
    batch.failureCount++;
    const isTimeout = err.message === BULK_TIMEOUT_MESSAGE;
    const msg = isTimeout ? BULK_TIMEOUT_MESSAGE : `API Error: ${err.message}`;
    const data = {
        filename: file.name,
        warnings: [msg],
        processing_ms: isTimeout ? BULK_REQUEST_TIMEOUT_MS + 1 : null,
        processing_ms_timeout: isTimeout
    };
    globalBatchResults.push({
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
    });
}

function renderTableHeader() {
    const table = document.getElementById("bulk-table");
    const thead = table.querySelector("thead");
    thead.innerHTML = `
        <tr>
            <th>Include</th>
            <th>Filename</th>
            ${visibleColumns().map(column => `<th class="draggable-column-header" draggable="true" data-column-id="${column.id}">${escapeHtml(column.label)}</th>`).join("")}
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
        if (item.success) {
            if (!item.included) tr.classList.add("excluded-row");
            tr.innerHTML = `
                <td><input type="checkbox" ${item.included ? "checked" : ""} class="toggle-checkbox" data-idx="${idx}"></td>
                <td>${escapeHtml(item.data?.filename || item.file_name)}
                    ${item.notes ? `<span title="${escapeHtml(item.notes)}" style="display:inline-block; width:18px; height:18px; background:#ffc107; color:#000; border-radius:50%; text-align:center; line-height:18px; font-weight:bold; cursor:help; margin-left:5px; font-size:12px;">!</span>` : ""}
                </td>
                ${columns.map(column => `<td class="${escapeHtml(column.cellClass || "")}">${renderCell(column, item)}</td>`).join("")}
            `;
        } else {
            if (!item.included) tr.classList.add("excluded-row");
            const includeCell = item.includeFailedMetrics
                ? `<input type="checkbox" ${item.included ? "checked" : ""} class="toggle-checkbox" data-idx="${idx}">`
                : "-";
            tr.innerHTML = `
                <td>${includeCell}</td>
                <td>${escapeHtml(item.file_name)}
                    <span style="color:red; margin-left:6px;">${escapeHtml(item.message)}</span>
                </td>
                ${columns.map(column => `<td class="${escapeHtml(column.cellClass || "")}" style="color:${item.includeFailedMetrics ? "inherit" : "red"};">${renderCell(column, item)}</td>`).join("")}
            `;
        }
        tbody.appendChild(tr);
    });
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

    while (batch.nextIndex < batch.files.length) {
        if (!isActiveBatch(batch) || batch.stopRequested) break;

        const index = batch.nextIndex;
        const file = batch.files[index];
        status.innerText = `${batch.completed > 0 ? "Processing" : "Starting"} image ${index + 1} of ${batch.files.length}...`;

        batch.abortController = new AbortController();
        try {
            const previewIds = selectedPreviewIds();
            const runLineOcr = batch.requestLineOcr || shouldRequestLineOcr(previewIds, batch.settings);
            const data = await postBulkImage(file, previewIds, batch.abortController.signal, batch.settings, runLineOcr);
            batch.abortController = null;
            if (!isActiveBatch(batch)) return;
            if (batch.stopRequested) break;
            addBatchResult(batch, file, data);
        } catch (err) {
            batch.abortController = null;
            if (!isActiveBatch(batch)) return;
            if (batch.stopRequested || err.message === "Batch stopped") break;
            addBatchFailure(batch, file, err);
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
        timerDiv.innerText = "Elapsed: 00:00 | ETA: Calculating...";
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
    const columns = visibleColumns().filter(column => column.csv !== false);
    const header = ["Filename", ...columns.map(column => column.csvLabel || column.label)];
    const rows = [header.map(csvEscape).join(",")];

    globalBatchResults.forEach(item => {
        if (!item.included || (!item.success && !item.includeFailedMetrics)) return;
        const values = [item.data.filename || item.file_name];
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
        lightboxImg.src = e.target.src;
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
