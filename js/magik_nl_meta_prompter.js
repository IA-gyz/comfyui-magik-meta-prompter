import { checkDisplayedPath } from "./magik_nl_path_check.js";
import { installTextPreview } from "./magik_nl_text_preview.js";
import { createChecklist } from "./magik_nl_checklist.js";
import { createSettingsStore } from "./magik_nl_settings.js";
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { openCharSearchForCombo } from "./magik_nl_search_panel.js";
import { createRandomFilterSection } from "./magik_nl_random_filters.js";

// ----- styles injection -----
function injectAssets() {
    if (document.getElementById("magik-nl-meta-styles")) return;
    const iconLink = document.createElement("script");
    iconLink.src = "https://cdn.jsdelivr.net/npm/@phosphor-icons/web@2.1.2";
    iconLink.onerror = () => console.warn("Magik NL Meta Prompter: icons failed.");
    document.head.appendChild(iconLink);

    const styleLink = document.createElement("link");
    styleLink.id = "magik-nl-meta-styles";
    styleLink.rel = "stylesheet";
    styleLink.href = new URL("./magik_nl_meta_prompter.css", import.meta.url).href;
    styleLink.onerror = () => console.warn("Magik NL Meta Prompter: stylesheet failed.");
    document.head.appendChild(styleLink);
}

// The 11 narrative phases, in ascending threshold order - must match
// PHASE_ORDER in the Python file exactly (same order, same names). Used to
// derive the *_enabled widget names for the new per-phase toggle checkboxes.
const PHASE_ORDER = [
    "Posing", "Teasing", "Groping", "Group_Groping", "Cunni", "BJ",
    "Action", "Anaction", "Group_BJ", "Group", "Facial",
];

// Array of labels for the 11 buttons
const labels = [
    "Posing", "Teasing", "Groping", "Group Groping", "Cunni",
"BJ", "Action", "Anaction", "Group BJ", "Group", "Facial"
];

// ----- Male-description randomizer: sets + template engine -----
// User-editable via the gear icon in the male-description icon area (see
// openMaleRandomizerSetsPanel below). Persisted in localStorage so edits
// survive page reloads; falls back to these defaults otherwise.
const MALE_RANDOMIZER_STORAGE_KEY = "magikNLMetaPrompter.maleRandomizerConfig";

const DEFAULT_MALE_RANDOMIZER_SETS = {
    hair_color: ["bald", "blond", "black", "brown", "blue", "purple", "pink"],
    clothes_color: ["white", "yellow", "blue", "green", "pink", "red", "brown", "black", "purple", "grey"],
    top_wear: ["shirt", "sweater", "vest", "t-shirt"],
    bottom_wear: ["pants", "denim", "shorts"],
    accessory: ["glasses", "a tie", "a bow tie", "a hat", "a cap", "a watch"],
};

const DEFAULT_MALE_RANDOMIZER_TEMPLATES = {
    with_accessory: "has #hair_color# hair and is wearing a #clothes_color1# #top_wear#, #clothes_color2# #bottom_wear# and #accessory#",
    without_accessory: "has #hair_color# hair and is wearing a #clothes_color1# #top_wear# and #clothes_color2# #bottom_wear#",
};

function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function loadMaleRandomizerConfig() {
    try {
        const raw = localStorage.getItem(MALE_RANDOMIZER_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed && parsed.sets && parsed.templates) return parsed;
    } catch (e) {
        console.warn("Magik NL Meta Prompter: failed to load male randomizer config, using defaults.", e);
    }
    return null;
}

function saveMaleRandomizerConfig(config) {
    try {
        localStorage.setItem(MALE_RANDOMIZER_STORAGE_KEY, JSON.stringify(config));
    } catch (e) {
        console.warn("Magik NL Meta Prompter: failed to save male randomizer config.", e);
    }
}

// Runtime state - shared across every combo's 4 male descriptions and
// across node instances (it's a randomizer preference, not per-node data).
// Deep-cloned from the defaults so edits never mutate the DEFAULT_* consts.
let maleRandomizerConfig = loadMaleRandomizerConfig() || {
    sets: JSON.parse(JSON.stringify(DEFAULT_MALE_RANDOMIZER_SETS)),
    templates: { ...DEFAULT_MALE_RANDOMIZER_TEMPLATES },
};

// Resolves one #token# from the template against the current sets. A
// trailing number (clothes_color1, clothes_color2, ...) lets the same set
// be drawn from more than once independently - falls back to the base set
// name once the digits are stripped. Unresolved tokens are left as-is
// (rather than silently blanked) so a typo in the template is obvious.
function resolveMaleRandomizerToken(token, sets) {
    if (sets[token]) return pickRandom(sets[token]);
    const m = token.match(/^(.*?)(\d+)$/);
    if (m && sets[m[1]]) return pickRandom(sets[m[1]]);
    return `#${token}#`;
}

function fillMaleRandomizerTemplate(template, sets) {
    return template.replace(/#([A-Za-z0-9_]+)#/g, (_, token) => resolveMaleRandomizerToken(token, sets));
}

// Builds one random description: picks the "with accessory" template ~50%
// of the time and the "without accessory" one the other ~50%, then fills
// in its tokens from the current sets.
function randomizeMaleDescription() {
    const useAccessory = Math.random() < 0.5;
    const template = useAccessory
        ? maleRandomizerConfig.templates.with_accessory
        : maleRandomizerConfig.templates.without_accessory;
    return fillMaleRandomizerTemplate(template, maleRandomizerConfig.sets);
}

// Opens the "edit sets & template" modal for the male-description
// randomizer. Edits apply to a working draft and only take effect (and get
// persisted) on Save; Cancel/backdrop-click/X discards them.
function openMaleRandomizerSetsPanel() {
    if (document.getElementById("magik-nl-male-sets-overlay")) return; // already open

    const draft = JSON.parse(JSON.stringify(maleRandomizerConfig));

    const overlay = document.createElement("div");
    overlay.id = "magik-nl-male-sets-overlay";
    overlay.className = "magik-nl-male-sets-overlay";
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const panel = document.createElement("div");
    panel.className = "magik-nl-male-sets-panel";
    overlay.appendChild(panel);

    const header = document.createElement("div");
    header.className = "magik-nl-male-sets-header";
    header.innerHTML = "<span><i class='ph ph-gear-six'></i> Male Description Randomizer</span>";
    const closeBtn = document.createElement("button");
    closeBtn.className = "magik-nl-male-sets-close";
    closeBtn.innerHTML = "<i class='ph ph-x'></i>";
    closeBtn.onclick = () => overlay.remove();
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const body = document.createElement("div");
    body.className = "magik-nl-male-sets-body";
    panel.appendChild(body);

    // --- Word sets ---
    const setsSection = document.createElement("div");
    setsSection.className = "magik-nl-male-sets-section";
    const setsTitle = document.createElement("div");
    setsTitle.className = "magik-nl-male-sets-section-title";
    setsTitle.textContent = "Word Sets";
    setsSection.appendChild(setsTitle);

    const setsList = document.createElement("div");
    setsList.className = "magik-nl-male-sets-list";
    setsSection.appendChild(setsList);

    const renderSetRow = (name) => {
        const row = document.createElement("div");
        row.className = "magik-nl-male-set-row";
        row.dataset.setName = name;

        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.className = "magik-nl-male-set-name";
        nameInput.value = name;
        nameInput.title = "Set name - referenced in the template as #name#";
        nameInput.oninput = () => {
            const newName = nameInput.value.trim();
            if (!newName || newName === row.dataset.setName || draft.sets[newName] !== undefined) return;
            draft.sets[newName] = draft.sets[row.dataset.setName];
            delete draft.sets[row.dataset.setName];
            row.dataset.setName = newName;
        };

        const valuesInput = document.createElement("input");
        valuesInput.type = "text";
        valuesInput.className = "magik-nl-male-set-values";
        valuesInput.value = draft.sets[name].join(", ");
        valuesInput.title = "Comma-separated values";
        valuesInput.oninput = () => {
            draft.sets[row.dataset.setName] = valuesInput.value.split(",").map(v => v.trim()).filter(Boolean);
        };

        const removeBtn = document.createElement("button");
        removeBtn.className = "magik-nl-male-set-remove";
        removeBtn.title = "Remove this set";
        removeBtn.innerHTML = "<i class='ph ph-trash'></i>";
        removeBtn.onclick = () => {
            delete draft.sets[row.dataset.setName];
            row.remove();
        };

        row.append(nameInput, valuesInput, removeBtn);
        return row;
    };

    Object.keys(draft.sets).forEach(name => setsList.appendChild(renderSetRow(name)));

    const addSetBtn = document.createElement("button");
    addSetBtn.className = "magik-nl-male-set-add";
    addSetBtn.innerHTML = "<i class='ph ph-plus'></i> Add Set";
    addSetBtn.onclick = () => {
        let base = "new_set", n = 1, name = base;
        while (draft.sets[name] !== undefined) name = `${base}_${n++}`;
        draft.sets[name] = [];
        setsList.appendChild(renderSetRow(name));
    };
    setsSection.appendChild(addSetBtn);
    body.appendChild(setsSection);

    // --- Template phrase(s) ---
    const templatesSection = document.createElement("div");
    templatesSection.className = "magik-nl-male-sets-section";
    const templatesTitle = document.createElement("div");
    templatesTitle.className = "magik-nl-male-sets-section-title";
    templatesTitle.textContent = "Template Phrase";
    templatesSection.appendChild(templatesTitle);

    const hint = document.createElement("div");
    hint.className = "magik-nl-male-sets-hint";
    hint.textContent = "Use #set_name# to draw a random value from a set. Add a trailing number (e.g. #clothes_color1#, #clothes_color2#) to draw independently from the same set more than once.";
    templatesSection.appendChild(hint);

    const withLabel = document.createElement("label");
    withLabel.className = "magik-nl-label";
    withLabel.textContent = "With accessory (used ~50% of the time)";
    const withInput = document.createElement("textarea");
    withInput.className = "magik-nl-male-sets-template";
    withInput.value = draft.templates.with_accessory;
    withInput.oninput = () => { draft.templates.with_accessory = withInput.value; };

    const withoutLabel = document.createElement("label");
    withoutLabel.className = "magik-nl-label";
    withoutLabel.textContent = "Without accessory (used the other ~50%)";
    const withoutInput = document.createElement("textarea");
    withoutInput.className = "magik-nl-male-sets-template";
    withoutInput.value = draft.templates.without_accessory;
    withoutInput.oninput = () => { draft.templates.without_accessory = withoutInput.value; };

    templatesSection.append(withLabel, withInput, withoutLabel, withoutInput);
    body.appendChild(templatesSection);

    // --- Footer actions ---
    const footer = document.createElement("div");
    footer.className = "magik-nl-male-sets-footer";

    const resetBtn = document.createElement("button");
    resetBtn.className = "magik-nl-male-sets-btn secondary";
    resetBtn.textContent = "Reset to Defaults";
    resetBtn.onclick = () => {
        draft.sets = JSON.parse(JSON.stringify(DEFAULT_MALE_RANDOMIZER_SETS));
        draft.templates = { ...DEFAULT_MALE_RANDOMIZER_TEMPLATES };
        setsList.innerHTML = "";
        Object.keys(draft.sets).forEach(name => setsList.appendChild(renderSetRow(name)));
        withInput.value = draft.templates.with_accessory;
        withoutInput.value = draft.templates.without_accessory;
    };

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "magik-nl-male-sets-btn secondary";
    cancelBtn.textContent = "Cancel";
    cancelBtn.onclick = () => overlay.remove();

    const saveBtn = document.createElement("button");
    saveBtn.className = "magik-nl-male-sets-btn primary";
    saveBtn.textContent = "Save";
    saveBtn.onclick = () => {
        // Drop any set left with no values (e.g. an abandoned "Add Set").
        Object.keys(draft.sets).forEach(name => {
            if (draft.sets[name].length === 0) delete draft.sets[name];
        });
        maleRandomizerConfig = draft;
        saveMaleRandomizerConfig(maleRandomizerConfig);
        overlay.remove();
    };

    const footerRight = document.createElement("div");
    footerRight.className = "magik-nl-male-sets-footer-right";
    footerRight.append(cancelBtn, saveBtn);

    footer.append(resetBtn, footerRight);
    panel.appendChild(footer);

    document.body.appendChild(overlay);
}

// Fixed backend pool of LoRA slots per combo. The frontend's Add/Remove
// LoRA UI doesn't create new widgets at runtime (INPUT_TYPES is static) -
// it just shows/hides rows within this pool via the lora_visible_{i}
// counter widget (see createLoRASection).
const MAX_LORA_SLOTS = 8;

// ----- canvas zoom/pan passthrough -----
function installCanvasZoomPassthrough(root) {
    if (!root || typeof root.addEventListener !== "function") return () => {};
    const onWheel = (e) => {
        let el = e.target;
        while (el && el !== root.parentElement) {
            if (el.nodeType === 1) {
                const cs = getComputedStyle(el);
                const oy = cs.overflowY, ox = cs.overflowX;
                const vertical = Math.abs(e.deltaY) >= Math.abs(e.deltaX);
                if (vertical && (oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1) {
                    const atTop = el.scrollTop <= 0, atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
                    if ((e.deltaY < 0 && !atTop) || (e.deltaY > 0 && !atBottom)) return;
                } else if (!vertical && (ox === "auto" || ox === "scroll") && el.scrollWidth > el.clientWidth + 1) {
                    const atLeft = el.scrollLeft <= 0, atRight = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
                    if ((e.deltaX < 0 && !atLeft) || (e.deltaX > 0 && !atRight)) return;
                }
            }
            el = el.parentElement;
        }
        const canvasEl = app?.canvas?.canvas;
        if (!canvasEl) return;
        e.preventDefault();
        e.stopPropagation();
        const { clientX, clientY, deltaX, deltaY, deltaMode, ctrlKey, metaKey, shiftKey } = e;
        canvasEl.dispatchEvent(new WheelEvent("wheel", {
            clientX, clientY, deltaX, deltaY, deltaMode,
            ctrlKey, metaKey, shiftKey, bubbles: true, cancelable: true,
        }));
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
}

function installCanvasPanPassthrough(root) {
    if (!root || typeof root.addEventListener !== "function") return () => {};
    let panning = false, lastX = 0, lastY = 0;
    const onPointerDown = (e) => {
        if (e.button !== 1) return;
        const canvas = app?.canvas;
        if (!canvas || !canvas.ds) return;
        panning = true;
        lastX = e.clientX;
        lastY = e.clientY;
        root.style.cursor = "grabbing";
        e.preventDefault();
        e.stopPropagation();
        try { root.setPointerCapture(e.pointerId); } catch {}
    };
    const onPointerMove = (e) => {
        if (!panning) return;
        const canvas = app?.canvas;
        if (!canvas || !canvas.ds) return;
        const dx = e.clientX - lastX, dy = e.clientY - lastY;
        lastX = e.clientX; lastY = e.clientY;
        const scale = canvas.ds.scale || 1;
        canvas.ds.offset[0] += dx / scale;
        canvas.ds.offset[1] += dy / scale;
        canvas.setDirty(true, true);
        e.preventDefault();
        e.stopPropagation();
    };
    const endPan = (e) => {
        if (!panning) return;
        panning = false;
        root.style.cursor = "";
        try { root.releasePointerCapture(e.pointerId); } catch {}
        e.preventDefault();
        e.stopPropagation();
    };
    root.addEventListener("pointerdown", onPointerDown);
    root.addEventListener("pointermove", onPointerMove);
    root.addEventListener("pointerup", endPan);
    root.addEventListener("pointercancel", endPan);
    return () => {
        root.removeEventListener("pointerdown", onPointerDown);
        root.removeEventListener("pointermove", onPointerMove);
        root.removeEventListener("pointerup", endPan);
        root.removeEventListener("pointercancel", endPan);
    };
}

// ----- autocomplete -----
const AUTOCOMPLETE_STORAGE_KEY = "magik_textarea_autocomplete_vocab";
function loadAutocompleteVocab() { try { const raw = localStorage.getItem(AUTOCOMPLETE_STORAGE_KEY); return raw ? new Set(JSON.parse(raw)) : new Set(); } catch { return new Set(); } }
let autocompleteVocab = loadAutocompleteVocab();
let autocompleteSaveTimer = null;
function saveAutocompleteVocab() {
    clearTimeout(autocompleteSaveTimer);
    autocompleteSaveTimer = setTimeout(() => {
        try { localStorage.setItem(AUTOCOMPLETE_STORAGE_KEY, JSON.stringify([...autocompleteVocab].slice(-2000))); } catch {}
    }, 400);
}
function learnPhrasesFrom(text) {
    if (!text) return;
    const parts = text.split(/[,\n]/).map(p => p.trim()).filter(p => p.length >= 2 && p.length <= 80);
    let changed = false;
    for (const p of parts) {
        if (!autocompleteVocab.has(p)) { autocompleteVocab.add(p); changed = true; }
    }
    if (changed) saveAutocompleteVocab();
}
function attachAutocomplete(el) {
    let menu = null, activeIdx = -1, matches = [];
    function removeMenuElement() { if (menu) { menu.remove(); menu = null; } }
    function closeMenu() { removeMenuElement(); activeIdx = -1; matches = []; }
    function currentSegmentBounds() {
        const caret = el.selectionStart;
        const text = el.value;
        let start = caret;
        while (start > 0 && text[start - 1] !== ',' && text[start - 1] !== '\n') start--;
        while (start < caret && /\s/.test(text[start])) start++;
        return { start, end: caret };
    }
    function positionMenu() {
        if (!menu) return;
        const rect = el.getBoundingClientRect();
        menu.style.left = `${rect.left}px`;
        menu.style.top = `${rect.bottom + 4}px`;
        menu.style.width = `${rect.width}px`;
    }
    function highlight(idx) {
        if (!menu) return;
        const items = menu.querySelectorAll(".magik-autocomplete-item");
        items.forEach((it, i) => it.classList.toggle("active", i === idx));
        activeIdx = idx;
    }
    function acceptMatch(idx) {
        const { start, end } = currentSegmentBounds();
        const chosen = matches[idx];
        const before = el.value.slice(0, start);
        const after = el.value.slice(end);
        el.value = before + chosen + after;
        const newCaret = (before + chosen).length;
        el.selectionStart = el.selectionEnd = newCaret;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        closeMenu();
        el.focus();
    }
    function renderMenu() {
        removeMenuElement();
        if (matches.length === 0) return;
        menu = document.createElement("div");
        menu.className = "magik-autocomplete-menu";
        matches.forEach((m, i) => {
            const item = document.createElement("div");
            item.className = "magik-autocomplete-item";
            item.textContent = m;
            item.onmousedown = (e) => { e.preventDefault(); acceptMatch(i); };
            menu.appendChild(item);
        });
        document.body.appendChild(menu);
        positionMenu();
        highlight(0);
    }
    el.addEventListener("input", () => {
        const caret = el.selectionStart;
        const justTyped = el.value[caret - 1];
        if (justTyped === ',' || justTyped === '\n') {
            learnPhrasesFrom(el.value.slice(0, caret));
        }
        const { start, end } = currentSegmentBounds();
        const partial = el.value.slice(start, end).trim();
        if (partial.length < 2) { closeMenu(); return; }
        const lower = partial.toLowerCase();
        const dynamicMatches = [...autocompleteVocab].filter(v => v.toLowerCase().startsWith(lower) && v.toLowerCase() !== lower);
        const seen = new Set(dynamicMatches.map(v => v.toLowerCase()));
        const staticMatches = DANBOORU_TAGS.filter(v => {
            const lv = v.toLowerCase();
            if (lv === lower || seen.has(lv) || !lv.startsWith(lower)) return false;
            seen.add(lv);
            return true;
        });
        matches = [...dynamicMatches.sort((a, b) => a.length - b.length), ...staticMatches].slice(0, 8);
        renderMenu();
    });
    el.addEventListener("keydown", (e) => {
        if (!menu) return;
        if (e.key === "ArrowDown") { e.preventDefault(); highlight((activeIdx + 1) % matches.length); }
        else if (e.key === "ArrowUp") {
            e.preventDefault();
            const nextIdx = activeIdx <= 0 ? matches.length - 1 : activeIdx - 1;
            highlight(nextIdx);
        }
        else if (e.key === "Tab" || e.key === "Enter") { if (activeIdx >= 0) { e.preventDefault(); acceptMatch(activeIdx); } }
        else if (e.key === "Escape") { closeMenu(); }
    });
    el.addEventListener("blur", () => {
        learnPhrasesFrom(el.value);
        setTimeout(closeMenu, 150);
    });
}

// Searchable replacement for a plain <select> over a closed list of
// choices (used for the LoRA name field). Always resolves back to a single
// committed value: typing filters, but blurring/Escape without picking an
// item reverts the field to whatever is still the actual backend value.
function attachLoraSearch(el, getOptions, getCurrentValue, onSelect) {
    let menu = null, activeIdx = -1, matches = [];
    function removeMenuElement() { if (menu) { menu.remove(); menu = null; } }
    function closeMenu() { removeMenuElement(); activeIdx = -1; matches = []; }
    function positionMenu() {
        if (!menu) return;
        const rect = el.getBoundingClientRect();
        menu.style.left = `${rect.left}px`;
        menu.style.top = `${rect.bottom + 4}px`;
        menu.style.width = `${rect.width}px`;
    }
    function highlight(idx) {
        if (!menu) return;
        const items = menu.querySelectorAll(".magik-autocomplete-item");
        items.forEach((it, i) => it.classList.toggle("active", i === idx));
        activeIdx = idx;
        items[idx]?.scrollIntoView({ block: "nearest" });
    }
    function accept(idx) {
        const chosen = matches[idx];
        if (chosen === undefined) return;
        el.value = chosen;
        onSelect(chosen);
        closeMenu();
    }
    function renderMenu() {
        removeMenuElement();
        if (matches.length === 0) return;
        menu = document.createElement("div");
        menu.className = "magik-autocomplete-menu";
        const current = getCurrentValue();
        matches.forEach((m, i) => {
            const item = document.createElement("div");
            item.className = "magik-autocomplete-item";
            item.textContent = m;
            item.onmousedown = (e) => { e.preventDefault(); accept(i); };
            menu.appendChild(item);
        });
        document.body.appendChild(menu);
        positionMenu();
        const preselect = Math.max(0, matches.indexOf(current));
        highlight(preselect);
    }
    function refresh() {
        const query = el.value.trim().toLowerCase();
        const all = getOptions();
        matches = (query ? all.filter(v => v.toLowerCase().includes(query)) : all).slice(0, 60);
        renderMenu();
    }
    el.addEventListener("focus", () => { el.select(); refresh(); });
    el.addEventListener("input", refresh);
    el.addEventListener("keydown", (e) => {
        if (!menu) return;
        if (e.key === "ArrowDown") { e.preventDefault(); highlight((activeIdx + 1) % matches.length); }
        else if (e.key === "ArrowUp") {
            e.preventDefault();
            highlight(activeIdx <= 0 ? matches.length - 1 : activeIdx - 1);
        }
        else if (e.key === "Enter" || e.key === "Tab") { if (activeIdx >= 0) { e.preventDefault(); accept(activeIdx); } }
        else if (e.key === "Escape") { e.preventDefault(); el.value = getCurrentValue(); closeMenu(); el.blur(); }
    });
    el.addEventListener("blur", () => {
        // Delayed so the mousedown-based accept() above still fires first.
        setTimeout(() => { el.value = getCurrentValue(); closeMenu(); }, 150);
    });
}

// ----- widget suppression -----
function suppressWidget(widget) {
    if (!widget) return;
    // Explicitly flag as hidden for LiteGraph's layout calculations — with
    // ~80 extra hidden LoRA widgets, computeSize/draw overrides alone risk
    // vertical-offset glitches (the bug AnimaX added this flag to fix).
    widget.hidden = true;
    widget.computeSize = () => [0, 0];
    widget.draw = () => {};
    if (widget.element) {
        widget.element.style.display = "none";
        widget.element.style.height = "0px";
        widget.element.style.width = "0px";
        widget.element.style.padding = "0px";
        widget.element.style.margin = "0px";
        widget.element.style.border = "none";
        widget.element.style.overflow = "hidden";
        widget.element.style.pointerEvents = "none";
    }
}

function hideMagikBackendWidgets(node) {
    const suffixes = ["_1", "_2", "_3", "_4", "_5", "_6", "_7", "_8"];
    // The suffix catch-all above doesn't cover every lora_* widget shape
    // (double-indexed, e.g. "lora_8_3") — these dedicated regexes are
    // load-bearing independent of whatever range `suffixes` happens to
    // cover, so LoRA widgets can't slip through as raw visible widgets.
    const loraPatterns = [
        /^lora_\d_\d$/,
        /^lora_enable_\d_\d$/,
        /^lora_strength_model_\d_\d$/,
        /^lora_strength_clip_\d_\d$/,
        /^lora_phases_\d_\d$/,  // <--- Added this line
        /^lora_trigger_word_\d_\d$/,
        /^lora_trigger_point_\d_\d$/,
        /^lora_visible_\d$/     // per-combo LoRA row count (Add/Remove LoRA), UI-only
    ];
    const agingPatterns = [/^teenager_\d$/, /^t_strength_\d$/, /^aged_up_\d$/, /^a_strength_\d$/, /^slim_\d$/, /^s_strength_\d$/];
    const malePatterns = [/^MALE_NAME_\d$/, /^MALE_DESCRIPTION_\d$/];
    const globalParamNames = new Set([
        "Posing", "Teasing", "Groping", "Group_Groping", "Cunni", "BJ", "Action", "Anaction", "Group_BJ", "Group", "Facial",
        ...PHASE_ORDER.map(n => `${n}_enabled`),
        "lift_clothes_panties", "lift_clothes_no_panties", "completely_nude",
        "CLOTHES_LIFTING_CHECKLIST",
        "use_Scene", "use_Composition", "use_Lighting", "use_Style", "use_Technical_details",
        "qt_style", "is_test", "test_path", "settings",
        "prompt_order",
        "active_combos",
        "index",
    ]);

    node.widgets?.forEach(w => {
        const isBackend = suffixes.some(s => w.name?.endsWith(s))
        || loraPatterns.some(p => p.test(w.name))
        || agingPatterns.some(p => p.test(w.name))
        || malePatterns.some(p => p.test(w.name))
        || globalParamNames.has(w.name);
        if (isBackend) suppressWidget(w);
    });
}

// ----- UI Controller -----
class MagikNLMetaUIController {
    constructor(node) {
        this.node = node;
        this.syncCallbacks = [];
        this.cells = {};
        this.randomCharacterSelections = {};
        this.characterRandomizers = {};
        this.stateRefreshInterval = null;
        this.controls = [];
        // Populated per-combo by createBackgroundSection - lets the single
        // global "Scene" toggle grey out every combo's Background fields at
        // once without a full sync()/DOM rebuild on every checkbox click.
        this.bgFields = {};
        injectAssets();
    }

    w(name) {
        return this.node._magikSettings.proxies.get(name)
            || this.node.widgets.find(x => x.name === name);
    }

    widgetMap() { return this.node._magikSettings.proxies; }

    // use_Scene is a single global toggle (not per-combo), so this updates
    // every registered combo's Background Fix/Random Text fields in one
    // pass: greyed out + disabled while Scene is checked (their output
    // isn't feeding line1 in that case - see process()'s use_Scene
    // handling in _build_line1), editable again once it's unchecked.
    updateBackgroundGreyedState() {
        for (const refresh of Object.values(this.pathRefreshers || {})) refresh();
        const sceneOn = this.w("use_Scene")?.value ?? true;
        Object.values(this.bgFields).forEach(({ fixInput, randomInput }) => {
            fixInput.disabled = sceneOn;
            randomInput.disabled = sceneOn;
        });
    }

    validate(el, val, className = "invalid") {
        el.classList.toggle(className, val.trim() === "");
    }

    createControl(type, labelText, widgetName, height = "120px", options = [], invalidClass = "invalid") {
        const container = document.createElement("div");
        container.innerHTML = `<label class="magik-nl-label">${labelText}</label>`;

        let el;
        if (type === "textarea") {
            el = document.createElement("textarea");
            el.className = "magik-nl-input";
            el.style.height = height;
        } else if (type === "text") {
            el = document.createElement("input");
            el.type = "text";
            el.className = "magik-nl-input";
        } else if (type === "dropdown") {
            el = document.createElement("select");
            el.className = "magik-nl-input";
            const widget = this.w(widgetName);
            const opts = options.length ? options : widget?.options?.values || [];
            opts.forEach(v => {
                const opt = document.createElement("option");
                opt.value = v; opt.textContent = v;
                if (v === widget?.value) opt.selected = true;
                el.appendChild(opt);
            });
        }

        const initialWidget = this.w(widgetName);
        el.value = initialWidget?.value || "";

        if (type === "textarea" || type === "text") {
            this.validate(el, el.value, invalidClass);
        }

        if (widgetName && /^CHARACTER_CLOTHES_\d$/.test(widgetName)) {
            el.classList.add("magik-nl-clothes");
        } else if (widgetName && /^MALE_NAME_\d$|^MALE_DESCRIPTION_\d$/.test(widgetName)) {
            el.classList.add("magik-nl-male");
        }

        el.oninput = (e) => {
            const widget = this.w(widgetName);
            if (widget) {
                widget.value = e.target.value;
                if (widget.callback) widget.callback(widget.value);
            }
            if (type === "textarea" || type === "text") {
                this.validate(el, e.target.value, invalidClass);
            }
        };

        this.controls.push({ el, widgetName, type });

        this.syncCallbacks.push(() => {
            const widget = this.w(widgetName);
            if (widget && el.value !== String(widget.value || "")) {
                el.value = widget.value || "";
                if (type === "textarea" || type === "text") {
                    this.validate(el, el.value, invalidClass);
                }
            }
        });

        container.appendChild(el);
        return { container, el };
    }

    // CRITICAL FIX: Push DOM values back into widgets before serialization.
    // ComfyUI recreates widget objects between queue runs; the DOM is the
    // only persistent store of user input. This method only overwrites
    // widgets that are empty, preserving any already-correct values.
    syncFromDOM() {
        for (const control of this.controls) {
            const widget = this.w(control.widgetName);
            if (widget && control.el) {
                const domValue = control.el.value;
                const widgetValue = String(widget.value || "");
                // Only sync if DOM has content and widget is empty/default-mismatched
                if (domValue && domValue !== widgetValue) {
                    widget.value = domValue;
                    if (widget.callback) widget.callback(domValue);
                }
            }
        }
    }

    updateActiveComboHighlight(slotValue) {
        const slot = Number(slotValue);
        this.executedSlot = Number.isInteger(slot) && slot >= 1 && slot <= 8 ? slot : null;
        for (let i = 1; i <= 8; i++) {
            const cell = this.cells[i];
            if (cell) cell.classList.toggle("active-combo", i === this.executedSlot);
        }
    }

    createExecutionSummary() {
        const panel = document.createElement("section");
        panel.className = "magik-nl-execution-summary";
        panel.setAttribute("aria-live", "polite");
        const title = document.createElement("h3");
        title.textContent = "Last execution";
        const status = document.createElement("span");
        status.textContent = this.node._magikSettings.warning || "Waiting for the first run";
        const details = document.createElement("div");
        details.className = "execution-details";
        const current = document.createElement("div");
        current.className = "execution-current";
        const picture = document.createElement("img");
        picture.className = "execution-character-picture";
        picture.hidden = true;
        const pictureStatus = document.createElement("span");
        pictureStatus.className = "execution-picture-status";
        pictureStatus.textContent = "Character picture available after execution";
        current.append(title, status, details, picture, pictureStatus);
        const placeholder = document.createElement("aside");
        placeholder.className = "execution-panel-placeholder";
        const heading = document.createElement("h3");
        heading.textContent = "Checklist & information";
        const description = document.createElement("p");
        description.textContent = "Panel coming soon";
        placeholder.append(heading, description);
        panel.append(current, placeholder);
        this.parameterChecklist = createChecklist(this, placeholder);
        this.executionSummary = { status, details, picture, pictureStatus };
        return panel;
    }

    updateExecutionSummary(data) {
        if (!data || !this.executionSummary) return;
        this.parameterChecklist?.update(data);
        const {status, details, picture, pictureStatus} = this.executionSummary;
        picture.hidden = true;
        picture.removeAttribute("src");
        picture.alt = `WaifuDB picture of ${data.character || "character"}`;
        const pictureId = data.picture_id;
        if (pictureId !== null && pictureId !== undefined && String(pictureId)) {
            pictureStatus.textContent = "Loading character picture…";
            const source = `/custom_character_search/thumbnail/${encodeURIComponent(pictureId)}`;
            picture.onload = () => { if (picture.getAttribute("src") === source) { picture.hidden = false; pictureStatus.textContent = ""; this.node._magikFitFrontend?.(); } };
            picture.onerror = () => { if (picture.getAttribute("src") === source) { picture.hidden = true; pictureStatus.textContent = "Character picture unavailable"; } };
            picture.src = source;
        } else {
            pictureStatus.textContent = "No matching database picture";
        }
        status.textContent = `${data.test ? "Test" : "Gen"} · ${data.random ? (data.locked ? "Random identity locked" : "Random identity") : "Manual identity"} · ${new Date().toLocaleTimeString()}`;
        details.replaceChildren();
        for (const [label, value] of [
            ["Combo", data.slot], ["Phase", `${data.phase} · ${labels[Number(data.phase) - 1] || ""}`],
            ["Input index", data.index], ["Character", data.character], ["Output path", data.path],
        ]) {
            const item = document.createElement("div");
            const caption = document.createElement("span"); caption.textContent = label;
            const content = document.createElement("strong"); content.textContent = String(value ?? "–");
            item.append(caption, content); details.appendChild(item);
        }
    }

    createPhaseBanner() {
        const banner = document.createElement("div");
        banner.className = "magik-nl-phase-banner";
        banner.textContent = "–";
        this.phaseBannerEl = banner;
        return banner;
    }

    // Add/Remove combo control. Stack semantics only — grows/shrinks from
    // the end (no removing from the middle), so there's never a gap in
    // 2..active_combos and no widget values ever need moving between slots.
    // All 8 combo cells already exist in the DOM (created up front); this
    // just toggles which ones are visible and keeps `active_combos` (the
    // thing process()'s round-robin actually reads) in sync.
    createComboCountControl() {
        const bar = document.createElement("div");
        bar.className = "magik-nl-combo-count-bar";

        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "magik-nl-combo-count-btn";
        removeBtn.title = "Remove last combo";
        removeBtn.innerHTML = "<i class='ph ph-minus'></i>";

        const label = document.createElement("span");
        label.className = "magik-nl-combo-count-label";

        const addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.className = "magik-nl-combo-count-btn";
        addBtn.title = "Add a combo";
        addBtn.innerHTML = "<i class='ph ph-plus'></i>";

        const refresh = () => {
            const n = Math.max(2, Math.min(8, parseInt(this.w("active_combos")?.value) || 2));
            label.textContent = `${n} / 8 combos`;
            removeBtn.disabled = n <= 2;
            addBtn.disabled = n >= 8;
            for (let i = 1; i <= 8; i++) {
                const cell = this.cells[i];
                if (cell) cell.style.display = i <= n ? "" : "none";
            }
        };

        const setCount = (n) => {
            n = Math.max(2, Math.min(8, n));
            const widget = this.w("active_combos");
            if (widget) {
                widget.value = n;
                if (widget.callback) widget.callback(widget.value);
            }
            refresh();
        };

        removeBtn.onclick = () => setCount((parseInt(this.w("active_combos")?.value) || 2) - 1);
        addBtn.onclick = () => setCount((parseInt(this.w("active_combos")?.value) || 2) + 1);

        this.syncCallbacks.push(refresh);
        refresh();

        bar.append(removeBtn, label, addBtn);
        return bar;
    }

    // Driven only by the real "executed" websocket event (see
    // beforeRegisterNodeDef below) carrying process()'s actual computed
    // `phase`. There is no local recompute here on purpose: `index` is a
    // forceInput socket, so its .value in the browser never reflects the
    // real execution-time value — any local guess from widget values was
    // wrong (always landing on phase 1) and, worse, a periodic poll calling
    // this would keep re-asserting that wrong guess over top of the correct
    // value shortly after every real execution.
    updatePhaseBanner(phaseValue) {
        if (!this.phaseBannerEl) return;
        const phase = parseInt(phaseValue);
        if (isNaN(phase) || !labels[phase - 1]) {
            this.phaseBannerEl.textContent = "–";
            return;
        }
        this.phaseBannerEl.textContent = `${phase}-${labels[phase - 1]}`;
    }

    createGlobalParamsPanel() {
        const panel = document.createElement("div");
        panel.className = "magik-nl-params-panel";

        const phaseRangeSpans = [];
        const phaseCountSpans = [];

        // Live "ACTIVE: ###" total, appended into the last stage card (see
        // STAGE_GROUPS.forEach below) - sum of each ENABLED phase's item
        // count, recomputed alongside the ranges in updateThresholdRanges().
        const activeCountDisplay = document.createElement("div");
        activeCountDisplay.className = "magik-nl-active-count";
        activeCountDisplay.title = "Total items across every enabled phase (disabled phases excluded)";

        const numCell = (labelText, widgetName, extraClass = "", withRange = false) => {
            const cell = document.createElement("div");
            cell.className = "magik-nl-param-cell";
            const label = document.createElement("span");
            label.className = "magik-nl-param-label";
            const labelTextEl = document.createElement("span");
            labelTextEl.className = "magik-nl-param-label-text";
            labelTextEl.textContent = labelText;
            label.appendChild(labelTextEl);
            let countEl = null;
            if (withRange) {
                // Fills the space that used to sit empty next to short labels
                // (e.g. "POSING") with how many items fall in that phase.
                countEl = document.createElement("span");
                countEl.className = "magik-nl-phase-count";
                label.appendChild(countEl);
            }

            // Enable/disable toggle for the phase itself. Not pushed into
            // this.controls (same reason as the other checkboxes in this
            // file - syncFromDOM() isn't checkbox-aware); synced directly
            // via onchange/syncCallbacks instead.
            let enableCb = null;
            if (withRange) {
                const enableWidgetName = `${widgetName}_enabled`;
                enableCb = document.createElement("input");
                enableCb.type = "checkbox";
                enableCb.className = "magik-nl-phase-enable-checkbox";
                enableCb.title = `Enable "${labelText}" phase (unchecked = skip straight to the next enabled phase)`;
                const initEnableW = this.w(enableWidgetName);
                enableCb.checked = initEnableW?.value ?? true;
                enableCb.onchange = (e) => {
                    const w = this.w(enableWidgetName);
                    if (w) {
                        w.value = e.target.checked;
                        if (w.callback) w.callback(w.value);
                    }
                    updateThresholdRanges();
                };
                this.syncCallbacks.push(() => {
                    const w = this.w(enableWidgetName);
                    const v = w?.value ?? true;
                    if (enableCb.checked !== v) enableCb.checked = v;
                });
            }

            const input = document.createElement("input");
            input.type = "number";
            input.className = `magik-nl-param-input${extraClass ? " " + extraClass : ""}`;
            const initW = this.w(widgetName);
            input.value = initW?.value ?? 0;
            input.oninput = (e) => {
                const widget = this.w(widgetName);
                const v = parseInt(e.target.value);
                if (!isNaN(v) && widget) {
                    widget.value = v;
                    if (widget.callback) widget.callback(v);
                }
                if (withRange) updateThresholdRanges();
            };
            this.controls.push({ el: input, widgetName, type: "number" });
            this.syncCallbacks.push(() => {
                const widget = this.w(widgetName);
                const v = String(widget?.value ?? "");
                if (input.value !== v) input.value = v;
                if (withRange) updateThresholdRanges();
            });

            if (withRange) {
                const range = document.createElement("span");
                range.className = "magik-nl-param-range";
                phaseRangeSpans.push(range);
                phaseCountSpans.push(countEl);
                cell.append(label, range, enableCb, input);
            } else {
                cell.append(label, input);
            }
            return cell;
        };

        const threshPanel = document.createElement("div");
        threshPanel.className = "magik-nl-state-panel";
        const threshHeader = document.createElement("div");
        threshHeader.className = "magik-nl-state-header";
        const threshTitle = document.createElement("h3");
        threshTitle.className = "magik-nl-state-title";
        threshTitle.innerHTML = `<i class="ph ph-sliders-horizontal"></i> Phase Thresholds`;
        threshHeader.append(threshTitle);

        const threshBody = document.createElement("div");
        threshBody.className = "magik-nl-thresh-body";

        // Phases are grouped into narrative "stages" that each render as
        // their own bordered card, rather than one undifferentiated grid.
        // Cards are built in the exact same left-to-right, top-to-bottom
        // order as before, so the flattened `thresholds` list below still
        // lines up 1:1 with phaseRangeSpans / updateThresholdRanges.
        const STAGE_GROUPS = [
            { title: "Hello Lady", items: [
                ["Posing", "Posing"],
                ["Teasing", "Teasing"],
                ["Groping", "Groping"],
                ["Group Groping", "Group_Groping"],
            ] },
            { title: "Time To Get Serious", items: [
                ["Cunni", "Cunni"],
                ["BJ", "BJ"],
                ["Action", "Action"],
                ["Anaction", "Anaction"],
            ] },
            { title: "Had Enough Yet ?", items: [
                ["Group BJ", "Group_BJ"],
                ["Group", "Group"],
                ["Facial", "Facial"],
            ] },
        ];
        const thresholds = STAGE_GROUPS.flatMap(g => g.items);

        // Same "enforce ascending, min prev+1" rule Python applies in
        // process() — mirrored here purely for live display, the backend
        // remains the source of truth for the actual clamped values.
        const updateThresholdRanges = () => {
            let prev = 0;
            let activeSum = 0;
            thresholds.forEach(([, name], i) => {
                const raw = parseInt(this.w(name)?.value) || 0;
                const t = Math.max(raw, prev + 1);
                const count = t - prev;
                if (phaseRangeSpans[i]) phaseRangeSpans[i].textContent = `[${prev + 1}...${t}]`;
                if (phaseCountSpans[i]) phaseCountSpans[i].textContent = `×${count}`;
                const enabled = this.w(`${name}_enabled`)?.value ?? true;
                if (enabled) activeSum += count;
                prev = t;
            });
            activeCountDisplay.textContent = `ACTIVE: ${activeSum}`;
        };

        const stageRow = document.createElement("div");
        stageRow.className = "magik-nl-stage-row";

        STAGE_GROUPS.forEach(({ title, items }, groupIdx) => {
            const card = document.createElement("div");
            card.className = "magik-nl-stage-card";
            const head = document.createElement("div");
            head.className = "magik-nl-stage-card-title";
            head.textContent = title;
            card.appendChild(head);
            items.forEach(([label, name]) => card.appendChild(numCell(label, name, "", true)));
            // "Had Enough Yet ?" has one fewer phase than the other two
            // cards, leaving a blank row's worth of space at the bottom -
            // that's where the running ACTIVE total lives.
            if (groupIdx === STAGE_GROUPS.length - 1) card.appendChild(activeCountDisplay);
            stageRow.appendChild(card);
        });
        updateThresholdRanges();

        const liftCard = document.createElement("div");
        liftCard.className = "magik-nl-stage-card magik-nl-lift-card";
        const liftHead = document.createElement("div");
        liftHead.className = "magik-nl-stage-card-title";
        liftHead.textContent = "Lift";
        liftCard.appendChild(liftHead);
        liftCard.appendChild(numCell("Lift (panties)", "lift_clothes_panties", "clothing"));
        liftCard.appendChild(numCell("Lift (no panties)", "lift_clothes_no_panties", "clothing"));
        liftCard.appendChild(numCell("Completely nude", "completely_nude", "clothing"));
        stageRow.appendChild(liftCard);

        // ---- Prompt Order: 5 drag-and-drop cards controlling the order the
        // 5 Prompt sections (Quality Tags/General/Man description/Female
        // description/Act) get joined in. Persisted as a comma-separated
        // key list on the "prompt_order" widget (e.g.
        // "line_QT,general,male,female,act").
        const ORDER_LABELS = {
            line_QT: "Quality Tags",
            general: "General",
            male: "Man description",
            female: "Female description",
            act: "Act",
        };
        const DEFAULT_ORDER = ["line_QT", "general", "male", "female", "act"];

        const orderCol = document.createElement("div");
        orderCol.className = "magik-nl-order-col";
        const orderLabel = document.createElement("div");
        orderLabel.className = "magik-nl-order-col-label";
        orderLabel.textContent = "Prompt Order";
        orderCol.appendChild(orderLabel);

        const orderList = document.createElement("div");
        orderList.className = "magik-nl-order-list";

        const commitOrder = () => {
            const keys = [...orderList.querySelectorAll(".magik-nl-order-card")].map(c => c.dataset.key);
            const widget = this.w("prompt_order");
            if (widget) {
                widget.value = keys.join(",");
                if (widget.callback) widget.callback(widget.value);
            }
        };

        const getDragAfterElement = (container, y) => {
            const els = [...container.querySelectorAll(".magik-nl-order-card:not(.dragging)")];
            return els.reduce((closest, child) => {
                const box = child.getBoundingClientRect();
                const offset = y - box.top - box.height / 2;
                if (offset < 0 && offset > closest.offset) {
                    return { offset, element: child };
                }
                return closest;
            }, { offset: Number.NEGATIVE_INFINITY }).element;
        };

        orderList.addEventListener("dragover", (e) => {
            e.preventDefault();
            const dragging = orderList.querySelector(".dragging");
            if (!dragging) return;

            // e.clientY and getBoundingClientRect() (used inside
            // getDragAfterElement) are both already real, post-transform
            // viewport pixels — no canvas-zoom adjustment belongs here.
            // Dividing by scale was throwing the two coordinate spaces out
            // of sync whenever the canvas wasn't at exactly 100% zoom,
            // which is why cards would drop in the wrong slot (or seem to
            // ignore the cursor) at any other zoom level.
            const afterEl = getDragAfterElement(orderList, e.clientY);
            if (afterEl == null) {
                orderList.appendChild(dragging);
            } else {
                orderList.insertBefore(dragging, afterEl);
            }
        });
        orderList.addEventListener("drop", (e) => e.preventDefault());

        const makeOrderCard = (key) => {
            const card = document.createElement("div");
            card.className = "magik-nl-order-card";
            card.draggable = true;
            card.dataset.key = key;
            card.textContent = ORDER_LABELS[key] || key;
            card.addEventListener("dragstart", () => {
                // Deferred so the dragged element itself isn't excluded from
                // getDragAfterElement() before the browser finishes reading
                // its drag image.
                setTimeout(() => card.classList.add("dragging"), 0);
            });
            card.addEventListener("dragend", () => {
                card.classList.remove("dragging");
                commitOrder();
            });
            return card;
        };

        // Initial order: whatever's saved on the widget (workflow reload),
        // falling back to the default, with any missing/unknown keys
        // defensively appended/ignored so a malformed saved value can't
        // hide a card or crash the UI.
        const orderWidget = this.w("prompt_order");
        const savedOrder = (orderWidget?.value || DEFAULT_ORDER.join(",")).split(",").map(s => s.trim()).filter(Boolean);
        const initialOrder = [...savedOrder, ...DEFAULT_ORDER.filter(k => !savedOrder.includes(k))];
        initialOrder.forEach(key => {
            if (ORDER_LABELS[key]) orderList.appendChild(makeOrderCard(key));
        });

        orderCol.appendChild(orderList);

        threshBody.append(stageRow, orderCol);
        threshPanel.append(threshHeader, threshBody);
        panel.appendChild(threshPanel);

        // Checkboxes intentionally are NOT pushed into this.controls: syncFromDOM()
        // reads control.el.value, which for a checkbox is always the fixed string
        // "on" regardless of checked state - it is not checkbox-aware. Sync back
        // into the widget happens directly via onchange instead (same pattern as
        // the per-combo teenager/aged-up/slim checkboxes below).
        const boolCell = (labelText, widgetName, onToggle = null) => {
            const label = document.createElement("label");
            label.className = "magik-nl-line1-toggle";
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.className = "magik-nl-line1-checkbox";
            const initW = this.w(widgetName);
            cb.checked = initW?.value ?? true;
            cb.onchange = (e) => {
                const widget = this.w(widgetName);
                if (widget) {
                    widget.value = e.target.checked;
                    if (widget.callback) widget.callback(widget.value);
                }
                if (onToggle) onToggle(cb.checked);
            };
            this.syncCallbacks.push(() => {
                const widget = this.w(widgetName);
                const v = widget?.value ?? true;
                if (cb.checked !== v) {
                    cb.checked = v;
                    if (onToggle) onToggle(cb.checked);
                }
            });
            const span = document.createElement("span");
            span.textContent = labelText;
            label.append(cb, span);
            if (onToggle) onToggle(cb.checked);
            return label;
        };

        const line1ToggleRow = document.createElement("div");
        line1ToggleRow.className = "magik-nl-line1-toggle-row";

        const nlToggle = document.createElement("button"); nlToggle.type = "button";
        const syncNLToggle = () => { const on = !!this.w("use_nl")?.value; nlToggle.textContent = `Use NL ${on ? "ON" : "OFF"}`; nlToggle.setAttribute("aria-pressed", String(on)); nlToggle.style.background = on ? "#245c45" : "#222"; };
        nlToggle.style.cssText = "font-size:78px;font-weight:700;padding:36px 78px;color:white;border:1px solid #526079;border-radius:30px;cursor:pointer;white-space:nowrap;flex-shrink:0;";
        nlToggle.onclick = () => { const w = this.w("use_nl"); w.value = !w.value; w.callback?.(w.value); syncNLToggle(); };
        syncNLToggle(); this.syncCallbacks.push(syncNLToggle); line1ToggleRow.appendChild(nlToggle);
        const styleToggle = document.createElement("div");
        styleToggle.className = "magik-nl-style-toggle";
        const realismBtn = document.createElement("button");
        realismBtn.type = "button";
        realismBtn.className = "magik-nl-style-toggle-btn magik-nl-icon-btn";
        realismBtn.title = "Realism";
        realismBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
            <circle cx="12" cy="13" r="4"/>
        </svg>`;
        const animeBtn = document.createElement("button");
        animeBtn.type = "button";
        animeBtn.className = "magik-nl-style-toggle-btn magik-nl-icon-btn";
        animeBtn.title = "Anime";
        animeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c1.4 0 2-1.1 2-2 0-.5-.2-1-.5-1.4-.3-.4-.5-.9-.5-1.4 0-1.1.9-2 2-2h2.4c2 0 3.6-1.6 3.6-3.6C21 6.4 17 2 12 2z"/>
            <circle cx="6.5" cy="11.5" r="1.1" fill="currentColor" stroke="none"/>
            <circle cx="9.5" cy="7.5" r="1.1" fill="currentColor" stroke="none"/>
            <circle cx="14.5" cy="7.5" r="1.1" fill="currentColor" stroke="none"/>
            <circle cx="17.3" cy="11" r="1.1" fill="currentColor" stroke="none"/>
        </svg>`;
        const noneBtn = document.createElement("button");
        noneBtn.type = "button";
        noneBtn.className = "magik-nl-style-toggle-btn magik-nl-icon-btn";
        noneBtn.title = "None";
        noneBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="9"/>
            <line x1="5.5" y1="5.5" x2="18.5" y2="18.5"/>
        </svg>`;
        const applyStyleToggle = (mode) => {
            realismBtn.classList.toggle("active", mode === "realism");
            animeBtn.classList.toggle("active", mode === "anime");
            noneBtn.classList.toggle("active", mode === "none");
        };
        const setQtStyle = (mode) => {
            const widget = this.w("qt_style");
            if (widget) {
                widget.value = mode;
                if (widget.callback) widget.callback(widget.value);
            }
            applyStyleToggle(mode);
        };
        realismBtn.onclick = () => setQtStyle("realism");
        animeBtn.onclick = () => setQtStyle("anime");
        noneBtn.onclick = () => setQtStyle("none");
        applyStyleToggle(this.w("qt_style")?.value ?? "anime");
        this.syncCallbacks.push(() => applyStyleToggle(this.w("qt_style")?.value ?? "anime"));
        styleToggle.append(realismBtn, animeBtn, noneBtn);
        line1ToggleRow.appendChild(styleToggle);

        const testToggle = document.createElement("div");
        testToggle.className = "magik-nl-style-toggle";
        const testBtn = document.createElement("button");
        testBtn.type = "button";
        testBtn.className = "magik-nl-style-toggle-btn magik-nl-test-btn";
        testBtn.textContent = "Test";
        const genBtn = document.createElement("button");
        genBtn.type = "button";
        genBtn.className = "magik-nl-style-toggle-btn";
        genBtn.textContent = "Gen";
        const applyTestToggle = (isTest) => {
            testBtn.classList.toggle("active", !!isTest);
            genBtn.classList.toggle("active", !isTest);
        };
        const setIsTest = (isTest) => {
            const widget = this.w("is_test");
            if (widget) {
                widget.value = isTest;
                if (widget.callback) widget.callback(widget.value);
            }
            applyTestToggle(isTest);
        };
        testBtn.onclick = () => setIsTest(true);
        genBtn.onclick = () => setIsTest(false);
        applyTestToggle(this.w("is_test")?.value ?? false);
        this.syncCallbacks.push(() => applyTestToggle(this.w("is_test")?.value ?? false));
        testToggle.append(testBtn, genBtn);

        const testPathInput = document.createElement("input");
        testPathInput.type = "text";
        testPathInput.className = "magik-nl-test-path-input";
        testPathInput.placeholder = "Required in Test mode";
        testPathInput.title = "Required in Test mode";
        testPathInput.setAttribute("aria-label", "test_path — Required in Test mode");
        testPathInput.value = this.w("test_path")?.value ?? "";
        const updateTestPathState = () => {
            testPathInput.classList.toggle("empty", testPathInput.value.trim() === "");
        };
        updateTestPathState();
        testPathInput.oninput = (e) => {
            const widget = this.w("test_path");
            if (widget) {
                widget.value = e.target.value;
                if (widget.callback) widget.callback(e.target.value);
            }
            updateTestPathState();
        };
        this.controls.push({ el: testPathInput, widgetName: "test_path", type: "text" });
        this.syncCallbacks.push(() => {
            const widget = this.w("test_path");
            const v = String(widget?.value ?? "");
            if (testPathInput.value !== v) testPathInput.value = v;
            updateTestPathState();
        });

        const testGroup = document.createElement("div");
        testGroup.className = "magik-nl-test-group";
        testGroup.append(testToggle, testPathInput);
        line1ToggleRow.appendChild(testGroup);

        [
            ["Scene", "use_Scene", () => this.updateBackgroundGreyedState()],
            ["Composition", "use_Composition"],
            ["Lighting", "use_Lighting"],
            ["Style", "use_Style"],
            ["Technical Details", "use_Technical_details"],
        ].forEach(([label, name, onToggle]) => line1ToggleRow.appendChild(boolCell(label, name, onToggle)));
        panel.appendChild(line1ToggleRow);
        // use_Scene is global (not per-combo), so the greyed state can also
        // change from outside this row (e.g. workflow load) - keep it in
        // sync every pass, on top of the per-checkbox onToggle above.
        this.syncCallbacks.push(() => this.updateBackgroundGreyedState());

        const checkSection = document.createElement("div");
        const checkLabel = document.createElement("span");
        checkLabel.className = "magik-nl-params-section-label";
        checkLabel.textContent = "Clothes Lifting Checklist";
        const checkInput = document.createElement("textarea");
        checkInput.className = "magik-nl-checklist-input";
        const initCheckW = this.w("CLOTHES_LIFTING_CHECKLIST");
        checkInput.value = initCheckW?.value ?? "";
        checkInput.rows = 1;
        const autoResizeCheck = () => {
            checkInput.style.height = "auto";
            checkInput.style.height = checkInput.scrollHeight + "px";
        };
        checkInput.addEventListener("input", (e) => {
            const checkWidget = this.w("CLOTHES_LIFTING_CHECKLIST");
            if (checkWidget) {
                checkWidget.value = e.target.value;
                if (checkWidget.callback) checkWidget.callback(e.target.value);
            }
            autoResizeCheck();
        });
        this.controls.push({ el: checkInput, widgetName: "CLOTHES_LIFTING_CHECKLIST", type: "textarea" });
        this.syncCallbacks.push(() => {
            const checkWidget = this.w("CLOTHES_LIFTING_CHECKLIST");
            const v = String(checkWidget?.value ?? "");
            if (checkInput.value !== v) { checkInput.value = v; autoResizeCheck(); }
        });
        requestAnimationFrame(autoResizeCheck);
        checkSection.append(checkLabel, checkInput);
        panel.appendChild(checkSection);
        const nlProgression = document.createElement("details");
        nlProgression.style.cssText = "border:1px solid #526079;border-radius:12px;padding:16px;";
        const nlHeading = document.createElement("summary"); nlHeading.textContent = "NL clothing progression"; nlHeading.style.cssText = "font-size:28px;cursor:pointer;";
        const nlHelp = document.createElement("p"); nlHelp.textContent = "Use NL only · One matching garment per generation · Mappings: garment=action. Templates: {clothing}, {garment}, {verb}, {action}, {agreement}, {exposure}, {underwear}. Unmatched garments use clothing / is adjusted.";
        nlHelp.style.cssText = "font-size:20px;color:#b8c7db;";
        nlProgression.append(nlHeading, nlHelp);
        for (const [label, key] of [["Garment actions", "nl_garment_actions"], ["Stage 2 · Underwear aside", "nl_clothing_stage_2"], ["Stage 3 · Underwear removed", "nl_clothing_stage_3"], ["Stage 4 · Unclothed", "nl_clothing_stage_4"]]) {
            nlProgression.appendChild(this.createControl("textarea", label, key, "140px").container);
        }
        panel.appendChild(nlProgression);


        const maleSection = document.createElement("div");
        maleSection.className = "magik-nl-male-section";

        const maleNamesRow = document.createElement("div");
        maleNamesRow.className = "magik-nl-male-names-row";
        for (let i = 1; i <= 4; i++) {
            const ctrl = this.createControl("text", `MALE_NAME_${i}`, `MALE_NAME_${i}`, "40px");
            maleNamesRow.appendChild(ctrl.container);
        }
        maleSection.appendChild(maleNamesRow);

        const maleDescRow = document.createElement("div");
        maleDescRow.className = "magik-nl-male-desc-row";

        // Icon area to the left of the 4 descriptions - same height as that
        // row, width = half its height (see .magik-nl-male-icon-area's
        // aspect-ratio in CSS). Two stacked icons: randomize every
        // description at once, and edit the randomizer's sets/template.
        const maleIconArea = document.createElement("div");
        maleIconArea.className = "magik-nl-male-icon-area";

        const randomizeAllBtn = document.createElement("button");
        randomizeAllBtn.className = "magik-nl-male-icon-btn";
        randomizeAllBtn.title = "Randomly set all 4 male descriptions at once";
        randomizeAllBtn.innerHTML = "<i class='ph ph-shuffle'></i>";

        const editSetsBtn = document.createElement("button");
        editSetsBtn.className = "magik-nl-male-icon-btn";
        editSetsBtn.title = "Edit the randomizer's word sets and template phrase";
        editSetsBtn.innerHTML = "<i class='ph ph-gear-six'></i>";
        editSetsBtn.onclick = () => openMaleRandomizerSetsPanel();

        maleIconArea.append(randomizeAllBtn, editSetsBtn);
        maleDescRow.appendChild(maleIconArea);

        const maleDescGrid = document.createElement("div");
        maleDescGrid.className = "magik-nl-male-desc-grid";

        const maleDescCtrls = [];
        for (let i = 1; i <= 4; i++) {
            const ctrl = this.createControl("textarea", `MALE_DESCRIPTION_${i}`, `MALE_DESCRIPTION_${i}`, "120px");
            maleDescCtrls.push(ctrl);
            const randomizeBtn = document.createElement("button");
            randomizeBtn.className = "magik-nl-randomize-btn";
            randomizeBtn.title = "Randomly set this description";
            randomizeBtn.innerHTML = "<i class='ph ph-dice-five'></i>";
            randomizeBtn.onclick = () => {
                ctrl.el.value = randomizeMaleDescription();
                // Reuse createControl's own oninput handler (widget sync +
                // validation) instead of duplicating that logic here.
                ctrl.el.dispatchEvent(new Event("input", { bubbles: true }));
            };
            const label = ctrl.container.querySelector(".magik-nl-label");
            if (label) label.prepend(randomizeBtn);
            maleDescGrid.appendChild(ctrl.container);
        }

        randomizeAllBtn.onclick = () => {
            maleDescCtrls.forEach(ctrl => {
                ctrl.el.value = randomizeMaleDescription();
                ctrl.el.dispatchEvent(new Event("input", { bubbles: true }));
            });
        };

        maleDescRow.appendChild(maleDescGrid);
        maleSection.appendChild(maleDescRow);
        panel.appendChild(maleSection);

        return panel;
    }

    savedRandomCharacter(index) {
        try {
            const selection = JSON.parse(this.w(`random_character_data_${index}`)?.value || "null");
            return selection && typeof selection.id === "string" &&
                typeof selection.name === "string" &&
                typeof selection.fields?.GIRL_FACE === "string" &&
                typeof selection.fields?.GIRL_NOFACE === "string" ? selection : null;
        } catch { return null; }
    }

    updateRandomCharacterSelection(slot, selection) {
        const index = Number(slot);
        if (!Number.isInteger(index) || index < 1 || index > 8 || !selection) return;
        // A previously queued, unlocked draw must not replace a snapshot
        // the user has locked since queueing that run.
        if (!this.w(`random_character_locked_${index}`)?.value) {
            const widget = this.w(`random_character_data_${index}`);
            if (widget) {
                widget.value = JSON.stringify(selection);
                widget.callback?.(widget.value);
            }
        }
        this.randomCharacterSelections[index] = this.savedRandomCharacter(index) || selection;
        const nl = this.w(`nl_girl_description_${index}`);
        if (nl) { nl.value = this.randomCharacterSelections[index]?.nl_girl_description || ""; nl.callback?.(nl.value); }
        const control = this.controls.find(control => control.widgetName === `nl_girl_description_${index}`);
        if (control && nl) control.el.value = nl.value;
        this.characterRandomizers[index]?.();
    }

    createComboCell(index) {
        const cell = document.createElement("div");
        cell.className = "magik-nl-cell";
        this.cells[index] = cell;
        this.randomCharacterSelections[index] = this.savedRandomCharacter(index);

        const buildPath = () => {
            const randomOn = !!this.w(`randomize_character_${index}`)?.value;
            const girlVal = String(this.w(`GIRL_FACE_${index}`)?.value ?? "");
            const suffixWidget = this.w(`suffix_${index}`);
            const sfx = String(suffixWidget?.value ?? "").trim();
            const rawName = randomOn ? "Random" : girlVal.split(',')[0].trim() || "";

            const background = this.w("use_Scene")?.value ? "RandomLocation" : String(this.w(`bg_fix_${index}`)?.value || "").split(",")[0].trim().replace(/\s+/g, " ");
            let p = [rawName, background, sfx].filter(Boolean).join("_") || "";

            // --- NEW: Sanitize the path to match backend ---
            if (p) {
                p = p.replace(/ /g, "_")
                .replace(/\\\(/g, "(")
                .replace(/\\\)/g, ")");
            }

            return p;
        };

        const pathDisplay = document.createElement("button");
        pathDisplay.type = "button";
        pathDisplay.className = "magik-nl-path-display header-path";
        pathDisplay.title = "Search WaifuDB character database";
        pathDisplay.innerHTML = `<i class="ph ph-magnifying-glass"></i> Search Character`;
        pathDisplay.onclick = () => openCharSearchForCombo(this.node, index, "search");

        const header = document.createElement("div");
        header.className = "magik-nl-header";

        const titleSpan = document.createElement("h3");
        titleSpan.className = "magik-nl-title";
        titleSpan.innerHTML = `<i class="ph ph-magic-wand"></i> Combo ${index}`;

        const clearBtn = document.createElement("button");
        clearBtn.className = "magik-nl-clear-btn";
        clearBtn.title = "Clear all fields";
        clearBtn.innerHTML = "<i class='ph ph-eraser'></i>";
        clearBtn.onclick = () => {
            const fields = ["GIRL_FACE", "GIRL_NOFACE", "CHARACTER_CLOTHES", "teenager", "aged_up", "t_strength", "a_strength", "slim", "s_strength"];
            fields.forEach(f => {
                const w = this.w(`${f}_${index}`);
                if (w) {
                    if (w.type === "BOOLEAN") w.value = false;
                    else if (w.type === "FLOAT") w.value = 1.0;
                    else w.value = "";
                    if (w.callback) w.callback(w.value);
                }
            });
            const suffixWidget = this.w(`suffix_${index}`);
            if (suffixWidget) {
                suffixWidget.value = "";
                if (suffixWidget.callback) suffixWidget.callback("");
            }
            // AnimaX parity: clearing a combo also disables its LoRA slots.
            // Names/strengths are kept, so re-enabling restores the stack.
            for (let l = 1; l <= MAX_LORA_SLOTS; l++) {
                const ew = this.w(`lora_enable_${index}_${l}`);
                if (ew) { ew.value = false; if (ew.callback) ew.callback(false); }
            }
            this.sync();
        };

        const randomButton = document.createElement("button");
        randomButton.type = "button";
        randomButton.className = "magik-nl-randomize-button";
        randomButton.title = "Draw a fresh WaifuDB character for this combo on each generation. Manual values are preserved.";
        randomButton.onclick = () => {
            const widget = this.w(`randomize_character_${index}`);
            if (widget) {
                widget.value = !widget.value;
                widget.callback?.(widget.value);
            }
            this.characterRandomizers[index]?.();
        };

        const collapseButton = document.createElement("button");
        collapseButton.type = "button";
        collapseButton.className = "magik-nl-collapse-button";
        collapseButton.onclick = () => {
            const widget = this.w(`combo_collapsed_${index}`);
            if (widget) { widget.value = !widget.value; widget.callback?.(widget.value); }
            this.characterRandomizers[index]?.();
        };
        header.append(titleSpan, pathDisplay, randomButton, clearBtn, collapseButton);
        cell.appendChild(header);

        const preview = document.createElement("div");
        preview.className = "magik-nl-character-preview";
        const thumbnail = document.createElement("img");
        thumbnail.className = "magik-nl-character-thumbnail";
        thumbnail.alt = "Selected character";
        thumbnail.hidden = true;
        thumbnail.onerror = () => { thumbnail.hidden = true; };
        const previewText = document.createElement("div");
        previewText.className = "magik-nl-character-preview-text";
        const previewName = document.createElement("strong");
        const previewState = document.createElement("span");
        previewText.append(previewName, previewState);
        const previewActions = document.createElement("div");
        previewActions.className = "magik-nl-character-preview-actions";
        const lockButton = document.createElement("button");
        lockButton.type = "button";
        lockButton.onclick = () => {
            if (!this.savedRandomCharacter(index)) return;
            const widget = this.w(`random_character_locked_${index}`);
            if (widget) {
                widget.value = !widget.value;
                widget.callback?.(widget.value);
            }
            this.characterRandomizers[index]?.();
        };
        const copyButton = document.createElement("button");
        copyButton.type = "button";
        copyButton.textContent = "Copy to Manual";
        copyButton.title = "Use the selected Face and No Face descriptions, turn Randomize off, and keep your outfit settings.";
        copyButton.onclick = () => {
            const selected = this.savedRandomCharacter(index);
            if (!selected) return;
            for (const key of ["GIRL_FACE", "GIRL_NOFACE"]) {
                const widget = this.w(`${key}_${index}`);
                if (widget) {
                    widget.value = selected.fields[key];
                    widget.callback?.(widget.value);
                }
            }
            for (const key of ["randomize_character", "random_character_locked"]) {
                const widget = this.w(`${key}_${index}`);
                if (widget) { widget.value = false; widget.callback?.(false); }
            }
            this.sync();
        };
        previewActions.append(lockButton, copyButton);
        preview.append(thumbnail, previewText, previewActions);
        cell.appendChild(preview);


        // Suffix input + auto-generated folder-name preview, side by side.
        // The header button above is now a pure "open the character search
        // panel" trigger (no path text) - the live preview of the folder
        // path this combo will write to moved down here instead.
        const suffixContainer = document.createElement("div");
        suffixContainer.style.cssText = "padding: 4px 0 6px 0;";
        const suffixLabel = document.createElement("label");
        suffixLabel.className = "magik-nl-label";
        suffixLabel.textContent = "Suffix";

        const suffixRow = document.createElement("div");
        suffixRow.className = "magik-nl-suffix-row";

        const suffixInput = document.createElement("input");
        suffixInput.className = "magik-nl-input-path";
        suffixInput.placeholder = "Suffix...";
        const initSuffixW = this.w(`suffix_${index}`);
        suffixInput.value = initSuffixW?.value || "";

        const folderNameDisplay = document.createElement("div");
        folderNameDisplay.className = "magik-nl-path-display suffix-path";
        folderNameDisplay.title = "Constructed directory path (auto-generated)";

        const updatePathDisplay = () => {
            const p = buildPath();
            if (folderNameDisplay.dataset.checkedPath !== p) folderNameDisplay.textContent = p;
            folderNameDisplay.classList.toggle("has-value", !!p);
            checkDisplayedPath(folderNameDisplay, p);
        };

        suffixInput.oninput = (e) => {
            const suffixWidget = this.w(`suffix_${index}`);
            if (suffixWidget) {
                suffixWidget.value = e.target.value;
                if (suffixWidget.callback) suffixWidget.callback(suffixWidget.value);
            }
            updatePathDisplay();
        };
        this.controls.push({ el: suffixInput, widgetName: `suffix_${index}`, type: "text" });
        this.syncCallbacks.push(() => {
            const suffixWidget = this.w(`suffix_${index}`);
            const sv = suffixWidget?.value || "";
            if (suffixInput.value !== sv) suffixInput.value = sv;
            updatePathDisplay();
        });
        this.pathRefreshers ||= {};
        this.pathRefreshers[index] = updatePathDisplay;
        suffixRow.append(suffixInput, folderNameDisplay);
        suffixContainer.append(suffixLabel, suffixRow);
        cell.appendChild(suffixContainer);
        updatePathDisplay();

        const girlFace   = this.createControl("textarea", "Girl Description (Face)",    `GIRL_FACE_${index}`,         "220px");
        const girlNoFace = this.createControl("textarea", "Girl Description (No Face)", `GIRL_NOFACE_${index}`,       "160px");
        const clothes    = this.createControl("textarea", "Clothes Description",       `CHARACTER_CLOTHES_${index}`, "180px");
        const nlGirl = this.createControl("textarea", "Natural language description", `nl_girl_description_${index}`, "160px");
        const nlClothing = this.createControl("textarea", "Natural language clothing", `nl_clothing_${index}`, "180px");
        const splitNoFace = document.createElement("div"); splitNoFace.className = "magik-nl-description-split"; splitNoFace.append(girlNoFace.container, nlGirl.container);
        const splitClothes = document.createElement("div"); splitClothes.className = "magik-nl-description-split"; splitClothes.append(clothes.container, nlClothing.container);
        this.syncCallbacks.push(() => { nlClothing.el.disabled = !!this.w(`random_outfit_${index}`)?.value; });

        [girlFace, girlNoFace, clothes].forEach(ctrl => attachAutocomplete(ctrl.el));

        const agingRow = document.createElement("div");
        agingRow.className = "magik-nl-aging-row";

        const createAgingControl = (labelTxt, boolName, floatName, onToggle) => {
            const wrapper = document.createElement("div");
            wrapper.dataset.widgetName = boolName;
            wrapper.style.display = "flex";
            wrapper.style.alignItems = "center";
            wrapper.style.gap = "16px";

            const container = document.createElement("label");
            container.className = "magik-nl-aging-toggle";
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.className = "magik-nl-aging-checkbox";
            const initBoolW = this.w(boolName);
            cb.checked = initBoolW?.value || false;
            cb.onchange = (e) => {
                const boolW = this.w(boolName);
                if (boolW) {
                    boolW.value = e.target.checked;
                    if (boolW.callback) boolW.callback(boolW.value);
                }
                if (onToggle) onToggle(e.target.checked);
            };
            const span = document.createElement("span");
            span.textContent = labelTxt;
            container.append(cb, span);
            wrapper.appendChild(container);

            if (floatName) {
                const inp = document.createElement("input");
                inp.type = "number";
                inp.step = "0.1";
                inp.min = "-20";
                inp.max = "20";
                inp.className = "magik-nl-aging-input";
                const initFloatW = this.w(floatName);
                inp.value = initFloatW?.value !== undefined ? initFloatW.value : 1.0;
                inp.oninput = (e) => {
                    const floatW = this.w(floatName);
                    if (floatW) {
                        let val = parseFloat(e.target.value);
                        floatW.value = isNaN(val) ? 1.0 : val;
                        if (floatW.callback) floatW.callback(floatW.value);
                    }
                };
                this.controls.push({ el: inp, widgetName: floatName, type: "number" });
                this.syncCallbacks.push(() => {
                    const boolW  = this.w(boolName);
                    const floatW = this.w(floatName);
                    if (boolW && cb.checked !== !!boolW.value) cb.checked = !!boolW.value;
                    if (floatW && inp.value !== String(floatW.value)) inp.value = floatW.value;
                });
                    wrapper.appendChild(inp);
            } else {
                this.syncCallbacks.push(() => {
                    const boolW = this.w(boolName);
                    if (boolW && cb.checked !== !!boolW.value) {
                        cb.checked = !!boolW.value;
                        if (onToggle) onToggle(cb.checked);
                    }
                });
                if (onToggle) onToggle(cb.checked);
            }
            return wrapper;
        };

        agingRow.append(
            createAgingControl("Teenager", `teenager_${index}`, `t_strength_${index}`),
                        createAgingControl("Aged Up", `aged_up_${index}`, `a_strength_${index}`),
                        createAgingControl("Slim", `slim_${index}`, `s_strength_${index}`),
                        createAgingControl("Cleavage", `cleavage_${index}`, `c_strength_${index}`),
                        // No paired strength float — this just picks the clothes-description
                        // source (Outfit_path random draw vs. the manual textarea below).
                        createAgingControl("Random Outfit", `random_outfit_${index}`, null, (checked) => {
                            clothes.el.disabled = checked;
                            nlClothing.el.disabled = checked;
                            clothes.el.classList.toggle("magik-nl-disabled-source", checked);
                        })
        );

        const rebuildOnInput = () => {
            updatePathDisplay();
        };
        girlFace.el.addEventListener("input", rebuildOnInput);

        const identityModifiers = Array.from(agingRow.children).filter(el =>
            /^(teenager|aged_up|slim)_/.test(el.dataset.widgetName || ""));
        const outfitModifiers = Array.from(agingRow.children).filter(el =>
            /^(cleavage|random_outfit)_/.test(el.dataset.widgetName || ""));
        const section = (title, ...elements) => {
            const block = document.createElement("section");
            block.className = "magik-nl-combo-section";
            const heading = document.createElement("h4");
            heading.className = "magik-nl-combo-section-title";
            heading.textContent = title;
            block.append(heading, ...elements);
            return block;
        };
        const identityRow = document.createElement("div");
        identityRow.className = "magik-nl-aging-row";
        identityRow.append(...identityModifiers);
        const outfitRow = document.createElement("div");
        outfitRow.className = "magik-nl-aging-row";
        outfitRow.append(...outfitModifiers);
        const filterPanel = createRandomFilterSection(this, index, "magik-nl");
        const comboBody = document.createElement("div");
        comboBody.className = "magik-nl-combo-body";
        comboBody.append(
            suffixContainer,
            section("Identity", filterPanel, girlFace.container, splitNoFace, identityRow),
            section("Outfit", splitClothes, outfitRow),
            this.createBackgroundSection(index),
            this.createLoRASection(index)
        );
        cell.appendChild(comboBody);

        const refreshRandomize = () => {
            const checked = !!this.w(`randomize_character_${index}`)?.value;
            this.randomCharacterSelections[index] = this.savedRandomCharacter(index);
            const locked = !!this.w(`random_character_locked_${index}`)?.value;
            randomButton.classList.toggle("active", checked);
            randomButton.setAttribute("aria-pressed", String(checked));
            randomButton.textContent = checked ? "Randomize ON" : "Randomize OFF";
            const collapsed = !!this.w(`combo_collapsed_${index}`)?.value;
            comboBody.hidden = collapsed;
            cell.classList.toggle("collapsed", collapsed);
            collapseButton.textContent = collapsed ? "Expand" : "Collapse";
            collapseButton.setAttribute("aria-expanded", String(!collapsed));
            filterPanel.magikRefresh?.();
            const sections = [girlFace.container, girlNoFace.container, ...identityModifiers];
            for (const section of sections) {
                section.classList.toggle("magik-nl-randomized-inputs", checked);
                section.querySelectorAll("input, textarea, select, button").forEach(el => {
                    el.disabled = checked;
                });
            }
            // Restore the independent Random Outfit source-disable rule.
            clothes.el.disabled = !!this.w(`random_outfit_${index}`)?.value;
            pathDisplay.disabled = checked;
            clearBtn.disabled = checked;
            pathDisplay.classList.toggle("magik-nl-randomized-inputs", checked);
            clearBtn.classList.toggle("magik-nl-randomized-inputs", checked);
            const selected = this.randomCharacterSelections[index];
            randomButton.title = checked && selected
                ? `${locked ? "Locked" : "Last generated"} character: ${selected.name} (ID: ${selected.id}). ${locked ? "The next run keeps this character." : "A fresh draw happens on the next run."}`
                : "Draw a fresh WaifuDB character for this combo on each generation. Manual values are preserved.";
            previewName.textContent = selected ? selected.name : "No character selected yet";
            previewState.textContent = selected
                ? `${locked ? "Locked character" : "Last selection"} · ID: ${selected.id}`
                : "Enable Randomize and generate to see the selection.";
            lockButton.disabled = !selected || !checked;
            lockButton.textContent = locked ? "Unlock" : "Lock";
            lockButton.setAttribute("aria-pressed", String(locked));
            lockButton.classList.toggle("active", locked);
            copyButton.disabled = !selected;
            if (selected) {
                const url = `/custom_character_search/thumbnail/${encodeURIComponent(selected.id)}`;
                if (thumbnail.getAttribute("src") !== url) {
                    thumbnail.hidden = false;
                    thumbnail.src = url;
                }
                thumbnail.alt = selected.name;
            } else {
                thumbnail.hidden = true;
                thumbnail.removeAttribute("src");
            }
            updatePathDisplay();
        };
        this.characterRandomizers[index] = refreshRandomize;
        // Register after the other field callbacks so source-disable rules
        // cannot accidentally re-enable randomized fields on workflow load.
        this.syncCallbacks.push(refreshRandomize);
        refreshRandomize();

        return cell;
    }

    // Background Builder, folded in from the standalone
    // MagikBackgroundBuilder node/pack (by way of MagikNLMetaPrompterJSON,
    // where this was folded in first). Presets are keyword lists (not
    // character-specific), so one shared preset library backs every
    // combo's Background section - see BG_PRESETS_DIR/the bg_* routes in
    // the .py.
    createBackgroundSection(index) {
        const section = document.createElement("div");
        section.className = "magik-nl-bg-section";

        const title = document.createElement("h4");
        title.className = "magik-nl-bg-title";
        title.innerHTML = `<i class="ph ph-image"></i> Background`;
        section.appendChild(title);

        const setW = (name, value) => {
            const w = this.w(name);
            if (!w) return;
            w.value = value;
            if (w.callback) w.callback(w.value);
            this.pathRefreshers?.[index]?.();
        };
        const getW = (name) => this.w(name)?.value;

        // --- Fix ---
        const fixRow = document.createElement("div");
        fixRow.className = "magik-nl-bg-row";
        const fixLabel = document.createElement("label");
        fixLabel.textContent = "Fix";
        const fixInput = document.createElement("input");
        fixInput.type = "text";
        fixInput.className = "magik-nl-bg-fix";
        fixInput.placeholder = "Always-included text (also names the preset)...";
        fixInput.value = getW(`bg_fix_${index}`) ?? "";
        fixInput.oninput = (e) => setW(`bg_fix_${index}`, e.target.value);
        fixRow.append(fixLabel, fixInput);

        // --- Random Text ---
        const randomRow = document.createElement("div");
        randomRow.className = "magik-nl-bg-row";
        const randomLabel = document.createElement("label");
        randomLabel.textContent = "Random Text";
        const randomInput = document.createElement("textarea");
        randomInput.className = "magik-nl-bg-random-text";
        randomInput.placeholder = "rain, neon lights 3, empty streets, cat...";
        randomInput.value = getW(`bg_random_text_${index}`) ?? "";
        randomInput.oninput = (e) => setW(`bg_random_text_${index}`, e.target.value);
        randomRow.append(randomLabel, randomInput);

        // --- How Many, Count, Location/Include, Save/Load — all one row,
        // left-to-right in that order.
        const controlsRow = document.createElement("div");
        controlsRow.className = "magik-nl-bg-combined-row";
        const howManyLabel = document.createElement("label");
        howManyLabel.textContent = "How Many";
        const howManyInput = document.createElement("input");
        howManyInput.type = "number";
        howManyInput.min = "1";
        howManyInput.max = "50";
        howManyInput.className = "magik-nl-bg-how-many";
        howManyInput.value = getW(`bg_how_many_${index}`) ?? 1;
        howManyInput.oninput = (e) => {
            const v = parseInt(e.target.value) || 1;
            setW(`bg_how_many_${index}`, v);
        };
        const countBtn = document.createElement("button");
        countBtn.type = "button";
        countBtn.className = "magik-nl-bg-count-btn";
        countBtn.innerHTML = "🔢 Count";
        const countDisplay = document.createElement("span");
        countDisplay.className = "magik-nl-bg-count-display";
        countDisplay.textContent = "0";
        countBtn.onclick = () => {
            const rt = getW(`bg_random_text_${index}`) || "";
            const keywords = rt.split(',').map(k => k.trim()).filter(k => k !== "");
            countDisplay.textContent = keywords.length;
        };

        // --- Location toggle + nested Include badge ---
        const toggleContainer = document.createElement("div");
        toggleContainer.className = "magik-nl-bg-toggle-container";
        const locationBtn = document.createElement("button");
        locationBtn.type = "button";
        locationBtn.className = "magik-nl-bg-location-btn";
        const includeBtn = document.createElement("button");
        includeBtn.type = "button";
        includeBtn.className = "magik-nl-bg-include-btn";

        const updateToggle = () => {
            const locType = getW(`bg_location_type_${index}`) || "indoors";
            const isIndoors = locType === "indoors";
            locationBtn.textContent = locType.toUpperCase();
            locationBtn.style.border = isIndoors ? "2px solid #4CAF50" : "2px solid #FF9800";
            locationBtn.style.color = isIndoors ? "#4CAF50" : "#FF9800";

            const included = getW(`bg_include_location_${index}`) ?? true;
            if (included) {
                includeBtn.textContent = "✓ Include";
                includeBtn.style.background = "#2e7d32";
                includeBtn.style.color = "#fff";
                locationBtn.style.opacity = "1.0";
            } else {
                includeBtn.textContent = "✕ Ignore";
                includeBtn.style.background = "#c62828";
                includeBtn.style.color = "#fff";
                locationBtn.style.opacity = "0.4";
            }
        };
        locationBtn.onclick = () => {
            const cur = getW(`bg_location_type_${index}`) || "indoors";
            setW(`bg_location_type_${index}`, cur === "indoors" ? "outdoors" : "indoors");
            updateToggle();
        };
        includeBtn.onclick = (e) => {
            e.stopPropagation();
            setW(`bg_include_location_${index}`, !(getW(`bg_include_location_${index}`) ?? true));
            updateToggle();
        };
        toggleContainer.append(locationBtn, includeBtn);

        // --- Save / Load Preset ---
        const getPresetName = () => {
            const val = getW(`bg_fix_${index}`) || "";
            return val.split(/[,\n]/)[0].trim();
        };

        const saveBtn = document.createElement("button");
        saveBtn.type = "button";
        saveBtn.className = "magik-nl-bg-save-btn";
        saveBtn.innerHTML = "💾 Save Preset";
        saveBtn.onclick = () => {
            const name = getPresetName();
            if (!name) {
                alert("Please type a valid location/keyword first in the Fix box to name your preset!");
                return;
            }
            const sendSaveRequest = (isOverwrite = false) => {
                const payload = {
                    preset_name: name,
                    fix: getW(`bg_fix_${index}`) || "",
                    random_text: getW(`bg_random_text_${index}`) || "",
                    how_many: getW(`bg_how_many_${index}`) ?? 1,
                    location_type: getW(`bg_location_type_${index}`) || "indoors",
                    include_location: getW(`bg_include_location_${index}`) ?? true,
                    overwrite: isOverwrite,
                };
                fetch('/magik_nl_meta_prompter/bg_save_preset', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                }).then(res => res.json()).then(data => {
                    if (data.status === "exists") {
                        if (confirm(`⚠️ A preset named "${name}" already exists.\n\nOverwrite it?`)) {
                            sendSaveRequest(true);
                        }
                    } else if (data.status === "success") {
                        saveBtn.style.backgroundColor = "#4caf50";
                        setTimeout(() => saveBtn.style.backgroundColor = "#2e7d32", 300);
                    } else {
                        alert("Error saving preset: " + data.message);
                    }
                });
            };
            sendSaveRequest(false);
        };

        const loadBtn = document.createElement("button");
        loadBtn.type = "button";
        loadBtn.className = "magik-nl-bg-load-btn";
        loadBtn.innerHTML = "📂 Load Preset";
        loadBtn.onclick = (e) => {
            e.stopPropagation();
            fetch('/magik_nl_meta_prompter/bg_list_presets')
                .then(res => res.json())
                .then(data => {
                    if (data.status !== "success" || !data.presets.length) {
                        alert("No saved presets found in the presets folder.");
                        return;
                    }
                    const old = document.getElementById("magik-nl-bg-preset-dropdown");
                    if (old) old.remove();

                    const dropdown = document.createElement("div");
                    dropdown.id = "magik-nl-bg-preset-dropdown";
                    dropdown.className = "magik-nl-bg-preset-dropdown";

                    const rect = loadBtn.getBoundingClientRect();
                    dropdown.style.top = `${rect.top - Math.min(320, data.presets.length * 44) - 10}px`;
                    dropdown.style.left = `${rect.left}px`;
                    dropdown.style.width = `${rect.width}px`;

                    data.presets.forEach(pName => {
                        const item = document.createElement("div");
                        item.className = "magik-nl-bg-preset-item";
                        item.textContent = pName;
                        item.onmousedown = (evt) => {
                            // mousedown, not click: the document-level
                            // dismiss handler below is also mousedown-based
                            // (fires before click), so a click handler here
                            // would never run - the dropdown (and this
                            // item) would already be removed from the DOM
                            // by the time click fired.
                            evt.preventDefault();
                            evt.stopPropagation();
                            fetch('/magik_nl_meta_prompter/bg_load_preset', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ preset_name: pName }),
                            }).then(res => res.json()).then(resData => {
                                if (resData.status === "success" && resData.data) {
                                    const d = resData.data;
                                    setW(`bg_fix_${index}`, d.fix || "");
                                    setW(`bg_random_text_${index}`, d.random_text || "");
                                    setW(`bg_how_many_${index}`, d.how_many || 1);
                                    setW(`bg_location_type_${index}`, d.location_type || "indoors");
                                    setW(`bg_include_location_${index}`, d.include_location !== undefined ? d.include_location : true);

                                    fixInput.value = d.fix || "";
                                    randomInput.value = d.random_text || "";
                                    howManyInput.value = d.how_many || 1;
                                    updateToggle();

                                    loadBtn.style.backgroundColor = "#00bcd4";
                                    setTimeout(() => loadBtn.style.backgroundColor = "#37474f", 300);
                                }
                                dropdown.remove();
                            });
                        };
                        dropdown.appendChild(item);
                    });

                    document.body.appendChild(dropdown);
                    const closeDropdown = () => {
                        dropdown.remove();
                        document.removeEventListener("mousedown", closeDropdown);
                    };
                    setTimeout(() => document.addEventListener("mousedown", closeDropdown), 10);
                });
        };

        controlsRow.append(
            howManyLabel, howManyInput, countBtn, countDisplay,
            toggleContainer,
            saveBtn, loadBtn
        );

        section.append(fixRow, randomRow, controlsRow);

        this.bgFields[index] = { fixInput, randomInput };

        this.syncCallbacks.push(() => {
            const fixW = getW(`bg_fix_${index}`) ?? "";
            const randomW = getW(`bg_random_text_${index}`) ?? "";
            const howManyW = getW(`bg_how_many_${index}`) ?? 1;
            if (fixInput.value !== fixW) fixInput.value = fixW;
            if (randomInput.value !== randomW) randomInput.value = randomW;
            if (howManyInput.value !== String(howManyW)) howManyInput.value = howManyW;
            updateToggle();
        });

        updateToggle();
        this.updateBackgroundGreyedState();
        return section;
    }

    // LoRA stack, ported from AnimaX's createLoRASection. Written in NL's
    // idiom: event handlers resolve the live widget fresh via this.w(name)
    // on every call (widget objects are recreated on workflow load), and
    // widget->DOM sync rides this.syncCallbacks. These controls are
    // deliberately NOT registered in this.controls: syncFromDOM() writes raw
    // DOM strings into widget values, which is wrong for typed number/select
    // widgets — DOM->widget flow happens in the handlers below, and
    // persistence rides the name-keyed magikNlValues backup like every
    // other widget.
    createLoRASection(index) {
        const section = document.createElement("div");
        section.className = "magik-nl-lora-section";

        const title = document.createElement("h4");
        title.className = "magik-nl-lora-title";
        title.innerHTML = `<i class="ph ph-sliders-horizontal"></i> LoRAs`;
        section.appendChild(title);

        const loraGrid = document.createElement("div");
        loraGrid.className = "magik-nl-lora-grid";
        section.appendChild(loraGrid);

        // Define the 11 phases
        const phaseLabels = [
            "Posing", "Teasing", "Groping", "Group Groping", "Cunni",
            "BJ", "Action", "Anaction", "Group BJ", "Group", "Facial"
        ];

        const setW = (name, value) => {
            const w = this.w(name);
            if (w) { w.value = value; if (w.callback) w.callback(value); }
        };
        const getW = (name) => this.w(name)?.value;

        const resetSlot = (l) => {
            setW(`lora_${index}_${l}`, "None");
            setW(`lora_enable_${index}_${l}`, false);
            setW(`lora_strength_model_${index}_${l}`, 1.0);
            setW(`lora_strength_clip_${index}_${l}`, 1.0);
            setW(`lora_phases_${index}_${l}`, "1,1,1,1,1,1,1,1,1,1,1");
            setW(`lora_trigger_word_${index}_${l}`, "");
            setW(`lora_trigger_point_${index}_${l}`, "background");
            setW(`lora_strength_locked_${index}_${l}`, false);
        };
        // Copies slot `from`'s values into slot `to` (used to shift every
        // later row up by one when an earlier row is removed).
        const copySlot = (from, to) => {
            setW(`lora_${index}_${to}`, getW(`lora_${index}_${from}`) ?? "None");
            setW(`lora_enable_${index}_${to}`, getW(`lora_enable_${index}_${from}`) ?? false);
            setW(`lora_strength_model_${index}_${to}`, getW(`lora_strength_model_${index}_${from}`) ?? 1.0);
            setW(`lora_strength_clip_${index}_${to}`, getW(`lora_strength_clip_${index}_${from}`) ?? 1.0);
            setW(`lora_phases_${index}_${to}`, getW(`lora_phases_${index}_${from}`) ?? "1,1,1,1,1,1,1,1,1,1,1");
            setW(`lora_trigger_word_${index}_${to}`, getW(`lora_trigger_word_${index}_${from}`) ?? "");
            setW(`lora_trigger_point_${index}_${to}`, getW(`lora_trigger_point_${index}_${from}`) ?? "background");
            setW(`lora_strength_locked_${index}_${to}`, getW(`lora_strength_locked_${index}_${from}`) ?? false);
        };

        const getVisibleCount = () => {
            const v = parseInt(this.w(`lora_visible_${index}`)?.value, 10);
            return Math.max(0, Math.min(MAX_LORA_SLOTS, isNaN(v) ? 2 : v));
        };
        const setVisibleCount = (n) => setW(`lora_visible_${index}`, Math.max(0, Math.min(MAX_LORA_SLOTS, n)));

        let renderedState = null;
        const renderLoraGrid = () => {
            const visibleCount = getVisibleCount();
            const state = JSON.stringify([visibleCount, ...Array.from({length: visibleCount}, (_, n) => {
                const l = n + 1;
                return ["lora", "lora_enable", "lora_strength_model", "lora_strength_clip",
                    "lora_phases", "lora_trigger_word", "lora_trigger_point", "lora_strength_locked"]
                    .map(key => getW(`${key}_${index}_${l}`));
            })]);
            if (state === renderedState) return;
            renderedState = state;
            loraGrid.innerHTML = "";

            for (let l = 1; l <= visibleCount; l++) {
                const slot = document.createElement("div");
                slot.className = "magik-nl-lora-slot";

                const row = document.createElement("div");
                row.className = "magik-nl-lora-row";

                // Enable toggle
                const enableBtn = document.createElement("button");
                enableBtn.className = "magik-nl-lora-enable";
                const updateEnable = () => {
                    const active = !!this.w(`lora_enable_${index}_${l}`)?.value;
                    enableBtn.innerHTML = active ? "<i class='ph ph-check'></i>" : "";
                    enableBtn.classList.toggle("active", active);
                    row.classList.toggle("disabled", !active);
                };
                enableBtn.onclick = () => {
                    const w = this.w(`lora_enable_${index}_${l}`);
                    if (w) {
                        w.value = !w.value;
                        if (w.callback) w.callback(w.value);
                    }
                    updateEnable();
                };

                // LoRA name — searchable field instead of a plain <select>
                // (LoRA lists can be long/path-like, e.g. "KREA2/Pose/...").
                const nameInput = document.createElement("input");
                nameInput.type = "text";
                nameInput.className = "magik-nl-lora-name";
                nameInput.placeholder = "Search LoRA...";
                nameInput.value = String(this.w(`lora_${index}_${l}`)?.value ?? "None");
                attachLoraSearch(
                    nameInput,
                    () => this.w(`lora_${index}_${l}`)?.options?.values || [],
                    () => String(this.w(`lora_${index}_${l}`)?.value ?? "None"),
                    (val) => {
                        const w = this.w(`lora_${index}_${l}`);
                        if (w) {
                            w.value = val;
                            if (w.callback) w.callback(val);
                        }
                    }
                );

                const smLabel = document.createElement("label");
                smLabel.innerText = "Model:";

                // Model strength
                const smInput = document.createElement("input");
                smInput.type = "number";
                smInput.className = "magik-nl-lora-strength";
                smInput.step = 0.01;
                smInput.value = this.w(`lora_strength_model_${index}_${l}`)?.value ?? 1.0;

                // Lock Button
                const lockBtn = document.createElement("button");
                lockBtn.className = "magik-nl-lock-btn";
                const paintLock = () => {
                    const locked = !!(this.w(`lora_strength_locked_${index}_${l}`)?.value ?? false);
                    lockBtn.dataset.locked = String(locked);
                    lockBtn.innerHTML = locked ? "🔒" : "🔓";
                    lockBtn.setAttribute("aria-pressed", String(locked));
                    lockBtn.title = locked ? "Model and CLIP strengths linked" : "Model and CLIP strengths independent";
                };
                paintLock();
                lockBtn.style.margin = "0 5px";

                const scLabel = document.createElement("label");
                scLabel.innerText = "CLIP:";

                // CLIP strength
                const scInput = document.createElement("input");
                scInput.type = "number";
                scInput.className = "magik-nl-lora-strength";
                scInput.step = 0.01;
                scInput.value = this.w(`lora_strength_clip_${index}_${l}`)?.value ?? 1.0;

                // Logic
                lockBtn.onclick = () => {
                    const locked = !Boolean(this.w(`lora_strength_locked_${index}_${l}`)?.value ?? false);
                    setW(`lora_strength_locked_${index}_${l}`, locked);
                    if (locked) {
                        const value = Number(this.w(`lora_strength_model_${index}_${l}`)?.value ?? 1);
                        scInput.value = value;
                        setW(`lora_strength_clip_${index}_${l}`, value);
                    }
                    paintLock();
                };

                smInput.oninput = (e) => {
                    const w = this.w(`lora_strength_model_${index}_${l}`);
                    if (w) { w.value = parseFloat(e.target.value) || 0; if (w.callback) w.callback(w.value); }
                    if (lockBtn.dataset.locked === "true") {
                        scInput.value = e.target.value;
                        const clipW = this.w(`lora_strength_clip_${index}_${l}`);
                        if (clipW) { clipW.value = parseFloat(e.target.value) || 0; if (clipW.callback) clipW.callback(clipW.value); }
                    }
                };

                scInput.oninput = (e) => {
                    const value = parseFloat(e.target.value) || 0;
                    setW(`lora_strength_clip_${index}_${l}`, value);
                    if (lockBtn.dataset.locked === "true") {
                        smInput.value = value;
                        setW(`lora_strength_model_${index}_${l}`, value);
                    }
                };

                // Remove button - clears this slot, shifts every later
                // visible slot's data down to fill the gap it leaves, then
                // shrinks the visible count by one and repaints. Every row
                // gets one, including the first ones.
                const removeBtn = document.createElement("button");
                removeBtn.className = "magik-nl-lora-remove";
                removeBtn.title = "Remove this LoRA";
                removeBtn.innerHTML = "<i class='ph ph-x'></i>";
                removeBtn.onclick = () => {
                    for (let k = l; k < visibleCount; k++) copySlot(k + 1, k);
                    resetSlot(visibleCount);
                    setVisibleCount(visibleCount - 1);
                    renderLoraGrid();
                };

                row.append(enableBtn, nameInput, smLabel, smInput, lockBtn, scLabel, scInput, removeBtn);
                slot.appendChild(row);

                // Trigger word + insertion point — separate row so the
                // already-dense name/strength row above doesn't get more
                // cramped. Fires (see _active_lora_triggers in the .py) on
                // the same enable+phase gate as the row above, independent
                // of whether a LoRA file is actually picked in nameInput.
                const triggerRow = document.createElement("div");
                triggerRow.className = "magik-nl-lora-trigger-row";

                const triggerLabel = document.createElement("label");
                triggerLabel.innerText = "Trigger:";

                const triggerInput = document.createElement("input");
                triggerInput.type = "text";
                triggerInput.className = "magik-nl-lora-trigger-word";
                triggerInput.placeholder = "trigger word / expression";
                triggerInput.value = String(this.w(`lora_trigger_word_${index}_${l}`)?.value ?? "");
                triggerInput.oninput = (e) => {
                    const w = this.w(`lora_trigger_word_${index}_${l}`);
                    if (w) { w.value = e.target.value; if (w.callback) w.callback(w.value); }
                };

                const triggerPointSelect = document.createElement("select");
                triggerPointSelect.className = "magik-nl-lora-trigger-point";
                const pointWidget = this.w(`lora_trigger_point_${index}_${l}`);
                const pointOptions = pointWidget?.options?.values
                    || ["background", "character", "outfit", "pose", "action", "overall"];
                pointOptions.forEach(v => {
                    const opt = document.createElement("option");
                    opt.value = v; opt.textContent = v;
                    if (v === (pointWidget?.value ?? "background")) opt.selected = true;
                    triggerPointSelect.appendChild(opt);
                });
                triggerPointSelect.onchange = (e) => {
                    const w = this.w(`lora_trigger_point_${index}_${l}`);
                    if (w) { w.value = e.target.value; if (w.callback) w.callback(w.value); }
                };

                triggerRow.append(triggerLabel, triggerInput, triggerPointSelect);
                slot.appendChild(triggerRow);

                // Phase Buttons
                const btnRow = document.createElement("div");
                btnRow.className = "magik-nl-lora-btn-row";
                btnRow.style.cssText = "display: flex; gap: 4px; margin-bottom: 8px; justify-content: center; flex-wrap: wrap;";

                // `let`, not `const` — rebound in updatePhaseButtons()/onclick
                // below, same reason as enableW/nameW/smW/scW above: ComfyUI
                // can recreate backend widget objects on workflow (re)load, so
                // a reference captured once here can go stale.
                let phasesWidget = this.w(`lora_phases_${index}_${l}`);

                const updatePhaseButtons = () => {
                    phasesWidget = this.w(`lora_phases_${index}_${l}`) || phasesWidget;
                    const state = phasesWidget?.value?.split(",") || Array(11).fill("1");
                    const buttons = btnRow.querySelectorAll(".magik-nl-phase-btn");
                    buttons.forEach((btn, idx) => {
                        const isActive = state[idx] === "1";
                        btn.classList.toggle("active", isActive);
                    });
                };

                const state = phasesWidget?.value?.split(",") || Array(11).fill("1");

                phaseLabels.forEach((label, idx) => {
                    const btn = document.createElement("button");
                    const num = idx + 1;
                    btn.textContent = `${num}-${label}`;
                    btn.className = "magik-nl-phase-btn";

                    if (state[idx] === "1") {
                        btn.classList.add("active");
                    }

                    btn.onclick = () => {
                        phasesWidget = this.w(`lora_phases_${index}_${l}`) || phasesWidget;
                        let stateArr = phasesWidget.value.split(",");
                        stateArr[idx] = stateArr[idx] === "1" ? "0" : "1";
                        phasesWidget.value = stateArr.join(",");
                        if (phasesWidget.callback) phasesWidget.callback(phasesWidget.value);

                        // Refresh visuals
                        btn.classList.toggle("active", stateArr[idx] === "1");
                    };
                    btnRow.appendChild(btn);
                });

                slot.appendChild(btnRow);
                loraGrid.appendChild(slot);
                updateEnable();
                updatePhaseButtons();
            }

            // Add-LoRA button - reveals the next slot in the fixed
            // MAX_LORA_SLOTS-slot backend pool and repaints. Hidden once
            // every slot is in use.
            if (visibleCount < MAX_LORA_SLOTS) {
                const addBtn = document.createElement("button");
                addBtn.className = "magik-nl-lora-add";
                addBtn.innerHTML = `<i class="ph ph-plus"></i> Add LoRA`;
                addBtn.onclick = () => {
                    setVisibleCount(visibleCount + 1);
                    renderLoraGrid();
                };
                loraGrid.appendChild(addBtn);
            }
        };

        renderLoraGrid();
        // One callback for the whole section (not per-row - a variable
        // number of rows can't each own a permanent slot in this.syncCallbacks
        // without leaking stale closures across Add/Remove repaints).
        this.syncCallbacks.push(() => renderLoraGrid());

        return section;
    }

    sync() {
        this._syncWidgetMap = this.widgetMap();
        try { this.syncCallbacks.forEach(cb => cb()); }
        finally { this._syncWidgetMap = null; }
        this.updateActiveComboHighlight(this.executedSlot);
    }
}

// ----- Extension registration -----
app.registerExtension({
    name: "MagikNLMetaPrompter.Magnificent",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "Magik.NLMetaPrompter") return;

        nodeType.prototype.onNodeCreated = function () {
            this._magikSettings = createSettingsStore(this, "magik_nl_meta_prompter");
            // Only the compact settings widget needs hiding.
            hideMagikBackendWidgets(this);
            setTimeout(() => hideMagikBackendWidgets(this), 50);
            setTimeout(() => hideMagikBackendWidgets(this), 200);

            // Phase banner is driven by process()'s actual computed phase,
            // sent back via the "ui" dict on execution — not by anything
            // guessable from widget values in the browser (index is a
            // forceInput socket, its .value here is never the real one).
            this._magikExecutedHandler = ({ detail }) => {
                if (!detail || String(detail.node) !== String(this.id)) return;
                this.ui?.updateExecutionSummary(detail.output?.magik_nl_summary?.[0]);
                const phaseOut = detail.output?.magik_nl_phase;
                this.ui?.updatePhaseBanner(phaseOut ? phaseOut[0] : null);
                const executedSlot = detail.output?.magik_nl_slot?.[0];
                this.ui?.updateActiveComboHighlight(executedSlot);
                const selectedCharacter = detail.output?.magik_nl_random_character?.[0];
                this.ui?.updateRandomCharacterSelection(executedSlot, selectedCharacter);
            };
            api.addEventListener("executed", this._magikExecutedHandler);

            this.ui = new MagikNLMetaUIController(this);

            this.ui._syncWidgetMap = this.ui.widgetMap();
            const paramsPanel = this.ui.createGlobalParamsPanel();
            const banner = this.ui.createPhaseBanner();

            const grid = document.createElement("div");
            grid.className = "magik-nl-grid";
            for (let i = 1; i <= 8; i++) {
                grid.appendChild(this.ui.createComboCell(i));
            }

            // Built after the cells above so its initial refresh() sees all
            // 8 already registered in this.cells and can hide 2..8 right away.
            const comboCountBar = this.ui.createComboCountControl();

            const master = document.createElement("div");
            master.className = "magik-nl-master";
            master.appendChild(paramsPanel);
            master.appendChild(banner);
            master.appendChild(this.ui.createExecutionSummary());
            master.appendChild(comboCountBar);
            master.appendChild(grid);
            this._magikTextPreviewCleanup = installTextPreview(this, master);

            this.ui._syncWidgetMap = null;
            const masterWidget = this.addDOMWidget("master_ui", "custom", master, { serialize: false });
            masterWidget.serialize = false;

            const cleanupZoom = installCanvasZoomPassthrough(master);
            const cleanupPan  = installCanvasPanPassthrough(master);
            this._magikPanZoomCleanup = [cleanupZoom, cleanupPan];

            const mwIdx = this.widgets.indexOf(masterWidget);
            if (mwIdx > 0) {
                this.widgets.splice(mwIdx, 1);
                this.widgets.unshift(masterWidget);
            }

            // Measure CSS layout units, not getBoundingClientRect(), whose
            // dimensions include canvas zoom. Let ComfyUI account for sockets
            // and widget spacing instead of guessing a fixed extra height.
            this.size[0] = Math.max(5000, this.size[0] || 0);
            let masterH = 1;
            let fitting = false;
            let disposed = false;
            let lastMeasuredHeight = 0;
            let lastMeasuredWidth = 0;
            const fitFrontend = () => {
                if (disposed || fitting) return;
                fitting = true;
                try {
                    const height = Math.ceil(Math.max(master.offsetHeight || 0, master.scrollHeight || 0));
                    if (height <= 0) return; // hidden/unmounted: retain last size
                    masterH = height;
                    // Do not add overflow repeatedly: scrollbar/rounding differences
                    // can otherwise grow the node on every ResizeObserver callback.
                    const width = Math.ceil(Math.max(5000, this.size[0] || 0));
                    if (height === lastMeasuredHeight && width === lastMeasuredWidth
                        && this.size[1] === this._magikFittedHeight) return;
                    lastMeasuredHeight = height;
                    lastMeasuredWidth = width;
                    const measured = this.computeSize?.([width, 0]);
                    const heightWithSockets = Number(measured?.[1]);
                    const desired = [width, Math.ceil(Number.isFinite(heightWithSockets)
                        && heightWithSockets >= masterH ? heightWithSockets : masterH + 40)];
                    this._magikFittedHeight = desired[1];
                    if (this.size[0] !== desired[0] || this.size[1] !== desired[1]) {
                        if (this.setSize) this.setSize(desired);
                        else this.size = desired;
                        this.setDirtyCanvas(true, true);
                    }
                } finally { fitting = false; }
            };
            masterWidget.computeSize = (width) => [width || this.size[0], masterH];
            const ro = new ResizeObserver(fitFrontend);
            ro.observe(master);
            this._magikResizeObserver = ro;
            this._magikFitFrontend = fitFrontend;
            this._magikFitCleanup = () => { disposed = true; };
            requestAnimationFrame(fitFrontend);
            // Styles and web fonts can arrive after the first DOM measurement.
            document.fonts?.ready.then(fitFrontend);

                setTimeout(() => {
                    this.ui.sync();
                    this._magikFitFrontend?.();
                    this._magikReady = true;
                }, 100);

        };

        const onSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function(o) {
            if (this.ui && this._magikReady) this.ui.syncFromDOM();
            this._magikSettings?.flush();
            onSerialize?.apply(this, arguments);
            o.magikSettings = this.widgets.find(w => w.name === "settings")?.value;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function(o) {
            onConfigure?.apply(this, arguments);
            const warning = this._magikSettings?.load(o?.magikSettings
                ?? this.widgets.find(w => w.name === "settings")?.value);
            if (warning && this.ui?.executionSummary) this.ui.executionSummary.status.textContent = warning;
            hideMagikBackendWidgets(this);
            this.ui?.sync();
            requestAnimationFrame(() => this._magikFitFrontend?.());
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function() {
            this._magikSettings?.dispose();
            this._magikTextPreviewCleanup?.();
            onRemoved?.apply(this, arguments);
            if (this._magikExecutedHandler) {
                api.removeEventListener("executed", this._magikExecutedHandler);
                this._magikExecutedHandler = null;
            }
            if (this.ui && this.ui.stateRefreshInterval) {
                clearInterval(this.ui.stateRefreshInterval);
                this.ui.stateRefreshInterval = null;
            }
            this._magikFitCleanup?.();
            this._magikFitFrontend = null;
            this._magikFitCleanup = null;
            if (this._magikResizeObserver) {
                this._magikResizeObserver.disconnect();
                this._magikResizeObserver = null;
            }
            if (this._magikPanZoomCleanup) {
                this._magikPanZoomCleanup.forEach(fn => fn && fn());
                this._magikPanZoomCleanup = null;
            }
        };
    }
});
