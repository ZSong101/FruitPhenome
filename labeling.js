// ============================================================================
// Labeling Studio: paint-style (brush/eraser) mask editor + dataset management.
// Depends on globals from app.js: proxyBaseUrl, usesProxyApi, currentPassword,
// currentUsername, activateTab, escapeHtml.
// ============================================================================
(function () {
    "use strict";

    const DEFAULT_CLASS_LAYERS = [
        { id: "whole", label: "Whole fruit", class_name: "watermelon_whole", color: [0, 220, 220], required: true },
        { id: "flesh_left", label: "Flesh left", class_name: "flesh_left", color: [40, 220, 60], required: false },
        { id: "flesh_right", label: "Flesh right", class_name: "flesh_right", color: [235, 60, 220], required: false }
    ];
    const DEFAULT_LAYER_COLORS = [
        [0, 220, 220], [40, 220, 60], [235, 60, 220], [255, 150, 30],
        [80, 150, 255], [180, 90, 245], [255, 215, 0], [40, 210, 200],
        [230, 80, 105], [120, 210, 80], [150, 130, 255], [255, 120, 210]
    ];
    const MAX_CLASS_LAYERS = 24;
    let classLayers = DEFAULT_CLASS_LAYERS.map((layer, idx) => ({ ...layer, class_id: idx }));
    let LAYERS = classLayers.map((layer) => layer.id);
    let LAYER_LABELS = Object.fromEntries(classLayers.map((layer) => [layer.id, layer.label]));
    let LAYER_COLORS = Object.fromEntries(classLayers.map((layer) => [layer.id, layer.color]));
    const MAX_DISPLAY_SIDE = 860;
    const MAX_UNDO = 14;
    const DOUBLE_CLICK_MS = 260;
    const STROKE_DRAG_THRESHOLD_PX = 3;
    const TRAIN_TERMINAL_STATUSES = new Set(["promoted", "rejected", "failed"]);

    // --- State ---
    let currentDatasetId = null;
    let datasetSummaries = [];
    let images = [];               // [{image_id, filename, status, width, height}]
    let currentImageId = null;
    let baseImage = null;          // HTMLImageElement of the source photo
    let imgW = 0, imgH = 0;
    let displayScale = 1;
    const layerCanvas = {};        // layer -> offscreen canvas (image resolution, colored)
    let activeLayer = "whole";
    let tool = "brush";            // "brush" | "eraser"
    let panMode = false;
    let brushSize = 40;
    const layerOpacity = { whole: 0.55, flesh_left: 0.55, flesh_right: 0.55 };
    let zoomLevel = 1;
    let panX = 0;
    let panY = 0;
    let panning = false;
    let panStart = null;

    let painting = false;
    let lastPt = null;
    let strokeBefore = null;       // ImageData snapshot of active layer at stroke start
    let strokeLayer = null;
    let strokeTool = null;
    let strokeBrushSize = null;
    let pendingStroke = null;
    let pendingTapStroke = null;
    let suppressNextDblClickUntil = 0;
    let undoStack = [];            // [{layer, data: ImageData}]
    let redoStack = [];
    let dirty = false;             // unsaved edits present
    let hoverPt = null;

    let datasetsLoaded = false;
    let displayCtx = null;
    let activeTrainJobId = null;
    let activeTrainJobStartedAt = null;
    let activeTrainJobLatest = null;
    let activeTrainJobTimer = null;
    let latentPoints = [];
    let latentBounds = null;
    let latentZoom = 1;
    let latentPanX = 0;
    let latentPanY = 0;
    let latentDragging = false;
    let latentDragStart = null;
    let latentHovered = null;
    let latentMethod = "";
    let latentColorMap = {};

    // --- DOM ---
    const el = (id) => document.getElementById(id);
    function dom() {
        return {
            authNote: el("studio-auth-note"),
            datasetSelect: el("studio-dataset-select"),
            uploadInput: el("studio-upload-input"),
            exportBtn: el("studio-export-btn"),
            augmentExportBtn: el("studio-augment-export-btn"),
            augCount: el("studio-aug-count"),
            bgProb: el("studio-bg-prob"),
            bgSwapStrength: el("studio-bg-swap-strength"),
            bgColorProb: el("studio-bg-color-prob"),
            bgColorStrength: el("studio-bg-color-strength"),
            bgSolidProb: el("studio-bg-solid-prob"),
            bgSolidStrength: el("studio-bg-solid-strength"),
            bgSurfaceProb: el("studio-bg-surface-prob"),
            bgSurfaceStrength: el("studio-bg-surface-strength"),
            bgClutterProb: el("studio-bg-clutter-prob"),
            bgClutterStrength: el("studio-bg-clutter-strength"),
            bgNoveltyProb: el("studio-bg-novelty-prob"),
            bgNoveltyStrength: el("studio-bg-novelty-strength"),
            valFraction: el("studio-val-fraction"),
            augSeed: el("studio-aug-seed"),
            includeFixed: el("studio-include-fixed"),
            augJob: el("studio-aug-job"),
            augJobText: el("studio-aug-job-text"),
            augJobFill: el("studio-aug-job-fill"),
            augmentPreviewBtn: el("studio-augment-preview-btn"),
            augmentPreviewStatus: el("studio-augment-preview-status"),
            augmentPreview: el("studio-augment-preview"),
            finetuneBtn: el("studio-finetune-btn"),
            trainJob: el("studio-train-job"),
            trainJobText: el("studio-train-job-text"),
            trainJobMeta: el("studio-train-job-meta"),
            trainJobFill: el("studio-train-job-fill"),
            modelPlan: el("studio-model-plan"),
            syncPanel: el("studio-sync-panel"),
            syncRefreshBtn: el("studio-sync-refresh-btn"),
            syncPushBtn: el("studio-sync-push-btn"),
            syncPullBtn: el("studio-sync-pull-btn"),
            syncExportBtn: el("studio-sync-export-btn"),
            syncDeleteLocalBtn: el("studio-sync-delete-local-btn"),
            syncDeleteRemoteBtn: el("studio-sync-delete-remote-btn"),
            syncImportInput: el("studio-sync-import-input"),
            syncReplace: el("studio-sync-replace"),
            syncStatus: el("studio-sync-status"),
            syncLocalDatasets: el("studio-sync-local-datasets"),
            syncLocalExperts: el("studio-sync-local-experts"),
            syncRemoteDatasets: el("studio-sync-remote-datasets"),
            syncRemoteExperts: el("studio-sync-remote-experts"),
            latentPanel: el("studio-latent-panel"),
            latentRefreshBtn: el("studio-latent-refresh-btn"),
            latentResetBtn: el("studio-latent-reset-btn"),
            latentStatus: el("studio-latent-status"),
            latentWrap: el("studio-latent-wrap"),
            latentCanvas: el("studio-latent-canvas"),
            latentTooltip: el("studio-latent-tooltip"),
            latentLegend: el("studio-latent-legend"),
            status: el("studio-status"),
            queueList: el("studio-queue-list"),
            prelabelBtn: el("studio-prelabel-btn"),
            undoBtn: el("studio-undo-btn"),
            redoBtn: el("studio-redo-btn"),
            saveBtn: el("studio-save-btn"),
            approveBtn: el("studio-approve-btn"),
            canvas: el("studio-canvas"),
            canvasHost: el("studio-canvas-host"),
            canvasEmpty: el("studio-canvas-empty"),
            layerButtons: el("studio-layer-buttons"),
            layerAddBtn: el("studio-layer-add-btn"),
            layerRenameBtn: el("studio-layer-rename-btn"),
            layerDeleteBtn: el("studio-layer-delete-btn"),
            brushBtn: el("studio-brush-btn"),
            eraserBtn: el("studio-eraser-btn"),
            brushSize: el("studio-brush-size"),
            brushSizeVal: el("studio-brush-size-val"),
            opacity: el("studio-opacity"),
            opacityVal: el("studio-opacity-val"),
            zoomOutBtn: el("studio-zoom-out-btn"),
            zoomInBtn: el("studio-zoom-in-btn"),
            zoomResetBtn: el("studio-zoom-reset-btn"),
            zoomValue: el("studio-zoom-value"),
            qa: el("studio-qa")
        };
    }

    function esc(value) {
        if (typeof escapeHtml === "function") return escapeHtml(value);
        return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => (
            { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
        ));
    }

    function safeLayerId(value, fallback = "class") {
        const raw = String(value || fallback).trim();
        const cleaned = raw.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 72);
        return cleaned || fallback;
    }

    function classNameFromLabel(label, fallback = "class") {
        const cleaned = String(label || fallback)
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_+|_+$/g, "")
            .slice(0, 48);
        return cleaned || fallback;
    }

    function normalizeClassLayers(layers) {
        const source = Array.isArray(layers) && layers.length ? layers : DEFAULT_CLASS_LAYERS;
        const usedIds = new Set();
        const usedNames = new Set();
        const out = [];
        source.slice(0, MAX_CLASS_LAYERS).forEach((item, idx) => {
            const entry = typeof item === "string" ? { id: item, label: item, class_name: item } : (item || {});
            const label = String(entry.label || entry.name || entry.class_name || entry.id || `Class ${idx + 1}`).trim();
            let id = safeLayerId(entry.id || classNameFromLabel(label, `class_${idx + 1}`), `class_${idx + 1}`);
            const idBase = id;
            let idSuffix = 2;
            while (usedIds.has(id)) id = `${idBase}_${idSuffix++}`;
            usedIds.add(id);

            let className = classNameFromLabel(entry.class_name || label, id);
            const nameBase = className;
            let nameSuffix = 2;
            while (usedNames.has(className)) className = `${nameBase}_${nameSuffix++}`;
            usedNames.add(className);

            const color = Array.isArray(entry.color) && entry.color.length >= 3
                ? entry.color.slice(0, 3).map((c) => Math.max(0, Math.min(255, Number(c) || 0)))
                : DEFAULT_LAYER_COLORS[idx % DEFAULT_LAYER_COLORS.length];
            out.push({
                id,
                label,
                class_name: className,
                class_id: out.length,
                color,
                required: Boolean(entry.required || (out.length === 0 && id === "whole"))
            });
        });
        return out.length ? out : DEFAULT_CLASS_LAYERS.map((layer, idx) => ({ ...layer, class_id: idx }));
    }

    function schemaSignature(layers) {
        return normalizeClassLayers(layers).map((layer) => `${layer.id}:${layer.class_name}`).join("|");
    }

    function currentClassLayersPayload() {
        return classLayers.map((layer, idx) => ({
            id: layer.id,
            label: layer.label,
            class_name: layer.class_name,
            class_id: idx,
            color: layer.color,
            required: Boolean(layer.required)
        }));
    }

    function setClassLayers(nextLayers, options = {}) {
        const preserveMasks = options.preserveMasks !== false;
        const normalized = normalizeClassLayers(nextLayers);
        const nextIds = normalized.map((layer) => layer.id);
        classLayers = normalized;
        LAYERS = nextIds;
        LAYER_LABELS = Object.fromEntries(normalized.map((layer) => [layer.id, layer.label]));
        LAYER_COLORS = Object.fromEntries(normalized.map((layer) => [layer.id, layer.color]));

        Object.keys(layerOpacity).forEach((layer) => {
            if (!nextIds.includes(layer)) delete layerOpacity[layer];
        });
        normalized.forEach((layer) => {
            if (layerOpacity[layer.id] == null) layerOpacity[layer.id] = 0.55;
            if (preserveMasks && baseImage && imgW && imgH && !layerCanvas[layer.id]) {
                layerCanvas[layer.id] = newLayerCanvas();
            }
        });
        Object.keys(layerCanvas).forEach((layer) => {
            if (!nextIds.includes(layer)) delete layerCanvas[layer];
        });
        if (!nextIds.includes(activeLayer)) activeLayer = nextIds[0] || "whole";
        renderLayerButtons();
        updateButtons();
        composite();
    }

    function setStatus(message, isError) {
        const d = dom();
        if (!d.status) return;
        d.status.innerText = message || "";
        d.status.style.color = isError ? "#c7362f" : "";
    }

    // --- URL + fetch helpers ---
    function datasetApiUrl(path) {
        const prefix = usesProxyApi() ? "proxy_datasets" : "datasets";
        return `${proxyBaseUrl()}/${prefix}${path || ""}`;
    }

    function syncApiUrl(path) {
        const prefix = usesProxyApi() ? "proxy_sync" : "sync";
        return `${proxyBaseUrl()}/${prefix}${path || ""}`;
    }

    function authQuery() {
        return `password=${encodeURIComponent(currentPassword)}&username=${encodeURIComponent(currentUsername)}`;
    }

    function loggedIn() {
        return Boolean(currentPassword);
    }

    function selectedStudioFruit() {
        return (typeof selectedFruit === "function" && selectedFruit()) || "";
    }

    async function apiGetJson(path) {
        const sep = path.includes("?") ? "&" : "?";
        const response = await fetch(`${datasetApiUrl(path)}${sep}${authQuery()}`);
        if (!response.ok) throw new Error(`Server responded with ${response.status}`);
        return response.json();
    }

    async function apiPostJson(path, body) {
        const response = await fetch(datasetApiUrl(path), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...body, password: currentPassword, username: currentUsername })
        });
        if (!response.ok) throw new Error(`Server responded with ${response.status}`);
        return response.json();
    }

    async function syncGetJson(path) {
        const sep = path.includes("?") ? "&" : "?";
        const response = await fetch(`${syncApiUrl(path)}${sep}${authQuery()}`);
        if (!response.ok) throw new Error(`Server responded with ${response.status}`);
        return response.json();
    }

    async function syncPostJson(path, body, expectBlob = false) {
        const response = await fetch(syncApiUrl(path), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...body, password: currentPassword, username: currentUsername })
        });
        if (!response.ok) {
            let detail = "";
            try {
                const data = await response.json();
                detail = data.detail || data.message || "";
            } catch (_err) {}
            throw new Error(detail || `Server responded with ${response.status}`);
        }
        return expectBlob ? response.blob() : response.json();
    }

    async function apiPutJson(path, body) {
        const response = await fetch(datasetApiUrl(path), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...body, password: currentPassword, username: currentUsername })
        });
        if (!response.ok) {
            let detail = "";
            try {
                const data = await response.json();
                detail = data.detail || data.message || "";
            } catch (_err) {}
            throw new Error(detail || `Server responded with ${response.status}`);
        }
        return response.json();
    }

    async function apiSendForm(path, method, formData) {
        formData.append("password", currentPassword);
        formData.append("username", currentUsername);
        const response = await fetch(datasetApiUrl(path), { method, body: formData });
        if (!response.ok) throw new Error(`Server responded with ${response.status}`);
        return response.json();
    }

    function syncAllowed() {
        return typeof isDevUser === "function" && isDevUser();
    }

    function setSyncStatus(message, isError = false) {
        const d = dom();
        if (!d.syncStatus) return;
        d.syncStatus.innerText = message || "";
        d.syncStatus.style.color = isError ? "#c7362f" : "";
    }

    function renderSyncList(container, items, source, kind) {
        if (!container) return;
        const list = Array.isArray(items) ? items : [];
        if (!list.length) {
            container.innerHTML = `<span class="muted">No ${kind === "datasets" ? "datasets" : "models"} found.</span>`;
            return;
        }
        container.innerHTML = list.map((item) => {
            const id = item.dataset_id || item.id || "";
            const title = item.name || item.id || item.dataset_id || "Unnamed";
            const fruit = String(item.fruit_type || "").replace(/_/g, " ") || "unknown fruit";
            const lastUsed = Number(item.last_used_hours);
            const lastUsedText = Number.isFinite(lastUsed) ? ` · ${lastUsed.toFixed(1)} h since last use` : "";
            const expiryText = kind === "datasets" && source === "remote" && item.stale_delete_warning
                ? ` · deletes in ${Number(item.hours_until_expiry || 0).toFixed(1)} h`
                : "";
            const meta = kind === "datasets"
                ? `${fruit} · ${item.owner_username || "global"} · ${item.image_count || 0} images${lastUsedText}${expiryText}`
                : `${fruit} · v${item.version || "?"} · ${item.status || "unknown"}`;
            return `<label class="studio-sync-item ${item.stale_delete_warning && source === "remote" ? "stale-warning" : ""}">
                <input type="checkbox" data-sync-source="${source}" data-sync-kind="${kind}" value="${esc(id)}">
                <span>${esc(title)}<small>${esc(id)} · ${esc(meta)}</small></span>
            </label>`;
        }).join("");
    }

    function renderSyncLoading() {
        const d = dom();
        [
            [d.syncLocalDatasets, "Loading local dev datasets..."],
            [d.syncLocalExperts, "Loading local dev models..."],
            [d.syncRemoteDatasets, "Loading production datasets..."],
            [d.syncRemoteExperts, "Loading production models..."],
        ].forEach(([container, message]) => {
            if (container) container.innerHTML = `<span class="studio-sync-loading">${esc(message)}</span>`;
        });
    }

    function setLatentStatus(message, isError = false) {
        const d = dom();
        if (!d.latentStatus) return;
        d.latentStatus.innerText = message || "";
        d.latentStatus.style.color = isError ? "#c7362f" : "";
    }

    function loadLatentColorMap() {
        try {
            const parsed = JSON.parse(localStorage.getItem("fruitphenome_latent_colors_v1") || "{}");
            latentColorMap = parsed && typeof parsed === "object" ? parsed : {};
        } catch (_err) {
            latentColorMap = {};
        }
    }

    function saveLatentColorMap() {
        try {
            localStorage.setItem("fruitphenome_latent_colors_v1", JSON.stringify(latentColorMap));
        } catch (_err) {}
    }

    function circularHueDistance(a, b) {
        const diff = Math.abs(Number(a) - Number(b)) % 360;
        return Math.min(diff, 360 - diff);
    }

    function nextMaxDistanceHue() {
        const used = Object.values(latentColorMap)
            .map(entry => Number(entry?.hue))
            .filter(Number.isFinite);
        if (!used.length) return 270;
        let bestHue = 0;
        let bestDistance = -1;
        for (let hue = 0; hue < 360; hue += 1) {
            const minDistance = Math.min(...used.map(existing => circularHueDistance(hue, existing)));
            if (minDistance > bestDistance) {
                bestDistance = minDistance;
                bestHue = hue;
            }
        }
        return bestHue;
    }

    function latentColor(key) {
        const text = String(key || "unknown fruit");
        if (!latentColorMap[text]) {
            const hue = nextMaxDistanceHue();
            latentColorMap[text] = { hue, color: `hsl(${hue} 68% 48%)` };
            saveLatentColorMap();
        }
        return latentColorMap[text].color;
    }

    function computeLatentBounds(points) {
        if (!points.length) return null;
        const xs = points.map(p => Number(p.x)).filter(Number.isFinite);
        const ys = points.map(p => Number(p.y)).filter(Number.isFinite);
        if (!xs.length || !ys.length) return null;
        let minX = Math.min(...xs), maxX = Math.max(...xs);
        let minY = Math.min(...ys), maxY = Math.max(...ys);
        if (minX === maxX) { minX -= 1; maxX += 1; }
        if (minY === maxY) { minY -= 1; maxY += 1; }
        return { minX, maxX, minY, maxY };
    }

    function sizeLatentCanvas() {
        const d = dom();
        const canvas = d.latentCanvas;
        const wrap = d.latentWrap;
        if (!canvas || !wrap) return { width: 0, height: 0, dpr: 1 };
        const rect = wrap.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const width = Math.max(320, Math.floor(rect.width || 720));
        const height = Math.max(260, Math.floor(rect.height || 420));
        if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
            canvas.width = Math.floor(width * dpr);
            canvas.height = Math.floor(height * dpr);
        }
        return { width, height, dpr };
    }

    function latentWorldToScreen(point, metrics) {
        const bounds = latentBounds;
        if (!bounds) return { x: 0, y: 0 };
        const spanX = bounds.maxX - bounds.minX;
        const spanY = bounds.maxY - bounds.minY;
        const baseScale = 0.86 * Math.min(metrics.width / spanX, metrics.height / spanY);
        const midX = (bounds.minX + bounds.maxX) / 2;
        const midY = (bounds.minY + bounds.maxY) / 2;
        return {
            x: metrics.width / 2 + (Number(point.x) - midX) * baseScale * latentZoom + latentPanX,
            y: metrics.height / 2 - (Number(point.y) - midY) * baseScale * latentZoom + latentPanY,
        };
    }

    function updateLatentLegend() {
        const d = dom();
        if (!d.latentLegend) return;
        const fruits = [...new Set(latentPoints.map(p => String(p.fruit_type || "unknown fruit")))].sort();
        d.latentLegend.innerHTML = fruits.map(fruit => (
            `<span><span class="studio-latent-dot" style="background:${latentColor(fruit)}"></span>${esc(fruit.replace(/_/g, " "))}</span>`
        )).join("");
    }

    function drawLatentMap() {
        const d = dom();
        const canvas = d.latentCanvas;
        if (!canvas) return;
        const metrics = sizeLatentCanvas();
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.setTransform(metrics.dpr, 0, 0, metrics.dpr, 0, 0);
        ctx.clearRect(0, 0, metrics.width, metrics.height);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, metrics.width, metrics.height);

        ctx.strokeStyle = "#edf0f4";
        ctx.lineWidth = 1;
        for (let x = 40; x < metrics.width; x += 80) {
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, metrics.height); ctx.stroke();
        }
        for (let y = 40; y < metrics.height; y += 80) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(metrics.width, y); ctx.stroke();
        }

        if (!latentPoints.length || !latentBounds) {
            ctx.fillStyle = "#6b7480";
            ctx.font = "14px system-ui, sans-serif";
            ctx.fillText("Load PaCMAP map to view stored latent embeddings.", 18, 30);
            return;
        }

        latentPoints.forEach(point => {
            const pos = latentWorldToScreen(point, metrics);
            point._sx = pos.x;
            point._sy = pos.y;
            const active = point === latentHovered;
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, active ? 5.5 : 3.8, 0, Math.PI * 2);
            ctx.fillStyle = latentColor(point.fruit_type);
            ctx.globalAlpha = active ? 1 : 0.78;
            ctx.fill();
            ctx.globalAlpha = 1;
            if (active) {
                ctx.lineWidth = 2;
                ctx.strokeStyle = "#231834";
                ctx.stroke();
            }
        });

        ctx.fillStyle = "#4d2779";
        ctx.font = "12px system-ui, sans-serif";
        ctx.fillText(`${latentMethod || "PaCMAP"} · ${latentPoints.length} stored embeddings`, 12, metrics.height - 12);
    }

    function nearestLatentPoint(event) {
        const d = dom();
        const canvas = d.latentCanvas;
        if (!canvas || !latentPoints.length) return null;
        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        let best = null;
        let bestDist = Infinity;
        latentPoints.forEach(point => {
            const dx = x - Number(point._sx);
            const dy = y - Number(point._sy);
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < bestDist) {
                best = point;
                bestDist = dist;
            }
        });
        return bestDist <= 12 ? best : null;
    }

    function updateLatentTooltip(point, event) {
        const d = dom();
        const tooltip = d.latentTooltip;
        const wrap = d.latentWrap;
        if (!tooltip || !wrap) return;
        if (!point || !event) {
            tooltip.classList.remove("visible");
            return;
        }
        tooltip.innerHTML = `<strong>${esc(point.image_name || "latent point")}</strong><br>
            ${esc(point.expert_id || "unknown model")} · v${esc(point.version || "?")} · ${esc(point.status || "")}<br>
            ${esc(String(point.fruit_type || "unknown fruit").replace(/_/g, " "))}`;
        const rect = wrap.getBoundingClientRect();
        tooltip.style.left = `${Math.min(Math.max(event.clientX - rect.left + 12, 8), rect.width - 220)}px`;
        tooltip.style.top = `${Math.min(Math.max(event.clientY - rect.top + 12, 8), rect.height - 80)}px`;
        tooltip.classList.add("visible");
    }

    function resetLatentView() {
        latentZoom = 1;
        latentPanX = 0;
        latentPanY = 0;
        drawLatentMap();
    }

    async function loadLatentMap() {
        if (!syncAllowed()) return;
        const d = dom();
        if (d.latentRefreshBtn) d.latentRefreshBtn.disabled = true;
        setLatentStatus("Computing PaCMAP projection...");
        try {
            const data = await syncGetJson("/latent_space?max_points=3000");
            if (!data.success) throw new Error(data.message || "PaCMAP projection failed.");
            latentPoints = Array.isArray(data.points) ? data.points : [];
            latentBounds = computeLatentBounds(latentPoints);
            latentMethod = data.method || "PaCMAP";
            latentHovered = null;
            resetLatentView();
            updateLatentLegend();
            setLatentStatus(latentPoints.length ? `${latentMethod} loaded (${latentPoints.length} points).` : "No latent embeddings found.");
            updateButtons();
        } catch (err) {
            latentPoints = [];
            latentBounds = null;
            latentHovered = null;
            drawLatentMap();
            updateLatentLegend();
            setLatentStatus(err.message || "Could not load PaCMAP map.", true);
            updateButtons();
        } finally {
            if (d.latentRefreshBtn) d.latentRefreshBtn.disabled = false;
            updateButtons();
        }
    }

    async function refreshSyncInventory() {
        const d = dom();
        if (!syncAllowed()) {
            if (d.syncPanel) d.syncPanel.classList.remove("visible");
            if (d.latentPanel) d.latentPanel.classList.remove("visible");
            return;
        }
        if (d.syncPanel) d.syncPanel.classList.add("visible");
        try {
            if (d.syncRefreshBtn) d.syncRefreshBtn.disabled = true;
            renderSyncLoading();
            setSyncStatus("Loading sync inventory...");
            const [localResult, remoteResult] = await Promise.allSettled([
                syncGetJson("/inventory"),
                syncGetJson("/remote_inventory"),
            ]);
            if (localResult.status === "rejected") throw localResult.reason;
            const local = localResult.value;
            if (local.success === false) throw new Error(local.message || "Could not load local inventory.");
            renderSyncList(d.syncLocalDatasets, local.datasets, "local", "datasets");
            renderSyncList(d.syncLocalExperts, local.experts, "local", "experts");
            if (remoteResult.status === "rejected") {
                renderSyncList(d.syncRemoteDatasets, [], "remote", "datasets");
                renderSyncList(d.syncRemoteExperts, [], "remote", "experts");
                setSyncStatus(`Local dev inventory loaded. Production inventory unavailable: ${remoteResult.reason?.message || remoteResult.reason}`);
                return;
            }
            const remote = remoteResult.value;
            if (remote.success === false) {
                renderSyncList(d.syncRemoteDatasets, [], "remote", "datasets");
                renderSyncList(d.syncRemoteExperts, [], "remote", "experts");
                setSyncStatus(`Local dev inventory loaded. Production inventory unavailable: ${remote.message || "production backend may not expose /sync/inventory yet."}`);
                return;
            }
            renderSyncList(d.syncRemoteDatasets, remote.datasets, "remote", "datasets");
            renderSyncList(d.syncRemoteExperts, remote.experts, "remote", "experts");
            setSyncStatus("Sync inventory loaded.");
        } catch (err) {
            setSyncStatus(`Sync inventory failed: ${err.message}`, true);
        } finally {
            if (d.syncRefreshBtn) d.syncRefreshBtn.disabled = false;
        }
    }

    function selectedSyncIds(source, kind) {
        return [...document.querySelectorAll(`input[data-sync-source="${source}"][data-sync-kind="${kind}"]:checked`)]
            .map((input) => input.value)
            .filter(Boolean);
    }

    function syncPayloadFor(source) {
        const d = dom();
        return {
            dataset_ids: selectedSyncIds(source, "datasets"),
            expert_ids: selectedSyncIds(source, "experts"),
            conflict_mode: d.syncReplace?.checked ? "replace" : "skip"
        };
    }

    function ensureSyncSelection(payload, directionLabel) {
        if ((payload.dataset_ids || []).length || (payload.expert_ids || []).length) return true;
        setSyncStatus(`Select at least one dataset or model to ${directionLabel}.`, true);
        return false;
    }

    function resetSyncDeleteConfirmation(button, label) {
        if (!button) return;
        button.dataset.confirmingDelete = "false";
        button.classList.remove("confirming-delete");
        button.textContent = label;
    }

    function confirmSyncDelete(button, label, count) {
        if (!button) return false;
        if (button.dataset.confirmingDelete === "true") return true;
        button.dataset.confirmingDelete = "true";
        button.classList.add("confirming-delete");
        button.textContent = `Click again to delete ${count}`;
        setTimeout(() => resetSyncDeleteConfirmation(button, label), 4000);
        return false;
    }

    async function deleteSelectedSyncItems(source) {
        const d = dom();
        const isRemote = source === "remote";
        const button = isRemote ? d.syncDeleteRemoteBtn : d.syncDeleteLocalBtn;
        const label = isRemote ? "Delete selected production items" : "Delete selected dev items";
        const payload = syncPayloadFor(source);
        const count = (payload.dataset_ids || []).length + (payload.expert_ids || []).length;
        if (!ensureSyncSelection(payload, `delete from ${isRemote ? "production" : "dev"}`)) return;
        if (!confirmSyncDelete(button, label, count)) return;
        try {
            if (button) button.disabled = true;
            setSyncStatus(`Permanently deleting ${count} selected ${isRemote ? "production" : "dev"} item${count === 1 ? "" : "s"}...`);
            const result = await syncPostJson(isRemote ? "/delete_prod" : "/delete", payload);
            if (result.success === false) throw new Error(result.message || "Delete failed.");
            resetSyncDeleteConfirmation(button, label);
            setSyncStatus("Delete complete. Refreshing inventories...");
            await refreshSyncInventory();
        } catch (err) {
            setSyncStatus(`Delete failed: ${err.message}`, true);
        } finally {
            if (button) button.disabled = false;
            resetSyncDeleteConfirmation(button, label);
            updateButtons();
        }
    }

    async function pushSelectedToProduction() {
        const payload = syncPayloadFor("local");
        if (!ensureSyncSelection(payload, "push")) return;
        try {
            setSyncStatus("Pushing selected dev items to production...");
            const result = await syncPostJson("/push_prod", payload);
            if (result.success === false) throw new Error(result.message || "Push failed.");
            setSyncStatus("Push complete. Refreshing inventories...");
            await refreshSyncInventory();
        } catch (err) {
            setSyncStatus(`Push failed: ${err.message}`, true);
        }
    }

    async function pullSelectedFromProduction() {
        const payload = syncPayloadFor("remote");
        if (!ensureSyncSelection(payload, "pull")) return;
        try {
            setSyncStatus("Pulling selected production items into dev...");
            const result = await syncPostJson("/pull_prod", payload);
            if (result.success === false) throw new Error(result.message || "Pull failed.");
            setSyncStatus("Pull complete. Refreshing inventories...");
            await refreshSyncInventory();
        } catch (err) {
            setSyncStatus(`Pull failed: ${err.message}`, true);
        }
    }

    async function exportSelectedDevBundle() {
        const payload = syncPayloadFor("local");
        if (!ensureSyncSelection(payload, "export")) return;
        try {
            setSyncStatus("Building dev sync bundle...");
            const blob = await syncPostJson("/export", { ...payload, source_label: "dev" }, true);
            const objectUrl = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = objectUrl;
            anchor.download = `fruitphenome_dev_sync_${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            URL.revokeObjectURL(objectUrl);
            setSyncStatus("Dev sync bundle downloaded.");
        } catch (err) {
            setSyncStatus(`Export failed: ${err.message}`, true);
        }
    }

    async function importBundleToDev(file) {
        if (!file) return;
        const d = dom();
        const form = new FormData();
        form.append("bundle", file);
        form.append("password", currentPassword);
        form.append("username", currentUsername);
        form.append("conflict_mode", d.syncReplace?.checked ? "replace" : "skip");
        try {
            setSyncStatus("Importing bundle into dev...");
            const response = await fetch(syncApiUrl("/import"), { method: "POST", body: form });
            const result = await response.json().catch(() => ({}));
            if (!response.ok || result.success === false) throw new Error(result.message || `Server responded with ${response.status}`);
            setSyncStatus("Bundle imported into dev. Refreshing inventories...");
            await refreshSyncInventory();
        } catch (err) {
            setSyncStatus(`Import failed: ${err.message}`, true);
        } finally {
            if (d.syncImportInput) d.syncImportInput.value = "";
        }
    }

    // --- Dataset management ---
    async function ensureDatasetsLoaded() {
        const d = dom();
        if (!loggedIn()) {
            if (d.authNote) d.authNote.innerText = "Log in to use the Labeling Studio.";
            return;
        }
        if (d.authNote) d.authNote.innerText = "";
        if (datasetsLoaded) return;
        await loadDatasets();
    }

    async function loadDatasets(selectId) {
        const d = dom();
        if (d.datasetSelect) {
            d.datasetSelect.innerHTML = `<option value="">Loading saved datasets...</option>`;
            d.datasetSelect.disabled = true;
        }
        setStatus("Loading saved labeling datasets and model metadata...");
        try {
            const data = await apiGetJson("");
            if (!data.success) throw new Error(data.message || "Could not load datasets.");
            const selected = selectedStudioFruit();
            datasetSummaries = (data.datasets || []).filter((ds) => (
                !selected || selected === "other" || String(ds.fruit_type || "watermelon").toLowerCase() === selected.toLowerCase()
            ));
            const options = [`<option value="">Select dataset...</option>`];
            datasetSummaries.forEach((ds) => {
                const fruit = String(ds.fruit_type || "watermelon").replace(/_/g, " ");
                const lastUsed = Number(ds.last_used_hours);
                const lastUsedText = Number.isFinite(lastUsed) ? ` · ${lastUsed.toFixed(1)} h since last use` : "";
                const expiryText = ds.stale_delete_warning
                    ? ` · deletes in ${Number(ds.hours_until_expiry || 0).toFixed(1)} h`
                    : "";
                options.push(`<option value="${esc(ds.dataset_id)}">${esc(ds.name)} · ${esc(fruit)} (${ds.image_count} img)${esc(lastUsedText)}${esc(expiryText)}</option>`);
            });
            options.push(`<option value="__new__">+ Create new dataset...</option>`);
            d.datasetSelect.innerHTML = options.join("");
            datasetsLoaded = true;
            const target = selectId || currentDatasetId || (datasetSummaries[0] && datasetSummaries[0].dataset_id);
            if (target) {
                d.datasetSelect.value = target;
                await selectDataset(target);
            } else {
                currentDatasetId = null;
                images = [];
                renderQueue();
                renderModelPlan(null);
                if (d.datasetSelect) d.datasetSelect.value = "";
            }
            setStatus("");
        } catch (err) {
            if (d.datasetSelect) {
                d.datasetSelect.innerHTML = `<option value="">Could not load saved datasets</option>`;
            }
            setStatus(`Could not load datasets: ${err.message}`, true);
        } finally {
            if (d.datasetSelect) d.datasetSelect.disabled = false;
        }
    }

    async function selectDataset(datasetId) {
        currentDatasetId = datasetId || null;
        currentImageId = null;
        clearCanvas();
        const summary = currentDatasetSummary();
        setClassLayers(summary?.class_layers || selectedExpertLayers() || DEFAULT_CLASS_LAYERS, { preserveMasks: false });
        const d = dom();
        if (d.augmentPreview) {
            d.augmentPreview.classList.remove("visible");
            d.augmentPreview.innerHTML = "";
        }
        if (d.augmentPreviewStatus) d.augmentPreviewStatus.innerText = "";
        if (!currentDatasetId) {
            images = [];
            renderQueue();
            renderModelPlan(null);
            updateButtons();
            return;
        }
        try {
            renderModelPlan({ loading: true });
            await Promise.all([loadImageList(), loadTrainingTarget()]);
        } catch (err) {
            setStatus(`Could not open dataset: ${err.message}`, true);
        }
        updateButtons();
    }

    function currentDatasetSummary() {
        return datasetSummaries.find((ds) => ds.dataset_id === currentDatasetId) || null;
    }

    function updateCurrentDatasetSummary(summary) {
        if (!summary?.dataset_id) return;
        const idx = datasetSummaries.findIndex((ds) => ds.dataset_id === summary.dataset_id);
        if (idx >= 0) datasetSummaries[idx] = { ...datasetSummaries[idx], ...summary };
        else datasetSummaries.push(summary);
    }

    function selectedExpertLayers() {
        if (typeof window.selectedExpertClassLayers === "function") {
            return window.selectedExpertClassLayers();
        }
        return null;
    }

    function layersDiffer(a, b) {
        return schemaSignature(a) !== schemaSignature(b);
    }

    async function saveClassLayersToDataset(statusMessage = "Class labels saved.") {
        if (!currentDatasetId) {
            setStatus("Select or create a dataset before editing class labels.", true);
            return false;
        }
        try {
            const data = await apiPutJson(`/${currentDatasetId}/class_layers`, {
                class_layers: currentClassLayersPayload()
            });
            if (!data.success) throw new Error(data.message || "Could not save class labels.");
            updateCurrentDatasetSummary(data.dataset);
            if (data.dataset?.class_layers) setClassLayers(data.dataset.class_layers, { preserveMasks: true });
            await Promise.all([loadImageList(), loadTrainingTarget()]);
            setStatus(statusMessage);
            return true;
        } catch (err) {
            setStatus(`Class label save failed: ${err.message}`, true);
            return false;
        }
    }

    function layerHasPaint(layer) {
        const canvas = layerCanvas[layer];
        if (!canvas || !imgW || !imgH) return false;
        const data = canvas.getContext("2d").getImageData(0, 0, imgW, imgH).data;
        for (let i = 3; i < data.length; i += 4) {
            if (data[i] > 0) return true;
        }
        return false;
    }

    async function addClassLayer() {
        if (!currentDatasetId) {
            setStatus("Create or select a dataset before adding labels.", true);
            return;
        }
        if (classLayers.length >= MAX_CLASS_LAYERS) {
            setStatus(`This dataset already has the maximum of ${MAX_CLASS_LAYERS} labels.`, true);
            return;
        }
        const label = window.prompt("New class label:", `Flesh chamber ${classLayers.length}`);
        if (label === null) return;
        const trimmed = label.trim();
        if (!trimmed) {
            setStatus("Class label cannot be blank.", true);
            return;
        }
        const layers = currentClassLayersPayload();
        layers.push({
            id: safeLayerId(classNameFromLabel(trimmed, `class_${layers.length + 1}`), `class_${layers.length + 1}`),
            label: trimmed,
            class_name: classNameFromLabel(trimmed, `class_${layers.length + 1}`),
            color: DEFAULT_LAYER_COLORS[layers.length % DEFAULT_LAYER_COLORS.length],
            required: false
        });
        setClassLayers(layers, { preserveMasks: true });
        activeLayer = classLayers[classLayers.length - 1]?.id || activeLayer;
        await saveClassLayersToDataset(`Added class label '${trimmed}'.`);
        setActiveLayer(activeLayer);
    }

    async function renameClassLayer() {
        if (!currentDatasetId || !activeLayer) {
            setStatus("Select a dataset and class label first.", true);
            return;
        }
        const existing = classLayers.find((layer) => layer.id === activeLayer);
        if (!existing) return;
        const label = window.prompt("Rename selected class label:", existing.label);
        if (label === null) return;
        const trimmed = label.trim();
        if (!trimmed) {
            setStatus("Class label cannot be blank.", true);
            return;
        }
        const layers = currentClassLayersPayload().map((layer) => (
            layer.id === activeLayer
                ? { ...layer, label: trimmed, class_name: classNameFromLabel(trimmed, layer.id) }
                : layer
        ));
        setClassLayers(layers, { preserveMasks: true });
        await saveClassLayersToDataset(`Renamed class label to '${trimmed}'.`);
        setActiveLayer(activeLayer);
    }

    async function deleteClassLayer() {
        if (!currentDatasetId || !activeLayer) {
            setStatus("Select a dataset and class label first.", true);
            return;
        }
        if (classLayers.length <= 1) {
            setStatus("A model needs at least one class label.", true);
            return;
        }
        const existing = classLayers.find((layer) => layer.id === activeLayer);
        if (!existing) return;
        const painted = layerHasPaint(activeLayer);
        const message = painted
            ? `Delete '${existing.label}' and discard its painted masks in this dataset?`
            : `Delete '${existing.label}' from this dataset?`;
        if (!window.confirm(message)) return;
        const nextActive = classLayers.find((layer) => layer.id !== activeLayer)?.id || null;
        const layers = currentClassLayersPayload().filter((layer) => layer.id !== activeLayer);
        delete layerCanvas[activeLayer];
        setClassLayers(layers, { preserveMasks: true });
        activeLayer = nextActive || classLayers[0]?.id || "whole";
        await saveClassLayersToDataset(`Deleted class label '${existing.label}'.`);
        setActiveLayer(activeLayer);
    }

    async function maybeAdoptSelectedModelSchema() {
        const expertLayers = selectedExpertLayers();
        if (!expertLayers || !expertLayers.length) return;
        if (!currentDatasetId) {
            setClassLayers(expertLayers, { preserveMasks: false });
            return;
        }
        const datasetLayers = currentDatasetSummary()?.class_layers || classLayers;
        if (!layersDiffer(datasetLayers, expertLayers)) return;
        const ok = window.confirm("The selected model uses a different class label list. Apply that label list to this dataset?");
        if (!ok) return;
        setClassLayers(expertLayers, { preserveMasks: true });
        await saveClassLayersToDataset("Dataset labels updated to match the selected model.");
    }

    function renderModelPlan(plan) {
        const d = dom();
        if (!d.modelPlan) return;
        if (!plan) {
            d.modelPlan.innerText = "Select a dataset to see which model will be fine-tuned or copied.";
            return;
        }
        if (plan.loading) {
            d.modelPlan.innerText = "Resolving the exact model for this dataset...";
            return;
        }
        if (plan.error) {
            d.modelPlan.innerText = `Model plan unavailable: ${plan.error}`;
            return;
        }
        const fruit = String(plan.fruit_type || currentDatasetSummary()?.fruit_type || "watermelon").replace(/_/g, " ");
        const layers = plan.dataset_class_layers || currentDatasetSummary()?.class_layers || classLayers;
        const labelText = normalizeClassLayers(layers).map((layer) => layer.label).join(", ");
        if (plan.operation === "copy_then_fine_tune") {
            d.modelPlan.innerText = `Model plan for ${fruit}: copy ${plan.base_id}, then fine-tune it as ${plan.candidate_id}. Labels: ${labelText}.`;
        } else {
            d.modelPlan.innerText = `Model plan for ${fruit}: fine-tune ${plan.base_id} into candidate ${plan.candidate_id}. Labels: ${labelText}.`;
        }
    }

    async function loadTrainingTarget() {
        if (!currentDatasetId) return;
        try {
            const selectedExpert = document.getElementById("model-version-select")?.value || "";
            const data = await apiGetJson(`/${currentDatasetId}/training_target?expert_id=${encodeURIComponent(selectedExpert)}`);
            if (!data.success) throw new Error(data.message || "Could not resolve model.");
            renderModelPlan(data);
        } catch (err) {
            renderModelPlan({ error: err.message });
        }
    }

    async function loadImageList() {
        const data = await apiGetJson(`/${currentDatasetId}/images_list`);
        if (data && data.success) {
            images = data.images || [];
            renderQueue();
        } else {
            images = [];
            renderQueue();
        }
    }

    function renderQueue() {
        const d = dom();
        if (!d.queueList) return;
        if (!images.length) {
            d.queueList.innerHTML = `<li class="muted" style="padding:6px;">No images. Upload some to begin.</li>`;
            return;
        }
        d.queueList.innerHTML = images.map((img) => `
            <li class="studio-queue-item ${img.image_id === currentImageId ? "active" : ""}" data-image-id="${esc(img.image_id)}">
                <span class="studio-queue-name" title="${esc(img.filename)}">${esc(img.filename)}</span>
                <span class="studio-status-badge ${esc(img.status)}">${esc(img.status)}</span>
            </li>
        `).join("");
    }

    async function createDataset() {
        const fruitType = selectedStudioFruit() || "watermelon";
        const fruitLabel = fruitType.replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
        const name = window.prompt("New dataset name:", `${fruitLabel} batch`);
        if (name === null) return null;
        try {
            setStatus("Creating dataset...");
            const expertLayers = selectedExpertLayers();
            if (expertLayers?.length) setClassLayers(expertLayers, { preserveMasks: false });
            const data = await apiPostJson("", {
                name,
                fruit_type: fruitType,
                source: "manual_upload",
                class_layers: currentClassLayersPayload()
            });
            if (!data.success) throw new Error(data.message || "Create failed.");
            datasetsLoaded = false;
            await loadDatasets(data.dataset.dataset_id);
            setStatus("Dataset created.");
            return data.dataset.dataset_id;
        } catch (err) {
            setStatus(`Create failed: ${err.message}`, true);
            return null;
        }
    }

    async function uploadImages(fileList) {
        const files = [...(fileList || [])];
        if (!files.length) return;
        if (!currentDatasetId) {
            setStatus("Create or select a dataset first.", true);
            return;
        }
        try {
            setStatus(`Uploading ${files.length} image${files.length === 1 ? "" : "s"}...`);
            const formData = new FormData();
            files.forEach((file) => formData.append("files", file));
            const data = await apiSendForm(`/${currentDatasetId}/images`, "POST", formData);
            if (!data.success) throw new Error(data.message || "Upload failed.");
            await loadImageList();
            const firstNew = (data.images || []).find((it) => it.success && it.image_id);
            if (firstNew) await selectImage(firstNew.image_id);
            setStatus(`Uploaded ${(data.images || []).filter((it) => it.success).length} image(s).`);
        } catch (err) {
            setStatus(`Upload failed: ${err.message}`, true);
        }
    }

    async function exportZip() {
        if (!currentDatasetId) {
            setStatus("Select a dataset to export.", true);
            return;
        }
        try {
            setStatus("Building export...");
            const formData = new FormData();
            formData.append("password", currentPassword);
            formData.append("username", currentUsername);
            const response = await fetch(datasetApiUrl(`/${currentDatasetId}/export`), { method: "POST", body: formData });
            if (!response.ok) {
                let message = `Export failed (${response.status})`;
                try { const j = await response.json(); message = j.detail || j.message || message; } catch (e) { /* binary */ }
                throw new Error(message);
            }
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = `${currentDatasetId}_export.zip`;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            URL.revokeObjectURL(url);
            setStatus("Export downloaded.");
        } catch (err) {
            setStatus(`Export failed: ${err.message}`, true);
        }
    }

    function readAugmentOptions() {
        const d = dom();
        return {
            random_augs_per_image: Math.max(0, Math.min(200, Number(d.augCount?.value || 12))),
            background_swap_prob: Math.max(0, Math.min(1, Number(d.bgProb?.value || 0.25))),
            background_swap_strength: Math.max(0, Math.min(1, Number(d.bgSwapStrength?.value || 1))),
            background_color_prob: Math.max(0, Math.min(1, Number(d.bgColorProb?.value || 0.18))),
            background_color_strength: Math.max(0, Math.min(1, Number(d.bgColorStrength?.value || 0.65))),
            solid_background_prob: Math.max(0, Math.min(1, Number(d.bgSolidProb?.value || 0.08))),
            solid_background_strength: Math.max(0, Math.min(1, Number(d.bgSolidStrength?.value || 1))),
            surface_background_prob: Math.max(0, Math.min(1, Number(d.bgSurfaceProb?.value || 0.18))),
            surface_background_strength: Math.max(0, Math.min(1, Number(d.bgSurfaceStrength?.value || 0.75))),
            background_clutter_prob: Math.max(0, Math.min(1, Number(d.bgClutterProb?.value || 0.25))),
            background_clutter_strength: Math.max(0, Math.min(1, Number(d.bgClutterStrength?.value || 0.55))),
            background_novelty_prob: Math.max(0, Math.min(1, Number(d.bgNoveltyProb?.value || 0.12))),
            background_novelty_strength: Math.max(0, Math.min(1, Number(d.bgNoveltyStrength?.value || 0.55))),
            val_fraction: Math.max(0, Math.min(0.5, Number(d.valFraction?.value || 0.2))),
            seed: Number(d.augSeed?.value || 42),
            include_fixed: Boolean(d.includeFixed?.checked)
        };
    }

    function renderAugJob(job) {
        const d = dom();
        if (!d.augJob || !job) return;
        d.augJob.classList.add("visible");
        const progress = Math.max(0, Math.min(100, Number(job.progress || 0)));
        if (d.augJobFill) d.augJobFill.style.width = `${progress}%`;
        if (d.augJobText) {
            const status = job.status ? `${job.status}: ` : "";
            d.augJobText.innerText = `${status}${job.message || ""} (${progress}%)`;
        }
    }

    async function downloadAugmentedZip(filename) {
        const url = `${datasetApiUrl(`/${currentDatasetId}/augment_exports/${encodeURIComponent(filename)}`)}?${authQuery()}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Download failed (${response.status})`);
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = filename || `${currentDatasetId}_augmented.zip`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(objectUrl);
    }

    async function pollAugmentJob(jobId) {
        for (;;) {
            await new Promise((resolve) => setTimeout(resolve, 1500));
            const data = await apiGetJson(`/${currentDatasetId}/augment_jobs/${jobId}`);
            if (!data.success) throw new Error(data.message || "Could not read augmentation job.");
            renderAugJob(data.job);
            if (data.job.status === "completed") {
                await downloadAugmentedZip(data.job.filename);
                setStatus("Augmented export downloaded.");
                return;
            }
            if (data.job.status === "failed") {
                throw new Error(data.job.error || data.job.message || "Augmentation failed.");
            }
        }
    }

    async function augmentExportZip() {
        if (!currentDatasetId) {
            setStatus("Select a dataset to augment.", true);
            return;
        }
        const d = dom();
        try {
            d.augmentExportBtn.disabled = true;
            setStatus("Starting augmented export...");
            const data = await apiPostJson(`/${currentDatasetId}/augment_export`, readAugmentOptions());
            if (!data.success) throw new Error(data.message || "Could not start augmentation.");
            renderAugJob(data.job);
            await pollAugmentJob(data.job.job_id);
        } catch (err) {
            setStatus(`Augmented export failed: ${err.message}`, true);
        } finally {
            d.augmentExportBtn.disabled = !currentDatasetId;
        }
    }

    async function previewAugmentations() {
        if (!currentDatasetId) {
            setStatus("Select a dataset to preview augmentations.", true);
            return;
        }
        const d = dom();
        try {
            d.augmentPreviewBtn.disabled = true;
            if (d.augmentPreviewStatus) d.augmentPreviewStatus.innerText = "Generating preview...";
            const data = await apiPostJson(`/${currentDatasetId}/augment_preview`, readAugmentOptions());
            if (!data.success) throw new Error(data.message || "Could not generate preview.");
            const src = `data:image/jpeg;base64,${data.image_base64}`;
            const fullSrc = data.full_image_base64 ? `data:image/jpeg;base64,${data.full_image_base64}` : src;
            d.augmentPreview.innerHTML = `<img class="preview-img" src="${src}" data-full-src="${fullSrc}" alt="Augmentation contact sheet" title="Open full-size augmentation preview">`;
            d.augmentPreview.classList.add("visible");
            if (d.augmentPreviewStatus) {
                d.augmentPreviewStatus.innerText = `${data.count || 0} examples generated with the current settings.`;
            }
        } catch (err) {
            if (d.augmentPreviewStatus) d.augmentPreviewStatus.innerText = `Preview failed: ${err.message}`;
        } finally {
            d.augmentPreviewBtn.disabled = !currentDatasetId;
        }
    }

    // --- Fine-tune from corrections ---
    function trainApiUrl(kind) {
        // kind: "finetune" | "job" | "jobs"
        if (usesProxyApi()) {
            const map = { finetune: "proxy_finetune", job: "proxy_train_job", jobs: "proxy_train_jobs" };
            return `${proxyBaseUrl()}/${map[kind]}`;
        }
        if (kind === "finetune") return `${proxyBaseUrl()}/__finetune__`; // replaced by caller
        if (kind === "job") return `${proxyBaseUrl()}/train_jobs/status`;
        return `${proxyBaseUrl()}/train_jobs`;
    }

    function formatTrainDuration(ms) {
        const elapsedSec = Math.max(0, Math.floor(Number(ms || 0) / 1000));
        const h = String(Math.floor(elapsedSec / 3600)).padStart(2, "0");
        const m = String(Math.floor((elapsedSec % 3600) / 60)).padStart(2, "0");
        const s = String(elapsedSec % 60).padStart(2, "0");
        return `${h}:${m}:${s}`;
    }

    function trainJobStartMs(job) {
        const parsed = Date.parse(job?.created_at || "");
        return Number.isFinite(parsed) ? parsed : Date.now();
    }

    function trainJobElapsedMs() {
        return activeTrainJobStartedAt ? Math.max(0, Date.now() - activeTrainJobStartedAt) : 0;
    }

    function stopTrainJobTimer() {
        if (activeTrainJobTimer) {
            clearInterval(activeTrainJobTimer);
            activeTrainJobTimer = null;
        }
    }

    function updateTrainJobTimingDisplay(job = activeTrainJobLatest) {
        const d = dom();
        if (!d.trainJobMeta || !job) return;
        const progress = Math.max(0, Math.min(100, Number(job.progress || 0)));
        const elapsedMs = trainJobElapsedMs();
        const terminal = TRAIN_TERMINAL_STATUSES.has(String(job.status || ""));
        let etaText = "Calculating...";
        if (terminal || progress >= 100) {
            etaText = "00:00:00";
        } else if (progress > 0) {
            etaText = formatTrainDuration(elapsedMs * (100 - progress) / progress);
        }
        d.trainJobMeta.innerText = terminal
            ? `Total time: ${formatTrainDuration(elapsedMs)}`
            : `Elapsed: ${formatTrainDuration(elapsedMs)} | ETA: ${etaText}`;
    }

    function startTrainJobTimer(job) {
        if (!job?.job_id) return;
        if (activeTrainJobId !== job.job_id) {
            activeTrainJobId = job.job_id;
            activeTrainJobStartedAt = trainJobStartMs(job);
        }
        if (!activeTrainJobTimer) {
            activeTrainJobTimer = setInterval(() => updateTrainJobTimingDisplay(), 1000);
        }
    }

    function renderTrainJob(job) {
        const d = dom();
        if (!d.trainJob || !job) return;
        d.trainJob.classList.add("visible");
        activeTrainJobLatest = job;
        startTrainJobTimer(job);
        const progress = Math.max(0, Math.min(100, Number(job.progress || 0)));
        if (d.trainJobFill) d.trainJobFill.style.width = `${progress}%`;
        if (d.trainJobText) {
            const status = job.status ? `${job.status}: ` : "";
            let extra = "";
            if (job.decision && typeof job.decision.candidate === "number") {
                const c = job.decision.candidate, b = job.decision.incumbent;
                extra = ` [candidate ${c?.toFixed ? c.toFixed(3) : c}${typeof b === "number" ? ` vs incumbent ${b.toFixed(3)}` : ""}]`;
            }
            d.trainJobText.innerText = `${status}${job.message || ""} (${progress}%)${extra}`;
        }
        updateTrainJobTimingDisplay(job);
        if (TRAIN_TERMINAL_STATUSES.has(String(job.status || ""))) stopTrainJobTimer();
        if (job.base_id && (job.candidate_expert_id || job.expert_id) && d.modelPlan) {
            d.modelPlan.innerText = `Training job: ${job.base_id} → ${job.candidate_expert_id || job.expert_id}.`;
        }
    }

    async function pollTrainJob(jobId) {
        for (;;) {
            await new Promise((resolve) => setTimeout(resolve, 3000));
            let data;
            if (usesProxyApi()) {
                const resp = await fetch(`${trainApiUrl("job")}?job_id=${encodeURIComponent(jobId)}&${authQuery()}`);
                data = await resp.json();
            } else {
                const resp = await fetch(`${proxyBaseUrl()}/train_jobs/status/${jobId}?${authQuery()}`);
                data = await resp.json();
            }
            if (!data.success) throw new Error(data.message || "Could not read training job.");
            renderTrainJob(data.job);
            const st = data.job.status;
            if (st === "promoted") {
                setStatus("Training complete: new model promoted and now active.");
                if (typeof window.refreshExperts === "function") window.refreshExperts();
                return data.job;
            }
            if (st === "rejected") {
                setStatus("Training complete: candidate did not beat the current model; incumbent kept.");
                return data.job;
            }
            if (st === "failed") {
                throw new Error(data.job.error || data.job.message || "Training failed.");
            }
        }
    }

    async function startFinetune(options) {
        const opts = options || {};
        const datasetId = opts.datasetId || currentDatasetId;
        if (!datasetId) {
            setStatus("Select a dataset to fine-tune from.", true);
            return null;
        }
        const d = dom();
        try {
            if (d.finetuneBtn) d.finetuneBtn.disabled = true;
            setStatus("Starting fine-tune from corrections...");
            const body = {
                expert_id: opts.expertId || document.getElementById("model-version-select")?.value || "auto",
                dataset_ids: [datasetId],
                fruit_type: opts.fruitType || null,
                aug_options: readAugmentOptions(),
                password: currentPassword,
                username: currentUsername
            };
            let data;
            if (usesProxyApi()) {
                const resp = await fetch(trainApiUrl("finetune"), {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body)
                });
                data = await resp.json();
            } else {
                const resp = await fetch(`${proxyBaseUrl()}/experts/${encodeURIComponent(body.expert_id)}/finetune`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body)
                });
                data = await resp.json();
            }
            if (!data.success) throw new Error(data.message || "Could not start fine-tune.");
            renderTrainJob(data.job);
            return await pollTrainJob(data.job.job_id);
        } catch (err) {
            stopTrainJobTimer();
            if (activeTrainJobLatest) {
                activeTrainJobLatest = {
                    ...activeTrainJobLatest,
                    status: "failed",
                    message: err.message || "Training failed.",
                    progress: activeTrainJobLatest.progress || 0
                };
                renderTrainJob(activeTrainJobLatest);
            }
            setStatus(`Fine-tune failed: ${err.message}`, true);
            return null;
        } finally {
            if (d.finetuneBtn) d.finetuneBtn.disabled = !currentDatasetId;
        }
    }

    // --- Canvas / paint editor ---
    function clearCanvas() {
        const d = dom();
        baseImage = null;
        imgW = imgH = 0;
        undoStack = [];
        redoStack = [];
        dirty = false;
        hoverPt = null;
        clearPendingTapStroke();
        pendingStroke = null;
        painting = false;
        lastPt = null;
        strokeBefore = null;
        strokeLayer = null;
        strokeTool = null;
        strokeBrushSize = null;
        LAYERS.forEach((layer) => { delete layerCanvas[layer]; });
        if (d.canvas) {
            d.canvas.width = 0;
            d.canvas.height = 0;
            d.canvas.style.display = "none";
        }
        if (d.canvasEmpty) d.canvasEmpty.style.display = "block";
        resetViewport();
        renderQa(null);
        updateButtons();
    }

    function newLayerCanvas() {
        const c = document.createElement("canvas");
        c.width = imgW;
        c.height = imgH;
        return c;
    }

    function loadImageElement(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error("Could not load image."));
            img.src = url;
        });
    }

    async function selectImage(imageId) {
        if (dirty && !window.confirm("Discard unsaved changes to the current image?")) return;
        currentImageId = imageId;
        renderQueue();
        const d = dom();
        try {
            setStatus("Loading image...");
            const imgUrl = `${datasetApiUrl(`/${currentDatasetId}/images/${imageId}`)}?${authQuery()}`;
            const blob = await (await fetch(imgUrl)).blob();
            const objectUrl = URL.createObjectURL(blob);
            baseImage = await loadImageElement(objectUrl);
            URL.revokeObjectURL(objectUrl);
            imgW = baseImage.naturalWidth;
            imgH = baseImage.naturalHeight;

            const maskData = await apiGetJson(`/${currentDatasetId}/images/${imageId}/masks`);
            if (maskData?.class_layers) {
                setClassLayers(maskData.class_layers, { preserveMasks: false });
            }
            LAYERS.forEach((layer) => { layerCanvas[layer] = newLayerCanvas(); });
            undoStack = [];
            redoStack = [];
            dirty = false;
            clearPendingTapStroke();
            pendingStroke = null;
            painting = false;
            lastPt = null;

            if (maskData && maskData.success && maskData.layers) {
                await Promise.all(LAYERS.map((layer) => loadMaskLayer(layer, maskData.layers[layer])));
            }

            setupDisplay();
            composite();
            setStatus("");
        } catch (err) {
            setStatus(`Could not load image: ${err.message}`, true);
        }
        updateButtons();
    }

    async function loadMaskLayer(layer, base64Png) {
        if (!base64Png) return;
        const maskImg = await loadImageElement(`data:image/png;base64,${base64Png}`);
        const scratch = document.createElement("canvas");
        scratch.width = imgW;
        scratch.height = imgH;
        const sctx = scratch.getContext("2d");
        sctx.drawImage(maskImg, 0, 0, imgW, imgH);
        const src = sctx.getImageData(0, 0, imgW, imgH);
        const lctx = layerCanvas[layer].getContext("2d");
        const out = lctx.createImageData(imgW, imgH);
        const [cr, cg, cb] = LAYER_COLORS[layer];
        const data = src.data;
        const od = out.data;
        for (let i = 0; i < data.length; i += 4) {
            if (data[i] > 127) {
                od[i] = cr; od[i + 1] = cg; od[i + 2] = cb; od[i + 3] = 255;
            }
        }
        lctx.putImageData(out, 0, 0);
    }

    function setupDisplay() {
        const d = dom();
        displayScale = Math.min(MAX_DISPLAY_SIDE / imgW, MAX_DISPLAY_SIDE / imgH, 1);
        d.canvas.width = Math.round(imgW * displayScale);
        d.canvas.height = Math.round(imgH * displayScale);
        d.canvas.style.display = "block";
        if (d.canvasEmpty) d.canvasEmpty.style.display = "none";
        displayCtx = d.canvas.getContext("2d");
        resetViewport();
    }

    function applyViewportTransform() {
        const d = dom();
        if (!d.canvas) return;
        d.canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomLevel})`;
        d.canvas.classList.toggle("pan-active", panMode);
        d.canvas.classList.toggle("panning", panning);
        if (d.zoomValue) d.zoomValue.innerText = `${Math.round(zoomLevel * 100)}%`;
    }

    function setZoom(nextZoom) {
        zoomLevel = Math.max(1, Math.min(8, Number(nextZoom) || 1));
        if (zoomLevel === 1) {
            panX = 0;
            panY = 0;
        }
        applyViewportTransform();
        updateButtons();
    }

    function resetViewport() {
        zoomLevel = 1;
        panX = 0;
        panY = 0;
        panMode = false;
        panning = false;
        panStart = null;
        clearPendingTapStroke();
        pendingStroke = null;
        painting = false;
        lastPt = null;
        applyViewportTransform();
    }

    function composite() {
        if (!displayCtx || !baseImage) return;
        const d = dom();
        const w = d.canvas.width;
        const h = d.canvas.height;
        displayCtx.clearRect(0, 0, w, h);
        displayCtx.drawImage(baseImage, 0, 0, w, h);
        LAYERS.forEach((layer) => {
            displayCtx.globalAlpha = layerOpacity[layer];
            displayCtx.drawImage(layerCanvas[layer], 0, 0, w, h);
        });
        displayCtx.globalAlpha = 1;
        if (hoverPt) {
            displayCtx.beginPath();
            displayCtx.arc(hoverPt.dx, hoverPt.dy, (brushSize * displayScale) / 2, 0, Math.PI * 2);
            displayCtx.strokeStyle = tool === "eraser" ? "rgba(255,255,255,0.9)" : "rgba(20,30,40,0.85)";
            displayCtx.lineWidth = 1.5;
            displayCtx.stroke();
        }
    }

    function pointToImage(event) {
        const d = dom();
        const rect = d.canvas.getBoundingClientRect();
        const dx = (event.clientX - rect.left) * (d.canvas.width / rect.width);
        const dy = (event.clientY - rect.top) * (d.canvas.height / rect.height);
        return {
            dx, dy,
            x: dx / displayScale,
            y: dy / displayScale
        };
    }

    function paintSegment(from, to, layer = activeLayer, mode = tool, size = brushSize) {
        const lctx = layerCanvas[layer].getContext("2d");
        lctx.lineCap = "round";
        lctx.lineJoin = "round";
        lctx.lineWidth = size;
        if (mode === "eraser") {
            lctx.globalCompositeOperation = "destination-out";
            lctx.strokeStyle = "rgba(0,0,0,1)";
            lctx.fillStyle = "rgba(0,0,0,1)";
        } else {
            lctx.globalCompositeOperation = "source-over";
            const [r, g, b] = LAYER_COLORS[layer];
            lctx.strokeStyle = `rgb(${r},${g},${b})`;
            lctx.fillStyle = `rgb(${r},${g},${b})`;
        }
        lctx.beginPath();
        lctx.moveTo(from.x, from.y);
        lctx.lineTo(to.x, to.y);
        lctx.stroke();
        // Dot at the endpoint keeps single clicks visible.
        lctx.beginPath();
        lctx.arc(to.x, to.y, brushSize / 2, 0, Math.PI * 2);
        lctx.fill();
        lctx.globalCompositeOperation = "source-over";
    }

    function clearPendingTapStroke() {
        if (!pendingTapStroke) return;
        window.clearTimeout(pendingTapStroke.timer);
        pendingTapStroke = null;
    }

    function commitTapStroke(entry) {
        if (!entry || !baseImage || !layerCanvas[entry.layer]) return;
        paintSegment(entry.pt, entry.pt, entry.layer, entry.tool, entry.size);
        composite();
        undoStack.push({ layer: entry.layer, data: entry.before });
        if (undoStack.length > MAX_UNDO) undoStack.shift();
        redoStack = [];
        dirty = true;
        updateButtons();
    }

    function flushPendingTapStroke() {
        if (!pendingTapStroke) return;
        const entry = pendingTapStroke;
        window.clearTimeout(entry.timer);
        pendingTapStroke = null;
        commitTapStroke(entry);
    }

    function scheduleTapStroke(stroke) {
        clearPendingTapStroke();
        const entry = {
            pt: stroke.startPt,
            layer: stroke.layer,
            before: stroke.before,
            tool: stroke.tool,
            size: stroke.size,
            timer: null
        };
        entry.timer = window.setTimeout(() => {
            if (pendingTapStroke !== entry) return;
            pendingTapStroke = null;
            commitTapStroke(entry);
        }, DOUBLE_CLICK_MS);
        pendingTapStroke = entry;
    }

    function activatePanModeFromDoubleClick(event) {
        clearPendingTapStroke();
        pendingStroke = null;
        painting = false;
        lastPt = null;
        strokeBefore = null;
        strokeLayer = null;
        strokeTool = null;
        strokeBrushSize = null;
        if (!baseImage || zoomLevel <= 1) return;
        panMode = true;
        suppressNextDblClickUntil = Date.now() + DOUBLE_CLICK_MS + 120;
        setStatus("Pan mode on. Drag the image; double-click again to return to painting.");
        beginPan(event);
        applyViewportTransform();
    }

    function beginStroke(event) {
        if (!baseImage || panMode) return;
        if (pendingTapStroke) {
            activatePanModeFromDoubleClick(event);
            return;
        }
        flushPendingTapStroke();
        const pt = pointToImage(event);
        pendingStroke = {
            pointerId: event.pointerId,
            startClientX: event.clientX,
            startClientY: event.clientY,
            startPt: pt,
            layer: activeLayer,
            tool,
            size: brushSize,
            before: layerCanvas[activeLayer].getContext("2d").getImageData(0, 0, imgW, imgH)
        };
        hoverPt = pt;
        composite();
    }

    function startPendingStroke(event) {
        if (!pendingStroke) return;
        painting = true;
        strokeBefore = pendingStroke.before;
        strokeLayer = pendingStroke.layer;
        strokeTool = pendingStroke.tool;
        strokeBrushSize = pendingStroke.size;
        const fromPt = pendingStroke.startPt;
        const toPt = pointToImage(event);
        paintSegment(fromPt, toPt, strokeLayer, strokeTool, strokeBrushSize);
        lastPt = toPt;
        pendingStroke = null;
        composite();
    }

    function moveStroke(event) {
        if (panning && panStart) {
            panX = panStart.panX + (event.clientX - panStart.clientX);
            panY = panStart.panY + (event.clientY - panStart.clientY);
            applyViewportTransform();
            return;
        }
        const pt = pointToImage(event);
        hoverPt = pt;
        if (pendingStroke && pendingStroke.pointerId === event.pointerId) {
            const dx = event.clientX - pendingStroke.startClientX;
            const dy = event.clientY - pendingStroke.startClientY;
            if (Math.hypot(dx, dy) >= STROKE_DRAG_THRESHOLD_PX) {
                startPendingStroke(event);
            }
        }
        if (painting && lastPt) {
            paintSegment(lastPt, pt, strokeLayer || activeLayer, strokeTool || tool, strokeBrushSize || brushSize);
            lastPt = pt;
        }
        composite();
    }

    function endStroke() {
        if (pendingStroke) {
            scheduleTapStroke(pendingStroke);
            pendingStroke = null;
            updateButtons();
            return;
        }
        if (!painting) return;
        painting = false;
        lastPt = null;
        if (strokeBefore) {
            undoStack.push({ layer: strokeLayer || activeLayer, data: strokeBefore });
            if (undoStack.length > MAX_UNDO) undoStack.shift();
            redoStack = [];
            strokeBefore = null;
            strokeLayer = null;
            strokeTool = null;
            strokeBrushSize = null;
            dirty = true;
        }
        updateButtons();
    }

    function beginPan(event) {
        if (!baseImage || zoomLevel <= 1) return;
        panning = true;
        panStart = { clientX: event.clientX, clientY: event.clientY, panX, panY };
        applyViewportTransform();
    }

    function endPan() {
        if (!panning) return;
        panning = false;
        panStart = null;
        applyViewportTransform();
    }

    function undo() {
        if (!undoStack.length) return;
        const entry = undoStack.pop();
        const lctx = layerCanvas[entry.layer].getContext("2d");
        redoStack.push({ layer: entry.layer, data: lctx.getImageData(0, 0, imgW, imgH) });
        lctx.putImageData(entry.data, 0, 0);
        setActiveLayer(entry.layer);
        dirty = true;
        composite();
        updateButtons();
    }

    function redo() {
        if (!redoStack.length) return;
        const entry = redoStack.pop();
        const lctx = layerCanvas[entry.layer].getContext("2d");
        undoStack.push({ layer: entry.layer, data: lctx.getImageData(0, 0, imgW, imgH) });
        lctx.putImageData(entry.data, 0, 0);
        setActiveLayer(entry.layer);
        dirty = true;
        composite();
        updateButtons();
    }

    // Convert a colored, transparent layer canvas to an opaque white-on-black PNG blob.
    function layerToBinaryBlob(layer) {
        const tmp = document.createElement("canvas");
        tmp.width = imgW;
        tmp.height = imgH;
        const t = tmp.getContext("2d");
        t.clearRect(0, 0, imgW, imgH);
        t.drawImage(layerCanvas[layer], 0, 0);
        t.globalCompositeOperation = "source-in";   // recolor painted pixels white
        t.fillStyle = "#ffffff";
        t.fillRect(0, 0, imgW, imgH);
        t.globalCompositeOperation = "destination-over"; // fill black behind
        t.fillStyle = "#000000";
        t.fillRect(0, 0, imgW, imgH);
        t.globalCompositeOperation = "source-over";
        return new Promise((resolve) => tmp.toBlob(resolve, "image/png"));
    }

    async function buildMaskFormData() {
        flushPendingTapStroke();
        const formData = new FormData();
        for (const layer of LAYERS) {
            const blob = await layerToBinaryBlob(layer);
            if (blob) formData.append(layer, blob, `${layer}.png`);
        }
        return formData;
    }

    async function saveDraft(silent) {
        if (!currentImageId) return false;
        try {
            if (!silent) setStatus("Saving...");
            const formData = await buildMaskFormData();
            formData.append("status", "draft");
            const data = await apiSendForm(`/${currentDatasetId}/images/${currentImageId}/masks`, "PUT", formData);
            if (!data.success) throw new Error(data.message || "Save failed.");
            dirty = false;
            updateImageStatus(currentImageId, data.status || "draft");
            if (!silent) setStatus("Saved.");
            return true;
        } catch (err) {
            setStatus(`Save failed: ${err.message}`, true);
            return false;
        }
    }

    async function prelabel() {
        if (!currentImageId) return;
        try {
            setStatus("Running model pre-label...");
            const formData = new FormData();
            formData.append("expert_id", document.getElementById("model-version-select")?.value || "");
            const data = await apiSendForm(`/${currentDatasetId}/images/${currentImageId}/prelabel`, "POST", formData);
            if (!data.success) throw new Error(data.message || "Pre-label failed.");
            if (data.class_layers) setClassLayers(data.class_layers, { preserveMasks: false });
            LAYERS.forEach((layer) => { layerCanvas[layer] = newLayerCanvas(); });
            undoStack = [];
            redoStack = [];
            await Promise.all(LAYERS.map((layer) => loadMaskLayer(layer, data.layers[layer])));
            dirty = true;
            composite();
            updateImageStatus(currentImageId, "prelabeled");
            setStatus("Pre-labeled. Refine with the brush, then approve.");
        } catch (err) {
            setStatus(`Pre-label failed: ${err.message}`, true);
        }
        updateButtons();
    }

    async function approveAndNext() {
        if (!currentImageId) return;
        if (dirty) {
            const ok = await saveDraft(true);
            if (!ok) return;
        }
        try {
            setStatus("Approving...");
            const formData = new FormData();
            const data = await apiSendForm(`/${currentDatasetId}/images/${currentImageId}/approve`, "POST", formData);
            if (!data.success) {
                renderQa(data.warnings || []);
                throw new Error(data.message || "Approve failed.");
            }
            updateImageStatus(currentImageId, "approved");
            renderQa(data.warnings || []);
            const polyMsg = `Approved (${data.polygon_count} polygons).`;
            setStatus(data.warnings && data.warnings.length ? `${polyMsg} See QA notes.` : polyMsg);
            goToNextUnapproved();
        } catch (err) {
            setStatus(`Approve failed: ${err.message}`, true);
        }
        updateButtons();
    }

    function goToNextUnapproved() {
        const idx = images.findIndex((it) => it.image_id === currentImageId);
        for (let offset = 1; offset <= images.length; offset += 1) {
            const candidate = images[(idx + offset) % images.length];
            if (candidate && candidate.status !== "approved") {
                selectImage(candidate.image_id);
                return;
            }
        }
    }

    function updateImageStatus(imageId, status) {
        const entry = images.find((it) => it.image_id === imageId);
        if (entry) entry.status = status;
        renderQueue();
    }

    function renderQa(warnings) {
        const d = dom();
        if (!d.qa) return;
        if (warnings === null) {
            d.qa.innerHTML = `<span class="muted">Approve an image to run QA checks.</span>`;
            return;
        }
        if (!warnings.length) {
            d.qa.innerHTML = `<span class="studio-qa-ok">All checks passed.</span>`;
            return;
        }
        d.qa.innerHTML = warnings.map((w) => `<p class="studio-qa-warn">&#9888; ${esc(w)}</p>`).join("");
    }

    // --- Tools UI ---
    function setActiveLayer(layer) {
        activeLayer = layer;
        const d = dom();
        if (d.opacity) d.opacity.value = String(Math.round(layerOpacity[layer] * 100));
        if (d.opacityVal) d.opacityVal.innerText = String(Math.round(layerOpacity[layer] * 100));
        renderLayerButtons();
        composite();
    }

    function renderLayerButtons() {
        const d = dom();
        if (!d.layerButtons) return;
        d.layerButtons.innerHTML = classLayers.map((entry) => {
            const layer = entry.id;
            const [r, g, b] = LAYER_COLORS[layer] || [120, 120, 120];
            return `<button type="button" class="studio-layer-btn ${layer === activeLayer ? "active" : ""}" data-layer="${layer}">
                <span class="swatch" style="background: rgb(${r},${g},${b});"></span>
                <span class="studio-layer-copy">
                    <span>${esc(LAYER_LABELS[layer])}</span>
                    <small>#${Number(entry.class_id || 0)} ${esc(entry.class_name || layer)}</small>
                </span>
            </button>`;
        }).join("");
    }

    function setTool(next) {
        tool = next;
        panMode = false;
        const d = dom();
        d.brushBtn.classList.toggle("active", tool === "brush");
        d.eraserBtn.classList.toggle("active", tool === "eraser");
        applyViewportTransform();
    }

    function updateButtons() {
        const d = dom();
        const hasImage = Boolean(currentImageId && baseImage);
        if (d.prelabelBtn) d.prelabelBtn.disabled = !hasImage;
        if (d.saveBtn) d.saveBtn.disabled = !hasImage;
        if (d.approveBtn) d.approveBtn.disabled = !hasImage;
        if (d.undoBtn) d.undoBtn.disabled = !undoStack.length;
        if (d.redoBtn) d.redoBtn.disabled = !redoStack.length;
        if (d.exportBtn) d.exportBtn.disabled = !currentDatasetId;
        if (d.augmentExportBtn) d.augmentExportBtn.disabled = !currentDatasetId;
        if (d.finetuneBtn) d.finetuneBtn.disabled = !currentDatasetId;
        if (d.augmentPreviewBtn) d.augmentPreviewBtn.disabled = !currentDatasetId;
        if (d.layerAddBtn) d.layerAddBtn.disabled = !currentDatasetId || classLayers.length >= MAX_CLASS_LAYERS;
        if (d.layerRenameBtn) d.layerRenameBtn.disabled = !currentDatasetId || !activeLayer;
        if (d.layerDeleteBtn) d.layerDeleteBtn.disabled = !currentDatasetId || classLayers.length <= 1;
        if (d.syncPanel) d.syncPanel.classList.toggle("visible", syncAllowed());
        if (d.latentPanel) d.latentPanel.classList.toggle("visible", syncAllowed());
        if (d.syncRefreshBtn) d.syncRefreshBtn.disabled = !syncAllowed();
        if (d.syncPushBtn) d.syncPushBtn.disabled = !syncAllowed();
        if (d.syncPullBtn) d.syncPullBtn.disabled = !syncAllowed();
        if (d.syncExportBtn) d.syncExportBtn.disabled = !syncAllowed();
        if (d.syncDeleteLocalBtn) d.syncDeleteLocalBtn.disabled = !syncAllowed();
        if (d.syncDeleteRemoteBtn) d.syncDeleteRemoteBtn.disabled = !syncAllowed();
        if (d.syncImportInput) d.syncImportInput.disabled = !syncAllowed();
        if (d.latentRefreshBtn) d.latentRefreshBtn.disabled = !syncAllowed();
        if (d.latentResetBtn) d.latentResetBtn.disabled = !syncAllowed() || !latentPoints.length;
        if (d.zoomInBtn) d.zoomInBtn.disabled = !hasImage || zoomLevel >= 8;
        if (d.zoomOutBtn) d.zoomOutBtn.disabled = !hasImage || zoomLevel <= 1;
        if (d.zoomResetBtn) d.zoomResetBtn.disabled = !hasImage || (zoomLevel === 1 && panX === 0 && panY === 0);
    }

    // --- Public hook for the OOD compatibility handoff (used by app.js) ---
    async function createDatasetFromFiles(name, files, options) {
        if (!loggedIn()) return null;
        const opts = options || {};
        try {
            setStatus("Creating dataset from samples...");
            const created = await apiPostJson("", {
                name: name || "Compatibility samples",
                fruit_type: opts.fruitType || "watermelon",
                source: opts.source || "compatibility_check",
                class_layers: opts.classLayers || selectedExpertLayers() || currentClassLayersPayload()
            });
            if (!created.success) throw new Error(created.message || "Create failed.");
            const datasetId = created.dataset.dataset_id;
            datasetsLoaded = false;
            const formData = new FormData();
            [...files].forEach((file) => formData.append("files", file));
            formData.append("password", currentPassword);
            formData.append("username", currentUsername);
            await fetch(datasetApiUrl(`/${datasetId}/images`), { method: "POST", body: formData });
            await loadDatasets(datasetId);
            setStatus("Dataset ready. Pre-label and correct the masks.");
            return datasetId;
        } catch (err) {
            setStatus(`Could not create dataset: ${err.message}`, true);
            return null;
        }
    }

    // --- New "other" fruit onboarding ---
    function slugifyFruit(name) {
        return String(name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
    }

    function pickFiles() {
        return new Promise((resolve) => {
            const input = document.createElement("input");
            input.type = "file";
            input.multiple = true;
            input.accept = ".jpg,.jpeg,.png";
            input.addEventListener("change", () => resolve(input.files));
            input.click();
        });
    }

    async function startNewFruitOnboarding() {
        if (typeof activateTab === "function") activateTab("labeling-panel");
        if (!loggedIn()) {
            setStatus("Log in first to onboard a new fruit.", true);
            return;
        }
        const name = window.prompt("Name the new fruit type (e.g. 'Bell Pepper'):", "");
        if (!name) return;
        const slug = slugifyFruit(name);
        if (!slug) {
            setStatus("Please provide a valid fruit name.", true);
            return;
        }
        setStatus(`Select a few example images of ${name} to label...`);
        const files = await pickFiles();
        if (!files || !files.length) {
            setStatus("Onboarding cancelled (no images selected).", true);
            return;
        }
        const datasetId = await createDatasetFromFiles(`${name} (new fruit)`, files, { fruitType: slug, source: "new_fruit_onboarding" });
        if (!datasetId) return;
        setStatus(`New fruit "${name}" dataset created. Pre-label, correct the masks, Approve a few images, then click "Fine-tune from corrections" to train the new model (seeded from the closest existing model).`);
    }

    // --- Wiring ---
    function bindEvents() {
        const d = dom();
        if (!d.canvas) return;

        document.querySelectorAll(".studio-strength-row input[type='range'][data-output]").forEach((input) => {
            const output = el(input.dataset.output);
            const sync = () => {
                if (output) output.innerText = `${Math.round(Number(input.value || 0) * 100)}%`;
            };
            input.addEventListener("input", sync);
            sync();
        });

        d.exportBtn?.addEventListener("click", exportZip);
        d.augmentExportBtn?.addEventListener("click", augmentExportZip);
        d.augmentPreviewBtn?.addEventListener("click", previewAugmentations);
        d.finetuneBtn?.addEventListener("click", () => startFinetune());
        d.syncRefreshBtn?.addEventListener("click", refreshSyncInventory);
        d.syncPushBtn?.addEventListener("click", pushSelectedToProduction);
        d.syncPullBtn?.addEventListener("click", pullSelectedFromProduction);
        d.syncExportBtn?.addEventListener("click", exportSelectedDevBundle);
        d.syncDeleteLocalBtn?.addEventListener("click", () => deleteSelectedSyncItems("local"));
        d.syncDeleteRemoteBtn?.addEventListener("click", () => deleteSelectedSyncItems("remote"));
        d.syncImportInput?.addEventListener("change", (e) => importBundleToDev(e.target.files?.[0]));
        d.latentRefreshBtn?.addEventListener("click", loadLatentMap);
        d.latentResetBtn?.addEventListener("click", resetLatentView);
        d.latentCanvas?.addEventListener("pointerdown", (e) => {
            if (!syncAllowed()) return;
            latentDragging = true;
            latentDragStart = { x: e.clientX, y: e.clientY, panX: latentPanX, panY: latentPanY };
            d.latentCanvas.setPointerCapture?.(e.pointerId);
            d.latentCanvas.classList.add("dragging");
        });
        d.latentCanvas?.addEventListener("pointermove", (e) => {
            if (latentDragging && latentDragStart) {
                latentPanX = latentDragStart.panX + (e.clientX - latentDragStart.x);
                latentPanY = latentDragStart.panY + (e.clientY - latentDragStart.y);
                drawLatentMap();
                updateLatentTooltip(null, null);
                return;
            }
            latentHovered = nearestLatentPoint(e);
            drawLatentMap();
            updateLatentTooltip(latentHovered, e);
        });
        d.latentCanvas?.addEventListener("pointerup", (e) => {
            latentDragging = false;
            latentDragStart = null;
            d.latentCanvas.releasePointerCapture?.(e.pointerId);
            d.latentCanvas.classList.remove("dragging");
        });
        d.latentCanvas?.addEventListener("pointerleave", () => {
            latentDragging = false;
            latentDragStart = null;
            latentHovered = null;
            d.latentCanvas.classList.remove("dragging");
            updateLatentTooltip(null, null);
            drawLatentMap();
        });
        d.latentCanvas?.addEventListener("wheel", (e) => {
            if (!latentPoints.length) return;
            e.preventDefault();
            const rect = d.latentCanvas.getBoundingClientRect();
            const beforeX = e.clientX - rect.left;
            const beforeY = e.clientY - rect.top;
            const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
            const prevZoom = latentZoom;
            latentZoom = Math.min(18, Math.max(0.35, latentZoom * factor));
            const scaleRatio = latentZoom / prevZoom;
            latentPanX = beforeX - (beforeX - latentPanX) * scaleRatio;
            latentPanY = beforeY - (beforeY - latentPanY) * scaleRatio;
            drawLatentMap();
        }, { passive: false });
        window.addEventListener("resize", drawLatentMap);
        d.datasetSelect?.addEventListener("change", async (e) => {
            if (e.target.value === "__new__") {
                const previous = currentDatasetId || "";
                const created = await createDataset();
                if (!created) e.target.value = previous;
                return;
            }
            await selectDataset(e.target.value);
        });
        d.uploadInput?.addEventListener("change", (e) => {
            uploadImages(e.target.files);
            e.target.value = "";
        });

        d.queueList?.addEventListener("click", (e) => {
            const item = e.target.closest(".studio-queue-item");
            if (item && item.dataset.imageId) selectImage(item.dataset.imageId);
        });

        d.prelabelBtn?.addEventListener("click", prelabel);
        d.undoBtn?.addEventListener("click", undo);
        d.redoBtn?.addEventListener("click", redo);
        d.saveBtn?.addEventListener("click", () => saveDraft(false));
        d.approveBtn?.addEventListener("click", approveAndNext);

        d.brushBtn?.addEventListener("click", () => setTool("brush"));
        d.eraserBtn?.addEventListener("click", () => setTool("eraser"));
        d.layerAddBtn?.addEventListener("click", addClassLayer);
        d.layerRenameBtn?.addEventListener("click", renameClassLayer);
        d.layerDeleteBtn?.addEventListener("click", deleteClassLayer);
        d.layerButtons?.addEventListener("click", (e) => {
            const btn = e.target.closest(".studio-layer-btn");
            if (btn && btn.dataset.layer) setActiveLayer(btn.dataset.layer);
        });

        d.brushSize?.addEventListener("input", (e) => {
            brushSize = Number(e.target.value);
            d.brushSizeVal.innerText = brushSize;
            composite();
        });
        d.opacity?.addEventListener("input", (e) => {
            layerOpacity[activeLayer] = Number(e.target.value) / 100;
            d.opacityVal.innerText = e.target.value;
            composite();
        });

        d.canvas.addEventListener("pointerdown", (e) => {
            d.canvas.setPointerCapture(e.pointerId);
            if (panMode || e.button === 2) {
                flushPendingTapStroke();
                beginPan(e);
            } else {
                beginStroke(e);
            }
        });
        d.canvas.addEventListener("pointermove", moveStroke);
        d.canvas.addEventListener("pointerup", () => { endStroke(); endPan(); });
        d.canvas.addEventListener("pointerleave", () => { hoverPt = null; composite(); });
        d.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
        d.canvas.addEventListener("dblclick", (e) => {
            e.preventDefault();
            if (Date.now() < suppressNextDblClickUntil) return;
            if (!baseImage || zoomLevel <= 1) return;
            panMode = !panMode;
            if (panMode) clearPendingTapStroke();
            setStatus(panMode ? "Pan mode on. Drag the image; double-click again to return to painting." : "Pan mode off.");
            applyViewportTransform();
        });
        window.addEventListener("pointerup", () => { endStroke(); endPan(); });
        d.canvasHost?.addEventListener("wheel", (e) => {
            if (!baseImage) return;
            e.preventDefault();
            setZoom(zoomLevel * (e.deltaY < 0 ? 1.08 : 0.93));
        }, { passive: false });
        d.zoomInBtn?.addEventListener("click", () => setZoom(zoomLevel * 1.2));
        d.zoomOutBtn?.addEventListener("click", () => setZoom(zoomLevel / 1.2));
        d.zoomResetBtn?.addEventListener("click", resetViewport);

        document.addEventListener("keydown", (e) => {
            if (!document.getElementById("labeling-panel")?.classList.contains("active")) return;
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
                e.preventDefault();
                redo();
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
                e.preventDefault();
                if (e.shiftKey) redo(); else undo();
            } else if (e.key === "[") {
                d.brushSize.value = Math.max(3, brushSize - 5);
                d.brushSize.dispatchEvent(new Event("input"));
            } else if (e.key === "]") {
                d.brushSize.value = Math.min(250, brushSize + 5);
                d.brushSize.dispatchEvent(new Event("input"));
            } else if (e.key.toLowerCase() === "b") {
                setTool("brush");
            } else if (e.key.toLowerCase() === "e") {
                setTool("eraser");
            }
        });

        const labelingTab = document.getElementById("labeling-tab");
        labelingTab?.addEventListener("click", () => {
            if (selectedStudioFruit()) ensureDatasetsLoaded();
        });
        document.getElementById("fruit-select")?.addEventListener("change", () => {
            datasetsLoaded = false;
            currentDatasetId = null;
            currentImageId = null;
            images = [];
            if (d.datasetSelect) d.datasetSelect.innerHTML = "";
            renderQueue();
            renderModelPlan(null);
            clearCanvas();
            if (selectedStudioFruit() !== "other" && document.getElementById("labeling-panel")?.classList.contains("active")) {
                ensureDatasetsLoaded();
            }
        });
        document.getElementById("model-version-select")?.addEventListener("change", async () => {
            await maybeAdoptSelectedModelSchema();
            if (currentDatasetId) loadTrainingTarget();
        });
        document.getElementById("model-version-select")?.addEventListener("modelversionchange", async () => {
            await maybeAdoptSelectedModelSchema();
        });

        setClassLayers(DEFAULT_CLASS_LAYERS, { preserveMasks: false });
        renderLayerButtons();
        renderQa(null);
        updateButtons();
    }

    function init() {
        loadLatentColorMap();
        bindEvents();
        // Expose the OOD handoff hook for app.js.
        window.LabelingStudio = {
            open: () => {
                if (typeof activateTab === "function") activateTab("labeling-panel");
                ensureDatasetsLoaded();
            },
            createDatasetFromFiles: async (name, files, options) => {
                if (typeof activateTab === "function") activateTab("labeling-panel");
                await createDatasetFromFiles(name, files, options);
            },
            finetuneDataset: (opts) => startFinetune(opts),
            currentDatasetId: () => currentDatasetId
        };
        window.FruitOnboarding = {
            start: startNewFruitOnboarding
        };
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
