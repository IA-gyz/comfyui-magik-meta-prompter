import { api } from "../../scripts/api.js";
import { loadRandomCharacterFilterOptions } from "./magik_nl_search_panel.js";

// Favorites live in the browser; save an explicit ID snapshot in the workflow
// so the Python execution path and API queues use the same eligible pool.
export function createRandomFilterSection(controller, index, prefix) {
    const panel = document.createElement("details");
    panel.className = `${prefix}-random-filters`;
    const summary = document.createElement("summary");
    summary.textContent = "Random selection filters";
    const body = document.createElement("div");
    body.className = `${prefix}-filter-grid`;
    const note = document.createElement("div");
    note.className = `${prefix}-filter-note`;
    const status = document.createElement("div");
    status.className = `${prefix}-filter-note`;
    const matchCount = document.createElement("div");
    matchCount.className = `${prefix}-filter-note`;
    matchCount.setAttribute("aria-live", "polite");
    matchCount.textContent = "Enable Randomize to check matching characters";
    const countRetry = document.createElement("button");
    countRetry.type = "button"; countRetry.textContent = "Refresh match count";
    body.appendChild(countRetry);
    panel.append(summary, matchCount, body, note, status);
    let countKey = null;
    let countTimer = null;
    let countSequence = 0;
    function scheduleCount(force = false) {
        const enabled = !!controller.w(`randomize_character_${index}`)?.value;
        countRetry.disabled = !enabled;
        const key = enabled ? JSON.stringify(read()) : null;
        if (!force && key === countKey) return;
        countKey = key;
        const sequence = ++countSequence;
        clearTimeout(countTimer);
        if (!enabled) { matchCount.textContent = "Enable Randomize to check matching characters"; return; }
        matchCount.textContent = "Counting matching characters…";
        countTimer = setTimeout(async () => {
            try {
                const response = await api.fetchApi("/custom_character_search/random_count", {
                    method: "POST", headers: { "Content-Type": "application/json" }, body: key,
                });
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
                if (!Number.isInteger(data.count) || data.count < 0) throw new Error("Invalid count response");
                if (sequence !== countSequence) return;
                matchCount.textContent = data.count === 0 ? "0 matching characters — adjust filters before running" : `${data.count.toLocaleString()} matching character${data.count === 1 ? "" : "s"}`;
                matchCount.style.color = data.count === 0 ? "#ff9999" : "#9ee1ba";
            } catch (error) {
                if (sequence === countSequence) { matchCount.textContent = `Match count unavailable: ${error.message}`; matchCount.style.color = "#ffbb88"; }
            }
        }, 250);
    }
    countRetry.onclick = () => scheduleCount(true);
    let options = null;
    let loading = false;
    const controls = {};
    const read = () => {
        try {
            const value = JSON.parse(controller.w(`random_character_filters_${index}`)?.value || "{}");
            return value && typeof value === "object" && !Array.isArray(value) ? value : {};
        } catch { return {}; }
    };
    const write = (value) => {
        const widget = controller.w(`random_character_filters_${index}`);
        if (widget) {
            widget.value = JSON.stringify(value);
            widget.callback?.(widget.value);
        }
    };
    const favoriteIds = (pool) => {
        const key = pool === "my_waifus" ? "waifudb_super_favorites" : "waifudb_favorites";
        try {
            const favorites = JSON.parse(localStorage.getItem(key) || "{}");
            return [...new Set(Object.values(favorites).map(c => String(c.char_id || "")).filter(Boolean))];
        } catch { return []; }
    };
    function fill(select, items, current, emptyLabel = "Any") {
        select.replaceChildren();
        const append = (value, label) => {
            const option = document.createElement("option");
            option.value = value; option.textContent = label;
            select.appendChild(option);
        };
        append("", emptyLabel);
        for (const item of items || []) {
            const value = typeof item === "string" ? item : item.name;
            if (value) append(value, value.replace(/_/g, " "));
        }
        // Keep saved filters visible even when a database value was removed.
        if (current && !Array.from(select.options).some(o => o.value === current)) append(current, current);
        select.value = current || "";
    }
    for (const [key, label] of [
        ["pool", "Character pool"], ["series", "Series"],
        ["breast_size", "Body trait"], ["eye_color", "Eye color"],
        ["hair_color", "Hair color"], ["hairstyle", "Hairstyle"],
    ]) {
        const wrapper = document.createElement("label");
        wrapper.textContent = label;
        const select = document.createElement("select");
        controls[key] = select;
        if (key === "pool") {
            for (const [value, text] of [["all", "All characters"], ["favorites", "Favorites"], ["my_waifus", "My Waifus"]]) {
                const option = document.createElement("option");
                option.value = value; option.textContent = text; select.appendChild(option);
            }
        } else fill(select, [], read()[key]);
        select.onchange = () => {
            const filters = { ...read(), [key]: select.value };
            if (key === "pool") {
                if (select.value === "all") delete filters.ids;
                else filters.ids = favoriteIds(select.value);
            }
            write(filters); refresh();
        };
        wrapper.appendChild(select); body.appendChild(wrapper);
    }
    const refreshFavorites = document.createElement("button");
    refreshFavorites.type = "button";
    refreshFavorites.textContent = "Refresh favorites";
    refreshFavorites.title = "Save the current browser favorites as this workflow's eligible character IDs.";
    refreshFavorites.onclick = () => {
        const filters = read();
        if (filters.pool && filters.pool !== "all") {
            write({ ...filters, ids: favoriteIds(filters.pool) }); refresh();
        }
    };
    const reset = document.createElement("button");
    reset.type = "button"; reset.textContent = "Clear filters";
    reset.onclick = () => { write({}); refresh(); };
    const retry = document.createElement("button");
    retry.type = "button"; retry.textContent = "Load filter options";
    retry.onclick = () => load();
    body.append(refreshFavorites, reset, retry);
    async function load() {
        if (loading) return;
        loading = true; status.textContent = "Loading database filter options…";
        try {
            options = await loadRandomCharacterFilterOptions();
            const filters = read();
            for (const key of ["series", "breast_size", "eye_color", "hair_color", "hairstyle"]) {
                fill(controls[key], options[key], filters[key]);
            }
            status.textContent = "All selected filters are combined. No matching character stops the run.";
        } catch (error) { status.textContent = `Could not load filter options: ${error.message}`; }
        finally { loading = false; refresh(); }
    }
    function refresh() {
        scheduleCount();
        const filters = read();
        const enabled = !!controller.w(`randomize_character_${index}`)?.value;
        const locked = !!controller.w(`random_character_locked_${index}`)?.value;
        for (const [key, select] of Object.entries(controls)) {
            const value = key === "pool" ? filters.pool || "all" : filters[key] || "";
            if (key !== "pool" && !Array.from(select.options).some(o => o.value === value)) fill(select, options?.[key], value);
            select.value = value; select.disabled = !enabled;
        }
        refreshFavorites.disabled = !enabled || !filters.pool || filters.pool === "all";
        reset.disabled = !enabled; retry.disabled = !enabled || loading;
        const count = ["series", "breast_size", "eye_color", "hair_color", "hairstyle"].filter(k => filters[k]).length;
        summary.textContent = `Random selection filters${count ? ` · ${count} active` : ""}${filters.pool && filters.pool !== "all" ? ` · ${filters.pool === "my_waifus" ? "My Waifus" : "Favorites"}` : ""}`;
        note.textContent = locked ? "Character locked — changed filters apply after Unlock."
            : filters.pool && filters.pool !== "all" ? `${filters.ids?.length || 0} saved favorite IDs. Refresh favorites to update the pool.`
            : "Draw from the entire database, restricted by any selected series or traits.";
    }
    panel.addEventListener("toggle", () => { if (panel.open && !options) load(); });
    panel.magikRefresh = refresh;
    controller.syncCallbacks.push(refresh);
    refresh();
    return panel;
}
