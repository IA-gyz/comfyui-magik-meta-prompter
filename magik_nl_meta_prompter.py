import os
import re
import json
import random
import threading
from collections import OrderedDict

import comfy.utils
import comfy.sd
import folder_paths
from aiohttp import web
from server import PromptServer

from comfy_api.latest import io, ui
from .magik_nl_character_randomizer import resolve_random_character, execution_picture
from .magik_nl_settings import decode_settings, MANIFEST
from .magik_nl_checklist import build_checklist
from .magik_nl_clothing import build_nl_clothing

_FILE_CACHE = OrderedDict() # Previously: _FILE_CACHE = {}
_CACHE_LOCK = threading.Lock()
_MAX_CACHE_ENTRIES = 50

# LoRA .safetensors cache: module-level LRU, mtime-validated (unlike AnimaX's
# unbounded instance cache — this one can't grow forever and survives a
# re-trained file being overwritten in place).
_LORA_FILE_CACHE = OrderedDict()
_LORA_CACHE_LOCK = threading.Lock()
_MAX_LORA_CACHE_ENTRIES = 12

# --- Background Builder integration -----------------------------------
# Folded in from the standalone MagikBackgroundBuilder node/pack (ported by
# way of MagikNLMetaPrompterJSON, where this was folded in first). Presets
# are keyword lists (not character-specific), so one shared preset library
# is used across every combo's Background section on this node.
#
# Routes are deliberately at a DIFFERENT path than either the standalone
# node's (/magik_background_builder/*) or the JSON node's
# (/magik_nl_meta_prompter_json/bg_*) - aiohttp doesn't allow two handlers
# on the same (method, path), so all three can register safely if loaded
# together instead of one crashing ComfyUI at startup. The presets FOLDER
# is still shared on purpose, though: all three files normally live side by
# side in the same custom_nodes directory, so os.path.dirname(__file__)
# resolves to the same place either way - a preset saved from one is
# readable from the others.
BG_PRESETS_DIR = os.path.join(os.path.dirname(__file__), "presets")
os.makedirs(BG_PRESETS_DIR, exist_ok=True)


@PromptServer.instance.routes.post('/magik_nl_meta_prompter/bg_save_preset')
async def magik_bg_save_preset(request):
    try:
        data = await request.json()
        preset_name = data.get('preset_name', '').strip()
        overwrite = data.get('overwrite', False)

        if not preset_name:
            return web.json_response({"status": "error", "message": "No valid keyword found in 'fix' area for preset name."}, status=400)

        filename = f"{preset_name}.json"
        preset_path = os.path.join(BG_PRESETS_DIR, filename)

        if os.path.exists(preset_path) and not overwrite:
            return web.json_response({"status": "exists", "message": f"Preset '{preset_name}' already exists."})

        payload = {
            "fix": data.get('fix', ''),
            "random_text": data.get('random_text', ''),
            "how_many": data.get('how_many', 1),
            "location_type": data.get('location_type', 'indoors'),
            "include_location": data.get('include_location', True)
        }

        with open(preset_path, 'w', encoding='utf-8') as f:
            json.dump(payload, f, indent=4, ensure_ascii=False)

        return web.json_response({"status": "success", "preset_name": preset_name})
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)}, status=500)


@PromptServer.instance.routes.get('/magik_nl_meta_prompter/bg_list_presets')
async def magik_bg_list_presets(request):
    try:
        files = [os.path.splitext(f)[0] for f in os.listdir(BG_PRESETS_DIR) if f.endswith('.json')]
        files.sort()
        return web.json_response({"status": "success", "presets": files})
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)}, status=500)


@PromptServer.instance.routes.post('/magik_nl_meta_prompter/bg_load_preset')
async def magik_bg_load_preset(request):
    try:
        data = await request.json()
        preset_name = data.get('preset_name', '').strip()

        if not preset_name:
            return web.json_response({"status": "error", "message": "No preset name provided."}, status=400)

        filename = f"{preset_name}.json"
        preset_path = os.path.join(BG_PRESETS_DIR, filename)

        if not os.path.exists(preset_path):
            return web.json_response({"status": "error", "message": f"Preset '{preset_name}' does not exist."}, status=404)

        with open(preset_path, 'r', encoding='utf-8') as f:
            preset_data = json.load(f)

        return web.json_response({"status": "success", "data": preset_data})
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)}, status=500)

# Patched-model memo: (id(model), id(clip), active LoRA signature) -> entry.
# Each entry holds STRONG refs to the source model/clip, so their id()s can
# never be recycled by the GC while an entry is alive, and a cache hit is
# verified with `is` — id-reuse cannot produce a false hit. This is what lets
# fingerprint_inputs stay always-dirty (§3.9: every run rerolls the text) without
# paying the clone+patch cost on runs where the LoRA state didn't change.
_PATCHED_MODEL_CACHE = OrderedDict()
_PATCHED_CACHE_LOCK = threading.Lock()
_MAX_PATCHED_CACHE_ENTRIES = 8  # one per combo slot (active_combos maxes out at 8)



# Outfit "no-repeat" bag cache: abs filepath -> {mtime, all_lines, bag, last}.
# `bag` is a shuffled copy of all_lines that gets popped from on every draw
# and reshuffled+refilled once emptied — a shuffle-bag, not plain
# random.choice(), so a line can't come up again until every other line in
# the file has been drawn once. Keyed by path (not by combo slot), so
# every slot with "Random Outfit" ON pulls from the same shared bag and
# none of them can repeat each other's picks either. LRU-capped like the
# other module caches above.
_OUTFIT_BAG_CACHE = OrderedDict()
_OUTFIT_BAG_LOCK = threading.Lock()
_MAX_OUTFIT_BAG_ENTRIES = 20


# The 11 narrative phases, in ascending threshold order. Single source of
# truth for: the *_enabled checkbox widgets, the raw_phase_thresh list in
# process(), and the disabled-phase skip logic (see process()).
PHASE_ORDER = [
    "Posing", "Teasing", "Groping", "Group_Groping", "Cunni", "BJ",
    "Action", "Anaction", "Group_BJ", "Group", "Facial",
]

# Fixed backend pool of LoRA slots per combo. The frontend's Add/Remove
# LoRA UI doesn't create new widgets at runtime (define_schema is static) -
# it just shows/hides rows within this pool via the lora_visible_{i}
# counter widget below.
MAX_LORA_SLOTS = 8


class MagikNLMetaPrompter(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        inputs = [
            io.Int.Input("index", force_input=True, default=0),
            io.String.Input("settings", default="{}"),
            io.Model.Input("model", optional=True),
            io.Clip.Input("clip", optional=True),
        ]

        # Keep real text/path connections; frontend-only settings stay compact.
        inputs.extend(io.String.Input(name, force_input=True, default=definition.get("default", ""))
            for name, definition in MANIFEST["magik_nl_meta_prompter"].items()
            if definition.get("force_input"))

        return io.Schema(
            node_id="Magik.NLMetaPrompter",
            display_name="Magik NL Meta Prompter",
            category="Magik/Tool/Prompt",
            inputs=inputs,
            # MODEL/CLIP are appended at the END: existing output indices 0-5 keep
            # their meaning, so saved workflows' output links survive the upgrade.
            outputs=[
                io.String.Output("Prompt", display_name="Prompt"),
                io.String.Output("Current Path", display_name="Current Path"),
                io.String.Output("CHAR_NAME", display_name="CHAR_NAME"),
                io.String.Output("FACE", display_name="FACE"),
                io.String.Output("DEBUG", display_name="DEBUG"),
                io.Int.Output("Wrapped Index", display_name="Wrapped Index"),
                io.Model.Output("model", display_name="model"),
                io.Clip.Output("clip", display_name="clip"),
                io.Int.Output("Phase", display_name="Phase"),
                io.String.Output("Prompt_bis", display_name="Prompt_bis"),
            ],
        )

    @classmethod
    def fingerprint_inputs(cls, index, **kwargs):
        # Deliberately always dirty (README §3.9): every run rerolls all
        # random text picks. The expensive side effect this would normally
        # imply — re-cloning model/clip and re-applying up to MAX_LORA_SLOTS
        # LoRAs on every run — is avoided inside _apply_loras(), which
        # memoizes the patched result on (source model identity + active
        # LoRA signature) and only re-patches when the active combo's LoRA
        # state actually changed.
        return os.urandom(8).hex()

    # ------------------------------------------------------------------ #
    #  LoRA stack (ported from MagikAnimaXMetaPrompter)                   #
    # ------------------------------------------------------------------ #

    @staticmethod
    def _load_lora_file(lora_name):
        if lora_name == "None" or not lora_name:
            return None, None

        try:
            lora_path = folder_paths.get_full_path_or_raise("loras", lora_name)
        except Exception as e:
            raise RuntimeError(f"LoRA '{lora_name}' not found: {e}")

        mtime = os.path.getmtime(lora_path)
        with _LORA_CACHE_LOCK:
            entry = _LORA_FILE_CACHE.get(lora_path)
            if entry and entry["mtime"] == mtime:
                _LORA_FILE_CACHE.move_to_end(lora_path)
                return entry["lora"], entry["metadata"]

        lora, metadata = comfy.utils.load_torch_file(lora_path, safe_load=True, return_metadata=True)
        with _LORA_CACHE_LOCK:
            _LORA_FILE_CACHE[lora_path] = {"mtime": mtime, "lora": lora, "metadata": metadata}
            _LORA_FILE_CACHE.move_to_end(lora_path)
            while len(_LORA_FILE_CACHE) > _MAX_LORA_CACHE_ENTRIES:
                _LORA_FILE_CACHE.popitem(last=False)
        return lora, metadata

    @staticmethod
    def _lora_mtime(lora_name):
        """Best-effort mtime lookup, for _PATCHED_MODEL_CACHE key purposes
        only. Returns None on any resolution failure — raising here isn't
        this helper's job; a genuinely missing file still surfaces its own
        error normally when _load_lora_file actually tries to load it. None
        just guarantees this LoRA can never produce a stale cache hit."""
        try:
            lora_path = folder_paths.get_full_path_or_raise("loras", lora_name)
            return os.path.getmtime(lora_path)
        except Exception:
            return None

    @staticmethod
    def _active_lora_stack(slot: int, kwargs: dict, current_phase: int) -> list:
        """Enabled LoRAs for one combo slot, filtered by current phase."""
        stack = []
        for l in range(1, MAX_LORA_SLOTS + 1):
            name = kwargs.get(f'lora_{slot}_{l}', 'None')
            enabled = kwargs.get(f'lora_enable_{slot}_{l}', False)
            sm = float(kwargs.get(f'lora_strength_model_{slot}_{l}', 1.0))
            sc = float(kwargs.get(f'lora_strength_clip_{slot}_{l}', 1.0))

            # --- PHASE FILTERING ---
            phase_str = kwargs.get(f'lora_phases_{slot}_{l}', '0,0,0,0,0,0,0,0,0,0,0')
            try:
                # current_phase is 1-based (1-11), so we index with phase - 1
                is_active = phase_str.split(',')[current_phase - 1] == '1'
            except (IndexError, ValueError):
                is_active = True # Default to active if string is malformed

            if not enabled or not is_active or not name or name == "None":
                continue
            if sm == 0 and sc == 0:
                continue

            stack.append((name, sm, sc))
        return stack

    @staticmethod
    def _active_lora_triggers(slot: int, kwargs: dict, current_phase: int, warnings: list = None) -> dict:
        """Enabled+phase-active LoRA trigger words for one combo slot,
        bucketed by insertion point (see the lora_trigger_point_{slot}_{l}
        combo and the six insertion sites in process()). Uses the same
        enable/phase gate as _active_lora_stack, but is independent of
        which lora_{slot}_{l} file (if any) is selected — a trigger word is
        a prompt-text concern, not a model-patching one, so a row can fire
        its trigger even with the LoRA file left at "None" as long as it's
        enabled and active for the current phase.
        """
        points = ("background", "character", "outfit", "pose", "action", "overall")
        triggers = {p: [] for p in points}
        for l in range(1, MAX_LORA_SLOTS + 1):
            enabled = kwargs.get(f'lora_enable_{slot}_{l}', False)

            phase_str = kwargs.get(f'lora_phases_{slot}_{l}', '0,0,0,0,0,0,0,0,0,0,0')
            try:
                is_active = phase_str.split(',')[current_phase - 1] == '1'
            except (IndexError, ValueError):
                is_active = True

            if not enabled or not is_active:
                continue

            word = (kwargs.get(f'lora_trigger_word_{slot}_{l}', '') or '').strip()
            if not word:
                continue

            point = kwargs.get(f'lora_trigger_point_{slot}_{l}', 'background')
            if point not in triggers:
                if warnings is not None:
                    warnings.append(
                        f"LoRA trigger word (slot {slot}, lora {l}): unknown trigger point "
                        f"'{point}', defaulting to 'background'"
                    )
                point = 'background'
            triggers[point].append(word)
        return triggers

    @classmethod
    def _apply_loras(cls, model, clip, slot: int, kwargs: dict, current_phase: int, warnings: list = None):
        if model is None and clip is None:
            return None, None

        stack = cls._active_lora_stack(slot, kwargs, current_phase)
        if not stack:
            # Identity passthrough — no clone: downstream caches keyed on
            # object identity stay valid on runs with an empty LoRA stack.
            return model, clip

        key = (id(model), id(clip), tuple((name, sm, sc, cls._lora_mtime(name)) for name, sm, sc in stack))
        with _PATCHED_CACHE_LOCK:
            entry = _PATCHED_MODEL_CACHE.get(key)
            # The entry holds strong refs to the source objects, so `is` is a
            # reliable identity check — id() cannot have been recycled.
            if entry is not None and entry["model_src"] is model and entry["clip_src"] is clip:
                _PATCHED_MODEL_CACHE.move_to_end(key)
                return entry["model"], entry["clip"]

        current_model = model.clone() if model is not None else None
        current_clip = clip.clone() if clip is not None else None

        for name, sm, sc in stack:
            # A missing/corrupt LoRA skips just this slot (with a warning),
            # same fail-soft contract as every text-file path in this node —
            # it doesn't fail the whole queue run.
            try:
                lora, metadata = cls._load_lora_file(name)
            except Exception as e:
                if warnings is not None:
                    warnings.append(f"LoRA skipped (slot {slot}): {e}")
                continue
            if lora is None:
                continue
            try:
                current_model, current_clip = comfy.sd.load_lora_for_models(
                    current_model, current_clip, lora, sm, sc, lora_metadata=metadata
                )
            except Exception as e:
                if warnings is not None:
                    warnings.append(f"LoRA '{name}' failed to apply (slot {slot}): {e}")
                continue

        with _PATCHED_CACHE_LOCK:
            _PATCHED_MODEL_CACHE[key] = {
                "model_src": model, "clip_src": clip,
                "model": current_model, "clip": current_clip,
            }
            _PATCHED_MODEL_CACHE.move_to_end(key)
            while len(_PATCHED_MODEL_CACHE) > _MAX_PATCHED_CACHE_ENTRIES:
                _PATCHED_MODEL_CACHE.popitem(last=False)

        return current_model, current_clip

    @staticmethod
    def _read_random_line(filepath: str, warnings: list = None) -> str:
        if not filepath:
            return ""
        if not os.path.isfile(filepath):
            if warnings is not None:
                warnings.append(f"Missing file: {filepath}")
            return ""
        try:
            mtime = os.path.getmtime(filepath)
            with _CACHE_LOCK:
                cached = _FILE_CACHE.get(filepath)
                if cached and cached["mtime"] == mtime:
                    # Move to end to register as most recently used
                    _FILE_CACHE.move_to_end(filepath)
                    lines = cached["lines"]
                else:
                    with open(filepath, 'r', encoding='utf-8') as f:
                        lines = [line.strip() for line in f if line.strip()]
                    _FILE_CACHE[filepath] = {"mtime": mtime, "lines": lines}
                    # Ensure the cache doesn't exceed max entries
                    while len(_FILE_CACHE) > _MAX_CACHE_ENTRIES:
                        _FILE_CACHE.popitem(last=False) # True LRU pop
            if not lines:
                if warnings is not None:
                    warnings.append(f"Empty file: {filepath}")
                return ""
            return random.choice(lines) if lines else ""
        except Exception as e:
            if warnings is not None:
                warnings.append(f"Error reading {filepath}: {e}")
            return ""

    @classmethod
    def _read_random_line_no_repeat(cls, filepath: str, warnings: list = None) -> str:
        """Like _read_random_line, but draws from a shuffled "bag" that gets
        depleted without repeats until every line has been drawn once, then
        reshuffled and refilled. Used for Outfit_path ("Random Outfit"
        checkbox): fingerprint_inputs is always-dirty (every run rerolls), so a
        plain random.choice() could easily repeat the same outfit back to
        back — the bag is what actually prevents that, across slots and
        across runs, not just within one process() call."""
        if not filepath:
            return ""
        if not os.path.isfile(filepath):
            if warnings is not None:
                warnings.append(f"Missing file: {filepath}")
            return ""
        try:
            mtime = os.path.getmtime(filepath)
            with _OUTFIT_BAG_LOCK:
                entry = _OUTFIT_BAG_CACHE.get(filepath)
                if not entry or entry["mtime"] != mtime:
                    with open(filepath, 'r', encoding='utf-8') as f:
                        lines = [line.strip() for line in f if line.strip()]
                    entry = {"mtime": mtime, "all_lines": lines, "bag": [], "last": None}
                    _OUTFIT_BAG_CACHE[filepath] = entry
                _OUTFIT_BAG_CACHE.move_to_end(filepath)
                while len(_OUTFIT_BAG_CACHE) > _MAX_OUTFIT_BAG_ENTRIES:
                    _OUTFIT_BAG_CACHE.popitem(last=False)

                if not entry["all_lines"]:
                    if warnings is not None:
                        warnings.append(f"Empty file: {filepath}")
                    return ""

                if not entry["bag"]:
                    entry["bag"] = entry["all_lines"].copy()
                    random.shuffle(entry["bag"])
                    # Don't let a fresh bag's first pick be the same line the
                    # previous (now-exhausted) bag ended on.
                    if entry["last"] is not None and len(entry["bag"]) > 1 and entry["bag"][-1] == entry["last"]:
                        entry["bag"][-1], entry["bag"][0] = entry["bag"][0], entry["bag"][-1]

                line = entry["bag"].pop()
                entry["last"] = line
                return line
        except Exception as e:
            if warnings is not None:
                warnings.append(f"Error reading {filepath}: {e}")
            return ""

    @staticmethod
    def _normalize_tag_string(text: str) -> str:
        if not text:
            return ""
        text = text.replace('\r\n', '\n').replace('\r', '\n').replace('\n', ',')
        parts = [p.strip() for p in text.split(',') if p.strip()]
        return ", ".join(parts)

    @staticmethod
    def _strip_comment_markers(text: str) -> str:
        # .* matches everything up to the end of the line, ignoring newlines.
        return re.sub(r"//.*", "", text) if text else ""

    _KEYWORD_RE = re.compile(r"(tongue_out|tongue|fellatio|blowjob|irrumatio|deepthroat)", re.I)

    _WILDCARD_FILE_MAP = {
        1: "face_fuck.txt",
        2: "face_fuck.txt",
        3: "face_fuck.txt",
        4: "face_fuck.txt",
        5: "face_fuck.txt",
        6: "face_fuck_mouthful.txt",
        7: "face_fuck.txt",
        8: "face_fuck.txt",
        9: "face_fuck_mouthful2.txt",
        10: "face_fuck.txt",
        11: "face_fuck_mouthful3.txt"
    }

    @classmethod
    def _get_wildcards_text(cls, wildcards_path: str, phase: int,
                            warnings: list = None) -> str:
        filename = cls._WILDCARD_FILE_MAP.get(phase, "face_fuck.txt")
        full_path = os.path.join(wildcards_path, filename)
        return cls._read_random_line(full_path, warnings)

    @classmethod
    def _build_line1(cls, paths: dict, use_flags: dict = None, background_val: str = "",
                     trigger_background: str = "", warnings: list = None) -> str:
        parts = []
        use_flags = use_flags or {}
        for key in ["Scene_path", "Composition_path", "Lighting_path", "Style_path", "Technical_details_path"]:
            toggle_key = "use_" + key[:-len("_path")]
            if key == "Scene_path":
                # use_Scene now picks the SOURCE (Scene_path's draw vs. this
                # combo's Background Builder output) rather than whether
                # Scene is included at all - ported from
                # MagikNLMetaPrompterJSON's scene_p_holder/background_val
                # relationship. Scene_path isn't even read when OFF (no bag
                # draw consumed for a value that'd be discarded).
                if use_flags.get(toggle_key, True):
                    line = cls._read_random_line(paths.get(key, ""), warnings).strip()
                else:
                    line = (background_val or "").strip()
                # background-point LoRA trigger words go just after this
                # combo's Scene/Background contribution, comma separated -
                # same insertion point as scene_p_holder in the JSON node,
                # applied here to whichever source fed `line` above.
                if trigger_background:
                    line = ", ".join(x for x in [line, trigger_background] if x)
            else:
                if not use_flags.get(toggle_key, True):
                    continue
                line = cls._read_random_line(paths.get(key, ""), warnings).strip()
            if line:
                line = line.rstrip('.').strip()
                parts.append(line)
        joined = ". ".join(parts)
        if joined and not joined.endswith('.'):
            joined += '.'
        return joined

    @classmethod
    def _build_background(cls, fix: str, random_text: str, how_many: int,
                           location_type: str, include_location: bool) -> str:
        # Ported from the standalone MagikBackgroundBuilder node's build()
        # (by way of MagikNLMetaPrompterJSON, where this was folded in
        # first). random_text is a comma-separated pool where each token
        # can end in " N" (a repeat/weight count, e.g. "rain 3") to bias the
        # odds of that keyword being drawn without letting it be drawn more
        # than once overall - expand into a flat weighted list, then
        # repeatedly pick one at random and strike every remaining copy of
        # it (not just the one instance picked) before the next draw.
        keyword_list = []
        if random_text and random_text.strip():
            tokens = [t.strip() for t in random_text.replace('\r', ',').replace('\n', ',').split(',') if t.strip()]
            for token in tokens:
                parts = token.rsplit(' ', 1)
                if len(parts) == 2 and parts[1].isdigit():
                    keyword = parts[0].strip()
                    count = int(parts[1])
                else:
                    keyword = token
                    count = 1
                keyword_list.extend([keyword] * count)

        selected = []
        temp_list = keyword_list[:]
        for _ in range(how_many):
            if not temp_list:
                break
            chosen = random.choice(temp_list)
            selected.append(chosen)
            temp_list = [kw for kw in temp_list if kw != chosen]

        parts = []
        if include_location:
            parts.append(location_type)
        if fix:
            parts.extend(line.strip().strip(', ') for line in fix.splitlines() if line.strip().strip(', '))
        parts.extend(selected)
        return ", ".join(part.strip() for part in parts if part.strip())

    @classmethod
    def _build_clothes_desc(cls, clothes_raw: str, p_clo: int, checklist: str, rng=None) -> str:
        rng = rng or random
        clothes_norm = cls._normalize_tag_string(clothes_raw)

        if p_clo == 4:
            return "completely nude"

        lift_parts = []
        if checklist and clothes_norm:
            keywords = [k.strip() for k in checklist.split(',') if k.strip()]
            for kw in keywords:
                if re.search(r'\b' + re.escape(kw) + r'\b', clothes_norm, re.I):
                    if kw.lower() == "pants":
                        lift_parts.append("{pants pull|open pants|downpants}")
                    elif kw.lower() == "shorts":
                        lift_parts.append("{Shorts aside|Shorts pull}")
                    else:
                        lift_parts.append(f"{{{kw} lift|{kw} pull}}")
        lift_resolved = re.sub(r'\{([^}]+)\}', lambda m: rng.choice(m.group(1).split('|')).strip(), ", ".join(lift_parts))

        if p_clo in (2, 3):
            breasts = rng.choice(["breasts out", "breasts visible"])
            state = "panties aside" if p_clo == 2 else "no panties"
            base_elements = ["partially undressed", breasts]
            if clothes_norm: base_elements.append(clothes_norm)
            if lift_resolved: base_elements.append(lift_resolved)
            base_elements.append(state)
            return ", ".join(base_elements)
        else:
            return clothes_norm

    @classmethod
    def _build_line2(cls, combo_data: dict, p_clo: int, checklist: str,
                     wild_text: str = "", trigger_outfit: str = "",
                     warnings: list = None, nl_settings=None, rng=None) -> str:
        girl_face = cls._strip_comment_markers(combo_data.get("GIRL_FACE", ""))
        girl_noface_raw = cls._strip_comment_markers(combo_data.get("GIRL_NOFACE", ""))
        clothes_raw = cls._strip_comment_markers(combo_data.get("CHARACTER_CLOTHES", ""))

        girl_face = cls._normalize_tag_string(girl_face)
        girl_noface_raw = cls._normalize_tag_string(girl_noface_raw)
        clothes_raw = cls._normalize_tag_string(clothes_raw)

        if warnings is not None:
            # Only warn if the user actually inputted text, but it became empty after stripping
            if combo_data.get("GIRL_FACE", "").strip() and not girl_face:
                warnings.append("GIRL_FACE is empty after stripping/normalization")
            if combo_data.get("GIRL_NOFACE", "").strip() and not girl_noface_raw:
                warnings.append("GIRL_NOFACE is empty after stripping/normalization")
            if combo_data.get("CHARACTER_CLOTHES", "").strip() and not clothes_raw:
                warnings.append("CHARACTER_CLOTHES is empty after stripping/normalization")

        if combo_data.get("slim", False):
            s_strength = combo_data.get("s_strength", 1.0)
            s_val = f"{s_strength:.2f}".rstrip('0').rstrip('.')
            slim_tag = f"(slim body, slim legs:{s_val})"
            girl_noface = cls._normalize_tag_string(", ".join(filter(None, [girl_noface_raw, slim_tag])))
        else:
            girl_noface = girl_noface_raw

        # Not just aging anymore (cleavage joined the party) — kept as one
        # list since all three get appended into the girl description line
        # the same way: plain tag at strength 1.0, weighted "(tag:X.XX)"
        # otherwise.
        desc_tags = []
        if combo_data.get("teenager", False):
            strength = combo_data.get("t_strength", 1.0)
            desc_tags.append("teenager" if strength == 1.0 else f"(teenager:{strength:.2f})")
        if combo_data.get("aged_up", False):
            strength = combo_data.get("a_strength", 1.0)
            desc_tags.append("aged up" if strength == 1.0 else f"(aged up:{strength:.2f})")
        if combo_data.get("cleavage", False):
            strength = combo_data.get("c_strength", 1.0)
            desc_tags.append("cleavage" if strength == 1.0 else f"(cleavage:{strength:.2f})")

        clothes_desc = build_nl_clothing(combo_data.get("CHARACTER_CLOTHES", ""), p_clo, nl_settings, chooser=(rng or random).choice) if nl_settings is not None else cls._build_clothes_desc(clothes_raw, p_clo, checklist, rng)
        # outfit-point LoRA trigger words go just before the clothing
        # description, comma separated with the rest - closest analog here
        # to outfit_p_holder in the JSON node, since this node folds
        # clothes straight into the girl description line rather than
        # keeping it as a separate placeholder.
        if trigger_outfit:
            clothes_desc = ", ".join(x for x in [trigger_outfit, clothes_desc] if x)

        elements = [girl_face, girl_noface]
        if desc_tags:
            elements.append(", ".join(desc_tags))
        if clothes_desc:
            elements.append(clothes_desc)
        if wild_text:
            elements.append(wild_text)

        result = ", ".join(e.strip() for e in elements if e.strip())
        if result and not result.endswith('.'):
            result += '.'
        return result

    @classmethod
    def _build_line3(cls, phase: int, phase_path: str, trigger_pose: str = "",
                     trigger_action: str = "", warnings: list = None) -> str:
        phase_line = cls._read_random_line(phase_path, warnings).strip()
        line3 = phase_line
        # action-point LoRA trigger words go at the very start of this
        # phase's text, comma separated with the rest - closest analog here
        # to the "action" JSON key's string value in the JSON node, since
        # this node has no JSON template/key structure to search - line3 is
        # the free-text "act" section of Prompt either way.
        if trigger_action:
            line3 = ", ".join(x for x in [trigger_action, line3] if x)
        if line3 and not line3.endswith('.'):
            line3 += '.'
        # pose-point LoRA trigger words go on their own line ahead of the
        # "act" section - closest analog here to the JSON node's "between
        # the picked template's first 'pose' and 'body'" insertion, since
        # this node has no separate pose/body fields to search between.
        if trigger_pose:
            line3 = f"{trigger_pose}\n{line3}" if line3 else trigger_pose
        # phase_line (pre-trigger, undotted) is returned separately and
        # still feeds _build_face's keyword scan below - trigger insertions
        # above only affect line3 (the Prompt-bound copy), not phase_line.
        return line3, phase_line

    @classmethod
    def _build_face(cls, girl_face: str, wild_text: str, phase_line: str,
                    aging_tags: list) -> str:
        combined_action = f"{phase_line} {wild_text}"
        keywords = cls._KEYWORD_RE.findall(combined_action)
        keywords_unique = list(dict.fromkeys(keywords))
        keyword_str = ", ".join(keywords_unique)

        parts = [girl_face, wild_text, keyword_str]
        if aging_tags:
            parts.append(", ".join(aging_tags))
        return cls._normalize_tag_string(", ".join(p for p in parts if p))

    @classmethod
    def execute(cls, index, settings="{}", model=None, clip=None, **kwargs):
        connected_inputs = dict(kwargs)
        kwargs = decode_settings(settings, "magik_nl_meta_prompter", kwargs)
        if kwargs.get("is_test", False) and not str(kwargs.get("test_path") or "").strip():
            raise ValueError("test_path is required in Test mode; enter a non-empty path or switch to Gen mode.")

        if index < 1:
            index = 1

        facial_val = kwargs.get("Facial", 160)
        if facial_val <= 0:
            facial_val = 160
        wrapped_index = ((index - 1) % facial_val) + 1

        # CORRECTED SLOT CALCULATION
        active_combos = kwargs.get("active_combos", 2)
        if active_combos < 2:
            active_combos = 2
        slot = ((index - 1) // facial_val) % active_combos + 1

        # --- CALCULATE PHASE FIRST ---
        raw_phase_thresh = [
            kwargs.get("Posing", 10),
            kwargs.get("Teasing", 20),
            kwargs.get("Groping", 30),
            kwargs.get("Group_Groping", 40),
            kwargs.get("Cunni", 50),
            kwargs.get("BJ", 70),
            kwargs.get("Action", 90),
            kwargs.get("Anaction", 110),
            kwargs.get("Group_BJ", 130),
            kwargs.get("Group", 140),
            kwargs.get("Facial", 160),
        ]
        thresholds = []
        prev = 0
        for t in raw_phase_thresh:
            t = max(t, prev + 1)
            thresholds.append(t)
            prev = t

        phase = 11
        for i, t in enumerate(thresholds):
            if wrapped_index <= t:
                phase = i + 1
                break

        # --- Skip disabled phases -----------------------------------
        # Unchecking a phase's *_enabled checkbox doesn't shrink the
        # threshold range - it just makes any index that would have
        # landed inside that phase cascade forward to the next enabled
        # phase's lower bound instead (see PHASE_ORDER).
        phase_enabled = [kwargs.get(f"{name}_enabled", True) for name in PHASE_ORDER]
        if not phase_enabled[phase - 1]:
            for i in range(phase, len(thresholds)):
                if phase_enabled[i]:
                    phase = i + 1
                    wrapped_index = thresholds[i - 1] + 1 if i > 0 else 1
                    break
            # If every remaining phase is disabled too, there's nowhere left
            # to jump - fall back to the originally computed (disabled)
            # phase rather than erroring out.

        kwargs, random_character = resolve_random_character(slot, kwargs)

        warnings = []
        out_model, out_clip = cls._apply_loras(model, clip, slot, kwargs, phase, warnings)

        # --- LoRA trigger words: gathered once per combo/phase (same
        # enable+phase gate as the LoRA stack itself, see
        # _active_lora_triggers), then folded into Prompt at whichever
        # point each row's lora_trigger_point_{slot}_{l} combo selects -
        # background/character/outfit/pose/action splice into their
        # respective _build_line* call below, overall splices onto the
        # fully assembled `prompt` near the end of this method.
        lora_triggers = cls._active_lora_triggers(slot, kwargs, phase, warnings)
        trigger_background = ", ".join(lora_triggers["background"])
        trigger_character = ", ".join(lora_triggers["character"])
        trigger_outfit = ", ".join(lora_triggers["outfit"])
        trigger_pose = ", ".join(lora_triggers["pose"])
        trigger_action = ", ".join(lora_triggers["action"])
        trigger_overall = ", ".join(lora_triggers["overall"])

        raw_clo = [
            kwargs.get("lift_clothes_panties", 35),
            kwargs.get("lift_clothes_no_panties", 90),
            kwargs.get("completely_nude", 125),
        ]
        clo_thresh = []
        prev = 0
        for t in raw_clo:
            t = max(t, prev + 1)
            clo_thresh.append(t)
            prev = t

        p_clo = 4
        for i, t in enumerate(clo_thresh):
            if wrapped_index <= t:
                p_clo = i + 1
                break

        phase_key_map = {
            1: "Posing_path", 2: "Teasing_path", 3: "Groping_path",
            4: "Group_Groping_path", 5: "Cunni_path", 6: "BJ_path",
            7: "Action_path", 8: "Anaction_path", 9: "Group_BJ_path",
            10: "Group_path", 11: "BJ_path"
        }
        phase_path = kwargs.get(phase_key_map[phase], "")
        wildcards_path = kwargs.get("wildcards_path", "")

        base_paths = {k: kwargs.get(k, "") for k in [
            "Scene_path", "Composition_path", "Lighting_path",
            "Style_path", "Technical_details_path"
        ]}
        use_flags = {k: kwargs.get(k, True) for k in [
            "use_Scene", "use_Composition", "use_Lighting",
            "use_Style", "use_Technical_details"
        ]}
        # background_val <- Background Builder section (per combo): weighted
        # random keyword draw + optional location + fixed text. Computed
        # before line1 since use_Scene=False swaps it in as Scene's source
        # within _build_line1 - see that function.
        background_val = cls._build_background(
            fix=kwargs.get(f"bg_fix_{slot}", ""),
            random_text=kwargs.get(f"bg_random_text_{slot}", ""),
            how_many=kwargs.get(f"bg_how_many_{slot}", 1),
            location_type=kwargs.get(f"bg_location_type_{slot}", "indoors"),
            include_location=kwargs.get(f"bg_include_location_{slot}", True),
        )
        line1 = cls._build_line1(base_paths, use_flags, background_val, trigger_background, warnings)

        wild_text = cls._get_wildcards_text(wildcards_path, phase, warnings).strip()

        outfit_path = kwargs.get("Outfit_path", "")
        random_outfit = kwargs.get(f"random_outfit_{slot}", False)
        if random_outfit:
            if not outfit_path:
                warnings.append(f"Random Outfit enabled for slot {slot} but Outfit_path is not connected")
            picked_outfit = cls._read_random_line_no_repeat(outfit_path, warnings)
            clothes_source = f"Alternate costume, {picked_outfit}" if picked_outfit else ""
        else:
            clothes_source = kwargs.get(f"nl_clothing_{slot}" if kwargs.get("use_nl", False) else f"CHARACTER_CLOTHES_{slot}", "")

        combo_data = {
            "GIRL_FACE": kwargs.get(f"GIRL_FACE_{slot}", ""),
            "GIRL_NOFACE": kwargs.get(f"GIRL_NOFACE_{slot}", ""),
            "CHARACTER_CLOTHES": clothes_source,
            "teenager": kwargs.get(f"teenager_{slot}", False),
            "t_strength": kwargs.get(f"t_strength_{slot}", 1.0),
            "aged_up": kwargs.get(f"aged_up_{slot}", False),
            "a_strength": kwargs.get(f"a_strength_{slot}", 1.0),
            "slim": kwargs.get(f"slim_{slot}", False),
            "s_strength": kwargs.get(f"s_strength_{slot}", 1.0),
            "cleavage": kwargs.get(f"cleavage_{slot}", False),
            "c_strength": kwargs.get(f"c_strength_{slot}", 1.0),
        }
        checklist = kwargs.get("CLOTHES_LIFTING_CHECKLIST", "")
        nl_combo_data = dict(combo_data, GIRL_FACE="", GIRL_NOFACE=kwargs.get(f"nl_girl_description_{slot}", "")) if kwargs.get("use_nl", False) else combo_data
        alternate_rng = random.Random(); alternate_rng.setstate(random.getstate())
        line2 = cls._build_line2(nl_combo_data, p_clo, checklist, wild_text, trigger_outfit, warnings, nl_settings=kwargs if kwargs.get("use_nl", False) else None)
        alternate_nl = not kwargs.get("use_nl", False)
        alternate_clothing = clothes_source if random_outfit else kwargs.get(f"nl_clothing_{slot}" if alternate_nl else f"CHARACTER_CLOTHES_{slot}", "")
        alternate_combo = dict(combo_data, CHARACTER_CLOTHES=alternate_clothing)
        if alternate_nl: alternate_combo.update(GIRL_FACE="", GIRL_NOFACE=kwargs.get(f"nl_girl_description_{slot}", ""))
        line2_bis = cls._build_line2(alternate_combo, p_clo, checklist, wild_text, trigger_outfit, None, nl_settings=kwargs if alternate_nl else None, rng=alternate_rng)
        # character-point LoRA trigger words go just before the girl
        # description line, comma separated with the rest.
        if trigger_character:
            line2 = ", ".join(x for x in [trigger_character, line2] if x)
            line2_bis = ", ".join(x for x in [trigger_character, line2_bis] if x)

        line3, phase_line = cls._build_line3(phase, phase_path, trigger_pose, trigger_action, warnings)

        male_line = ""

        if "CHAR_MALE_4" in phase_line:
            male_count = 4
            count_word = "four"
        elif "CHAR_MALE_3" in phase_line:
            male_count = 3
            count_word = "three"
        elif "CHAR_MALE_2" in phase_line:
            male_count = 2
            count_word = "two"
        elif "CHAR_MALE_1" in phase_line:
            male_count = 1
            count_word = "one"
        else:
            male_count = 0
            count_word = None

        if male_count > 0:
            male_pairs = []
            for i in range(1, male_count + 1):
                name = kwargs.get(f"MALE_NAME_{i}", "").strip()
                desc = kwargs.get(f"MALE_DESCRIPTION_{i}", "").strip()
                if name or desc:
                    pair = f"{name}, {desc}" if name and desc else (name or desc)
                    male_pairs.append(pair)

            male_pairs_str = ". ".join(male_pairs) if male_pairs else ""
            if male_pairs_str and not male_pairs_str.endswith('.'):
                male_pairs_str += '.'

            # === INTERCEPT AND ENRICH MALE_LINE BASED ON PHASE ===
            if male_count == 1:
                base_prefix = "There is one woman and one man."
            else:
                base_prefix = f"There is one woman and {count_word} men."

            if phase in (3, 4):
                enhanced_prefix = base_prefix.replace(
                    "There is one woman and one man.",
                    "There is one woman and one man engaged in sexual relations."
                ).replace(
                    "There is one woman and two men.",
                    "There is one woman and two men engaged in sexual relations."
                ).replace(
                    "There is one woman and three men.",
                    "There is one woman and three men engaged in sexual relations."
                ).replace(
                    "There is one woman and four men.",
                    "There is one woman and four men engaged in sexual relations."
                )
            elif phase == 5:
                enhanced_prefix = base_prefix.replace(
                    "There is one woman and one man.",
                    "There is one woman and one man engaged in sexual relations, (cunnilingus:3)."
                ).replace(
                    "There is one woman and two men.",
                    "There is one woman and two men engaged in sexual relations, (cunnilingus:3)."
                ).replace(
                    "There is one woman and three men.",
                    "There is one woman and three men engaged in sexual relations, (cunnilingus:3)."
                ).replace(
                    "There is one woman and four men.",
                    "There is one woman and four men engaged in sexual relations, (cunnilingus:3)."
                )
            elif phase in (6, 11):
                enhanced_prefix = base_prefix.replace(
                    "There is one woman and one man.",
                    "There is one woman and one man engaged in sexual relations, (fellatio:3), (oral:3), (blowjob:3)."
                ).replace(
                    "There is one woman and two men.",
                    "There is one woman and two men engaged in sexual relations, (fellatio:3), (oral:3), (blowjob:3)."
                ).replace(
                    "There is one woman and three men.",
                    "There is one woman and three men engaged in sexual relations, (fellatio:3), (oral:3), (blowjob:3)."
                ).replace(
                    "There is one woman and four men.",
                    "There is one woman and four men engaged in sexual relations, (fellatio:3), (oral:3), (blowjob:3)."
                )
            elif phase == 7:
                enhanced_prefix = base_prefix.replace(
                    "There is one woman and one man.",
                    "There is one woman and one man engaged in sexual relations, (hardcore sex:3), (vaginal penetration:3)."
                ).replace(
                    "There is one woman and two men.",
                    "There is one woman and two men engaged in sexual relations, (hardcore sex:3), (vaginal penetration:3)."
                ).replace(
                    "There is one woman and three men.",
                    "There is one woman and three men engaged in sexual relations, (hardcore sex:3), (vaginal penetration:3)."
                ).replace(
                    "There is one woman and four men.",
                    "There is one woman and four men engaged in sexual relations, (hardcore sex:3), (vaginal penetration:3)."
                )
            elif phase == 8:
                enhanced_prefix = base_prefix.replace(
                    "There is one woman and one man.",
                    "There is one woman and one man engaged in sexual relations, (hardcore sex:3), (anal penetration:3)."
                ).replace(
                    "There is one woman and two men.",
                    "There is one woman and two men engaged in sexual relations, (hardcore sex:3), (anal penetration:3)."
                ).replace(
                    "There is one woman and three men.",
                    "There is one woman and three men engaged in sexual relations, (hardcore sex:3), (anal penetration:3)."
                ).replace(
                    "There is one woman and four men.",
                    "There is one woman and four men engaged in sexual relations, (hardcore sex:3), (anal penetration:3)."
                )
            elif phase == 9:
                enhanced_prefix = base_prefix.replace(
                    "There is one woman and one man.",
                    "There is one woman and one man engaged in sexual relations, (hardcore sex:3), (vaginal penetration:3)."
                ).replace(
                    "There is one woman and two men.",
                    "There is one woman and two men engaged in sexual relations, (blowgang:3), (oral:3), (fellatio:3), (blowjob:3)."
                ).replace(
                    "There is one woman and three men.",
                    "There is one woman and three men engaged in sexual relations, (blowgang:3), (oral:3), (fellatio:3), (blowjob:3)."
                ).replace(
                    "There is one woman and four men.",
                    "There is one woman and four men engaged in sexual relations, (blowgang:3), (oral:3), (fellatio:3), (blowjob:3)."
                )
            elif phase == 10:
                enhanced_prefix = base_prefix.replace(
                    "There is one woman and one man.",
                    "There is one woman and one man engaged in sexual relations, (hardcore sex:3), (double penetration:3)."
                ).replace(
                    "There is one woman and two men.",
                    "There is one woman and two men engaged in sexual relations, (hardcore sex:3), (double penetration:3)."
                ).replace(
                    "There is one woman and three men.",
                    "There is one woman and three men engaged in sexual relations, (hardcore sex:3), (double penetration:3)."
                ).replace(
                    "There is one woman and four men.",
                    "There is one woman and four men engaged in sexual relations, (hardcore sex:3), (double penetration:3)."
                )
            else:
                enhanced_prefix = base_prefix

            if male_pairs_str:
                male_line = f"{enhanced_prefix} {male_pairs_str}"
            else:
                male_line = enhanced_prefix
        else:
            male_line = "There is one solo woman."

        qt_style = kwargs.get("qt_style", "anime")
        if qt_style == "anime":
            qt_plus_style = kwargs.get("QT+ Anime", "")
            qt_minus_style = kwargs.get("QT- Anime", "")
        elif qt_style == "realism":
            qt_plus_style = kwargs.get("QT+ Realism", "")
            qt_minus_style = kwargs.get("QT- Realism", "")
        else:  # "none" — only QT+/QT- Common make it into line_qt
            qt_plus_style = ""
            qt_minus_style = ""
        qt_plus_common = kwargs.get("QT+ Common", "")
        qt_minus_common = kwargs.get("QT- Common", "")
        qt_parts = [qt_plus_style, qt_plus_common, qt_minus_style, qt_minus_common]
        line_qt = ", ".join(p.strip() for p in qt_parts if p and p.strip())

        parts_map = {
            "line_QT": line_qt,
            "general": line1,
            "male": male_line,
            "female": line2,
            "act": line3,
        }
        default_order = ["line_QT", "general", "male", "female", "act"]
        order_str = kwargs.get("prompt_order", ",".join(default_order))
        order_keys = [k.strip() for k in order_str.split(",") if k.strip()]

        prompt_parts = []
        prompt_parts_bis = []
        seen = set()
        for key in order_keys:
            if key in parts_map and key not in seen:
                seen.add(key)
                if parts_map[key] or (key == "female" and line2_bis):
                    prompt_parts.append(parts_map[key])
                    prompt_parts_bis.append(line2_bis if key == "female" else parts_map[key])
        for key in default_order:
            if key not in seen and (parts_map[key] or (key == "female" and line2_bis)):
                prompt_parts.append(parts_map[key])
                prompt_parts_bis.append(line2_bis if key == "female" else parts_map[key])
                seen.add(key)

        prompt = "\n".join(p for p in prompt_parts if p)
        prompt_bis = "\n".join(p for p in prompt_parts_bis if p)

        phase_filename = os.path.basename(phase_path) if phase_path else ""
        prompt_before_replacements = prompt
        debug_str = f"Phase file: {phase_filename}\n\n** Prompt before replacements: **\n\n{prompt_before_replacements}"

        if warnings:
            debug_str += "\n\nWarnings:\n" + "\n".join(warnings)

        girl_face_clean = cls._strip_comment_markers(combo_data["GIRL_FACE"])
        girl_face_normalized = cls._normalize_tag_string(girl_face_clean)
        char_name = girl_face_normalized.split(',')[0].strip() if girl_face_normalized else "Girl"

        if random_character:
            debug_str += (
                f"\n\nRandom character: {random_character['name']} "
                f"(ID: {random_character['id']}, combo: {slot})"
            )

        suffix = kwargs.get(f"suffix_{slot}", "")
        suffix = suffix.strip()
        path_name = "Random" if kwargs.get(f"randomize_character_{slot}", False) else char_name
        background_name = "RandomLocation" if kwargs.get("use_Scene", True) else str(kwargs.get(f"bg_fix_{slot}", "")).split(",")[0].strip()
        background_name = " ".join(background_name.split())
        current_path = "_".join(part for part in (path_name, background_name, suffix) if part)

        if current_path:
            current_path = current_path.replace(" ", "_")
            current_path = current_path.replace("\\(", "(").replace("\\)", ")")

        if kwargs.get("is_test", False):
            current_path = kwargs.get("test_path", "")

        # Name the participants before resolving the existing name placeholders.
        prompt = re.sub(r"\bthere is a one single woman\b(?! named)",
                        "There is one single woman named CHAR_FEMALE", prompt, flags=re.I)
        prompt_bis = re.sub(r"\bthere is a one single woman\b(?! named)",
                        "There is one single woman named CHAR_FEMALE", prompt_bis, flags=re.I)
        prompt = re.sub(r"\bone woman\b(?! named)", "one woman named CHAR_FEMALE", prompt, flags=re.I)
        prompt_bis = re.sub(r"\bone woman\b(?! named)", "one woman named CHAR_FEMALE", prompt_bis, flags=re.I)
        for count, phrase in ((4, "four men"), (3, "three men"), (2, "two men"), (1, "one man")):
            names = [f"CHAR_MALE_{n}" for n in range(1, count + 1)]
            joined = names[0] if count == 1 else ", ".join(names[:-1]) + " and " + names[-1]
            prompt = re.sub(r"\b" + phrase + r"\b(?! named)", phrase + " named " + joined, prompt, flags=re.I)
            prompt_bis = re.sub(r"\b" + phrase + r"\b(?! named)", phrase + " named " + joined, prompt_bis, flags=re.I)

        prompt = prompt.replace("CHAR_FEMALE", char_name).replace("CHAR_NAME", char_name)
        prompt_bis = prompt_bis.replace("CHAR_FEMALE", char_name).replace("CHAR_NAME", char_name)

        for i in range(1, 5):
            male_name_i = kwargs.get(f"MALE_NAME_{i}", "")
            prompt = prompt.replace(f"CHAR_MALE_{i}", male_name_i)
            prompt_bis = prompt_bis.replace(f"CHAR_MALE_{i}", male_name_i)

        # overall-point LoRA trigger words: always the very first line of
        # the final Prompt - applied last so nothing above can end up ahead
        # of it.
        if trigger_overall:
            prompt = f"{trigger_overall}\n{prompt}" if prompt else trigger_overall
            prompt_bis = f"{trigger_overall}\n{prompt_bis}" if prompt_bis else trigger_overall

        girl_face_clean = cls._strip_comment_markers(combo_data["GIRL_FACE"])

        aging_tags = []
        if combo_data["teenager"]:
            strength = combo_data["t_strength"]
            aging_tags.append("teenager" if strength == 1.0 else f"(teenager:{strength:.2f})")
        if combo_data["aged_up"]:
            strength = combo_data["a_strength"]
            aging_tags.append("aged up" if strength == 1.0 else f"(aged up:{strength:.2f})")

        face_out = cls._build_face(
            girl_face=girl_face_clean,
            wild_text=wild_text,
            phase_line=phase_line,
            aging_tags=aging_tags
        )

        # NOTE: every documented V3 `ui=` example uses a typed helper
        # (ui.PreviewText, ui.SavedImages, etc.) - there's no documented
        # generic/custom-key UI mechanism for an arbitrary key like
        # "magik_nl_phase" (read by the JS phase banner via the "executed"
        # websocket event). Passing a raw dict here is UNVERIFIED - test the
        # phase banner after this lands.
        # Sentence boundaries should not retain a tag separator comma.
        prompt = re.sub(r",[ \t]*(?=\.(?!\d))", "", prompt)
        prompt_bis = re.sub(r",[ \t]*(?=\.(?!\d))", "", prompt_bis)
        prompt = re.sub(r"(?<=\.)[ \t]*,", lambda match: match.group(0)[:-1], prompt)
        prompt_bis = re.sub(r"(?<=\.)[ \t]*,", lambda match: match.group(0)[:-1], prompt_bis)

        return io.NodeOutput(
            prompt, current_path, char_name, face_out, debug_str, wrapped_index, out_model, out_clip, phase, prompt_bis,
            ui={
                "magik_nl_summary": [{
                    "checklist": build_checklist(kwargs, connected_inputs, slot, phase, p_clo, current_path, model, clip, cls._active_lora_stack(slot, kwargs, phase), json_node=False, warnings=warnings),
                    "slot": slot, "phase": phase, "index": index,
                    "character": char_name, "path": current_path,
                    "picture_id": execution_picture(char_name, random_character),
                    "random": bool(kwargs.get(f"randomize_character_{slot}", False)),
                    "locked": bool(kwargs.get(f"random_character_locked_{slot}", False)),
                    "test": bool(kwargs.get("is_test", False)),
                }],
                "magik_nl_phase": [str(phase)],
                "magik_nl_slot": [str(slot)],
                "magik_nl_random_character": [random_character] if random_character else [],
            },
        )
