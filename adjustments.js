// Preview adjustment editor: mask repainting and draggable Legacy Features (TA) controls.
(function () {
    "use strict";

    const LAYERS = ["whole", "flesh_left", "flesh_right"];
    const LAYER_LABELS = {
        whole: "Whole fruit",
        flesh_left: "Flesh left",
        flesh_right: "Flesh right"
    };
    const LAYER_COLORS = {
        whole: [0, 210, 210],
        flesh_left: [38, 220, 65],
        flesh_right: [235, 65, 215]
    };
    const MAX_UNDO = 12;

    const state = {
        context: null,
        payload: null,
        source: null,
        mode: "masks",
        activeLayer: "whole",
        tool: "brush",
        brushSize: 40,
        opacity: 0.55,
        layerCanvas: {},
        displayCtx: null,
        painting: false,
        lastPoint: null,
        strokeBefore: null,
        undo: [],
        redo: [],
        dirtyMasks: false,
        dirtyTraditional: false,
        dirtySmoothing: false,
        zoom: 1,
        panMode: false,
        panX: 0,
        panY: 0,
        panning: false,
        panStart: null,
        draggingHandle: null,
        settings: null,
        smoothingLayer: "rind",
        baseCurves: { rind: [], flesh: [] },
        curveAnchors: { rind: [], flesh: [] },
        draggingCurveAnchor: null
    };

    const el = id => document.getElementById(id);
    const dom = () => ({
        modal: el("adjustment-modal"),
        title: el("adjustment-title"),
        subtitle: el("adjustment-subtitle"),
        close: el("adjustment-close-btn"),
        cancel: el("adjustment-cancel-btn"),
        maskMode: el("adjustment-mask-mode-btn"),
        smoothingMode: el("adjustment-smoothing-mode-btn"),
        traditionalMode: el("adjustment-traditional-mode-btn"),
        maskTools: el("adjustment-mask-tools"),
        maskPanel: el("adjustment-mask-panel"),
        traditionalPanel: el("adjustment-traditional-panel"),
        smoothingPanel: el("adjustment-smoothing-panel"),
        canvas: el("adjustment-canvas"),
        canvasHost: el("adjustment-canvas-host"),
        canvasStatus: el("adjustment-canvas-status"),
        layerButtons: el("adjustment-layer-buttons"),
        brush: el("adjustment-brush-btn"),
        eraser: el("adjustment-eraser-btn"),
        undo: el("adjustment-undo-btn"),
        redo: el("adjustment-redo-btn"),
        brushSize: el("adjustment-brush-size"),
        opacity: el("adjustment-opacity"),
        zoomOut: el("adjustment-zoom-out-btn"),
        zoomIn: el("adjustment-zoom-in-btn"),
        zoomReset: el("adjustment-zoom-reset-btn"),
        zoomValue: el("adjustment-zoom-value"),
        values: el("adjustment-traditional-values"),
        rindCurve: el("adjustment-rind-curve-btn"),
        fleshCurve: el("adjustment-flesh-curve-btn"),
        clearAnchors: el("adjustment-clear-anchors-btn"),
        anchorCount: el("adjustment-anchor-count"),
        status: el("adjustment-status"),
        saveRow: el("adjustment-save-row-btn"),
        saveBatch: el("adjustment-save-batch-btn"),
        finetune: el("adjustment-finetune-btn")
    });

    function host() {
        return window.PhenotypeAdjustmentsHost;
    }

    function setStatus(message, error = false) {
        const node = dom().status;
        node.textContent = message || "";
        node.classList.toggle("error", Boolean(error));
    }

    function apiUrl(path) {
        return `${host().apiBase()}${path}`;
    }

    async function jsonResponse(response) {
        const text = await response.text();
        let data = {};
        try {
            data = text ? JSON.parse(text) : {};
        } catch {
            data = { message: text.slice(0, 220) };
        }
        if (!response.ok || data.success === false) {
            throw new Error(data.detail || data.message || `HTTP ${response.status}`);
        }
        return data;
    }

    function loadImage(src) {
        return new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error("Could not load editable image data."));
            image.src = src;
        });
    }

    function dataImage(base64, type = "jpeg") {
        return `data:image/${type};base64,${base64}`;
    }

    function newLayerCanvas() {
        const canvas = document.createElement("canvas");
        canvas.width = state.source.naturalWidth;
        canvas.height = state.source.naturalHeight;
        return canvas;
    }

    async function loadMaskLayer(layer, base64) {
        const canvas = newLayerCanvas();
        state.layerCanvas[layer] = canvas;
        if (!base64) return;
        const image = await loadImage(dataImage(base64, "png"));
        const scratch = document.createElement("canvas");
        scratch.width = canvas.width;
        scratch.height = canvas.height;
        const scratchCtx = scratch.getContext("2d");
        scratchCtx.drawImage(image, 0, 0, canvas.width, canvas.height);
        const source = scratchCtx.getImageData(0, 0, canvas.width, canvas.height);
        const targetCtx = canvas.getContext("2d");
        const target = targetCtx.createImageData(canvas.width, canvas.height);
        const [r, g, b] = LAYER_COLORS[layer];
        for (let i = 0; i < source.data.length; i += 4) {
            if (source.data[i] > 127) {
                target.data[i] = r;
                target.data[i + 1] = g;
                target.data[i + 2] = b;
                target.data[i + 3] = 255;
            }
        }
        targetCtx.putImageData(target, 0, 0);
    }

    function setupCanvas() {
        const d = dom();
        d.canvas.width = state.source.naturalWidth;
        d.canvas.height = state.source.naturalHeight;
        state.displayCtx = d.canvas.getContext("2d");
        d.canvas.style.display = "block";
        d.canvasStatus.style.display = "none";
        resetViewport();
        composite();
    }

    function applyViewport() {
        const d = dom();
        d.canvas.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
        d.canvas.classList.toggle("pan-active", state.panMode || state.panning);
        d.canvas.classList.toggle("panning", state.panning);
        d.zoomValue.textContent = `${Math.round(state.zoom * 100)}%`;
    }

    function setZoom(value) {
        state.zoom = Math.max(1, Math.min(8, Number(value) || 1));
        if (state.zoom === 1) {
            state.panX = 0;
            state.panY = 0;
            state.panMode = false;
        }
        applyViewport();
    }

    function resetViewport() {
        state.zoom = 1;
        state.panX = 0;
        state.panY = 0;
        state.panning = false;
        state.panMode = false;
        state.panStart = null;
        applyViewport();
    }

    function pointToImage(event) {
        const canvas = dom().canvas;
        const rect = canvas.getBoundingClientRect();
        return {
            x: (event.clientX - rect.left) * canvas.width / Math.max(rect.width, 1),
            y: (event.clientY - rect.top) * canvas.height / Math.max(rect.height, 1),
            threshold: 20 * canvas.width / Math.max(rect.width, 1)
        };
    }

    function drawMaskComposite(ctx) {
        const width = dom().canvas.width;
        const height = dom().canvas.height;
        ctx.drawImage(state.source, 0, 0, width, height);
        LAYERS.forEach(layer => {
            ctx.globalAlpha = layer === state.activeLayer ? state.opacity : Math.min(0.32, state.opacity);
            ctx.drawImage(state.layerCanvas[layer], 0, 0, width, height);
        });
        ctx.globalAlpha = 1;
    }

    function lerp(a, b, fraction) {
        return {
            x: a.x + (b.x - a.x) * fraction,
            y: a.y + (b.y - a.y) * fraction
        };
    }

    function geometry() {
        const payloadGeometry = state.payload?.geometry || {};
        const height = payloadGeometry.height_line || [];
        const width = payloadGeometry.width_line || [];
        if (height.length !== 2 || width.length !== 2) {
            const w = dom().canvas.width;
            const h = dom().canvas.height;
            return {
                proximal: { x: w / 2, y: h * 0.08 },
                distal: { x: w / 2, y: h * 0.92 },
                left: { x: w * 0.12, y: h / 2 },
                right: { x: w * 0.88, y: h / 2 }
            };
        }
        return {
            proximal: { x: height[0][0], y: height[0][1] },
            distal: { x: height[1][0], y: height[1][1] },
            left: { x: width[0][0], y: width[0][1] },
            right: { x: width[1][0], y: width[1][1] }
        };
    }

    function normalized(vector) {
        const length = Math.hypot(vector.x, vector.y) || 1;
        return { x: vector.x / length, y: vector.y / length, length };
    }

    function traditionalHandles() {
        const g = geometry();
        const settings = state.settings;
        const widthVector = normalized({ x: g.right.x - g.left.x, y: g.right.y - g.left.y });
        const proxWidth = lerp(g.proximal, g.distal, settings.proximal_width_percent / 100);
        const distWidth = lerp(g.proximal, g.distal, 1 - settings.distal_width_percent / 100);
        const proxIndent = lerp(g.proximal, g.distal, settings.end_indentation_percent / 100);
        const distIndent = lerp(g.proximal, g.distal, 1 - settings.end_indentation_percent / 100);
        const angleOffset = widthVector.length * settings.angle_sample_percent / 100;
        const offset = { x: widthVector.x * angleOffset, y: widthVector.y * angleOffset };
        return {
            proxWidth,
            distWidth,
            proxIndent,
            distIndent,
            angleProxLeft: { x: g.proximal.x - offset.x, y: g.proximal.y - offset.y },
            angleProxRight: { x: g.proximal.x + offset.x, y: g.proximal.y + offset.y },
            angleDistLeft: { x: g.distal.x - offset.x, y: g.distal.y - offset.y },
            angleDistRight: { x: g.distal.x + offset.x, y: g.distal.y + offset.y }
        };
    }

    function drawLineAcrossAxis(ctx, center, unit, halfLength, color, width = 4) {
        ctx.strokeStyle = color;
        ctx.lineWidth = width * Math.max(1, Math.max(ctx.canvas.width, ctx.canvas.height) / 900);
        ctx.beginPath();
        ctx.moveTo(center.x - unit.x * halfLength, center.y - unit.y * halfLength);
        ctx.lineTo(center.x + unit.x * halfLength, center.y + unit.y * halfLength);
        ctx.stroke();
    }

    function drawHandle(ctx, point, color, label) {
        const scale = Math.max(1, Math.max(ctx.canvas.width, ctx.canvas.height) / 900);
        ctx.fillStyle = color;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 3 * scale;
        ctx.beginPath();
        ctx.arc(point.x, point.y, 11 * scale, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        if (label) {
            ctx.font = `bold ${24 * scale}px sans-serif`;
            ctx.fillStyle = color;
            ctx.fillText(label, point.x + 15 * scale, point.y - 13 * scale);
        }
    }

    function drawTraditionalComposite(ctx) {
        const canvas = dom().canvas;
        ctx.drawImage(state.source, 0, 0, canvas.width, canvas.height);
        ctx.globalAlpha = 0.18;
        ctx.drawImage(state.layerCanvas.whole, 0, 0, canvas.width, canvas.height);
        ctx.globalAlpha = 1;

        const g = geometry();
        const handles = traditionalHandles();
        const widthUnit = normalized({ x: g.right.x - g.left.x, y: g.right.y - g.left.y });
        const crossHalf = widthUnit.length * 0.48;

        ctx.strokeStyle = "#d34f9d";
        ctx.lineWidth = 3 * Math.max(1, Math.max(ctx.canvas.width, ctx.canvas.height) / 900);
        ctx.beginPath();
        ctx.moveTo(g.proximal.x, g.proximal.y);
        ctx.lineTo(g.distal.x, g.distal.y);
        ctx.stroke();
        ctx.strokeStyle = "#1e9bb8";
        ctx.beginPath();
        ctx.moveTo(g.left.x, g.left.y);
        ctx.lineTo(g.right.x, g.right.y);
        ctx.stroke();

        drawLineAcrossAxis(ctx, handles.proxWidth, widthUnit, crossHalf, "#00b7d8");
        drawLineAcrossAxis(ctx, handles.distWidth, widthUnit, crossHalf, "#ff9f1c");
        drawLineAcrossAxis(ctx, handles.proxIndent, widthUnit, crossHalf, "#39e639", 3);
        drawLineAcrossAxis(ctx, handles.distIndent, widthUnit, crossHalf, "#39e639", 3);
        drawHandle(ctx, handles.proxWidth, "#00b7d8", "prox width");
        drawHandle(ctx, handles.distWidth, "#ff9f1c", "dist width");
        drawHandle(ctx, handles.proxIndent, "#39e639", "indent band");
        drawHandle(ctx, handles.distIndent, "#39e639", "");

        ["angleProxLeft", "angleProxRight", "angleDistLeft", "angleDistRight"].forEach((key, index) => {
            drawHandle(ctx, handles[key], "#8a5bd1", index === 0 ? "angle span" : "");
        });
        ctx.setLineDash([8, 6]);
        ctx.strokeStyle = "#8a5bd1";
        ctx.lineWidth = 3;
        for (const apex of [g.proximal, g.distal]) {
            const offset = widthUnit.length * state.settings.angle_sample_percent / 100;
            ctx.beginPath();
            ctx.moveTo(apex.x - widthUnit.x * offset, apex.y - widthUnit.y * offset);
            ctx.lineTo(apex.x + widthUnit.x * offset, apex.y + widthUnit.y * offset);
            ctx.stroke();
        }
        ctx.setLineDash([]);
    }

    function curvePoints(layer) {
        const base = state.baseCurves[layer] || [];
        const anchors = state.curveAnchors[layer] || [];
        if (!base.length || !anchors.length) return base.map(point => ({ ...point }));
        const count = base.length;
        return base.map((point, index) => {
            let offsetX = 0;
            let offsetY = 0;
            anchors.forEach(anchor => {
                const circularDistance = Math.min(
                    Math.abs(index - anchor.index),
                    count - Math.abs(index - anchor.index)
                );
                const sigma = Math.max(1.5, count * 0.045);
                const weight = Math.exp(-0.5 * (circularDistance / sigma) ** 2);
                const originX = Number.isFinite(anchor.originX) ? anchor.originX : (base[anchor.index]?.x || point.x);
                const originY = Number.isFinite(anchor.originY) ? anchor.originY : (base[anchor.index]?.y || point.y);
                offsetX += (anchor.x - originX) * weight;
                offsetY += (anchor.y - originY) * weight;
            });
            return {
                x: point.x + offsetX,
                y: point.y + offsetY
            };
        });
    }

    function strokeClosedCurve(ctx, points, color, width) {
        if (!points || points.length < 2) return;
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
        ctx.closePath();
        ctx.stroke();
    }

    function drawSmoothingComposite(ctx) {
        const canvas = dom().canvas;
        ctx.drawImage(state.source, 0, 0, canvas.width, canvas.height);
        ctx.globalAlpha = 0.16;
        ctx.drawImage(state.layerCanvas.whole, 0, 0, canvas.width, canvas.height);
        ctx.drawImage(state.layerCanvas.flesh_left, 0, 0, canvas.width, canvas.height);
        ctx.drawImage(state.layerCanvas.flesh_right, 0, 0, canvas.width, canvas.height);
        ctx.globalAlpha = 1;

        const scale = Math.max(1, Math.max(canvas.width, canvas.height) / 900);
        const rind = curvePoints("rind");
        const flesh = curvePoints("flesh");
        strokeClosedCurve(ctx, rind, state.smoothingLayer === "rind" ? "#7d42c3" : "#5b9564", 5 * scale);
        strokeClosedCurve(ctx, flesh, state.smoothingLayer === "flesh" ? "#e52d8a" : "#c85d92", 5 * scale);

        for (const layer of ["rind", "flesh"]) {
            const active = layer === state.smoothingLayer;
            const color = layer === "rind" ? "#7d42c3" : "#e52d8a";
            (state.curveAnchors[layer] || []).forEach(anchor => {
                ctx.fillStyle = color;
                ctx.strokeStyle = "#fff";
                ctx.lineWidth = 3 * scale;
                ctx.beginPath();
                ctx.arc(anchor.x, anchor.y, (active ? 10 : 7) * scale, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
            });
        }
    }

    function composite() {
        if (!state.displayCtx || !state.source) return;
        const canvas = dom().canvas;
        state.displayCtx.clearRect(0, 0, canvas.width, canvas.height);
        if (state.mode === "traditional") drawTraditionalComposite(state.displayCtx);
        else if (state.mode === "smoothing") drawSmoothingComposite(state.displayCtx);
        else drawMaskComposite(state.displayCtx);
    }

    function renderLayers() {
        const container = dom().layerButtons;
        container.innerHTML = LAYERS.map(layer => {
            const [r, g, b] = LAYER_COLORS[layer];
            return `<button type="button" class="adjustment-layer-btn ${layer === state.activeLayer ? "active" : ""}" data-layer="${layer}">
                <span class="swatch" style="background:rgb(${r},${g},${b})"></span>${LAYER_LABELS[layer]}
            </button>`;
        }).join("");
    }

    function renderTraditionalValues() {
        const s = state.settings;
        dom().values.innerHTML = [
            ["Proximal width position", `${s.proximal_width_percent.toFixed(1)}%`],
            ["Distal width position", `${s.distal_width_percent.toFixed(1)}%`],
            ["Angle sample span", `${s.angle_sample_percent.toFixed(1)}%`],
            ["End indentation band", `${s.end_indentation_percent.toFixed(1)}%`]
        ].map(([label, value]) => `<div class="adjustment-value-row"><span>${label}</span><strong>${value}</strong></div>`).join("");
    }

    function renderAnchorCount() {
        const rindCount = state.curveAnchors.rind.length;
        const fleshCount = state.curveAnchors.flesh.length;
        dom().anchorCount.textContent = `${rindCount} rind anchor${rindCount === 1 ? "" : "s"} · ${fleshCount} flesh anchor${fleshCount === 1 ? "" : "s"}`;
    }

    function setMode(mode) {
        state.mode = mode;
        const d = dom();
        d.maskMode.classList.toggle("active", mode === "masks");
        d.smoothingMode.classList.toggle("active", mode === "smoothing");
        d.traditionalMode.classList.toggle("active", mode === "traditional");
        d.maskTools.hidden = mode !== "masks";
        d.maskPanel.hidden = mode !== "masks";
        d.smoothingPanel.hidden = mode !== "smoothing";
        d.traditionalPanel.hidden = mode !== "traditional";
        d.saveRow.textContent = mode === "masks"
            ? "Save Corrected Masks"
            : mode === "smoothing"
                ? "Refit Smoothing Curve"
                : "Save This Image";
        d.saveBatch.hidden = mode !== "traditional" || !state.payload?.is_batch;
        const missingCurve = mode === "smoothing"
            && !state.baseCurves.rind.length
            && !state.baseCurves.flesh.length;
        d.saveRow.disabled = missingCurve;
        renderAnchorCount();
        if (missingCurve) setStatus("No smoothing curve is available for this row.", true);
        composite();
    }

    function setBusy(busy) {
        const d = dom();
        [d.saveBatch, d.cancel, d.close].forEach(button => {
            if (button) button.disabled = Boolean(busy);
        });
        if (d.saveRow) {
            const missingCurve = state.mode === "smoothing"
                && !state.baseCurves.rind.length
                && !state.baseCurves.flesh.length;
            d.saveRow.disabled = Boolean(busy) || missingCurve;
        }
        if (d.finetune) d.finetune.disabled = Boolean(busy) || !state.payload?.can_finetune;
    }

    async function fetchPayload(context) {
        const credentials = host().credentials();
        const params = new URLSearchParams({ ...credentials, _t: String(Date.now()) });
        return jsonResponse(await fetch(
            apiUrl(`/${encodeURIComponent(context.sessionId)}/${encodeURIComponent(context.rowId)}?${params}`)
        ));
    }

    function normalizedCurve(rawPoints) {
        return (rawPoints || []).map(point => ({
            x: Number(point[0]),
            y: Number(point[1])
        })).filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
    }

    function nearestCurveIndex(curve, point) {
        let bestIndex = -1;
        let bestDistance = Infinity;
        curve.forEach((candidate, index) => {
            const distance = Math.hypot(candidate.x - point.x, candidate.y - point.y);
            if (distance < bestDistance) {
                bestIndex = index;
                bestDistance = distance;
            }
        });
        return { index: bestIndex, distance: bestDistance };
    }

    function initializeSmoothingState(payload) {
        state.baseCurves = {
            rind: normalizedCurve(payload.geometry?.smoothed_rind_curve),
            flesh: normalizedCurve(payload.geometry?.smoothed_flesh_curve)
        };
        state.curveAnchors = { rind: [], flesh: [] };
        for (const layer of ["rind", "flesh"]) {
            (payload.smoothing_constraints?.[layer] || []).forEach(entry => {
                const point = { x: Number(entry.x), y: Number(entry.y) };
                const nearest = nearestCurveIndex(state.baseCurves[layer], point);
                if (nearest.index >= 0) {
                    state.curveAnchors[layer].push({
                        ...point,
                        index: nearest.index,
                        originX: point.x,
                        originY: point.y
                    });
                }
            });
        }
        state.smoothingLayer = state.baseCurves.rind.length ? "rind" : "flesh";
        dom().rindCurve.disabled = !state.baseCurves.rind.length;
        dom().fleshCurve.disabled = !state.baseCurves.flesh.length;
        dom().rindCurve.classList.toggle("active", state.smoothingLayer === "rind");
        dom().fleshCurve.classList.toggle("active", state.smoothingLayer === "flesh");
        renderAnchorCount();
    }

    async function open(context) {
        if (!context?.sessionId || !context?.rowId) {
            setStatus("This preview does not have editable session artifacts.", true);
            return;
        }
        state.context = context;
        state.payload = null;
        state.dirtyMasks = false;
        state.dirtyTraditional = false;
        state.dirtySmoothing = false;
        state.undo = [];
        state.redo = [];
        const d = dom();
        d.modal.classList.add("open");
        d.modal.setAttribute("aria-hidden", "false");
        d.canvas.style.display = "none";
        d.canvasStatus.style.display = "block";
        d.canvasStatus.textContent = "Loading editable artifacts...";
        d.subtitle.textContent = context.filename || "";
        setStatus("");
        setBusy(true);
        try {
            const payload = await fetchPayload(context);
            state.payload = payload;
            d.subtitle.textContent = `${payload.filename || context.filename || ""} · Masks from ${payload.model_id || "active model"}`;
            state.settings = { ...payload.traditional_settings };
            initializeSmoothingState(payload);
            state.source = await loadImage(dataImage(payload.source_base64));
            await Promise.all(LAYERS.map(layer => loadMaskLayer(layer, payload.masks?.[layer])));
            renderLayers();
            renderTraditionalValues();
            setupCanvas();
            d.finetune.hidden = !payload.mask_corrected;
            d.finetune.disabled = !payload.can_finetune;
            d.finetune.title = payload.can_finetune
                ? "Fine-tune the selected fruit model from saved mask corrections."
                : "Fine-tuning becomes available after the full batch completes.";
            setMode(
                context.previewType === "image_traditional_base64"
                    ? "traditional"
                    : context.previewType === "image_sm_base64"
                        ? "smoothing"
                        : "masks"
            );
        } catch (error) {
            d.canvasStatus.textContent = "Editable artifacts unavailable.";
            setStatus(error.message, true);
        } finally {
            setBusy(false);
        }
    }

    function close(force = false) {
        if (!force && (state.dirtyMasks || state.dirtyTraditional || state.dirtySmoothing) && !window.confirm("Discard unsaved adjustments?")) return;
        const d = dom();
        d.modal.classList.remove("open");
        d.modal.setAttribute("aria-hidden", "true");
        state.context = null;
        state.payload = null;
        state.source = null;
        state.layerCanvas = {};
        state.displayCtx = null;
    }

    function beginPan(event) {
        if (state.zoom <= 1) return false;
        if (event.button !== 2 && !event.shiftKey && !state.panMode) return false;
        state.panning = true;
        state.panStart = {
            clientX: event.clientX,
            clientY: event.clientY,
            panX: state.panX,
            panY: state.panY
        };
        applyViewport();
        return true;
    }

    function paintSegment(from, to) {
        const ctx = state.layerCanvas[state.activeLayer].getContext("2d");
        const [r, g, b] = LAYER_COLORS[state.activeLayer];
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.lineWidth = state.brushSize;
        ctx.globalCompositeOperation = state.tool === "eraser" ? "destination-out" : "source-over";
        ctx.strokeStyle = state.tool === "eraser" ? "#000" : `rgb(${r},${g},${b})`;
        ctx.fillStyle = ctx.strokeStyle;
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(to.x, to.y, state.brushSize / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = "source-over";
    }

    function nearestTraditionalHandle(point) {
        const handles = traditionalHandles();
        let best = null;
        Object.entries(handles).forEach(([key, handle]) => {
            const distance = Math.hypot(point.x - handle.x, point.y - handle.y);
            if (distance <= point.threshold && (!best || distance < best.distance)) best = { key, distance };
        });
        return best?.key || null;
    }

    function beginCurveDrag(point) {
        const layer = state.smoothingLayer;
        const curve = curvePoints(layer);
        const nearest = nearestCurveIndex(curve, point);
        if (nearest.index < 0 || nearest.distance > point.threshold * 1.8) return;
        let anchorIndex = state.curveAnchors[layer].findIndex(anchor => (
            Math.min(
                Math.abs(anchor.index - nearest.index),
                curve.length - Math.abs(anchor.index - nearest.index)
            ) <= 1
        ));
        if (anchorIndex < 0) {
            if (state.curveAnchors[layer].length >= 16) {
                setStatus("A curve can use at most 16 anchors. Clear or move an existing anchor.", true);
                return;
            }
            state.curveAnchors[layer].push({
                index: nearest.index,
                x: curve[nearest.index].x,
                y: curve[nearest.index].y,
                originX: curve[nearest.index].x,
                originY: curve[nearest.index].y
            });
            anchorIndex = state.curveAnchors[layer].length - 1;
        }
        state.draggingCurveAnchor = { layer, anchorIndex };
        setStatus("Drag the anchor to the desired fitted boundary, then save to refit.");
    }

    function beginPointer(event) {
        if (!state.source || beginPan(event)) return;
        const point = pointToImage(event);
        if (state.mode === "traditional") {
            state.draggingHandle = nearestTraditionalHandle(point);
            return;
        }
        if (state.mode === "smoothing") {
            beginCurveDrag(point);
            composite();
            return;
        }
        state.painting = true;
        const ctx = state.layerCanvas[state.activeLayer].getContext("2d");
        state.strokeBefore = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
        state.lastPoint = point;
        paintSegment(point, point);
        composite();
    }

    function updateTraditionalDrag(point) {
        const key = state.draggingHandle;
        if (!key) return;
        const g = geometry();
        const heightVector = { x: g.distal.x - g.proximal.x, y: g.distal.y - g.proximal.y };
        const heightLength2 = Math.max(1, heightVector.x ** 2 + heightVector.y ** 2);
        const heightFraction = (
            (point.x - g.proximal.x) * heightVector.x
            + (point.y - g.proximal.y) * heightVector.y
        ) / heightLength2;
        if (key === "proxWidth") {
            state.settings.proximal_width_percent = Math.max(2, Math.min(30, heightFraction * 100));
        } else if (key === "distWidth") {
            state.settings.distal_width_percent = Math.max(2, Math.min(30, (1 - heightFraction) * 100));
        } else if (key === "proxIndent" || key === "distIndent") {
            const fraction = key === "proxIndent" ? heightFraction : 1 - heightFraction;
            state.settings.end_indentation_percent = Math.max(5, Math.min(40, fraction * 100));
        } else if (key.startsWith("angle")) {
            const widthVector = { x: g.right.x - g.left.x, y: g.right.y - g.left.y };
            const widthLength = Math.max(1, Math.hypot(widthVector.x, widthVector.y));
            const widthUnit = { x: widthVector.x / widthLength, y: widthVector.y / widthLength };
            const apex = key.includes("Prox") ? g.proximal : g.distal;
            const projected = Math.abs((point.x - apex.x) * widthUnit.x + (point.y - apex.y) * widthUnit.y);
            state.settings.angle_sample_percent = Math.max(0.5, Math.min(15, projected / widthLength * 100));
        }
        state.dirtyTraditional = true;
        renderTraditionalValues();
        composite();
    }

    function movePointer(event) {
        if (state.panning && state.panStart) {
            state.panX = state.panStart.panX + event.clientX - state.panStart.clientX;
            state.panY = state.panStart.panY + event.clientY - state.panStart.clientY;
            applyViewport();
            return;
        }
        const point = pointToImage(event);
        if (state.mode === "traditional") {
            updateTraditionalDrag(point);
        } else if (state.mode === "smoothing" && state.draggingCurveAnchor) {
            const { layer, anchorIndex } = state.draggingCurveAnchor;
            const anchor = state.curveAnchors[layer][anchorIndex];
            if (anchor) {
                anchor.x = Math.max(0, Math.min(dom().canvas.width - 1, point.x));
                anchor.y = Math.max(0, Math.min(dom().canvas.height - 1, point.y));
                state.dirtySmoothing = true;
                renderAnchorCount();
                composite();
            }
        } else if (state.painting && state.lastPoint) {
            paintSegment(state.lastPoint, point);
            state.lastPoint = point;
            composite();
        }
    }

    function endPointer() {
        if (state.panning) {
            state.panning = false;
            state.panStart = null;
            applyViewport();
        }
        if (state.painting) {
            state.painting = false;
            state.lastPoint = null;
            if (state.strokeBefore) {
                state.undo.push({ layer: state.activeLayer, imageData: state.strokeBefore });
                if (state.undo.length > MAX_UNDO) state.undo.shift();
                state.redo = [];
                state.strokeBefore = null;
                state.dirtyMasks = true;
            }
        }
        state.draggingHandle = null;
        state.draggingCurveAnchor = null;
    }

    function layerToBlob(layer) {
        const sourceCanvas = state.layerCanvas[layer];
        const canvas = document.createElement("canvas");
        canvas.width = sourceCanvas.width;
        canvas.height = sourceCanvas.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(sourceCanvas, 0, 0);
        ctx.globalCompositeOperation = "source-in";
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.globalCompositeOperation = "destination-over";
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        return new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    }

    async function saveMasks() {
        setBusy(true);
        setStatus("Saving corrected masks...");
        try {
            const credentials = host().credentials();
            const form = new FormData();
            for (const layer of LAYERS) {
                form.append(layer, await layerToBlob(layer), `${layer}.png`);
            }
            form.append("username", credentials.username);
            form.append("password", credentials.password);
            const response = await fetch(
                apiUrl(`/${encodeURIComponent(state.context.sessionId)}/${encodeURIComponent(state.context.rowId)}/masks`),
                { method: "PUT", body: form }
            );
            const data = await jsonResponse(response);
            setStatus("Masks saved. Recalculating cleanup, smoothing, and TA outputs...");
            await host().recomputeMasks(state.context.sessionId, data.row_ids);
            const refreshed = await fetchPayload(state.context);
            state.payload = refreshed;
            state.settings = { ...refreshed.traditional_settings };
            state.dirtyMasks = false;
            dom().finetune.hidden = false;
            dom().finetune.disabled = !state.payload.can_finetune;
            renderTraditionalValues();
            composite();
            setStatus(state.payload.can_finetune
                ? "Correction saved and outputs recalculated. Fine-tuning is ready."
                : "Correction saved and outputs recalculated. Fine-tuning unlocks when the full batch completes.");
        } catch (error) {
            setStatus(error.message, true);
        } finally {
            setBusy(false);
        }
    }

    async function saveTraditional(scope) {
        setBusy(true);
        setStatus(scope === "batch" ? "Applying settings to the batch..." : "Saving traditional settings...");
        try {
            const credentials = host().credentials();
            const response = await fetch(
                apiUrl(`/${encodeURIComponent(state.context.sessionId)}/${encodeURIComponent(state.context.rowId)}/traditional`),
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ ...credentials, scope, settings: state.settings })
                }
            );
            const data = await jsonResponse(response);
            setStatus(`Settings saved. Recalculating ${data.row_ids.length} image${data.row_ids.length === 1 ? "" : "s"}...`);
            await host().recomputeTraditional(state.context.sessionId, data.row_ids, data.traditional_settings);
            state.settings = { ...data.traditional_settings };
            state.dirtyTraditional = false;
            renderTraditionalValues();
            composite();
            setStatus(scope === "batch"
                ? "Traditional settings applied to completed rows and saved for future batch images."
                : "Traditional settings saved for this image.");
        } catch (error) {
            setStatus(error.message, true);
        } finally {
            setBusy(false);
        }
    }

    async function saveSmoothing() {
        setBusy(true);
        setStatus("Saving curve anchors and refitting all smoothing parameters...");
        try {
            const credentials = host().credentials();
            const constraints = {
                rind: state.curveAnchors.rind.map(({ x, y }) => ({ x, y })),
                flesh: state.curveAnchors.flesh.map(({ x, y }) => ({ x, y }))
            };
            const response = await fetch(
                apiUrl(`/${encodeURIComponent(state.context.sessionId)}/${encodeURIComponent(state.context.rowId)}/smoothing`),
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ ...credentials, constraints })
                }
            );
            const data = await jsonResponse(response);
            await host().recomputeSmoothing(state.context.sessionId, data.row_ids);
            const refreshed = await fetchPayload(state.context);
            state.payload = refreshed;
            initializeSmoothingState(refreshed);
            state.dirtySmoothing = false;
            composite();
            setStatus("Smoothing curve refit complete. All function parameters were optimized together.");
        } catch (error) {
            setStatus(error.message, true);
        } finally {
            setBusy(false);
        }
    }

    async function startFinetune() {
        setBusy(true);
        setStatus("Queueing fine-tune from saved corrections...");
        try {
            const credentials = host().credentials();
            const response = await fetch(
                apiUrl(`/${encodeURIComponent(state.context.sessionId)}/finetune`),
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        ...credentials,
                        expert_id: "auto"
                    })
                }
            );
            const data = await jsonResponse(response);
            setStatus(`Fine-tune queued: ${data.job?.job_id || "training job created"}. Progress is available in Labeling Studio.`);
        } catch (error) {
            setStatus(error.message, true);
        } finally {
            setBusy(false);
        }
    }

    function undo() {
        const entry = state.undo.pop();
        if (!entry) return;
        const ctx = state.layerCanvas[entry.layer].getContext("2d");
        state.redo.push({ layer: entry.layer, imageData: ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height) });
        ctx.putImageData(entry.imageData, 0, 0);
        state.activeLayer = entry.layer;
        renderLayers();
        state.dirtyMasks = true;
        composite();
    }

    function redo() {
        const entry = state.redo.pop();
        if (!entry) return;
        const ctx = state.layerCanvas[entry.layer].getContext("2d");
        state.undo.push({ layer: entry.layer, imageData: ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height) });
        ctx.putImageData(entry.imageData, 0, 0);
        state.activeLayer = entry.layer;
        renderLayers();
        state.dirtyMasks = true;
        composite();
    }

    function bind() {
        const d = dom();
        d.close.addEventListener("click", () => close());
        d.cancel.addEventListener("click", () => close());
        d.maskMode.addEventListener("click", () => setMode("masks"));
        d.smoothingMode.addEventListener("click", () => setMode("smoothing"));
        d.traditionalMode.addEventListener("click", () => setMode("traditional"));
        d.brush.addEventListener("click", () => {
            state.tool = "brush";
            d.brush.classList.add("active");
            d.eraser.classList.remove("active");
        });
        d.eraser.addEventListener("click", () => {
            state.tool = "eraser";
            d.eraser.classList.add("active");
            d.brush.classList.remove("active");
        });
        d.undo.addEventListener("click", undo);
        d.redo.addEventListener("click", redo);
        d.brushSize.addEventListener("input", event => { state.brushSize = Number(event.target.value); });
        d.opacity.addEventListener("input", event => {
            state.opacity = Number(event.target.value) / 100;
            composite();
        });
        d.layerButtons.addEventListener("click", event => {
            const button = event.target.closest("[data-layer]");
            if (!button) return;
            state.activeLayer = button.dataset.layer;
            renderLayers();
            composite();
        });
        d.rindCurve.addEventListener("click", () => {
            state.smoothingLayer = "rind";
            d.rindCurve.classList.add("active");
            d.fleshCurve.classList.remove("active");
            composite();
        });
        d.fleshCurve.addEventListener("click", () => {
            state.smoothingLayer = "flesh";
            d.fleshCurve.classList.add("active");
            d.rindCurve.classList.remove("active");
            composite();
        });
        d.clearAnchors.addEventListener("click", () => {
            state.curveAnchors = { rind: [], flesh: [] };
            state.dirtySmoothing = true;
            renderAnchorCount();
            composite();
            setStatus("Curve anchors cleared locally. Save the smoothing curve to restore the unconstrained fit.");
        });
        d.zoomOut.addEventListener("click", () => setZoom(state.zoom / 1.25));
        d.zoomIn.addEventListener("click", () => setZoom(state.zoom * 1.25));
        d.zoomReset.addEventListener("click", resetViewport);
        d.canvas.addEventListener("pointerdown", beginPointer);
        d.canvas.addEventListener("pointermove", movePointer);
        window.addEventListener("pointerup", endPointer);
        d.canvas.addEventListener("contextmenu", event => event.preventDefault());
        d.canvas.addEventListener("dblclick", event => {
            event.preventDefault();
            if (state.zoom <= 1) {
                setZoom(2);
                state.panMode = true;
            } else {
                state.panMode = !state.panMode;
            }
            applyViewport();
            setStatus(state.panMode ? "Pan mode on. Drag the image; double-click again to edit." : "");
        });
        d.canvasHost.addEventListener("wheel", event => {
            event.preventDefault();
            setZoom(event.deltaY < 0 ? state.zoom * 1.12 : state.zoom / 1.12);
        }, { passive: false });
        d.saveRow.addEventListener("click", () => {
            if (state.mode === "masks") saveMasks();
            else if (state.mode === "smoothing") saveSmoothing();
            else saveTraditional("row");
        });
        d.saveBatch.addEventListener("click", () => saveTraditional("batch"));
        d.finetune.addEventListener("click", startFinetune);
        d.modal.addEventListener("click", event => {
            if (event.target === d.modal) close();
        });
        window.addEventListener("keydown", event => {
            if (!d.modal.classList.contains("open")) return;
            if (event.key === "Escape") close();
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
                event.preventDefault();
                if (event.shiftKey) redo();
                else undo();
            }
        });
    }

    window.PreviewAdjustments = { open };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
    else bind();
})();
