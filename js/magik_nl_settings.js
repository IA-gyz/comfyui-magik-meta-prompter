import { api } from "../../scripts/api.js";
import { SETTINGS_MANIFEST } from "./magik_nl_settings_manifest.js";

let loraRequest;
export function createSettingsStore(node, variant) {
    const widget = node.widgets.find(w => w.name === "settings");
    if (!widget) throw new Error("Compact settings input is missing; recreate this node with the updated Python backend.");
    const definitions = SETTINGS_MANIFEST[variant];
    const values = {};
    const proxies = new Map();
    let pending = false;
    let disposed = false;
    const serialize = () => JSON.stringify(values);
    const flush = () => { if (!disposed) widget.value = serialize(); };
    const changed = () => {
        if (pending || disposed) return;
        pending = true;
        queueMicrotask(() => { pending = false; flush(); });
    };
    for (const [name, definition] of Object.entries(definitions)) {
        const proxy = { name, options: {values: definition.options || []}, callback: changed };
        Object.defineProperty(proxy, "value", {
            get: () => values[name],
            set: value => { values[name] = value; changed(); },
        });
        proxies.set(name, proxy);
    }
    let loadWarning = "";
    const load = (raw = widget.value) => {
        let saved;
        loadWarning = "";
        try { saved = JSON.parse(raw || "{}"); }
        catch { saved = null; }
        if (!saved || typeof saved !== "object" || Array.isArray(saved)) {
            saved = {};
            loadWarning = "Unsupported or invalid saved settings: this node was reset to defaults. Reconfigure it before running.";
            console.warn("Magik settings:", loadWarning);
        }
        for (const [name, definition] of Object.entries(definitions)) {
            values[name] = Object.hasOwn(saved, name) ? saved[name] : definition.default ?? "";
        }
        flush();
        return loadWarning;
    };
    load();
    // ComfyUI invokes serializeValue for API queues as well as saved workflows.
    widget.serializeValue = () => serialize();
    if (!loraRequest) {
        loraRequest = api.fetchApi("/magik_nl_meta_prompter/lora_options")
            .then(async response => { if (!response.ok) throw new Error("Could not load LoRA options"); return response.json(); })
            .catch(error => { loraRequest = null; throw error; });
    }
    loraRequest.then(options => {
        if (disposed) return;
        for (const [name, proxy] of proxies) {
            if (/^lora_\d_\d$/.test(name)) proxy.options.values = options;
        }
    }).catch(error => console.warn("Magik settings:", error.message));
    return { proxies, load, flush, get warning() { return loadWarning; }, dispose: () => { disposed = true; } };
}
