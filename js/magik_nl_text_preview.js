// Full-screen text editor/preview shared by both Meta Prompter variants.
export function installTextPreview(node, master) {
    let closeActive = null;
    const open = event => {
        const source = event.target.closest?.("textarea");
        if (!source || !master.contains(source)) return;
        event.preventDefault(); event.stopPropagation();
        closeActive?.();
        const previousFocus = document.activeElement;
        const overlay = document.createElement("div");
        overlay.style.cssText = "position:fixed;inset:0;z-index:100100;background:rgba(0,0,0,.88);display:flex;align-items:center;justify-content:center;";
        const panel = document.createElement("section");
        panel.setAttribute("role", "dialog"); panel.setAttribute("aria-modal", "true"); panel.setAttribute("aria-label", "Expanded text preview");
        panel.style.cssText = "width:94vw;height:92vh;box-sizing:border-box;background:#161b24;color:#edf2f7;border:1px solid #526079;border-radius:18px;padding:24px;display:flex;flex-direction:column;gap:18px;";
        const toolbar = document.createElement("div"); toolbar.style.cssText = "display:flex;align-items:center;gap:16px;flex:none;flex-wrap:wrap;";
        const title = document.createElement("strong"); const label = source.getAttribute("aria-label") || source.parentElement?.querySelector("label")?.textContent?.trim() || source.dataset.widgetName || "Text preview";
        const combo = source.closest(".magik-nl-cell, .magik-nl-json-cell")?.querySelector(".magik-nl-title, .magik-nl-json-title")?.textContent?.trim();
        title.textContent = combo ? `${combo} · ${label}` : label; title.style.flex = "1";
        const copy = document.createElement("button"); copy.type = "button"; copy.textContent = "Copy";
        const editable = !source.disabled && !source.readOnly;
        const close = document.createElement("button"); close.type = "button"; close.textContent = editable ? "Cancel" : "Close";
        const apply = document.createElement("button"); apply.type = "button"; apply.textContent = "Apply"; apply.hidden = !editable;
        const autoFit = document.createElement("button"); autoFit.type = "button"; autoFit.textContent = "Auto-fit";
        for (const button of [copy, close, apply, autoFit]) button.style.cssText = "font:inherit;font-size:18px;padding:10px 22px;border:1px solid #66758a;border-radius:9px;background:#29364b;color:white;cursor:pointer;";
        const text = document.createElement("textarea"); text.readOnly = !editable;
        text.setAttribute("aria-label", editable ? "Expanded text editor" : "Expanded text preview");
        text.style.cssText = "flex:1;min-height:0;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.2;user-select:text;resize:none;box-sizing:border-box;width:100%;background:#111722;color:#edf2f7;border:1px solid #526079;border-radius:10px;padding:12px;";
        text.style.fontFamily = getComputedStyle(source).fontFamily;
        text.value = String(source.value || "");
        const fontLabel = document.createElement("label"); fontLabel.textContent = "Font size ";
        const fontSize = document.createElement("input"); fontSize.type = "range"; fontSize.min = "1"; fontSize.max = "128"; fontSize.step = "1";
        fontSize.setAttribute("aria-label", "Editor font size"); fontSize.style.width = "140px";
        const fontValue = document.createElement("output");
        fontLabel.append(fontSize, fontValue);
        const info = document.createElement("span"); info.style.cssText = "font-size:16px;color:#b8c7db;";
        const original = text.value;
        const refreshInfo = () => {
            const words = text.value.trim() ? text.value.trim().split(/\s+/u).length : 0;
            info.textContent = `${editable && text.value !== original ? "Modified · " : ""}${words} words · ${Array.from(text.value).length} characters`;
        };
        const setFont = size => { text.style.fontSize = `${size}px`; fontSize.value = String(size); fontValue.textContent = ` ${size} px`; };
        fontSize.addEventListener("input", () => { cancelAnimationFrame(frame); setFont(Number(fontSize.value)); });
        refreshInfo();
        toolbar.append(title, fontLabel, autoFit, copy, apply, close, info); panel.append(toolbar, text); overlay.appendChild(panel); document.body.appendChild(overlay);
        const searchbar = document.createElement("div"); searchbar.style.cssText = "display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:16px;";
        const find = document.createElement("input"); find.placeholder = "Find text"; find.setAttribute("aria-label", "Find text");
        const replacement = document.createElement("input"); replacement.placeholder = "Replace with"; replacement.setAttribute("aria-label", "Replacement text"); replacement.hidden = !editable;
        for (const input of [find, replacement]) input.style.cssText = "font-size:16px;padding:8px;background:#111722;color:white;border:1px solid #526079;border-radius:6px;";
        const caseLabel = document.createElement("label");
        const sensitive = document.createElement("input"); sensitive.type = "checkbox"; caseLabel.append(sensitive, document.createTextNode(" Case-sensitive"));
        const count = document.createElement("span");
        const previous = document.createElement("button"); previous.textContent = "Previous";
        const next = document.createElement("button"); next.textContent = "Next";
        const replaceOne = document.createElement("button"); replaceOne.textContent = "Replace current"; replaceOne.hidden = !editable;
        const replaceAll = document.createElement("button"); replaceAll.textContent = "Replace all"; replaceAll.hidden = !editable;
        for (const button of [previous, next, replaceOne, replaceAll]) { button.type = "button"; button.style.cssText = copy.style.cssText; }
        searchbar.append(find, previous, next, count, caseLabel, replacement, replaceOne, replaceAll);
        panel.insertBefore(searchbar, text);
        let matches = [], currentMatch = -1;
        const scan = () => {
            matches = []; currentMatch = -1;
            if (find.value) {
                const needle = sensitive.checked ? find.value : find.value.toLowerCase();
                // Slice the original text to preserve UTF-16 selection offsets.
                for (let pos = 0; pos <= text.value.length - find.value.length;) {
                    const part = text.value.slice(pos, pos + find.value.length);
                    if ((sensitive.checked ? part : part.toLowerCase()) === needle) { matches.push(pos); pos += find.value.length; }
                    else pos++;
                }
            }
            count.textContent = `${matches.length} matches`;
            for (const button of [previous, next, replaceOne, replaceAll]) button.disabled = !matches.length;
        };
        const navigate = direction => {
            if (!matches.length) return;
            currentMatch = currentMatch < 0 ? (direction < 0 ? matches.length - 1 : 0) : (currentMatch + direction + matches.length) % matches.length;
            text.focus(); text.setSelectionRange(matches[currentMatch], matches[currentMatch] + find.value.length);
            count.textContent = `${currentMatch + 1} / ${matches.length} matches`;
        };
        find.addEventListener("input", scan); sensitive.addEventListener("change", scan);
        previous.onclick = () => navigate(-1); next.onclick = () => navigate(1);
        replaceOne.onclick = () => {
            if (!editable || !matches.length) return;
            if (currentMatch < 0) navigate(1);
            const pos = matches[currentMatch];
            text.setRangeText(replacement.value, pos, pos + find.value.length, "end");
            text.dispatchEvent(new Event("input", { bubbles: true }));
        };
        replaceAll.onclick = () => {
            if (!editable || !matches.length) return;
            let value = text.value;
            for (const pos of [...matches].reverse()) value = value.slice(0, pos) + replacement.value + value.slice(pos + find.value.length);
            text.value = value; text.dispatchEvent(new Event("input", { bubbles: true }));
        };
        scan();
        let frame = 0;
        const fit = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                if (!text.value) { setFont(32); return; }
                let low = 1, high = 128, best = 1;
                while (low <= high) {
                    const size = Math.floor((low + high) / 2); text.style.fontSize = `${size}px`;
                    if (text.scrollHeight <= text.clientHeight + 1 && text.scrollWidth <= text.clientWidth + 1) { best = size; low = size + 1; }
                    else high = size - 1;
                }
                setFont(best);
            });
        };
        text.addEventListener("input", () => {
            if (!editable || source.disabled || source.readOnly) return;

            copy.textContent = "Copy";
            refreshInfo();
            scan();
        });
        const keydown = e => {
            if (editable && !e.isComposing && (e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); apply.onclick(); return; }
            if (e.key === "Escape") { e.preventDefault(); dismiss(); }
            if (e.key === "Tab") {
                const focusable = [fontSize, autoFit, copy, ...(editable ? [apply] : []), close, find, previous, next, sensitive, ...(editable ? [replacement, replaceOne, replaceAll] : []), text].filter(el => !el.disabled); const i = focusable.indexOf(document.activeElement);
                e.preventDefault(); focusable[(i + (e.shiftKey ? -1 : 1) + focusable.length) % focusable.length].focus();
            }
        };
        const dismiss = () => { cancelAnimationFrame(frame); document.removeEventListener("keydown", keydown, true); overlay.remove(); closeActive = null; previousFocus?.focus?.(); };
        autoFit.onclick = fit;
        apply.onclick = () => {
            if (source.disabled || source.readOnly) return;
            source.value = text.value;
            source.dispatchEvent(new Event("input", { bubbles: true }));
            source.dispatchEvent(new Event("change", { bubbles: true }));
            dismiss();
        };
        close.onclick = dismiss; overlay.onclick = e => { if (e.target === overlay) dismiss(); };
        copy.onclick = async () => {
            try { await navigator.clipboard.writeText(text.value); copy.textContent = "Copied"; }
            catch { text.focus(); text.select(); copy.textContent = "Press Ctrl+C"; }
        };
        document.addEventListener("keydown", keydown, true); closeActive = dismiss; (editable ? text : copy).focus(); fit();
    };
    master.addEventListener("dblclick", open);
    return () => { master.removeEventListener("dblclick", open); closeActive?.(); };
}
