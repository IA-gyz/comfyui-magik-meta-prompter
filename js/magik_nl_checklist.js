// Shared checklist, rendered with textContent so paths and metadata remain text.
export function createChecklist(ui, panel) {
    const heading = document.createElement("h3"); heading.textContent = "Parameter checklist";
    const note = document.createElement("p"); note.textContent = "Current settings · Run to resolve connected inputs and inspect sources";
    const rows = document.createElement("div"); rows.className = "parameter-checklist";
    panel.replaceChildren(heading, note, rows);
    const draw = (items) => {
        rows.replaceChildren();
        for (const item of items) {
            const row = document.createElement("div"); row.className = `checklist-row checklist-${item.status}`;
            const label = document.createElement("strong"); label.textContent = `${({ready:"✓",warning:"!",error:"✕",disabled:"–"})[item.status] || "–"} ${item.label}`;
            const detail = document.createElement("span"); detail.textContent = item.detail;
            row.append(label, detail); rows.appendChild(row);
        }
    };
    let last = null;
    function current() {
        const test = Boolean(ui.w("is_test")?.value);
        const path = String(ui.w("test_path")?.value || "").trim();
        draw([
            {label:"Mode & output path",status:test && !path ? "error":"ready",detail:test ? (path || "Required in Test mode") : "Gen · Output path resolved on execution"},
            ...["Character source","Outfit","Scene & background","Connected inputs","LoRAs","Prompt sources"].map(label=>({label,status:"disabled",detail:last ? "Settings changed · Run again to resolve effective parameters" : "Awaiting execution · Effective combo and connected values not yet resolved"}))
        ]);
    }
    current();
    // Delegate to the existing master DOM; no observers, polling, or server requests.
    queueMicrotask(() => {
        const master = panel.parentElement?.parentElement;
        const changed = () => { note.textContent = "Current settings · Run again to refresh effective parameters"; current(); };
        master?.addEventListener("change", changed);
        master?.addEventListener("input", changed);
        master?.addEventListener("click", changed);
    });
    return {update(data) { if (!Array.isArray(data.checklist)) return; last = data; note.textContent = `Last execution · Combo ${data.slot} · Phase ${data.phase}`; draw(data.checklist); }};
}
