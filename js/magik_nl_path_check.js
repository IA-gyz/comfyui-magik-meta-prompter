// Debounced, stale-response-safe server filesystem checks.
export function checkDisplayedPath(element, path) {
    if (element.dataset.checkedPath === path) return;
    element.dataset.checkedPath = path;
    clearTimeout(element._pathTimer);
    element.style.color = "";
    if (!path) return;
    element._pathTimer = setTimeout(async () => {
        try {
            const response = await fetch("/magik_nl_meta_prompter/path_exists", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({path})});
            if (!response.ok) return;
            const data = await response.json();
            if (element.dataset.checkedPath !== path) return;
            element.style.color = data.exists ? "#ef4444" : "";
            element.textContent = path + (data.exists ? " · Path exists" : "");
        } catch { /* A failed check must not prevent prompt editing. */ }
    }, 300);
}
