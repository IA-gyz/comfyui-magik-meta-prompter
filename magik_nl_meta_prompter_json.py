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
# Folded in from the standalone MagikBackgroundBuilder node/pack. Presets
# are keyword lists (not character-specific), so one shared preset library
# is used across every combo's Background section on this node.
#
# Routes are deliberately at DIFFERENT paths than the standalone node's
# (/magik_nl_meta_prompter_json/bg_* here vs. /magik_background_builder/*
# there) - aiohttp doesn't allow two handlers on the same (method, path),
# so if the standalone node pack is still installed and loaded in the same
# ComfyUI instance, both can now register safely instead of one crashing
# ComfyUI at startup. The presets FOLDER is still shared on purpose,
# though: both files normally live side by side in the same custom_nodes
# directory, so os.path.dirname(__file__) resolves to the same place
# either way - a preset saved from one is readable from the other.
BG_PRESETS_DIR = os.path.join(os.path.dirname(__file__), "presets")
os.makedirs(BG_PRESETS_DIR, exist_ok=True)


@PromptServer.instance.routes.post('/magik_nl_meta_prompter_json/bg_save_preset')
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


@PromptServer.instance.routes.get('/magik_nl_meta_prompter_json/bg_list_presets')
async def magik_bg_list_presets(request):
    try:
        files = [os.path.splitext(f)[0] for f in os.listdir(BG_PRESETS_DIR) if f.endswith('.json')]
        files.sort()
        return web.json_response({"status": "success", "presets": files})
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)}, status=500)


@PromptServer.instance.routes.post('/magik_nl_meta_prompter_json/bg_load_preset')
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
# the file has been drawn once. Keyed by path, so every draw against the
# same Outfit_path shares one bag (relevant here since outfit_p_holder is
# drawn once per combo slot per run). LRU-capped like the other module
# caches above.
_OUTFIT_BAG_CACHE = OrderedDict()
_OUTFIT_BAG_LOCK = threading.Lock()
_MAX_OUTFIT_BAG_ENTRIES = 20


# Outfit-style "no-repeat" bag cache, but for whole JSON template FILES
# rather than lines within one file: dir path -> {mtime, all_files, bag,
# last}. See _pick_random_json_file(). Directory mtime (not file mtime,
# since there's no single file) is the invalidation signal - it's bumped
# by most filesystems whenever an entry is added/removed from the dir,
# which is exactly the "did the pool of choices change" question we need
# answered. Keyed by directory path so every phase folder gets its own
# independent bag, same LRU cap convention as every other cache above.
_JSON_FILE_BAG_CACHE = OrderedDict()
_JSON_FILE_BAG_LOCK = threading.Lock()
_MAX_JSON_FILE_BAG_ENTRIES = 20


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


class MagikNLMetaPrompterJSON(io.ComfyNode):
    # Clone of MagikNLMetaPrompter. Same widget surface (thresholds, combo
    # slots, LoRAs, wildcards, base/phase path inputs, QT tables, etc.) and
    # same phase/slot/clothes-threshold math, but 'Prompt' is built
    # completely differently:
    #
    #   - phase_paths (Posing_path, Teasing_path, ...) now point to a
    #     DIRECTORY of *.json template files instead of one multi-line text
    #     file. A random file is picked (no-repeat bag, see
    #     _pick_random_json_file) and its raw text becomes the Prompt
    #     template.
    #   - That template's placeholder tokens are substituted in place:
    #       scene_p_holder    <- use_Scene picks the source: ON -> random
    #                            line from Scene_path (the historical
    #                            behavior); OFF -> this combo's Background
    #                            Builder output (background_p_holder's
    #                            value - see below), and Scene_path isn't
    #                            even read in that case (no bag draw
    #                            consumed for a value that'd be discarded).
    #       style_p_holder    <- random line from Style_path
    #       lighting_p_holder <- random line from Lighting_path
    #       framing_p_holder  <- random line from Composition_path
    #       medium_p_holder   <- the Realism/Anime/None selector (qt_style):
    #                            "anime" -> "Anime", "realism" ->
    #                            "Photography", "none" -> "Indeterminate".
    #       outfit_p_holder   <- mutually exclusive on random_outfit_{i}:
    #                            ON  -> random line from Outfit_path
    #                                   (no-repeat); Outfit_path isn't even
    #                                   read when OFF.
    #                            OFF -> the clothes-lifting description
    #                                   (_build_clothes_desc's output -
    #                                   manual CHARACTER_CLOTHES text, or
    #                                   the p_clo 2/3 "partially undressed,
    #                                   breasts out/visible, <clothes>,
    #                                   <lift tags>, panties aside/no
    #                                   panties" reconstruction, or
    #                                   "completely nude" at p_clo 4).
    #                            Never both, never concatenated - this is
    #                            "the clothing item," see below.
    #       ID_p_holder       <- the girl description line (what
    #                            _build_line2 produces - GIRL_FACE/NOFACE +
    #                            aging/slim/cleavage tags ONLY, no clothes,
    #                            no wildcards), same subject-only computation
    #                            as the original node's "female" prompt part
    #                            minus the clothing/wildcards it used to
    #                            also carry.
    #       name_p_holder     <- CHAR_NAME output value (first comma-
    #                            separated tag of GIRL_FACE, comment-
    #                            stripped/normalized - same value the
    #                            CHAR_NAME output returns)
    #       background_p_holder <- Background Builder section (per combo,
    #                            folded in from the standalone
    #                            MagikBackgroundBuilder node): optional
    #                            location_type + fixed text + a weighted
    #                            random draw of how_many unique keywords
    #                            from random_text (see _build_background).
    #                            Always available at this token regardless
    #                            of use_Scene - it's also what scene_p_holder
    #                            swaps to when use_Scene is OFF (see above).
    #       MID{n}_p_holder   <- MALE_DESCRIPTION_{n} verbatim, n = 1..12,
    #                            UNLESS the picked template's own JSON marks
    #                            that man's head "not visible" (a "head"
    #                            field containing that phrase, case-
    #                            insensitive, anywhere in the object that
    #                            holds his "description": "MID{n}_p_holder"
    #                            - see _men_with_invisible_heads), in which
    #                            case it's the literal string "a man"
    #                            instead (MALE_NAME_{n} is not used by any
    #                            placeholder yet)
    #   - QT+ and QT- are now two separate STRING outputs (still driven by
    #     qt_style realism/anime/none + the six QT input tables), rather
    #     than being folded into the assembled Prompt text.
    #   - Phase 1 (Posing) is meant to stay non-explicit: after everything
    #     above, a fixed negative-weight tag line is prepended on its own
    #     line ahead of the rest of Prompt (see the `if phase == 1` check
    #     in process()).
    #
    # The old "general" line (Scene+Composition+Lighting+Style+Technical
    # joined into one sentence via the use_* toggles) and the "male"
    # paragraph (the phase-based "engaged in sexual relations..." enrichment
    # text, joining MALE_NAME_i + MALE_DESCRIPTION_i into a sentence) are
    # NOT part of Prompt anymore, and neither is the original automatic
    # CHAR_FEMALE/CHAR_MALE_i find-and-replace. name_p_holder and the 12
    # MID{n}_p_holder tokens above are the only name/description
    # substitution left, and they're explicit placeholders like the other
    # six, not an automatic replacement - MALE_DESCRIPTION_i content reaches
    # Prompt this way, but MALE_NAME_i still doesn't reach it at all.
    # The "Prompt Order" widget/drag-card UI has been
    # removed entirely (there's no assembly order left to control - Prompt
    # is a single JSON template with placeholders substituted in place).
    # random_outfit_{i} ("Random Outfit") is meaningful again, but scoped
    # differently than the original node: clothes_source (CHARACTER_CLOTHES
    # text) is still always what _build_clothes_desc computes from - the
    # toggle no longer changes what clothes_desc's CONTENT is - it changes
    # which of clothes_desc vs. Outfit_path's draw reaches outfit_p_holder
    # (mutually exclusive, see process()). Neither one feeds the subject
    # description (ID_p_holder) at all anymore - clothes/clothes-lifting is
    # "the clothing item," not part of the subject. Wildcards (wild_text)
    # aren't appended to Prompt anywhere either - they're still computed
    # and still feed FACE's keyword scan, just not Prompt.
    # use_Scene is meaningful too, but scoped differently than the old
    # "general" line ever was: it doesn't join Scene into a joint sentence
    # anymore - it picks scene_p_holder's source (Scene_path's draw when ON,
    # this combo's Background Builder output when OFF - see process()).
    # The other four use_* toggles (Composition/Lighting/Style/Technical)
    # and Technical_details_path are still intentionally left in place
    # (unused/dead) rather than removed, per design decision -
    # Technical_details_path in particular has no placeholder counterpart
    # in the list above and is simply unused by process().
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
            for name, definition in MANIFEST["magik_nl_meta_prompter_json"].items()
            if definition.get("force_input"))

        return io.Schema(
            node_id="Magik.NLMetaPrompterJSON",
            display_name="Magik NL Meta Prompter JSON",
            category="Magik/Tool/Prompt",
            inputs=inputs,
            # QT+ and QT- are inserted right after Prompt; everything else keeps
            # the same relative order/meaning as the original node.
            outputs=[
                io.String.Output("Prompt", display_name="Prompt"),
                io.String.Output("QT+", display_name="QT+"),
                io.String.Output("QT-", display_name="QT-"),
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
        reshuffled and refilled. Used for Outfit_path (outfit_p_holder):
        fingerprint_inputs is always-dirty (every run rerolls), so a plain
        random.choice() could easily repeat the same outfit back to back —
        the bag is what actually prevents that, across slots and across
        runs, not just within one process() call."""
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

    @classmethod
    def _pick_random_json_file(cls, dir_path: str, warnings: list = None):
        """Picks a random *.json file from dir_path and returns
        (filename, raw_text_content). Same no-repeat "shuffle bag" idea as
        _read_random_line_no_repeat above, but at the file level: draws are
        keyed per-directory, so every phase folder gets its own bag and a
        template can't come up again until every other file in that folder
        has been picked once. Directory mtime is the invalidation signal -
        it's bumped by most filesystems whenever an entry is added/removed,
        which is exactly the "did the pool of choices change" question we
        need answered here (we don't care about an existing file's content
        changing, only about the list of available files)."""
        if not dir_path:
            return "", ""
        if not os.path.isdir(dir_path):
            if warnings is not None:
                warnings.append(f"Missing phase directory: {dir_path}")
            return "", ""
        try:
            mtime = os.path.getmtime(dir_path)
            with _JSON_FILE_BAG_LOCK:
                entry = _JSON_FILE_BAG_CACHE.get(dir_path)
                if not entry or entry["mtime"] != mtime:
                    all_files = sorted(f for f in os.listdir(dir_path) if f.lower().endswith(".json"))
                    entry = {"mtime": mtime, "all_files": all_files, "bag": [], "last": None}
                    _JSON_FILE_BAG_CACHE[dir_path] = entry
                _JSON_FILE_BAG_CACHE.move_to_end(dir_path)
                while len(_JSON_FILE_BAG_CACHE) > _MAX_JSON_FILE_BAG_ENTRIES:
                    _JSON_FILE_BAG_CACHE.popitem(last=False)

                if not entry["all_files"]:
                    if warnings is not None:
                        warnings.append(f"No .json files found in: {dir_path}")
                    return "", ""

                if not entry["bag"]:
                    entry["bag"] = entry["all_files"].copy()
                    random.shuffle(entry["bag"])
                    # Don't let a fresh bag's first pick be the same file the
                    # previous (now-exhausted) bag ended on.
                    if entry["last"] is not None and len(entry["bag"]) > 1 and entry["bag"][-1] == entry["last"]:
                        entry["bag"][-1], entry["bag"][0] = entry["bag"][0], entry["bag"][-1]

                filename = entry["bag"].pop()
                entry["last"] = filename
        except Exception as e:
            if warnings is not None:
                warnings.append(f"Error listing {dir_path}: {e}")
            return "", ""

        full_path = os.path.join(dir_path, filename)
        try:
            with open(full_path, "r", encoding="utf-8") as f:
                content = f.read()
        except Exception as e:
            if warnings is not None:
                warnings.append(f"Error reading {full_path}: {e}")
            return filename, ""
        return filename, content

    @staticmethod
    def _object_has_invisible_head(node) -> bool:
        """Recursively searches `node` (a dict/list from a parsed JSON
        template, including everything nested inside it - e.g. a "pose"
        sub-object) for a "head" key whose string value contains the
        substring "not visible" (case-insensitive). Used by
        _men_with_invisible_heads below to decide MID{n}_p_holder's fallback
        - see that method for why this looks at the WHOLE object rather than
        just its own top-level keys (a man's "head" lives inside "pose",
        not as a sibling of "description")."""
        if isinstance(node, dict):
            for k, v in node.items():
                if isinstance(k, str) and k.strip().lower() == "head" \
                        and isinstance(v, str) and "not visible" in v.lower():
                    return True
            return any(MagikNLMetaPrompterJSON._object_has_invisible_head(v) for v in node.values())
        if isinstance(node, list):
            return any(MagikNLMetaPrompterJSON._object_has_invisible_head(item) for item in node)
        return False

    @staticmethod
    def _men_with_invisible_heads(template_text: str, warnings: list = None) -> set:
        """Parses template_text - the raw picked JSON template, BEFORE any
        scene/style/outfit/etc. token substitutions (those can inject
        arbitrary text into string values and would risk breaking JSON
        validity, so this reads the pristine file content instead) - and
        returns the set of man indices n for which the JSON object holding
        that man's "description": "MID{n}_p_holder" placeholder also
        contains a "head" field (anywhere inside that same object, e.g.
        nested under "pose", per _object_has_invisible_head above) whose
        value contains "not visible" (case-insensitive - matches "Not
        visible.", "NOT VISIBLE", etc.).

        MID{n}_p_holder falls back to the generic "a man" for every n in
        the returned set (see the substitution loop in process()), instead
        of MALE_DESCRIPTION_{n}.

        Returns an empty set - i.e. every man's description is used as
        normal - if the template isn't valid JSON, so a malformed/legacy
        template file degrades to the pre-existing behavior rather than
        erroring out the whole node."""
        try:
            parsed = json.loads(template_text)
        except (ValueError, TypeError) as e:
            if warnings is not None:
                warnings.append(f"Head-visibility check skipped: template isn't valid JSON ({e})")
            return set()

        invisible = set()

        def walk(node):
            if isinstance(node, dict):
                desc = node.get("description")
                if isinstance(desc, str):
                    m = re.search(r'MID(\d+)_p_holder', desc)
                    if m and MagikNLMetaPrompterJSON._object_has_invisible_head(node):
                        invisible.add(int(m.group(1)))
                for v in node.values():
                    walk(v)
            elif isinstance(node, list):
                for item in node:
                    walk(item)

        walk(parsed)
        return invisible

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
    def _build_line1(cls, paths: dict, use_flags: dict = None, warnings: list = None) -> str:
        parts = []
        use_flags = use_flags or {}
        for key in ["Scene_path", "Composition_path", "Lighting_path", "Style_path", "Technical_details_path"]:
            toggle_key = "use_" + key[:-len("_path")]
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

    @staticmethod
    def _resolve_braces(text: str, rng=None) -> str:
        # Picks a random "|"-separated option out of a "{a|b|c}" span.
        # Only ever called on our own hardcoded/templated lift_parts
        # strings below (never on clothes_norm/free-text), and per-part
        # rather than on one joined string, so one entry's braces can
        # never bleed into - or be corrupted by - a neighboring entry.
        return re.sub(r'\{([^}]+)\}', lambda m: (rng or random).choice(m.group(1).split('|')).strip(), text)

    @classmethod
    def _compute_lift_parts(cls, text_norm: str, checklist: str, rng=None) -> list:
        # Shared by every _build_clothes_desc call site - both the manual
        # CHARACTER_CLOTHES text and a line drawn from Outfit_path (see the
        # random_outfit branch of outfit_p_holder in execute()) go through
        # the same checklist-keyword-to-lift-phrase mapping here.
        lift_parts = []
        if checklist and text_norm:
            keywords = [k.strip() for k in checklist.split(',') if k.strip()]
            for kw in keywords:
                if re.search(r'\b' + re.escape(kw) + r'\b', text_norm, re.I):
                    # CLOTHES_LIFTING_CHECKLIST is a user-editable widget - if
                    # a keyword itself contained a stray "{" or "}" it would
                    # otherwise corrupt the "{a|b}" template we're about to
                    # build out of it, so strip those before interpolating.
                    safe_kw = kw.replace("{", "").replace("}", "")
                    if safe_kw.lower() == "pants":
                        lift_parts.append(cls._resolve_braces("{pants pull|open pants|downpants}", rng))
                    elif safe_kw.lower() == "shorts":
                        lift_parts.append(cls._resolve_braces("{Shorts aside|Shorts pull}", rng))
                    else:
                        lift_parts.append(cls._resolve_braces(f"{{{safe_kw} lift|{safe_kw} pull}}", rng))
        return lift_parts

    @classmethod
    def _build_clothes_desc(cls, clothes_raw: str, p_clo: int, checklist: str, rng=None) -> str:
        # Also reused as-is (see the random_outfit branch of outfit_p_holder
        # below) for a line drawn from Outfit_path - "clothes_raw" there is
        # the drawn line rather than manually-typed CHARACTER_CLOTHES text,
        # but the checklist scan/lift-phrase generation and the "partially
        # undressed, breasts out/visible, ..., panties aside/no panties"
        # reconstruction at p_clo 2/3 apply identically either way.
        rng = rng or random
        clothes_norm = cls._normalize_tag_string(clothes_raw)

        if p_clo == 4:
            return "completely nude"

        lift_parts = cls._compute_lift_parts(clothes_norm, checklist, rng)
        lift_resolved = ", ".join(lift_parts)

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
    def _build_background(cls, fix: str, random_text: str, how_many: int,
                           location_type: str, include_location: bool) -> str:
        # Ported from the standalone MagikBackgroundBuilder node's build().
        # random_text is a comma-separated pool where each token can end in
        # " N" (a repeat/weight count, e.g. "rain 3") to bias the odds of
        # that keyword being drawn without letting it be drawn more than
        # once overall - expand into a flat weighted list, then repeatedly
        # pick one at random and strike every remaining copy of it (not
        # just the one instance picked) before the next draw.
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
    def _build_line2(cls, combo_data: dict, warnings: list = None) -> str:
        # Subject description only: GIRL_FACE/GIRL_NOFACE(+slim) + aging/
        # cleavage tags. Clothes (with lift tags) and wildcards used to be
        # appended here too - clothes-lifting now belongs to the clothing
        # item (see _build_clothes_desc's call site in execute(), attached
        # to outfit_p_holder instead), and wildcards aren't appended to
        # the girl description at all anymore.
        girl_face = cls._strip_comment_markers(combo_data.get("GIRL_FACE", ""))
        girl_noface_raw = cls._strip_comment_markers(combo_data.get("GIRL_NOFACE", ""))

        girl_face = cls._normalize_tag_string(girl_face)
        girl_noface_raw = cls._normalize_tag_string(girl_noface_raw)

        if warnings is not None:
            # Only warn if the user actually inputted text, but it became empty after stripping
            if combo_data.get("GIRL_FACE", "").strip() and not girl_face:
                warnings.append("GIRL_FACE is empty after stripping/normalization")
            if combo_data.get("GIRL_NOFACE", "").strip() and not girl_noface_raw:
                warnings.append("GIRL_NOFACE is empty after stripping/normalization")

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

        elements = [girl_face, girl_noface]
        if desc_tags:
            elements.append(", ".join(desc_tags))

        result = ", ".join(e.strip() for e in elements if e.strip())
        if result and not result.endswith('.'):
            result += '.'
        return result

    @classmethod
    def _build_face(cls, girl_face: str, wild_text: str, scan_text: str,
                    aging_tags: list) -> str:
        # scan_text used to be the single line read from the old phase_path
        # text file; phase_path is now a JSON-template directory, so this
        # scans the final, fully-substituted Prompt text instead - the
        # keywords it's looking for are static template words, not
        # something introduced by the placeholder substitutions.
        combined_action = f"{scan_text} {wild_text}"
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
        kwargs = decode_settings(settings, "magik_nl_meta_prompter_json", kwargs)
        if kwargs.get("is_test", False) and not str(kwargs.get("test_path") or "").strip():
            raise ValueError("test_path is required in Test mode; enter a non-empty path or switch to Gen mode.")

        if index < 1:
            index = 1

        # --- CALCULATE PHASE THRESHOLDS FIRST ---
        # facial_val (used below for the index wraparound and slot cycling)
        # must come from the CORRECTED thresholds, not the raw "Facial"
        # widget value. If thresholds are ever set out of ascending order
        # (nothing enforces min/max on these widgets), the raw Facial value
        # can end up lower than an earlier phase's corrected threshold -
        # using it for the wraparound modulus would silently make every
        # phase above that value unreachable, even though thresholds below
        # still (correctly) shows them as existing.
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

        # Corrected, not raw - guaranteed >= every other threshold, and by
        # construction always >= 1 (prev starts at 0, each step advances by
        # at least 1), so the old "facial_val <= 0" fallback is no longer
        # reachable and has been removed.
        facial_val = thresholds[-1]
        wrapped_index = ((index - 1) % facial_val) + 1

        # CORRECTED SLOT CALCULATION
        active_combos = kwargs.get("active_combos", 2)
        if active_combos < 2:
            active_combos = 2
        slot = ((index - 1) // facial_val) % active_combos + 1

        phase = 11
        for i, t in enumerate(thresholds):
            if wrapped_index <= t:
                phase = i + 1
                break

        # --- Skip disabled phases ---------------------------------------
        # Unchecking a phase's "enabled" checkbox doesn't shrink its slice
        # of the 1..Facial index range - instead, whenever wrapped_index
        # lands inside a disabled phase, jump forward to the next enabled
        # phase's lower bound (its first index) and use that instead. This
        # cascades through any run of consecutive disabled phases.
        # Everything downstream (LoRA phase filtering, wildcard/template
        # selection, clothes-lift progress, and the returned Wrapped Index)
        # is computed from this adjusted phase/wrapped_index, so a disabled
        # phase is effectively invisible to the rest of the pipeline.
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
        # background/character/outfit splice into their p_holder's VALUE
        # below, pose/action/overall splice into the fully assembled
        # `prompt` string near the end of this method.
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
        phase_dir = kwargs.get(phase_key_map[phase], "")
        wildcards_path = kwargs.get("wildcards_path", "")

        # --- girl_description_line (== the original node's "female"/line2
        # part, subject-only now) - this is what ID_p_holder gets replaced
        # with below. wild_text is still computed here (still used by
        # _build_face's keyword scan further down) but no longer appended
        # to the subject description itself.
        wild_text = cls._get_wildcards_text(wildcards_path, phase, warnings).strip()

        # NOTE: Random Outfit no longer swaps the girl's clothes description
        # for a draw from Outfit_path - clothes_source is always the manual
        # CHARACTER_CLOTHES_{slot} text now, and it's the clothing item now
        # (see clothes_desc below), not part of the subject description.
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
        tag_girl_description_line = cls._build_line2(combo_data, warnings)
        nl_combo_data = dict(combo_data, GIRL_FACE="", GIRL_NOFACE=kwargs.get(f"nl_girl_description_{slot}", "")) if kwargs.get("use_nl", False) else combo_data
        girl_description_line = cls._build_line2(nl_combo_data, warnings)
        alternate_nl = not kwargs.get("use_nl", False)
        alternate_combo = dict(combo_data)
        if alternate_nl: alternate_combo.update(GIRL_FACE="", GIRL_NOFACE=kwargs.get(f"nl_girl_description_{slot}", ""))
        girl_description_bis = cls._build_line2(alternate_combo, None)

        # character-point LoRA trigger words go just before ID_p_holder's
        # value, comma separated with the rest.
        if trigger_character:
            girl_description_line = ", ".join(x for x in [trigger_character, girl_description_line] if x)
            tag_girl_description_line = ", ".join(x for x in [trigger_character, tag_girl_description_line] if x)
            girl_description_bis = ", ".join(x for x in [trigger_character, girl_description_bis] if x)

        # Clothes-lifting (the p_clo 2/3 "partially undressed, breasts out,
        # <clothes>, <lift tags>, panties aside" reconstruction, or plain
        # clothes text at p_clo 1, or "completely nude" at p_clo 4) belongs
        # to the clothing item - it feeds outfit_p_holder below, not the
        # subject description above. Whether it or Outfit_path's draw is
        # what actually reaches outfit_p_holder depends on random_outfit_i
        # - see that toggle below.
        clothes_raw = cls._normalize_tag_string(cls._strip_comment_markers(clothes_source))
        checklist = kwargs.get("CLOTHES_LIFTING_CHECKLIST", "")
        alternate_rng = random.Random(); alternate_rng.setstate(random.getstate())
        clothes_desc = build_nl_clothing(clothes_source, p_clo, kwargs) if kwargs.get("use_nl", False) else cls._build_clothes_desc(clothes_raw, p_clo, checklist)

        # --- Pick a random JSON template for the current phase and
        # substitute its placeholder tokens. Every occurrence of a given
        # placeholder gets the SAME single random draw (plain str.replace,
        # not a fresh draw per occurrence).
        json_filename, template_text = cls._pick_random_json_file(phase_dir, warnings)
        # Which men (by MID{n}_p_holder index) have "head": "not visible"
        # (or any value containing that phrase, case-insensitive) somewhere
        # in their own object in the picked template's JSON - see
        # _men_with_invisible_heads. Computed against the pristine
        # template_text, before scene/style/outfit/etc. substitutions below
        # can touch it.
        invisible_heads = cls._men_with_invisible_heads(template_text, warnings)

        # background_p_holder <- Background Builder section (per combo):
        # weighted random keyword draw + optional location + fixed text.
        # Computed before scene_val below since use_Scene=False swaps it in
        # as scene_val's source too - see that toggle immediately below.
        background_val = cls._build_background(
            fix=kwargs.get(f"bg_fix_{slot}", ""),
            random_text=kwargs.get(f"bg_random_text_{slot}", ""),
            how_many=kwargs.get(f"bg_how_many_{slot}", 1),
            location_type=kwargs.get(f"bg_location_type_{slot}", "indoors"),
            include_location=kwargs.get(f"bg_include_location_{slot}", True),
        )
        # scene_p_holder: use_Scene picks between Scene_path's draw (ON,
        # the historical behavior) and this combo's Background Builder
        # output (OFF) - same "don't even read the source that isn't
        # selected" pattern as random_outfit/Outfit_path below (Scene_path's
        # no-repeat bag isn't advanced for a value that would be discarded
        # anyway). background_p_holder (see below) still carries the same
        # value independently, so a template can use either token.
        use_scene = kwargs.get("use_Scene", True)
        if use_scene:
            scene_val = cls._read_random_line(kwargs.get("Scene_path", ""), warnings)
        else:
            scene_val = background_val
        # background-point LoRA trigger words go just after scene_p_holder's
        # value, comma separated.
        if trigger_background:
            scene_val = ", ".join(x for x in [scene_val, trigger_background] if x)
        style_val = cls._read_random_line(kwargs.get("Style_path", ""), warnings)
        lighting_val = cls._read_random_line(kwargs.get("Lighting_path", ""), warnings)
        framing_val = cls._read_random_line(kwargs.get("Composition_path", ""), warnings)
        # medium_p_holder <- the Realism/Anime/None selector (qt_style,
        # same widget that already picks QT+/QT- Anime vs Realism vs
        # neither below) mapped to a plain medium word.
        qt_style_for_medium = kwargs.get("qt_style", "anime")
        medium_val = {
            "anime": "Anime",
            "realism": "Photography",
        }.get(qt_style_for_medium, "Indeterminate")
        # outfit_p_holder: random_outfit_{slot} picks exactly one of the two
        # sources below - Outfit_path's draw and clothes_desc are mutually
        # exclusive, never concatenated, never both empty-checked against
        # each other. When OFF, Outfit_path isn't read at all (no bag draw
        # consumed, no missing-file warning for a path that isn't in use).
        # When ON, the drawn line goes through _build_clothes_desc (same
        # function as the manual path) so it gets the same p_clo/checklist
        # lift-and-reconstruct treatment: p_clo == 4 discards it for
        # "completely nude", p_clo 2/3 wraps it in "partially undressed,
        # breasts out/visible, <line>, <lift phrase>, panties aside/no
        # panties" with any checklist-matched lift phrase folded in.
        random_outfit = kwargs.get(f"random_outfit_{slot}", False)
        if random_outfit:
            outfit_random_val = cls._read_random_line_no_repeat(kwargs.get("Outfit_path", ""), warnings)
            outfit_val = build_nl_clothing(outfit_random_val, p_clo, kwargs) if kwargs.get("use_nl", False) else cls._build_clothes_desc(outfit_random_val, p_clo, checklist)
        else:
            if clothes_source.strip() and not clothes_raw:
                warnings.append("CHARACTER_CLOTHES is empty after stripping/normalization")
            outfit_val = clothes_desc
        alternate_source = outfit_random_val if random_outfit else kwargs.get(f"nl_clothing_{slot}" if alternate_nl else f"CHARACTER_CLOTHES_{slot}", "")
        outfit_bis = build_nl_clothing(alternate_source, p_clo, kwargs, chooser=alternate_rng.choice) if alternate_nl else cls._build_clothes_desc(cls._normalize_tag_string(cls._strip_comment_markers(alternate_source)), p_clo, checklist, alternate_rng)
        # outfit-point LoRA trigger words go just before outfit_p_holder's
        # value, comma separated with the rest.
        if trigger_outfit:
            outfit_val = ", ".join(x for x in [trigger_outfit, outfit_val] if x)
            outfit_bis = ", ".join(x for x in [trigger_outfit, outfit_bis] if x)

        girl_face_clean = cls._strip_comment_markers(combo_data["GIRL_FACE"])
        girl_face_normalized = cls._normalize_tag_string(girl_face_clean)
        char_name = girl_face_normalized.split(',')[0].strip() if girl_face_normalized else "Girl"

        def render_prompt(girl_description_line, outfit_val):
            prompt = template_text
            prompt = prompt.replace("scene_p_holder", scene_val)
            prompt = prompt.replace("style_p_holder", style_val)
            prompt = prompt.replace("lighting_p_holder", lighting_val)
            prompt = prompt.replace("framing_p_holder", framing_val)
            prompt = prompt.replace("medium_p_holder", medium_val)
            prompt = prompt.replace("outfit_p_holder", outfit_val)
            prompt = prompt.replace("background_p_holder", background_val)
            prompt = prompt.replace("ID_p_holder", girl_description_line)
            # MID{n}_p_holder <- MALE_DESCRIPTION_{n} verbatim (n = 1..12),
            # UNLESS n is in invisible_heads (this man's "head" was "not
            # visible" in the picked template's own JSON - see
            # _men_with_invisible_heads above), in which case the placeholder
            # gets the generic "a man" instead. MALE_NAME_{n} is intentionally
            # not used here yet.
            for n in range(1, 13):
                if n in invisible_heads:
                    male_val = "a man"
                else:
                    male_val = kwargs.get(f"MALE_DESCRIPTION_{n}", "")
                prompt = prompt.replace(f"MID{n}_p_holder", male_val)
            prompt = prompt.replace("name_p_holder", char_name)
            prompt = prompt.strip()

            # Phase 1 (Posing) is meant to stay non-explicit - prepend a fixed
            # negative-weight tag line, on its own line, ahead of everything else.
            if phase == 1:
                posing_negatives = "(nsfw:-1), (nude:-1), (naked:-1), (nipples:-1), (cleavage:-1), (explicitly sexual:-1), (explicit:-1), (revealing clothes:-1)"
                prompt = f"{posing_negatives}\n{prompt}" if prompt else posing_negatives

            # pose-point LoRA trigger words: dropped on their own line between
            # the picked template's first literal "pose" and the "body" that
            # follows it - both are searched as plain substrings in the fully
            # assembled Prompt text (the JSON template files aren't parsed,
            # just treated as raw text - see _pick_random_json_file), not as
            # actual JSON keys.
            if trigger_pose:
                idx_pose = prompt.find("pose")
                idx_body = prompt.find("body", idx_pose) if idx_pose != -1 else -1
                if idx_pose != -1 and idx_body != -1:
                    prompt = prompt[:idx_body] + trigger_pose + "\n" + prompt[idx_body:]
                else:
                    warnings.append(
                        "LoRA pose-trigger skipped: no \"pose\" ... \"body\" pair found in the picked template"
                    )

            # action-point LoRA trigger words: dropped at the very start of the
            # "action" key's string value, comma separated with whatever text
            # is already there.
            if trigger_action:
                m = re.search(r'"action"\s*:\s*"', prompt)
                if m:
                    insert_pos = m.end()
                    prompt = prompt[:insert_pos] + trigger_action + ", " + prompt[insert_pos:]
                else:
                    warnings.append(
                        'LoRA action-trigger skipped: no "action": "..." key found in the picked template'
                    )

            # overall-point LoRA trigger words: always the very first line of
            # the final Prompt - applied last so nothing above (including the
            # phase-1 posing negatives) can end up ahead of it.
            if trigger_overall:
                prompt = f"{trigger_overall}\n{prompt}" if prompt else trigger_overall

            return prompt

        prompt = render_prompt(girl_description_line, outfit_val)
        prompt_bis = render_prompt(girl_description_bis, outfit_bis)

        # --- QT+ / QT- (separate outputs now, same realism/anime/none +
        # QT-table logic as the original node's combined line_QT).
        qt_style = kwargs.get("qt_style", "anime")
        if qt_style == "anime":
            qt_plus_style = kwargs.get("QT+ Anime", "")
            qt_minus_style = kwargs.get("QT- Anime", "")
        elif qt_style == "realism":
            qt_plus_style = kwargs.get("QT+ Realism", "")
            qt_minus_style = kwargs.get("QT- Realism", "")
        else:  # "none" — only QT+/QT- Common make it into the outputs
            qt_plus_style = ""
            qt_minus_style = ""
        qt_plus_common = kwargs.get("QT+ Common", "")
        qt_minus_common = kwargs.get("QT- Common", "")
        qt_plus = ", ".join(p.strip() for p in [qt_plus_style, qt_plus_common] if p and p.strip())
        qt_minus = ", ".join(p.strip() for p in [qt_minus_style, qt_minus_common] if p and p.strip())

        debug_str = (
            f"Phase dir: {phase_dir}\n"
            f"Picked JSON: {json_filename}\n\n"
            f"** Template before replacements: **\n\n{template_text}\n\n"
            f"** QT+ **\n{qt_plus}\n\n"
            f"** QT- **\n{qt_minus}"
        )
        if warnings:
            debug_str += "\n\nWarnings:\n" + "\n".join(warnings)

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

        aging_tags = []
        if combo_data["teenager"]:
            strength = combo_data["t_strength"]
            aging_tags.append("teenager" if strength == 1.0 else f"(teenager:{strength:.2f})")
        if combo_data["aged_up"]:
            strength = combo_data["a_strength"]
            aging_tags.append("aged up" if strength == 1.0 else f"(aged up:{strength:.2f})")

        face_scan_prompt = prompt
        if kwargs.get("use_nl", False):
            if girl_description_line:
                face_scan_prompt = face_scan_prompt.replace(girl_description_line, tag_girl_description_line)
            if not random_outfit and outfit_val:
                tag_clothes = cls._build_clothes_desc(cls._normalize_tag_string(cls._strip_comment_markers(kwargs.get(f"CHARACTER_CLOTHES_{slot}", ""))), p_clo, checklist)
                if trigger_outfit: tag_clothes = ", ".join(x for x in [trigger_outfit, tag_clothes] if x)
                face_scan_prompt = face_scan_prompt.replace(outfit_val, tag_clothes)

        face_out = cls._build_face(
            girl_face=girl_face_clean,
            wild_text=wild_text,
            scan_text=face_scan_prompt,
            aging_tags=aging_tags
        )

        # NOTE: every documented V3 `ui=` example uses a typed helper
        # (ui.PreviewText, ui.SavedImages, etc.) - there's no documented
        # generic/custom-key UI mechanism for arbitrary keys like
        # "magik_nl_json_phase"/"magik_nl_json_slot" (read by the JS phase
        # banner + slot indicator via the "executed" websocket event).
        # Passing a raw dict here is UNVERIFIED - test the phase banner and
        # slot indicator after this lands.
        # Sentence boundaries should not retain a tag separator comma.
        prompt = re.sub(r",[ \t]*(?=\.(?!\d))", "", prompt)
        prompt = re.sub(r"(?<=\.)[ \t]*,", lambda match: match.group(0)[:-1], prompt)

        # Sentence boundaries should not retain a tag separator comma.
        prompt_bis = re.sub(r",[ \t]*(?=\.(?!\d))", "", prompt_bis)
        prompt_bis = re.sub(r"(?<=\.)[ \t]*,", lambda match: match.group(0)[:-1], prompt_bis)

        return io.NodeOutput(
            prompt, qt_plus, qt_minus, current_path, char_name, face_out, debug_str, wrapped_index, out_model, out_clip, phase, prompt_bis,
            ui={
                "magik_nl_json_summary": [{
                    "checklist": build_checklist(kwargs, connected_inputs, slot, phase, p_clo, current_path, model, clip, cls._active_lora_stack(slot, kwargs, phase), json_node=True, warnings=warnings),
                    "slot": slot, "phase": phase, "index": index,
                    "character": char_name, "path": current_path,
                    "picture_id": execution_picture(char_name, random_character),
                    "random": bool(kwargs.get(f"randomize_character_{slot}", False)),
                    "locked": bool(kwargs.get(f"random_character_locked_{slot}", False)),
                    "test": bool(kwargs.get("is_test", False)),
                }],
                "magik_nl_json_phase": [str(phase)],
                "magik_nl_json_slot": [str(slot)],
                "magik_nl_json_random_character": [random_character] if random_character else [],
            },
        )
