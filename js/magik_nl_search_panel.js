function addExportModeToggle(modal) {
    const select = modal.querySelector("#magikExportMode");
    if (!select) return;
    const group = document.createElement("span"); group.setAttribute("role", "group"); group.setAttribute("aria-label", "Export format");
    group.style.cssText = "display:inline-flex;gap:6px;margin-left:12px;";
    const buttons = [];
    const sync = () => buttons.forEach(({button, value}) => { const active = select.value === value; button.setAttribute("aria-pressed", String(active)); button.style.background = active ? "#245c45" : "#222"; });
    for (const [value, label] of [["tags", "Tags"], ["nl", "Natural language"], ["both", "Both"]]) {
        const button = document.createElement("button"); button.type = "button"; button.textContent = label;
        button.style.cssText = "padding:8px 12px;color:white;border:1px solid #526079;border-radius:8px;cursor:pointer;font:inherit;";
        button.onclick = () => { select.value = value; sync(); select.dispatchEvent(new Event("change", {bubbles:true})); };
        buttons.push({button, value}); group.appendChild(button);
    }
    select.hidden = true; select.parentElement.appendChild(group); select.addEventListener("change", sync); sync();
}

// ===========================================================================
// Magik NL Meta Prompter — WaifuDB Search Panel integration
// ===========================================================================
// This is a direct copy of magik_animax_search_panel.js with the CSS
// loading updated to use magik_nl_search_panel.css.

function loadCSS() {
    if (document.getElementById("magik-nl-search-panel-styles")) return;
    const link = document.createElement("link");
    link.id = "magik-nl-search-panel-styles";
    link.rel = "stylesheet";
    link.type = "text/css";
    link.href = new URL("./magik_nl_search_panel.css", import.meta.url).href;
    document.head.appendChild(link);
}
loadCSS();

// ---------------------------------------------------------------------------
// Recent series — persists across reloads via localStorage (shared w/ WaifuDB)
// ---------------------------------------------------------------------------
const RECENT_MAX = 8;
const RECENT_KEY = "waifudb_recent_series";

function loadRecentSeries() {
    try {
        const raw = localStorage.getItem(RECENT_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch { return []; }
}

function saveRecentSeries(arr) {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(arr)); } catch {}
}

const recentSeries = loadRecentSeries();

function pushRecentSeries(name) {
    const idx = recentSeries.indexOf(name);
    if (idx !== -1) recentSeries.splice(idx, 1);
    recentSeries.unshift(name);
    if (recentSeries.length > RECENT_MAX) recentSeries.pop();
    saveRecentSeries(recentSeries);
}

// ---------------------------------------------------------------------------
// Favorites — persists across reloads via localStorage (shared w/ WaifuDB)
// ---------------------------------------------------------------------------
const FAV_KEY = "waifudb_favorites";

function loadFavorites() {
    try {
        const raw = localStorage.getItem(FAV_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
}

function saveFavorites(favs) {
    try { localStorage.setItem(FAV_KEY, JSON.stringify(favs)); } catch {}
}

const favorites = loadFavorites();

function isFavorite(charId) { return !!favorites[String(charId)]; }

function toggleFavorite(charId, charData) {
    const id = String(charId);
    if (favorites[id]) {
        delete favorites[id];
    } else {
        favorites[id] = charData;
    }
    saveFavorites(favorites);
}

function getFavoritesList() {
    return Object.values(favorites).sort((a, b) =>
        (a.original_input || "").localeCompare(b.original_input || "")
    );
}

// ---------------------------------------------------------------------------
// Super Favorites (My Waifus) — persists across reloads via localStorage
// ---------------------------------------------------------------------------
const SUPER_FAV_KEY = "waifudb_super_favorites";

function loadSuperFavorites() {
    try {
        const raw = localStorage.getItem(SUPER_FAV_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
}

function saveSuperFavorites(favs) {
    try { localStorage.setItem(SUPER_FAV_KEY, JSON.stringify(favs)); } catch {}
}

const superFavorites = loadSuperFavorites();

function isSuperFavorite(charId) { return !!superFavorites[String(charId)]; }

function toggleSuperFavorite(charId, charData) {
    const id = String(charId);
    if (superFavorites[id]) {
        delete superFavorites[id];
    } else {
        superFavorites[id] = charData;
    }
    saveSuperFavorites(superFavorites);
    document.dispatchEvent(new CustomEvent("waifudb_super_favorites_changed"));
}

function getSuperFavoritesList() {
    return Object.values(superFavorites).sort((a, b) =>
        (a.original_input || "").localeCompare(b.original_input || "")
    );
}

function setLoading(modal, visible, message = "Loading…") {
    const el = modal.querySelector("#magikLoadingMsg");
    if (!el) return;
    el.textContent = message;
    el.style.display = visible ? "block" : "none";
}

function showError(modal, message) {
    const el = modal.querySelector("#magikErrorMsg");
    if (!el) return;
    el.textContent = message ? "⚠ " + message : "";
    el.style.display = message ? "block" : "none";
}

// ---------------------------------------------------------------------------
// Dropdown panel positioning (shared by createSearchableSelect / createCharSelect)
// ---------------------------------------------------------------------------
// Dropdown panels are position:fixed (viewport-relative) rather than
// absolutely anchored inside .waifudb-dropdown-root, because an
// absolutely-positioned panel gets clipped at the modal's own border once
// the modal sets `overflow-y: auto` — this modal in particular stacks the
// series dropdown, character dropdown, My Waifus grid, selection list,
// checkbox grid, and footer all in one scrollable column, so the panel had
// almost nowhere to render without being cut off. We compute the panel's
// screen position by hand instead, and flip it above the trigger when there
// isn't room below.
// Shared search/trait scale preference; constrained to a usable viewport.
function addUIScaleSlider(modal) {
    const storageKey = "magik_waifudb_ui_scale";
    let saved = 100;
    try { saved = Number(localStorage.getItem(storageKey) || 100); } catch {}
    const row = document.createElement("label");
    row.style.cssText = "display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:13px;";
    const caption = document.createElement("span"); caption.textContent = "UI scale";
    const slider = document.createElement("input");
    slider.type = "range"; slider.min = "50"; slider.max = "200"; slider.step = "5";
    slider.setAttribute("aria-label", "Character search UI scale");
    slider.style.cssText = "flex:1;min-width:100px;";
    slider.value = String(Number.isFinite(saved) ? Math.max(50, Math.min(200, saved)) : 100);
    const value = document.createElement("output"); value.style.minWidth = "42px";
    function apply() {
        const percent = Math.max(50, Math.min(200, Number(slider.value) || 100));
        const scale = percent / 100;
        modal.style.zoom = String(scale);
        modal.style.maxWidth = `${95 / scale}vw`;
        modal.style.maxHeight = `${90 / scale}vh`;
        modal.dataset.uiScale = String(scale);
        value.textContent = `${percent}%`;
        slider.setAttribute("aria-valuetext", `${percent}%`);
        try { localStorage.setItem(storageKey, String(percent)); } catch {}
        window.dispatchEvent(new Event("resize"));
    }
    slider.addEventListener("input", apply);
    row.append(caption, slider, value);
    modal.insertBefore(row, modal.firstChild?.nextSibling || null);
    apply();
}

function attachDropdownPositioning(trigger, panel) {
    function positionPanel() {
        const rect = trigger.getBoundingClientRect();
        const scale = Number(trigger.closest(".waifudb-modal")?.dataset.uiScale) || 1;
        const margin = 4;
        const spaceBelow = window.innerHeight - rect.bottom - margin;
        const spaceAbove = rect.top - margin;
        const naturalHeight = (panel.scrollHeight || 260) * scale;

        panel.style.left = `${rect.left / scale}px`;
        panel.style.width = `${rect.width / scale}px`;

        if (spaceBelow < naturalHeight && spaceAbove > spaceBelow) {
            // Not enough room below, and more room above: flip upward.
            panel.style.top = "";
            panel.style.bottom = `${(window.innerHeight - rect.top + margin) / scale}px`;
            panel.style.maxHeight = `${Math.max(120, spaceAbove) / scale}px`;
        } else {
            panel.style.bottom = "";
            panel.style.top = `${(rect.bottom + margin) / scale}px`;
            panel.style.maxHeight = `${Math.max(120, spaceBelow) / scale}px`;
        }
    }
    function startTracking() {
        positionPanel();
        // Capture phase so scrolling any ancestor (e.g. the modal body)
        // keeps the panel glued to the trigger — scroll events don't bubble,
        // but a capture listener on window still sees them.
        window.addEventListener("scroll", positionPanel, true);
        window.addEventListener("resize", positionPanel);
    }
    function stopTracking() {
        window.removeEventListener("scroll", positionPanel, true);
        window.removeEventListener("resize", positionPanel);
    }
    return { positionPanel, startTracking, stopTracking };
}

// ---------------------------------------------------------------------------
// createSearchableSelect (unchanged from WaifuDB)
// ---------------------------------------------------------------------------
function createSearchableSelect({ placeholder = "Select…", onSelect } = {}) {
    let allItems = [];
    let selectedValue = "";
    let isOpen = false;
    let sortMode = "alpha";

    const root = document.createElement("div");
    root.classList.add("waifudb-dropdown-root");

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.classList.add("waifudb-dropdown-trigger");
    trigger.innerHTML = `<span class="magik-trigger-label">${placeholder}</span><span>▾</span>`;
    root.appendChild(trigger);

    const panel = document.createElement("div");
    panel.classList.add("waifudb-dropdown-panel");
    root.appendChild(panel);

    const sortBar = document.createElement("div");
    sortBar.classList.add("waifudb-dropdown-sortbar");
    panel.appendChild(sortBar);

    function makeSortBtn(label, mode) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = label;
        btn.classList.add("waifudb-dropdown-sort-btn");
        if (sortMode === mode) btn.classList.add("waifudb-active");

        btn.addEventListener("mousedown", e => {
            e.preventDefault();
            if (sortMode === mode) return;
            sortMode = mode;
            sortBar.querySelectorAll(".waifudb-dropdown-sort-btn").forEach(b => {
                b.classList.toggle("waifudb-active", b === btn);
            });
            renderList(searchInput.value);
        });
        return btn;
    }
    sortBar.appendChild(makeSortBtn("A – Z", "alpha"));
    sortBar.appendChild(makeSortBtn("Most characters", "count"));

    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.placeholder = "Filter…";
    searchInput.classList.add("waifudb-dropdown-search");
    panel.appendChild(searchInput);

    const list = document.createElement("div");
    list.classList.add("waifudb-dropdown-list");
    panel.appendChild(list);

    function renderList(query = "") {
        list.innerHTML = "";
        const q = query.toLowerCase();
        let filtered = q
            ? allItems.filter(it => it.label.toLowerCase().includes(q))
            : allItems.slice();

        const hasCount = allItems.length > 0 && allItems[0].count != null;
        if (hasCount && sortMode === "count") {
            filtered = filtered.slice().sort((a, b) => (b.count || 0) - (a.count || 0));
        }

        if (selectedValue && !q) {
            const clearRow = document.createElement("div");
            clearRow.textContent = "✕ Clear selection";
            clearRow.classList.add("waifudb-dropdown-clear-row");
            clearRow.addEventListener("mousedown", e => { e.preventDefault(); select("", ""); });
            list.appendChild(clearRow);
        }

        if (filtered.length === 0) {
            const empty = document.createElement("div");
            empty.textContent = "No results";
            empty.classList.add("waifudb-dropdown-empty-row");
            list.appendChild(empty);
            return;
        }
        filtered.forEach(item => {
            const row = document.createElement("div");
            row.classList.add("waifudb-dropdown-item-row");
            if (item.value === selectedValue) row.classList.add("waifudb-selected");

            const nameSpan = document.createElement("span");
            nameSpan.textContent = item.label;
            nameSpan.classList.add("waifudb-dropdown-item-name");
            row.appendChild(nameSpan);

            if (item.count != null) {
                const badge = document.createElement("span");
                badge.textContent = item.count;
                badge.classList.add("waifudb-dropdown-badge");
                row.appendChild(badge);
            }
            row.addEventListener("mousedown", e => {
                e.preventDefault();
                select(item.value, item.label);
            });
            list.appendChild(row);
        });
    }

    const dropdownPositioning = attachDropdownPositioning(trigger, panel);

    function open() {
        panel.classList.add("waifudb-open");
        isOpen = true;
        searchInput.value = "";
        const hasCount = allItems.length > 0 && allItems[0].count != null;
        sortBar.style.display = hasCount ? "flex" : "none";
        renderList();
        dropdownPositioning.startTracking();
        searchInput.focus();
    }

    function close() {
        panel.classList.remove("waifudb-open");
        isOpen = false;
        dropdownPositioning.stopTracking();
    }

    function select(value, label) {
        selectedValue = value;
        const lbl = trigger.querySelector(".magik-trigger-label");
        lbl.textContent = label || placeholder;
        lbl.style.color = label ? "#eee" : "#aaa";
        close();
        onSelect && onSelect(value, label);
    }

    trigger.addEventListener("click", e => { e.stopPropagation(); isOpen ? close() : open(); });
    searchInput.addEventListener("input", () => renderList(searchInput.value));
    function onDocClick(e) {
        if (!root.isConnected) {
            document.removeEventListener("mousedown", onDocClick);
            if (isOpen) close();
            return;
        }
        if (!root.contains(e.target)) close();
    }
    document.addEventListener("mousedown", onDocClick);

    root.setItems = function(items) {
        allItems = items.map(i =>
            typeof i === "string"
                ? { value: i, label: i }
                : { value: i.value ?? i.name, label: i.label ?? i.name, count: i.count, thumbnail: i.thumbnail }
        );
        select("", "");
        const lbl = trigger.querySelector(".magik-trigger-label");
        lbl.textContent = placeholder;
        lbl.style.color = "#aaa";
    };
    root.getValue = () => selectedValue;
    root.reset    = () => select("", "");
    root.selectByValue = function(value) {
        const item = allItems.find(i => i.value === value);
        if (item) select(item.value, item.label);
    };
    Object.defineProperty(root, "isOpen", { get: () => isOpen });
    return root;
}

// ---------------------------------------------------------------------------
// Flyout Preview System (unchanged)
// ---------------------------------------------------------------------------
const hoverFlyout = document.createElement("img");
hoverFlyout.classList.add("waifudb-flyout");
if (document.body) {
    document.body.appendChild(hoverFlyout);
} else {
    document.addEventListener("DOMContentLoaded", () => document.body.appendChild(hoverFlyout));
}

// ---------------------------------------------------------------------------
// createCharSelect (unchanged from WaifuDB)
// ---------------------------------------------------------------------------
function createCharSelect({ onSelect } = {}) {
    const DEBOUNCE_MS   = 220;
    const MIN_QUERY_LEN = 3;
    const SEARCH_LIMIT  = 50;

    let mode          = "search";
    let staticItems   = [];
    let selectedValue = "";
    let isOpen        = false;
    let debounceTimer = null;
    let activeRequest = 0;
    let lastRenderedItems = [];
    let lastRenderedHl    = "";

    const root = document.createElement("div");
    root.classList.add("waifudb-dropdown-root");

    const tabBar = document.createElement("div");
    tabBar.classList.add("waifudb-tab-bar");
    root.appendChild(tabBar);

    function makeTab(label, targetMode) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = label;
        btn.dataset.tabMode = targetMode;
        btn.classList.add("waifudb-tab");

        btn.addEventListener("mousedown", e => {
            e.preventDefault();
            if (mode === targetMode && isOpen) return;
            if (targetMode === "favorites") {
                mode = "favorites";
                staticItems = getFavoritesList().map(c => ({
                    value: c.char_id, label: c.original_input, data: c,
                }));
            } else {
                mode = "search";
                staticItems = [];
            }
            updateTabStyles();
            if (!isOpen) open(); else { searchInput.value = ""; renderItems(currentItems(), ""); }
        });
        return btn;
    }

    const tabAll  = makeTab("All", "search");
    const tabFavs = makeTab("★ Favorites", "favorites");
    tabBar.appendChild(tabAll);
    tabBar.appendChild(tabFavs);

    function updateTabStyles() {
        [tabAll, tabFavs].forEach(t => {
            const active = t.dataset.tabMode === mode
                || (t.dataset.tabMode === "search" && mode === "series");
            t.classList.toggle("waifudb-active", active);
        });
    }
    updateTabStyles();

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.classList.add("waifudb-dropdown-trigger", "waifudb-dropdown-trigger-flat-bottom");
    trigger.innerHTML = `<span class="magik-clabel">Select Character…</span><span>▾</span>`;
    root.appendChild(trigger);

    const panel = document.createElement("div");
    panel.classList.add("waifudb-dropdown-panel");
    root.appendChild(panel);

    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.classList.add("waifudb-dropdown-search");
    panel.appendChild(searchInput);

    const statusLine = document.createElement("div");
    statusLine.classList.add("waifudb-dropdown-status");
    statusLine.style.display = "none";
    panel.appendChild(statusLine);

    const list = document.createElement("div");
    list.classList.add("waifudb-dropdown-list");
    panel.appendChild(list);

    function renderItems(items, hl = "") {
        lastRenderedItems = items;
        lastRenderedHl    = hl;
        list.innerHTML = "";
        if (!items.length) {
            const el = document.createElement("div");
            el.textContent = mode === "favorites" ? "No favorites yet — click ★ on any character" : "No results";
            el.classList.add("waifudb-dropdown-empty-row");
            list.appendChild(el);
            return;
        }
        const hlLow = hl.toLowerCase();
        items.forEach(item => {
            const isFav = isFavorite(item.value);
            const isSuper = isSuperFavorite(item.value);
            const row = document.createElement("div");
            row.classList.add("waifudb-dropdown-item-row", "waifudb-dropdown-item-row-char");
            if (item.value === selectedValue) row.classList.add("waifudb-selected");

            const thumb = document.createElement("img");
            thumb.classList.add("waifudb-thumb");
            thumb.alt = "";
            if (item.data && item.data.char_id) {
                const thumbUrl = `/custom_character_search/thumbnail/${item.data.char_id}`;

                thumb.src = thumbUrl;
                thumb.title = "Click to open full image";
                thumb.onerror = () => { thumb.style.display = "none"; };

                thumb.addEventListener("mouseenter", e => {
                    hoverFlyout.style.display = "none";
                    hoverFlyout.src = thumbUrl;

                    hoverFlyout.onload = () => {
                        const targetWidth = hoverFlyout.naturalWidth / 2;
                        const targetHeight = hoverFlyout.naturalHeight / 2;

                        hoverFlyout.style.width = targetWidth + "px";
                        hoverFlyout.style.height = targetHeight + "px";

                        const panelRect = panel.getBoundingClientRect();
                        let leftPos = panelRect.left - targetWidth - 15;

                        if (leftPos < 10) {
                            leftPos = panelRect.right + 15;
                        }

                        let topPos = e.clientY - (targetHeight / 2);
                        if (topPos < 10) topPos = 10;
                        if (topPos + targetHeight > window.innerHeight) {
                            topPos = window.innerHeight - targetHeight - 10;
                        }

                        hoverFlyout.style.left = leftPos + "px";
                        hoverFlyout.style.top = topPos + "px";
                        hoverFlyout.style.display = "block";
                    };
                });

                thumb.addEventListener("mouseleave", () => {
                    hoverFlyout.style.display = "none";
                    hoverFlyout.src = "";
                });

                thumb.addEventListener("mousedown", e => {
                    e.preventDefault();
                    e.stopPropagation();
                    window.open(thumbUrl, "_blank");
                });
            } else {
                thumb.style.display = "none";
            }
            row.appendChild(thumb);

            const nameSpan = document.createElement("span");
            nameSpan.classList.add("waifudb-dropdown-item-name");
            if (hlLow && item.label.toLowerCase().includes(hlLow)) {
                const idx = item.label.toLowerCase().indexOf(hlLow);
                const mark = document.createElement("mark");
                mark.textContent = item.label.slice(idx, idx + hlLow.length);
                nameSpan.append(
                    document.createTextNode(item.label.slice(0, idx)),
                    mark,
                    document.createTextNode(item.label.slice(idx + hlLow.length))
                );
            } else {
                nameSpan.textContent = item.label;
            }
            row.appendChild(nameSpan);

            if (mode !== "favorites") {
                const star = document.createElement("span");
                star.textContent = isFav ? "★" : "☆";
                star.title = isFav ? "Remove from favorites" : "Add to favorites";
                star.classList.add("waifudb-star-icon");
                if (isFav) star.classList.add("waifudb-is-favorite");

                star.addEventListener("mouseleave", () => {
                    star.classList.toggle("waifudb-is-favorite", isFavorite(item.value));
                });
                star.addEventListener("mousedown", e => {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleFavorite(item.value, item.data);
                    const nowFav = isFavorite(item.value);
                    star.textContent = nowFav ? "★" : "☆";
                    star.classList.toggle("waifudb-is-favorite", nowFav);
                    updateFavTab();
                    renderItems(lastRenderedItems, lastRenderedHl);
                });
                row.appendChild(star);

                const superStar = document.createElement("span");
                superStar.textContent = isSuper ? "★" : "☆";
                superStar.title = isSuper ? "Remove from My Waifus" : "Add to My Waifus";
                superStar.classList.add("waifudb-star-icon", "waifudb-super-star-icon");
                if (isSuper) superStar.classList.add("waifudb-is-super-favorite");

                superStar.addEventListener("mouseleave", () => {
                    superStar.classList.toggle("waifudb-is-super-favorite", isSuperFavorite(item.value));
                });
                superStar.addEventListener("mousedown", e => {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleSuperFavorite(item.value, item.data);
                    const nowSuper = isSuperFavorite(item.value);
                    superStar.textContent = nowSuper ? "★" : "☆";
                    superStar.classList.toggle("waifudb-is-super-favorite", nowSuper);
                    renderItems(lastRenderedItems, lastRenderedHl);
                });
                row.appendChild(superStar);
            }

            if (mode === "favorites") {
                const removeBtn = document.createElement("span");
                removeBtn.textContent = "✕";
                removeBtn.title = "Remove from favorites";
                removeBtn.classList.add("waifudb-remove-fav-btn");

                removeBtn.addEventListener("mousedown", e => {
                    e.preventDefault();
                    e.stopPropagation();
                    const id = String(item.value);
                    delete favorites[id];
                    saveFavorites(favorites);
                    updateFavTab();
                    renderItems(
                        getFavoritesList().map(c => ({ value: c.char_id, label: c.original_input, data: c })),
                        lastRenderedHl
                    );
                });
                row.appendChild(removeBtn);
            }

            row.addEventListener("mousedown", e => { e.preventDefault(); select(item.value, item.label, item.data); });
            list.appendChild(row);
        });
    }

    function updateFavTab() {
        const n = Object.keys(favorites).length;
        tabFavs.textContent = n > 0 ? `★ Favorites (${n})` : "★ Favorites";
    }
    updateFavTab();

    function setStatus(text) {
        statusLine.textContent = text;
        statusLine.style.display = text ? "block" : "none";
    }

    function currentItems() {
        if (mode === "favorites")
            return getFavoritesList().map(c => ({ value: c.char_id, label: c.original_input, data: c }));
        if (mode === "series") return staticItems;
        return [];
    }

    const dropdownPositioning = attachDropdownPositioning(trigger, panel);

    function open() {
        panel.classList.add("waifudb-open");
        isOpen = true;
        keyboardFocusIdx = -1;
        searchInput.value = "";
        updateTabStyles();
        if (mode === "favorites") {
            searchInput.placeholder = "Filter favorites…";
            setStatus("");
            renderItems(currentItems(), "");
        } else if (mode === "series") {
            searchInput.placeholder = "Filter…";
            setStatus("");
            renderItems(staticItems, "");
        } else {
            searchInput.placeholder = "Search all characters…";
            setStatus(`Type at least ${MIN_QUERY_LEN} characters to search…`);
            list.innerHTML = "";
        }
        dropdownPositioning.startTracking();
        searchInput.focus();
    }

    function close() {
        panel.classList.remove("waifudb-open");
        isOpen = false;
        clearTimeout(debounceTimer);
        dropdownPositioning.stopTracking();
    }

    function select(value, label, data) {
        selectedValue = value;
        const lbl = trigger.querySelector(".magik-clabel");
        lbl.textContent = label || "Select Character…";
        lbl.style.color = label ? "#eee" : "#aaa";
        close();
        onSelect && onSelect(value, label, data);
    }

    let keyboardFocusIdx = -1;
    function setKeyboardFocus(idx) {
        const rows = list.querySelectorAll(".waifudb-dropdown-item-row");
        rows.forEach((r, i) => r.classList.toggle("waifudb-keyboard-focus", i === idx));
        keyboardFocusIdx = idx;
        if (idx >= 0 && rows[idx]) rows[idx].scrollIntoView({ block: "nearest" });
    }

    searchInput.addEventListener("keydown", e => {
        const rows = list.querySelectorAll(".waifudb-dropdown-item-row");
        if (e.key === "ArrowDown") {
            e.preventDefault();
            if (!isOpen) open();
            setKeyboardFocus(Math.min(keyboardFocusIdx + 1, rows.length - 1));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            if (!isOpen) open();
            setKeyboardFocus(Math.max(keyboardFocusIdx - 1, 0));
        } else if (e.key === "Enter") {
            e.preventDefault();
            if (keyboardFocusIdx >= 0 && rows[keyboardFocusIdx]) {
                rows[keyboardFocusIdx].dispatchEvent(new Event("mousedown", { bubbles: true }));
            } else if (isOpen) {
                close();
            }
        } else if (e.key === "Escape") {
            if (isOpen) close();
        }
    });

    searchInput.addEventListener("input", () => {
        const q = searchInput.value;

        if (mode === "favorites" || mode === "series") {
            const items = currentItems();
            const ql = q.toLowerCase();
            renderItems(
                ql ? items.filter(i => i.label.toLowerCase().includes(ql)) : items,
                q
            );
            return;
        }

        clearTimeout(debounceTimer);
        if (q.length < MIN_QUERY_LEN) {
            setStatus(`Type at least ${MIN_QUERY_LEN} characters to search…`);
            list.innerHTML = "";
            return;
        }
        setStatus("Searching…");
        debounceTimer = setTimeout(async () => {
            const reqId = ++activeRequest;
            try {
                const res = await fetch(
                    `/custom_character_search/char_search?q=${encodeURIComponent(q)}&limit=${SEARCH_LIMIT}`
                );
                if (reqId !== activeRequest) return;
                if (!res.ok) {
                    const body = await res.json().catch(() => ({}));
                    throw new Error(body.error || `Server returned ${res.status}`);
                }
                const data = await res.json();
                if (reqId !== activeRequest) return;
                const items = data.map(c => ({ value: c.char_id, label: c.original_input, data: c }));
                setStatus(items.length === SEARCH_LIMIT
                    ? `Showing top ${SEARCH_LIMIT} results`
                    : `${items.length} result${items.length !== 1 ? "s" : ""}`);
                renderItems(items, q);
            } catch (err) {
                if (reqId !== activeRequest) return;
                setStatus("Error: " + err.message);
                list.innerHTML = "";
            }
        }, DEBOUNCE_MS);
    });

    trigger.addEventListener("click", e => { e.stopPropagation(); isOpen ? close() : open(); });
    function onDocClick(e) {
        if (!root.isConnected) {
            document.removeEventListener("mousedown", onDocClick);
            if (isOpen) close();
            return;
        }
        if (!root.contains(e.target)) close();
    }
    document.addEventListener("mousedown", onDocClick);

    root.setSeriesItems = function(chars) {
        mode = "series";
        staticItems = chars.map((c, i) => ({ value: String(i), label: c.original_input || `character_${i}`, data: c }));
        _reset();
        updateTabStyles();
    };
    root.setSearchMode = function() {
        if (mode !== "favorites") mode = "search";
        staticItems = [];
        _reset();
        updateTabStyles();
    };
    function _reset() {
        selectedValue = "";
        clearTimeout(debounceTimer);
        activeRequest++;
        const lbl = trigger.querySelector(".magik-clabel");
        lbl.textContent = "Select Character…";
        lbl.style.color = "#aaa";
        if (isOpen) open();
    }
    root.getValue = () => selectedValue;
    Object.defineProperty(root, "isOpen", { get: () => isOpen });
    return root;
}

// ---------------------------------------------------------------------------
// Shared tag-writing logic — adapted for AnimaX's 3-field combo layout
// ---------------------------------------------------------------------------
const SMALL_BREAST_TAGS = new Set([
    "medium_breasts", "small_breasts", "flat_chest",
    "medium breasts",  "small breasts",  "flat chest",
]);

function escapeParens(tag) {
    return tag.replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

const FIELD_TARGET_MAP = {
    "breast_size":                              "noface",
    "eye_color":                                "face",
    "hair_color_1,hair_color_2":                 "noface",
    "hairstyle_1,hairstyle_2,hairstyle_3,hairstyle_4": "noface",
    "common_outfits,clothing_pieces":            "clothes",
    "clothing_accessories":                      "clothes",
    "others":                                    "noface",
};
const DANBOORU_TAG_TARGET = "face";

function buildCharTagBuckets(charData, modal, enforceLarge) {
    const allCharText = [
        charData.hairstyle_1, charData.hairstyle_2,
        charData.hairstyle_3, charData.hairstyle_4,
        charData.others,
    ].join(" ").toLowerCase();
    const hasMulticoloredHair = allCharText.includes("multicolored hair")
        || allCharText.includes("multicolored_hair");

    const buckets = { face: [], noface: [], clothes: [] };
    if (charData.danbooru_tag) buckets[DANBOORU_TAG_TARGET].push(charData.danbooru_tag);

    modal.querySelectorAll("#includeCheckboxes input:checked").forEach(cb => {
        const target = FIELD_TARGET_MAP[cb.dataset.cols] || "noface";
        const cols = cb.dataset.cols.split(",");

        if (cols.includes("hair_color_1")) {
            const val1 = (charData.hair_color_1 || "").trim();
            if (val1) buckets[target].push(val1);
            if (hasMulticoloredHair) {
                const val2 = (charData.hair_color_2 || "").trim();
                if (val2) buckets[target].push(val2);
            }
            return;
        }

        cols.forEach(col => {
            const val = (charData[col] || "").trim();
            if (val) buckets[target].push(val);
        });
    });

    const clean = (arr) => {
        const seen = new Set();
        return arr
            .flatMap(t => t.split(",").map(s => s.trim()))
            .map(t => (enforceLarge && SMALL_BREAST_TAGS.has(t)) ? "large_breasts" : t)
            .map(t => escapeParens(t))
            .filter(t => t && !seen.has(t) && seen.add(t))
            .map(t => t.replace(/_/g, " "));
    };

    return { face: clean(buckets.face), noface: clean(buckets.noface), clothes: clean(buckets.clothes) };
}

function buildPreviewText(selectionList, modal) {
    const enforceLarge = modal.querySelector("#magikEnforceLarge")?.checked ?? false;
    const chars = Array.isArray(selectionList) ? selectionList : (selectionList ? [selectionList] : []);
    if (chars.length === 0) return "";
    return chars
        .map(charData => {
            const b = buildCharTagBuckets(charData, modal, enforceLarge);
            const tags = [...b.face, ...b.noface, ...b.clothes].join(", ");
            const nl = [charData.nl_girl_description, charData.nl_clothing].filter(Boolean).join(" ");
            const mode = modal.querySelector("#magikExportMode")?.value || "both";
            return mode === "tags" ? tags : mode === "nl" ? nl : [tags, nl].filter(Boolean).join("\n");
        })
        .join(",\n\n");
}

function updateLivePreview(modal, selectionList) {
    const box = modal.querySelector("#magikLivePreviewText");
    if (!box) return;
    box.value = buildPreviewText(selectionList, modal);
}

function updateSelectionCount(modal, n) {
    const el = modal.querySelector("#magikSelCount");
    if (!el) return;
    el.textContent = n > 0 ? `(${n})` : "";
}

function writeCharsToCombo(node, index, modal, selectionList) {
    showError(modal, "");
    const chars = Array.isArray(selectionList) ? selectionList : (selectionList ? [selectionList] : []);

    if (chars.length === 0) {
        showError(modal, "Please add at least one character to the selection.");
        return false;
    }

    const enforceLarge = modal.querySelector("#magikEnforceLarge")?.checked ?? false;
    const perChar = chars.map(charData => buildCharTagBuckets(charData, modal, enforceLarge));
    const combined = {
        face:    perChar.map(b => b.face.join(", ")).join(",\n\n"),
        noface:  perChar.map(b => b.noface.join(", ")).join(",\n\n"),
        clothes: perChar.map(b => b.clothes.join(", ")).join(",\n\n"),
    };

    const targets = {
        face:    (node._magikSettings?.proxies.get(`GIRL_FACE_${index}`) || node.widgets.find(w => w.name === `GIRL_FACE_${index}`)),
        noface:  (node._magikSettings?.proxies.get(`GIRL_NOFACE_${index}`) || node.widgets.find(w => w.name === `GIRL_NOFACE_${index}`)),
        clothes: (node._magikSettings?.proxies.get(`CHARACTER_CLOTHES_${index}`) || node.widgets.find(w => w.name === `CHARACTER_CLOTHES_${index}`)),
    };
    if (!targets.face || !targets.noface || !targets.clothes) {
        showError(modal, `Could not find GIRL_FACE_${index} / GIRL_NOFACE_${index} / CHARACTER_CLOTHES_${index} on this node.`);
        return false;
    }

    const appendMode = modal.querySelector("#magikAppend")?.checked ?? false;
    for (const key of ["face", "noface", "clothes"]) {
        const text = combined[key];
        if (!text) continue;
        const w = targets[key];
        if (appendMode && w.value.trim()) {
            w.value = w.value.trimEnd() + ",\n\n" + text;
        } else {
            w.value = text;
        }
        if (w.callback) w.callback(w.value);
    }

    for (const field of ["nl_girl_description", "nl_clothing"]) {
        const w = node._magikSettings?.proxies.get(`${field}_${index}`);
        if (!w) continue;
        const value = chars.map(c => c[field] || "").filter(Boolean).join("\n\n");
        w.value = appendMode && w.value.trim() && value ? w.value.trimEnd() + "\n\n" + value : value;
        w.callback?.(w.value);
    }
    node.ui?.sync();
    node.setDirtyCanvas(true, true);
    return true;
}

const CHECKBOX_HTML = `
    <label>Export format <select id="magikExportMode"><option value="tags">Tags</option><option value="nl">Natural language</option><option value="both" selected>Both</option></select></label>
    <div class="waifudb-checkbox-container">
        <div id="includeCheckboxes" class="waifudb-checkbox-grid">
            <label><input type="checkbox" data-cols="breast_size" checked> Breast Size</label>
            <label><input type="checkbox" data-cols="eye_color" checked> Eyes</label>
            <label><input type="checkbox" data-cols="hair_color_1,hair_color_2" checked> Hair Color</label>
            <label><input type="checkbox" data-cols="hairstyle_1,hairstyle_2,hairstyle_3,hairstyle_4" checked> Hairstyle</label>
            <label><input type="checkbox" data-cols="common_outfits,clothing_pieces" checked> Outfit</label>
            <label><input type="checkbox" data-cols="clothing_accessories" checked> Accessories</label>
            <label><input type="checkbox" data-cols="others" checked> Others</label>
        </div>
        <div class="waifudb-overrides-box">
            <div class="waifudb-overrides-title">Overrides</div>
            <label title="Replaces flat_chest, small_breasts and medium_breasts with large_breasts">
                <input type="checkbox" id="magikEnforceLarge" checked> Enforce large breasts
            </label>
        </div>
    </div>`;

const SELECTION_HTML = `
    <div class="waifudb-selection-container">
        <div class="waifudb-selection-header">
            <div class="waifudb-selection-title">Selection<span id="magikSelCount" class="waifudb-selection-count"></span></div>
            <div class="waifudb-selection-actions">
                <button id="magikSelUndo" type="button" class="waifudb-selection-undo-btn" title="Undo last add" disabled>↺ Undo</button>
                <button id="magikSelClear" type="button" class="waifudb-selection-clear-btn" title="Clear all">✕ Clear all</button>
            </div>
        </div>
        <div id="magikSelectionList" class="waifudb-selection-list"></div>
        <div class="waifudb-selection-footer-text">
            Click a character above to add · ✏ to edit · ✕ to remove
        </div>
        <div class="waifudb-live-preview-box">
            <div class="waifudb-live-preview-title">Live Preview</div>
            <textarea id="magikLivePreviewText" class="waifudb-live-preview-text" rows="3" readonly></textarea>
        </div>
    </div>`;

const FOOTER_HTML = `
    <label class="waifudb-footer-append">
        <input type="checkbox" id="magikAppend"> Append to existing tags
    </label>
    <div id="magikLoadingMsg" class="waifudb-loading-msg" style="display:none;">Loading…</div>
    <div id="magikErrorMsg" class="waifudb-error-msg" style="display:none;"></div>
    <div class="waifudb-footer-actions">
        <button id="magikCopyBtn" type="button" class="waifudb-copy-btn">📋 Copy</button>
        <button id="magikSearchBtn" class="waifudb-submit-btn">Add Tags to Combo</button>
    </div>`;

// ---------------------------------------------------------------------------
// Edit character modal (unchanged)
// ---------------------------------------------------------------------------
async function openEditModal(charData, onSaved) {
    const overlay = document.createElement("div");
    overlay.classList.add("waifudb-overlay", "waifudb-edit-overlay");
    overlay.setAttribute("tabindex", "-1");

    const modal = document.createElement("div");
    modal.classList.add("waifudb-modal", "waifudb-modal-edit");

    const SCALAR_FIELDS = [
        { key: "breast_size",  label: "Breast Size" },
        { key: "eye_color",    label: "Eye Color" },
        { key: "hair_color_1", label: "Hair Color 1" },
        { key: "hair_color_2", label: "Hair Color 2" },
        { key: "hairstyle_1",  label: "Hairstyle 1" },
        { key: "hairstyle_2",  label: "Hairstyle 2" },
        { key: "hairstyle_3",  label: "Hairstyle 3" },
        { key: "hairstyle_4",  label: "Hairstyle 4" },
    ];
    const MULTI_FIELDS = [
        { key: "common_outfits",       label: "Common Outfits" },
        { key: "clothing_pieces",      label: "Clothing Pieces" },
        { key: "clothing_accessories", label: "Accessories" },
        { key: "others",               label: "Others" },
    ];

    function makeFieldGroup(labelText, value, id) {
        const group = document.createElement("div");
        group.classList.add("waifudb-field-group");
        const label = document.createElement("label");
        label.textContent = labelText;
        group.appendChild(label);
        const input = document.createElement("input");
        input.id = id;
        input.type = "text";
        input.value = value || "";
        group.appendChild(input);
        return group;
    }

    const h2 = document.createElement("h2");
    h2.textContent = "✏ Edit Character";
    modal.appendChild(h2);

    const meta = document.createElement("div");
    meta.classList.add("waifudb-modal-meta");
    const strong = document.createElement("strong");
    strong.textContent = charData.original_input || "";
    meta.appendChild(strong);
    meta.appendChild(document.createTextNode("  ·  "));
    const code = document.createElement("code");
    code.textContent = charData.danbooru_tag || "";
    meta.appendChild(code);
    modal.appendChild(meta);

    const scalarGrid = document.createElement("div");
    scalarGrid.classList.add("waifudb-fields-grid");
    SCALAR_FIELDS.forEach(f => {
        scalarGrid.appendChild(makeFieldGroup(f.label, charData[f.key], "edit_" + f.key));
    });
    modal.appendChild(scalarGrid);

    const multiGrid = document.createElement("div");
    multiGrid.classList.add("waifudb-fields-grid", "waifudb-fields-grid-secondary");
    MULTI_FIELDS.forEach(f => {
        multiGrid.appendChild(makeFieldGroup(f.label, charData[f.key], "edit_" + f.key));
    });
    modal.appendChild(multiGrid);

    const statusEl = document.createElement("div");
    statusEl.id = "editStatusMsg";
    statusEl.classList.add("waifudb-edit-status-msg");
    statusEl.style.display = "none";
    modal.appendChild(statusEl);

    function setEditStatus(msg, isError) {
        statusEl.textContent = msg;
        statusEl.style.color = isError ? "#f88" : "#8f8";
        statusEl.style.display = msg ? "block" : "none";
    }

    const actionsRow = document.createElement("div");
    actionsRow.classList.add("waifudb-modal-actions-row");

    const saveBtn = document.createElement("button");
    saveBtn.id = "editSaveBtn";
    saveBtn.classList.add("waifudb-save");
    saveBtn.textContent = "Save";

    const cancelBtn = document.createElement("button");
    cancelBtn.id = "editCancelBtn";
    cancelBtn.classList.add("waifudb-cancel");
    cancelBtn.textContent = "Cancel";

    actionsRow.appendChild(saveBtn);
    actionsRow.appendChild(cancelBtn);
    modal.appendChild(actionsRow);

    document.body.appendChild(overlay);
    overlay.appendChild(modal);
    overlay.focus();

    cancelBtn.addEventListener("click", () => {
        if (overlay.parentNode) document.body.removeChild(overlay);
    });

    saveBtn.addEventListener("click", async () => {
        const updates = {};
        [...SCALAR_FIELDS, ...MULTI_FIELDS].forEach(f => {
            const input = modal.querySelector("#edit_" + f.key);
            updates[f.key] = input ? input.value.trim() : "";
        });

        setEditStatus("Saving…", false);
        try {
            const res = await fetch("/custom_character_search/char_update", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ char_id: charData.char_id, updates }),
            });
            const result = await res.json();
            if (!res.ok || result.error) throw new Error(result.error || `Server returned ${res.status}`);

            setEditStatus("Saved!", false);
            Object.assign(charData, updates);
            if (isFavorite(charData.char_id)) {
                favorites[String(charData.char_id)] = { ...charData };
                saveFavorites(favorites);
            }
            if (isSuperFavorite(charData.char_id)) {
                superFavorites[String(charData.char_id)] = { ...charData };
                saveSuperFavorites(superFavorites);
                document.dispatchEvent(new CustomEvent("waifudb_super_favorites_changed"));
            }
            onSaved && onSaved(charData);
            setTimeout(() => {
                if (overlay.parentNode) document.body.removeChild(overlay);
            }, 800);
        } catch (err) {
            setEditStatus("Error: " + err.message, true);
        }
    });

    overlay.addEventListener("mousedown", e => {
        if (e.target === overlay && overlay.parentNode) document.body.removeChild(overlay);
    });
    overlay.addEventListener("keydown", e => {
        if (e.key === "Escape" && overlay.parentNode) document.body.removeChild(overlay);
    });
}

// ---------------------------------------------------------------------------
// Panel 1 — Character search
// ---------------------------------------------------------------------------
async function openSearchPanel(node, index, filtersData) {
    const overlay = document.createElement("div");
    overlay.classList.add("waifudb-overlay");
    overlay.setAttribute("tabindex", "-1");

    const modal = document.createElement("div");
    modal.classList.add("waifudb-modal");

    modal.innerHTML = `
        <h2>🪄 Character Search — Combo ${index}
            <button id="magikGoTrait" type="button" class="waifudb-selection-btn-action" style="float:right;font-size:11px;" title="Switch to Trait Filter">🎨 Trait Filter</button>
        </h2>
        <div class="waifudb-columns-container">
            <div class="waifudb-main-column">
                <div id="magikSeriesSlot"></div>
                <div id="magikCharSlot"></div>
                <div id="magikMyWaifusSlot" class="waifudb-my-waifus-container"></div>
            </div>
            <div id="magikRecentSeries" class="waifudb-recent-sidebar"></div>
        </div>
        ${SELECTION_HTML}
        ${CHECKBOX_HTML}
        ${FOOTER_HTML}`;

    document.body.appendChild(overlay);
    overlay.appendChild(modal);
    addUIScaleSlider(modal);
    addExportModeToggle(modal);
    modal.querySelector("#magikExportMode")?.addEventListener("change", () => updateLivePreview(modal, selectionData));
    overlay.focus();

    const recentBox = modal.querySelector("#magikRecentSeries");

    function renderRecentSeries(onClickSeries) {
        recentBox.innerHTML = "";
        if (recentSeries.length === 0) return;
        const label = document.createElement("div");
        label.textContent = "Recent";
        label.classList.add("waifudb-recent-title");
        recentBox.appendChild(label);
        recentSeries.forEach(name => {
            const pill = document.createElement("button");
            pill.type = "button";
            pill.textContent = name;
            pill.title = name;
            pill.classList.add("waifudb-recent-pill");
            pill.addEventListener("click", () => onClickSeries(name));
            recentBox.appendChild(pill);
        });
    }

    const selectionData = [];
    const selListEl = modal.querySelector("#magikSelectionList");

    function renderSelectionRow(charData) {
        const row = document.createElement("div");
        row.dataset.charId = charData.char_id;
        row.classList.add("waifudb-selection-row");

        const name = document.createElement("span");
        name.textContent = charData.original_input;
        name.classList.add("waifudb-selection-row-name");
        row.appendChild(name);

        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.textContent = "✏";
        editBtn.title = "Edit " + charData.original_input;
        editBtn.classList.add("waifudb-selection-btn-action");
        editBtn.addEventListener("click", () => {
            const i = selectionData.findIndex(c => c.char_id === charData.char_id);
            if (i === -1) return;
            openEditModal(selectionData[i], updatedChar => {
                selectionData[i] = updatedChar;
                name.textContent = updatedChar.original_input;
                editBtn.title = "Edit " + updatedChar.original_input;
                row.dataset.charId = updatedChar.char_id;
                updateLivePreview(modal, selectionData);
            });
        });
        row.appendChild(editBtn);

        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.textContent = "✕";
        removeBtn.title = "Remove from selection";
        removeBtn.classList.add("waifudb-selection-btn-action", "waifudb-selection-btn-remove");
        removeBtn.addEventListener("click", () => {
            const i = selectionData.findIndex(c => c.char_id === charData.char_id);
            if (i !== -1) selectionData.splice(i, 1);
            row.remove();
            updateLivePreview(modal, selectionData);
            updateSelectionCount(modal, selectionData.length);
        });
        row.appendChild(removeBtn);

        return row;
    }

    modal.querySelector("#magikSelClear").addEventListener("click", () => {
        selectionData.length = 0;
        selListEl.innerHTML = "";
        lastAdded = null;
        if (undoBtn) undoBtn.disabled = true;
        updateLivePreview(modal, selectionData);
        updateSelectionCount(modal, selectionData.length);
    });

    function addToSelection(charData) {
        if (!charData) return;
        if (selectionData.some(c => c.char_id === charData.char_id)) return;
        selectionData.push(charData);
        selListEl.appendChild(renderSelectionRow(charData));
    }

    function renderMyWaifus() {
        const slot = modal.querySelector("#magikMyWaifusSlot");
        if (!slot) return;
        slot.innerHTML = "";
        const list = getSuperFavoritesList();
        if (list.length === 0) return;

        const title = document.createElement("div");
        title.textContent = "My Waifus";
        title.classList.add("waifudb-recent-title");
        slot.appendChild(title);

        const grid = document.createElement("div");
        grid.classList.add("waifudb-my-waifus-grid");
        slot.appendChild(grid);

        list.forEach(charData => {
            const tile = document.createElement("div");
            tile.classList.add("waifudb-waifu-tile");
            tile.title = "Add " + charData.original_input;
            tile.addEventListener("click", () => addToSelection(charData));

            const removeBtn = document.createElement("span");
            removeBtn.textContent = "✕";
            removeBtn.title = "Remove from My Waifus";
            removeBtn.classList.add("waifudb-waifu-tile-remove");
            removeBtn.addEventListener("click", e => {
                e.stopPropagation();
                toggleSuperFavorite(charData.char_id, charData);
            });

            const thumbUrl = `/custom_character_search/thumbnail/${charData.char_id}`;
            const img = document.createElement("img");
            img.classList.add("waifudb-waifu-tile-img");
            img.src = thumbUrl;
            img.onerror = () => { img.style.display = "none"; };

            const name = document.createElement("span");
            name.classList.add("waifudb-waifu-tile-name");
            name.textContent = charData.original_input;

            tile.appendChild(removeBtn);
            tile.appendChild(img);
            tile.appendChild(name);
            grid.appendChild(tile);
        });
    }

    renderMyWaifus();
    const updateMyWaifusListener = () => renderMyWaifus();
    document.addEventListener("waifudb_super_favorites_changed", updateMyWaifusListener);

    function closePanel() {
        document.removeEventListener("waifudb_super_favorites_changed", updateMyWaifusListener);
        document.body.removeChild(overlay);
    }

    const charDropdown = createCharSelect({
        onSelect: (_v, _l, data) => { if (data) addToSelection(data); },
    });
    charDropdown.setSearchMode();
    modal.querySelector("#magikCharSlot").appendChild(charDropdown);

    async function loadSeries(seriesName) {
        showError(modal, "");
        if (!seriesName) { charDropdown.setSearchMode(); return; }
        setLoading(modal, true, "Loading characters…");
        try {
            const res = await fetch(`/custom_character_search/series_chars?series=${encodeURIComponent(seriesName)}`);
            if (!res.ok) throw new Error(`Server returned ${res.status}`);
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            charDropdown.setSeriesItems(Array.isArray(data) ? data : []);
            setLoading(modal, false);
            pushRecentSeries(seriesName);
            renderRecentSeries(recentPillClick);
        } catch (err) {
            setLoading(modal, false);
            showError(modal, "Could not load characters: " + err.message);
            charDropdown.setSearchMode();
        }
    }

    const seriesDropdown = createSearchableSelect({
        placeholder: "Select Series… (or skip to search all)",
        onSelect: loadSeries,
    });
    modal.querySelector("#magikSeriesSlot").appendChild(seriesDropdown);
    seriesDropdown.setItems(
        (filtersData.series || []).map(s => ({ value: s.name, label: s.name, count: s.count }))
    );

    function recentPillClick(name) {
        seriesDropdown.selectByValue(name);
        loadSeries(name);
    }

    renderRecentSeries(recentPillClick);

    modal.querySelector("#magikSearchBtn").addEventListener("click", () => {
        if (writeCharsToCombo(node, index, modal, selectionData)) {
            closePanel();
        }
    });

    modal.querySelector("#magikCopyBtn")?.addEventListener("click", () => {
        const text = buildPreviewText(selectionData, modal);
        if (!text) return;
        navigator.clipboard.writeText(text).then(() => {
            const btn = modal.querySelector("#magikCopyBtn");
            btn.classList.add("waifudb-copied");
            btn.textContent = "✓ Copied!";
            setTimeout(() => {
                btn.classList.remove("waifudb-copied");
                btn.textContent = "📋 Copy";
            }, 1500);
        }).catch(() => {
            showError(modal, "Could not copy to clipboard.");
        });
    });

    modal.querySelector("#magikGoTrait")?.addEventListener("click", () => {
        closePanel();
        openTraitPanel(node, index, filtersData);
    });

    // Undo last add
    let lastAdded = null;
    const undoBtn = modal.querySelector("#magikSelUndo");
    const origAddToSelection = addToSelection;
    addToSelection = function(charData) {
        if (!charData) return;
        if (selectionData.some(c => c.char_id === charData.char_id)) return;
        origAddToSelection(charData);
        lastAdded = charData;
        updateLivePreview(modal, selectionData);
        updateSelectionCount(modal, selectionData.length);
        if (undoBtn) undoBtn.disabled = false;
    };
    undoBtn?.addEventListener("click", () => {
        if (!lastAdded) return;
        const i = selectionData.findIndex(c => c.char_id === lastAdded.char_id);
        if (i !== -1) {
            selectionData.splice(i, 1);
            const row = selListEl.querySelector(`[data-char-id="${lastAdded.char_id}"]`);
            if (row) row.remove();
        }
        lastAdded = null;
        undoBtn.disabled = true;
        updateLivePreview(modal, selectionData);
        updateSelectionCount(modal, selectionData.length);
    });

    function trapFocus(e) {
        if (e.key !== "Tab") return;
        const focusables = modal.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    }
    modal.addEventListener("keydown", trapFocus);

    overlay.addEventListener("mousedown", e => {
        if (e.target !== overlay) return;
        if (seriesDropdown.isOpen || charDropdown.isOpen) return;
        closePanel();
    });

    overlay.addEventListener("keydown", e => {
        if (e.key === "Escape") closePanel();
    });
}

// ---------------------------------------------------------------------------
// Panel 2 — Trait filter
// ---------------------------------------------------------------------------
async function openTraitPanel(node, index, filtersData) {
    const overlay = document.createElement("div");
    overlay.classList.add("waifudb-overlay");
    overlay.setAttribute("tabindex", "-1");

    const modal = document.createElement("div");
    modal.classList.add("waifudb-modal", "waifudb-modal-trait");

    modal.innerHTML = `
        <h2>🎨 Trait Filter — Combo ${index}
            <button id="magikGoSearch" type="button" class="waifudb-selection-btn-action" style="float:right;font-size:11px;" title="Switch to Character Search">🪄 Search</button>
        </h2>
        <div class="waifudb-trait-grid">
            <div>
                <div class="waifudb-trait-grid-label">Series</div>
                <div id="tfSeriesSlot"></div>
            </div>
            <div>
                <div class="waifudb-trait-grid-label">Breast Size</div>
                <div id="tfBreastSlot"></div>
            </div>
            <div>
                <div class="waifudb-trait-grid-label">Eye Color</div>
                <div id="tfEyeSlot"></div>
            </div>
            <div>
                <div class="waifudb-trait-grid-label">Hair Color</div>
                <div id="tfHairSlot"></div>
            </div>
            <div>
                <div class="waifudb-trait-grid-label">Hairstyle</div>
                <div id="tfHairstyleSlot"></div>
            </div>
            <div class="waifudb-trait-search-btn-wrapper">
            <button id="tfSearchBtn" class="waifudb-trait-search-btn">Search</button>
            </div>
            </div>
            <div style="margin-top:8px;">
            <button id="tfClearBtn" type="button" class="waifudb-clear-filters-btn">✕ Clear all filters</button>
            </div>

        <div id="tfResultCount" class="waifudb-trait-results-counter" style="display:none;"></div>
        <div id="tfResultsSlot"></div>

        ${SELECTION_HTML}
        ${CHECKBOX_HTML}
        ${FOOTER_HTML}`;

    document.body.appendChild(overlay);
    overlay.appendChild(modal);
    addUIScaleSlider(modal);
    addExportModeToggle(modal);
    modal.querySelector("#magikExportMode")?.addEventListener("change", () => updateLivePreview(modal, selectionData));
    overlay.focus();

    function makeFilterDrop(slotId, items, placeholder) {
        const drop = createSearchableSelect({ placeholder });
        drop.setItems(items);
        modal.querySelector(slotId).appendChild(drop);
        return drop;
    }

    const seriesDrop   = makeFilterDrop("#tfSeriesSlot",    filtersData.series      || [], "Any");
    const breastDrop   = makeFilterDrop("#tfBreastSlot",    (filtersData.breast_size || []).map(v => ({ value: v, label: v.replace(/_/g, " ") })), "Any");
    const eyeDrop      = makeFilterDrop("#tfEyeSlot",       (filtersData.eye_color   || []).map(v => ({ value: v, label: v.replace(/_/g, " ") })), "Any");
    const hairDrop     = makeFilterDrop("#tfHairSlot",      (filtersData.hair_color  || []).map(v => ({ value: v, label: v.replace(/_/g, " ") })), "Any");
    const hairstyleDrop= makeFilterDrop("#tfHairstyleSlot", (filtersData.hairstyle   || []).map(v => ({ value: v, label: v.replace(/_/g, " ") })), "Any");

    const selectionData = [];
    const selListEl = modal.querySelector("#magikSelectionList");

    function renderSelectionRow(charData) {
        const row = document.createElement("div");
        row.dataset.charId = charData.char_id;
        row.classList.add("waifudb-selection-row");

        const name = document.createElement("span");
        name.textContent = charData.original_input;
        name.classList.add("waifudb-selection-row-name");
        row.appendChild(name);

        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.textContent = "✏";
        editBtn.title = "Edit " + charData.original_input;
        editBtn.classList.add("waifudb-selection-btn-action");
        editBtn.addEventListener("click", () => {
            const i = selectionData.findIndex(c => c.char_id === charData.char_id);
            if (i === -1) return;
            openEditModal(selectionData[i], updatedChar => {
                selectionData[i] = updatedChar;
                name.textContent = updatedChar.original_input;
                editBtn.title = "Edit " + updatedChar.original_input;
                row.dataset.charId = updatedChar.char_id;
                updateLivePreview(modal, selectionData);
            });
        });
        row.appendChild(editBtn);

        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.textContent = "✕";
        removeBtn.title = "Remove from selection";
        removeBtn.classList.add("waifudb-selection-btn-action", "waifudb-selection-btn-remove");
        removeBtn.addEventListener("click", () => {
            const i = selectionData.findIndex(c => c.char_id === charData.char_id);
            if (i !== -1) selectionData.splice(i, 1);
            row.remove();
            updateLivePreview(modal, selectionData);
            updateSelectionCount(modal, selectionData.length);
        });
        row.appendChild(removeBtn);

        return row;
    }

    modal.querySelector("#magikSelClear").addEventListener("click", () => {
        selectionData.length = 0;
        selListEl.innerHTML = "";
        updateLivePreview(modal, selectionData);
        updateSelectionCount(modal, selectionData.length);
    });

    modal.querySelector("#tfClearBtn")?.addEventListener("click", () => {
        seriesDrop.reset();
        breastDrop.reset();
        eyeDrop.reset();
        hairDrop.reset();
        hairstyleDrop.reset();
        resultDrop.setItems([]);
        currentResults = [];
        modal.querySelector("#tfResultCount").style.display = "none";
    });

    function addToSelection(charData) {
        if (!charData) return;
        if (selectionData.some(c => c.char_id === charData.char_id)) return;
        selectionData.push(charData);
        selListEl.appendChild(renderSelectionRow(charData));
        updateLivePreview(modal, selectionData);
        updateSelectionCount(modal, selectionData.length);
    }

    const resultDrop = createSearchableSelect({
        placeholder: "Select from results…",
        onSelect: (_v, _l, data) => {
            const idx = parseInt(_v, 10);
            const charData = isNaN(idx) ? null : currentResults[idx] || null;
            if (charData) addToSelection(charData);
        },
    });
    modal.querySelector("#tfResultsSlot").appendChild(resultDrop);

    let currentResults = [];
    const resultCountEl = modal.querySelector("#tfResultCount");

    modal.querySelector("#tfSearchBtn").addEventListener("click", async () => {
        showError(modal, "");
        resultDrop.setItems([]);
        resultCountEl.style.display = "none";

        const params = new URLSearchParams();
        if (seriesDrop.getValue())    params.set("series",      seriesDrop.getValue());
        if (breastDrop.getValue())    params.set("breast_size", breastDrop.getValue());
        if (eyeDrop.getValue())       params.set("eye_color",   eyeDrop.getValue());
        if (hairDrop.getValue())      params.set("hair_color",  hairDrop.getValue());
        if (hairstyleDrop.getValue()) params.set("hairstyle",   hairstyleDrop.getValue());

        if (!params.toString()) {
            showError(modal, "Please select at least one filter.");
            return;
        }

        setLoading(modal, true, "Searching…");
        try {
            const res = await fetch(`/custom_character_search/trait_filter?${params}`);
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error || `Server returned ${res.status}`);
            }
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            currentResults = Array.isArray(data) ? data : [];

            const cap = 200;
            resultCountEl.textContent = currentResults.length === cap
                ? `Showing top ${cap} results — add more filters to narrow down`
                : `${currentResults.length} character${currentResults.length !== 1 ? "s" : ""} found`;
            resultCountEl.style.display = "block";

            resultDrop.setItems(currentResults.map((c, i) => ({
                value: String(i),
                label: c.original_input,
                thumbnail: `/custom_character_search/thumbnail/${c.char_id}`,
            })));
            setLoading(modal, false);
        } catch (err) {
            setLoading(modal, false);
            showError(modal, "Search failed: " + err.message);
        }
    });

    modal.querySelector("#magikSearchBtn").addEventListener("click", () => {
        if (writeCharsToCombo(node, index, modal, selectionData))
            document.body.removeChild(overlay);
    });

    modal.querySelector("#magikCopyBtn")?.addEventListener("click", () => {
        const text = buildPreviewText(selectionData, modal);
        if (!text) return;
        navigator.clipboard.writeText(text).then(() => {
            const btn = modal.querySelector("#magikCopyBtn");
            btn.classList.add("waifudb-copied");
            btn.textContent = "✓ Copied!";
            setTimeout(() => {
                btn.classList.remove("waifudb-copied");
                btn.textContent = "📋 Copy";
            }, 1500);
        }).catch(() => {
            showError(modal, "Could not copy to clipboard.");
        });
    });

    modal.querySelector("#magikGoSearch")?.addEventListener("click", async () => {
        document.body.removeChild(overlay);
        openSearchPanel(node, index, filtersData);
    });

    overlay.addEventListener("click", e => { if (e.target === overlay) document.body.removeChild(overlay); });
    overlay.addEventListener("keydown", e => {
        if (e.key === "Escape") document.body.removeChild(overlay);
    });
}

// ---------------------------------------------------------------------------
// Modal launcher
// ---------------------------------------------------------------------------
let cachedFiltersData = null;
let cachedFiltersTime = 0;
const FILTERS_CACHE_TTL = 5 * 60 * 1000;

async function fetchFilters() {
    if (cachedFiltersData && (Date.now() - cachedFiltersTime) < FILTERS_CACHE_TTL) {
        return cachedFiltersData;
    }
    const res = await fetch("/custom_character_search/filters");
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    cachedFiltersData = data;
    cachedFiltersTime = Date.now();
    return data;
}

let filtersRequest = null;
export function loadRandomCharacterFilterOptions() {
    if (cachedFiltersData && Date.now() - cachedFiltersTime < FILTERS_CACHE_TTL) {
        return Promise.resolve(cachedFiltersData);
    }
    if (!filtersRequest) {
        filtersRequest = fetchFilters().finally(() => { filtersRequest = null; });
    }
    return filtersRequest;
}
function loadFilters() { return loadRandomCharacterFilterOptions(); }

function showUnavailableNotice(detail) {
    const overlay = document.createElement("div");
    overlay.classList.add("waifudb-overlay");
    overlay.setAttribute("tabindex", "-1");

    const modal = document.createElement("div");
    modal.classList.add("waifudb-modal");
    modal.style.width = "420px";

    modal.innerHTML = `
        <h2>🔌 Character database unavailable</h2>
        <div style="font-size:13px;color:#ccc;line-height:1.5;">
            Couldn't reach the WaifuDB character database. This feature needs the
            <strong>Magik WaifuDB</strong> custom node installed and enabled
            alongside Magik NL Meta Prompter in this ComfyUI instance.
        </div>
        <div class="waifudb-modal-meta" style="word-break:break-all;"></div>
        <button id="magikUnavailDismiss" class="waifudb-cancel" style="align-self:flex-end;">Dismiss</button>`;
    modal.querySelector(".waifudb-modal-meta").textContent = detail || "";

    document.body.appendChild(overlay);
    overlay.appendChild(modal);
    overlay.focus();

    function close() { if (overlay.parentNode) document.body.removeChild(overlay); }
    modal.querySelector("#magikUnavailDismiss").addEventListener("click", close);
    overlay.addEventListener("mousedown", e => { if (e.target === overlay) close(); });
    overlay.addEventListener("keydown", e => { if (e.key === "Escape") close(); });
}

async function openMagikModal(node, index, panelType = "search") {
    let filtersData;
    try {
        filtersData = await loadFilters();
    } catch (err) {
        showUnavailableNotice(err.message);
        return;
    }
    if (panelType === "trait") {
        openTraitPanel(node, index, filtersData);
    } else {
        openSearchPanel(node, index, filtersData);
    }
}

export function openCharSearchForCombo(node, index, panelType = "search") {
    openMagikModal(node, index, panelType);
}
