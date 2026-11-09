"""Execution checklist: inspect effective inputs without consuming random draws."""
import os
import folder_paths


def build_checklist(values, connected, slot, phase, clothing, path, model, clip, stack, json_node=False, warnings=()):
    rows = []
    def add(label, status, detail):
        rows.append(dict(label=label, status=status, detail=detail))
    test = values.get("is_test", False)
    add("Mode & output path", "error" if test and not str(path).strip() else "ready", f"{'Test' if test else 'Gen'} · {path or 'No output path'}")
    random = values.get(f"randomize_character_{slot}", False)
    locked = values.get(f"random_character_locked_{slot}", False)
    add("Character source", "ready", "Locked" if random and locked else "Random" if random else "Manual")
    outfit = values.get(f"random_outfit_{slot}", False)
    cleavage = values.get(f"cleavage_{slot}", False)
    add("Outfit", "ready", f"{'Random' if outfit else 'Manual'} · {['Dressed', 'Clothes lifted / panties aside', 'Clothes lifted / no panties', 'Nude'][clothing-1]} · Cleavage {'ON' if cleavage else 'OFF'}")
    scene = values.get("use_Scene", True)
    add("Scene & background", "ready", f"Scene input · {values.get('Scene_path') or 'Empty'}" if scene else f"Combo {slot} background")
    phase_key = {1:'Posing_path',2:'Teasing_path',3:'Groping_path',4:'Group_Groping_path',5:'Cunni_path',6:'BJ_path',7:'Action_path',8:'Anaction_path',9:'Group_BJ_path',10:'Group_path',11:'BJ_path'}[phase]
    required = {phase_key}
    if scene: required.add('Scene_path')
    if outfit: required.add('Outfit_path')
    missing = [key for key in connected if key in required and not str(connected[key] or '').strip()]
    add("Connected inputs", "warning" if missing else "ready" if connected else "disabled", (', '.join(connected) + ' override stored settings' if connected else 'No connected text overrides') + (" · Empty active sources: " + ', '.join(missing) if missing else ''))
    loras = []
    errors = []
    for name, sm, sc in stack:
        loras.append(f"{name} (Model {sm:g} / CLIP {sc:g})")
        try:
            full = folder_paths.get_full_path_or_raise('loras', name)
            if not os.path.isfile(full): errors.append(f"Missing {name}")
        except Exception: errors.append(f"Missing {name}")
    if stack and model is None: errors.append('Model input missing')
    if stack and clip is None: errors.append('CLIP input missing')
    add("LoRAs", "error" if any(e.startswith('Missing ') for e in errors) else "warning" if errors else "ready" if stack else "disabled", f"{len(stack)} active in phase {phase}" + (' · ' + '; '.join(loras + errors) if loras or errors else ''))
    sources = []
    for key in sorted(required):
        value = str(values.get(key) or '').strip()
        if not value: state = 'empty'
        elif json_node and key == phase_key:
            try:
                with os.scandir(value) as entries:
                    available = any(e.is_file() and e.name.lower().endswith('.json') for e in entries)
                state = 'templates ready' if available else 'no JSON templates'
            except OSError: state = 'unavailable directory'
        else:
            try: state = 'ready' if os.path.isfile(value) and os.path.getsize(value) else 'empty or unavailable'
            except OSError: state = 'unavailable'
        sources.append(f"{key}: {state}")
    if not json_node:
        for name in ('Composition', 'Lighting', 'Style', 'Technical_details'):
            if values.get('use_' + name, True):
                value = str(values.get(name + '_path') or '').strip()
                sources.append(f"{name}_path: " + ('ready' if value and os.path.isfile(value) and os.path.getsize(value) else 'empty or unavailable'))
    source_problem = any(not s.endswith('ready') for s in sources)
    add("Prompt sources", "warning" if source_problem or warnings else "ready", ' · '.join(sources) + (' · ' + '; '.join(str(w) for w in warnings) if warnings else ''))
    return rows
