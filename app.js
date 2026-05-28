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

function processUrl(previewIds = []) {
    const params = new URLSearchParams();
    params.set("include_image", previewIds.length > 0 ? "true" : "false");
    if (previewIds.length > 0) params.set("preview_types", previewIds.join(","));
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
    return data.delta_e_final !== null && data.delta_e_final !== undefined ? "cm" : "px";
}

function areaUnit(data) {
    if (data.area_unit === "cm2") return "cm²";
    if (data.area_unit === "px2") return "px²";
    return measurementUnit(data) === "cm" ? "cm²" : "px²";
}

function rowNotes(data) {
    const notes =[];
    if (Array.isArray(data.warnings)) notes.push(...data.warnings);
    if (data.rind_source && data.rind_source !== "whole_mask_overlap") {
        notes.push(`rind: ${data.rind_source}`);
    }
    return notes.join(" | ");
}

async function postImage(file, previewIds = [], timeoutMs = SINGLE_REQUEST_TIMEOUT_MS, maxRetries = 1) {
    const formData = new FormData();
    formData.append("password", currentPassword);
    formData.append("username", currentUsername); 
    formData.append("file", file);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
            // Strict timeout wrapper
            const fetchPromise = fetch(processUrl(previewIds), {
                method: "POST",
                body: formData,
                signal: controller.signal
            });

            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error("Timeout")), timeoutMs)
            );

            const response = await Promise.race([fetchPromise, timeoutPromise]);
            clearTimeout(timeoutId);

            const text = await response.text();
            
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
            
            const isTimeout = err.name === "AbortError" || err.message === "Timeout";
            
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
        }
    }
}

async function postBulkImage(file, previewIds) {
    // 30 second timeout, 1 automatic retry if the server drops the connection
    return postImage(file, previewIds, BULK_REQUEST_TIMEOUT_MS, 1);
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
        csv: options.csv !== false,
        cellClass: options.cellClass || "",
        get: options.get || ((data) => valueOrNull(data[field]))
    };
}

function cmMetricColumn(id, label, field, digits = (item) => item.digits, options = {}) {
    return metricColumn(id, label, field, digits, {
        ...options,
        get: (data, item) => (item.isCm || item.allowPixelMetrics) ? valueOrNull(data[field]) : null
    });
}

function previewColumn(id, label, field) {
    return {
        id,
        label,
        histogram: false,
        csv: false,
        get: () => null,
        html: (item) => item.data[field]
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
                label: "Raw Features",
                columns: [
                    cmMetricColumn("raw_width", "Width (Raw)", "raw_width", undefined, { histLabel: "Width - Raw (cm)" }),
                    cmMetricColumn("raw_height", "Height (Raw)", "raw_height", undefined, { histLabel: "Height - Raw (cm)" }),
                    cmMetricColumn("raw_perimeter", "Perim (Raw)", "raw_perimeter", undefined, { histLabel: "Perim - Raw (cm)" }),
                    cmMetricColumn("raw_flesh_width", "F.Width (Raw)", "raw_flesh_width", undefined, { histLabel: "F.Width - Raw (cm)" }),
                    cmMetricColumn("raw_flesh_height", "F.Height (Raw)", "raw_flesh_height", undefined, { histLabel: "F.Height - Raw (cm)" }),
                    cmMetricColumn("raw_flesh_perimeter", "F.Perim (Raw)", "raw_flesh_perimeter", undefined, { histLabel: "F.Perim - Raw (cm)" }),
                    cmMetricColumn("raw_rind_thick", "Rind Thick (Raw)", "raw_rind_thick", undefined, { histLabel: "Rind Thick - Raw (cm)" }),
                    metricColumn("raw_rind_ratio", "Rind Ratio (Raw)", "raw_rind_ratio", 3, { histLabel: "Rind Ratio - Raw" }),
                    cmMetricColumn("raw_total_area", "Tot Area (Raw)", "raw_total_area", undefined, { histLabel: "Total Area - Raw (cm²)" }),
                    cmMetricColumn("raw_flesh_area", "Flesh Area (Raw)", "raw_flesh_area", undefined, { histLabel: "Flesh Area - Raw (cm²)" }),
                    metricColumn("raw_flesh_ratio", "Flesh Rat (Raw)", "raw_flesh_ratio", 3, { histLabel: "Flesh Ratio - Raw" }),
                    metricColumn("raw_elongation", "Elong (Raw)", "raw_elongation", 3, { histLabel: "Elongation - Raw" }),
                    metricColumn("raw_asym", "Asym (Raw)", "raw_asym", 3, { histLabel: "Asymmetry - Raw" }),
                    metricColumn("raw_flesh_asym", "F.Asym (Raw)", "raw_flesh_asym", 3, { histLabel: "Flesh Asym - Raw" }),
                    metricColumn("raw_circ", "Circ (Raw)", "raw_circ", 3, { histLabel: "Circularity - Raw" })
                ]
            },
            {
                id: "experimental_smoothed",
                label: "Smoothed Features",
                columns: [
                    metricColumn("r2_rind", "R² Rind", "r2_rind", 4, { csvLabel: "R2 Rind" }),
                    metricColumn("r2_flesh", "R² Flesh", "r2_flesh", 4, { csvLabel: "R2 Flesh" }),
                    cmMetricColumn("sm_width", "Width (Sm)", "sm_width", undefined, { histLabel: "Width - Sm (cm)" }),
                    cmMetricColumn("sm_height", "Height (Sm)", "sm_height", undefined, { histLabel: "Height - Sm (cm)" }),
                    cmMetricColumn("sm_perimeter", "Perim (Sm)", "sm_perimeter", undefined, { histLabel: "Perim - Sm (cm)" }),
                    cmMetricColumn("sm_flesh_width", "F.Width (Sm)", "sm_flesh_width", undefined, { histLabel: "F.Width - Sm (cm)" }),
                    cmMetricColumn("sm_flesh_height", "F.Height (Sm)", "sm_flesh_height", undefined, { histLabel: "F.Height - Sm (cm)" }),
                    cmMetricColumn("sm_flesh_perimeter", "F.Perim (Sm)", "sm_flesh_perimeter", undefined, { histLabel: "F.Perim - Sm (cm)" }),
                    cmMetricColumn("sm_rind_thick", "Rind Thick (Sm)", "sm_rind_thick", undefined, { histLabel: "Rind Thick - Sm (cm)" }),
                    metricColumn("sm_rind_ratio", "Rind Ratio (Sm)", "sm_rind_ratio", 3, { histLabel: "Rind Ratio - Sm" }),
                    cmMetricColumn("sm_total_area", "Tot Area (Sm)", "sm_total_area", undefined, { histLabel: "Total Area - Sm (cm²)" }),
                    cmMetricColumn("sm_flesh_area", "Flesh Area (Sm)", "sm_flesh_area", undefined, { histLabel: "Flesh Area - Sm (cm²)" }),
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
                    metricColumn("trad_distal_angle", "Distal Angle", "trad_distal_angle", 1),
                    metricColumn("trad_distal_blockiness", "Distal Blockiness", "trad_distal_blockiness", 3),
                    metricColumn("trad_distal_indentation_area", "Distal Indent Area", "trad_distal_indentation_area", 4),
                    metricColumn("trad_proximal_angle", "Proximal Angle", "trad_proximal_angle", 1),
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
                    previewColumn("image_pre_calibration_base64", "Preview (Pre-Cal)", "image_pre_calibration_base64"),
                    previewColumn("image_raw_base64", "Preview (Raw)", "image_raw_base64"),
                    previewColumn("image_sm_base64", "Preview (Smooth)", "image_sm_base64"),
                    previewColumn("image_traditional_base64", "Preview (Traditional)", "image_traditional_base64")
                ]
            },
            {
                id: "previews_cleanup",
                label: "Mask Cleanup Comparison",
                columns: [
                    previewColumn("image_cleanup_morph_base64", "Preview (Morph Cleanup)", "image_cleanup_morph_base64"),
                    previewColumn("image_cleanup_blur_base64", "Preview (Blur Cleanup)", "image_cleanup_blur_base64"),
                    previewColumn("image_cleanup_contour_base64", "Preview (Contour Cleanup)", "image_cleanup_contour_base64"),
                    previewColumn("image_cleanup_hybrid_base64", "Preview (Hybrid Cleanup)", "image_cleanup_hybrid_base64")
                ]
            }
        ]
    },
    {
        id: "run_info",
        label: "Run Info",
        columns: [
            metricColumn("processing_ms", "Time (ms)", "processing_ms", 0)
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
    return collectColumns(group);
}

const ALL_COLUMNS = COLUMN_GROUPS.flatMap(group => collectColumns(group));
const COLUMN_GROUP_MAP = collectGroups(COLUMN_GROUPS);
let visibleColumnIds = new Set(ALL_COLUMNS.map(column => column.id));

function visibleColumns() {
    return ALL_COLUMNS.filter(column => visibleColumnIds.has(column.id));
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
                    ${group.columns.map(column => `
                    <label class="column-option">
                        <input type="checkbox" class="column-checkbox" data-column-id="${column.id}">
                        ${escapeHtml(column.label)}
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

function syncVisibleOutputs() {
    renderBulkTable();
    rebuildHistograms(document.getElementById("histograms-container"));
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
}

setupColumnControls();

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
    const ownCard = group.columns ? renderSingleMetricCard(title, group.columns, item) : "";
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

document.getElementById("single-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const file = document.getElementById("single-file").files[0];
    const status = document.getElementById("single-status");
    const resultDiv = document.getElementById("single-result");

    status.innerText = "Processing...";
    resultDiv.innerHTML = "";

    try {
        const requestedPreviewIds = selectedPreviewIds();
        const data = await postImage(file, requestedPreviewIds, SINGLE_REQUEST_TIMEOUT_MS, 0);  // No retries for single images
        
        if (data.success) {
            status.innerText = "Success";

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
            const notes = rowNotes(data);
            status.innerText = `Error: ${data.message}`;
            resultDiv.innerHTML = notes ? `<p><strong>Notes:</strong> ${escapeHtml(notes)}</p>` : "";
        }
    } catch (err) {
        status.innerText = `API request failed: ${err.message}`;
    }
});

let globalBatchResults = []; // Stores all row data for dynamic toggling

function renderTableHeader() {
    const table = document.getElementById("bulk-table");
    const thead = table.querySelector("thead");
    thead.innerHTML = `
        <tr>
            <th>Include</th>
            <th>Filename</th>
            ${visibleColumns().map(column => `<th>${escapeHtml(column.label)}</th>`).join("")}
        </tr>
    `;
}

function renderCell(column, item) {
    if (column.html) {
        return column.html(item);
    }

    const value = columnValue(column, item);
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
                <td>${escapeHtml(item.data.filename || item.file_name)}
                    ${item.notes ? `<span title="${escapeHtml(item.notes)}" style="display:inline-block; width:18px; height:18px; background:#ffc107; color:#000; border-radius:50%; text-align:center; line-height:18px; font-weight:bold; cursor:help; margin-left:5px; font-size:12px;">!</span>` : ""}
                </td>
                ${columns.map(column => `<td class="${escapeHtml(column.cellClass || "")}">${renderCell(column, item)}</td>`).join("")}
            `;
        } else {
            tr.innerHTML = `
                <td>-</td>
                <td>${escapeHtml(item.file_name)}</td>
                <td colspan="${Math.max(columns.length, 1)}" style="color:red;">${escapeHtml(item.message)}</td>
            `;
        }
        tbody.appendChild(tr);
    });
}

document.getElementById("bulk-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const files = document.getElementById("bulk-files").files;
    const status = document.getElementById("bulk-status");
    const table = document.getElementById("bulk-table");
    const chartsContainer = document.getElementById("histograms-container");
    const downloadBtn = document.getElementById("download-csv-btn");

    chartsContainer.innerHTML = "";
    table.style.display = "table";
    document.getElementById("bulk-section").classList.add("bulk-card");
    downloadBtn.style.display = "none";

    // Reset global state
    globalBatchResults = [];
    renderBulkTable();
    let completed = 0, successCount = 0, failureCount = 0, pixelScaleCount = 0;
    
    // --- RESTORED TIMER INITIALIZATION ---
    const timerDiv = document.getElementById("batch-timer");
    if (timerDiv) {
        timerDiv.style.display = "block";
        timerDiv.innerText = "Elapsed: 00:00 | ETA: Calculating...";
    }
    const batchStartTime = Date.now();
    let timerInterval = setInterval(() => {
        if (!timerDiv) return;
        const elapsedSec = Math.floor((Date.now() - batchStartTime) / 1000);
        const m = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
        const s = String(elapsedSec % 60).padStart(2, '0');
        
        let etaStr = "Calculating...";
        if (completed > 0 && completed < files.length) {
            const timePerImg = elapsedSec / completed;
            const remainingSec = Math.floor(timePerImg * (files.length - completed));
            const rm = String(Math.floor(remainingSec / 60)).padStart(2, '0');
            const rs = String(remainingSec % 60).padStart(2, '0');
            etaStr = `${rm}:${rs}`;
        }
        timerDiv.innerText = `Elapsed: ${m}:${s} | ETA: ${etaStr}`;
    }, 1000);
    // -------------------------------------
    
    for (let i = 0; i < files.length; i++) {
        status.innerText = `Processing image ${i + 1} of ${files.length}...`;

        try {
            const data = await postBulkImage(files[i], selectedPreviewIds());

            if (data.success) {
                successCount++;
                const isCm = measurementUnit(data) === "cm";
                const digits = isCm ? 1 : 0;
                const notes = rowNotes(data);
                if (!isCm) pixelScaleCount++;

                globalBatchResults.push({ file_name: files[i].name, data, included: true, isCm, digits, notes, success: true });
            } else {
                failureCount++;
                globalBatchResults.push({ file_name: files[i].name, success: false, message: `Error: ${data.message || "Unknown error"}` });
            }
        } catch (err) {
            failureCount++;
            const msg = err.message === BULK_TIMEOUT_MESSAGE ? BULK_TIMEOUT_MESSAGE : `API Error: ${err.message}`;
            globalBatchResults.push({ file_name: files[i].name, success: false, message: msg });
        }

        completed++;
        renderBulkTable();
        rebuildHistograms(chartsContainer);
        if (i < files.length - 1) await new Promise(r => setTimeout(r, 500));
    }

    clearInterval(timerInterval);
    const finalElapsed = Math.floor((Date.now() - batchStartTime) / 1000);
    const fm = String(Math.floor(finalElapsed / 60)).padStart(2, '0');
    const fs = String(finalElapsed % 60).padStart(2, '0');
    timerDiv.innerText = `Total Time: ${fm}:${fs}`;

    const excludedText = pixelScaleCount > 0 ? ` ${pixelScaleCount} pixel-scale row(s) ignored for spatial metrics.` : "";
    status.innerText = `Batch complete: ${successCount} succeeded, ${failureCount} failed, ${completed} attempted.${excludedText}`;

    if (typeof gtag === 'function') {
        gtag('event', 'processed_bulk_batch', { 'event_category': 'Phenotyping', 'images_attempted': completed, 'images_succeeded': successCount });
    }
    
    if (successCount > 0) {
        downloadBtn.style.display = "inline-block";
        rebuildHistograms(chartsContainer);
    }
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
        if (!item.included || !item.success) return;
        histogramColumns.forEach(column => {
            const value = columnValue(column, item);
            if (isNumber(value)) {
                batchData[column.histLabel || column.label].push(value);
            }
        });
    });

    drawHistograms(batchData, container);
}

function drawHistograms(batchData, container) {
    const deKeys = Object.keys(batchData).filter(k => k.includes("ΔE"));
    let allDE =[];
    deKeys.forEach(k => {
        if (batchData[k]) allDE.push(...batchData[k].filter(isNumber));
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
        deKeys.forEach(k => {
            const vals = batchData[k] ? batchData[k].filter(isNumber) :[];
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
    for (const [title, rawValues] of Object.entries(batchData)) {
        const values = rawValues.filter(isNumber);
        if (values.length === 0) continue;

        let min, max, numBins, binWidth, maxY;
        const isDE = title.includes("ΔE");

        if (isDE && allDE.length > 0) {
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
        if (!item.success || !item.included) return;
        const values = [item.data.filename || item.file_name];
        columns.forEach(column => {
            const value = columnValue(column, item);
            values.push(isNumber(value) ? value : (value || ""));
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
