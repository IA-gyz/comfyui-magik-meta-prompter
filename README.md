# Magik NL Meta Prompter

ComfyUI prompt-building nodes with a JavaScript interface, multiple character combos, phase progression, background generation, optional LoRA stacks, and WaifuDB character selection.

This README describes the **current compact-settings implementation, including the connected-input correction (v10)**. It replaces the older widget-based documentation. It is intended to let a human use the pack and an LLM understand, maintain, or extend it without guessing its contracts.

## Contents

1. [Scope and node variants](#1-scope-and-node-variants)
2. [Installation and first use](#2-installation-and-first-use)
3. [Architecture and source map](#3-architecture-and-source-map)
4. [Inputs and outputs](#4-inputs-and-outputs)
5. [Settings and persistence](#5-settings-and-persistence)
6. [Index, combo, phase, and clothing progression](#6-index-combo-phase-and-clothing-progression)
7. [Standard prompt construction](#7-standard-prompt-construction)
8. [JSON template construction](#8-json-template-construction)
9. [Character selection and randomization](#9-character-selection-and-randomization)
10. [Backgrounds and presets](#10-backgrounds-and-presets)
11. [LoRAs and trigger words](#11-loras-and-trigger-words)
12. [Paths and Test mode](#12-paths-and-test-mode)
13. [Frontend layout and execution feedback](#13-frontend-layout-and-execution-feedback)
14. [API usage](#14-api-usage)
15. [HTTP routes](#15-http-routes)
16. [Randomness, caches, and performance](#16-randomness-caches-and-performance)
17. [Troubleshooting and limitations](#17-troubleshooting-and-limitations)
18. [Maintenance instructions for LLMs](#18-maintenance-instructions-for-llms)
19. [Verification checklist](#19-verification-checklist)
20. [Complete settings reference](#20-complete-settings-reference)

## 1. Scope and node variants

| Variant | Registered node ID | Display name | Prompt source |
|---|---|---|---|
| Standard | `Magik.NLMetaPrompter` | Magik NL Meta Prompter | Assembled text sections; random lines from phase text files |
| JSON | `Magik.NLMetaPrompterJSON` | Magik NL Meta Prompter JSON | Raw text of a randomly selected `.json` template, with placeholder substitution |

Both nodes appear under `Magik/Tool/Prompt`. Each supports 2–8 active combo slots and up to 8 LoRA rows per combo. The frontend retains eight combo definitions; the active count controls which are visible and participate in index cycling.

These nodes build strings and optionally patch MODEL/CLIP. They do **not** sample images, advance an upstream batch index, encode conditioning, save output images, or create output directories. Connect their outputs to the corresponding downstream nodes.

The standard and JSON variants share many controls but are not interchangeable prompt formats. In particular, the JSON node has separate positive/negative QT outputs and does not guarantee that its final Prompt string is valid JSON.

## 2. Installation and first use

### Requirements

- A ComfyUI installation supporting `comfy_api.latest`, `ComfyExtension`, `io.ComfyNode`, and the V3 schema API.
- ComfyUI's existing `comfy`, `folder_paths`, `server`, and `aiohttp` modules; `typing_extensions` for pack registration.
- Browser JavaScript, module imports, and `ResizeObserver` support.
- The updated Magik WaifuDB backend and its SQLite database when using character search, filters, match counts, or unlocked random character selection.
- Accessible local text files or template directories for the path inputs you use. Paths resolve on the **ComfyUI server**, not on the browser's computer.

### Install

1. Put the pack directory in `ComfyUI/custom_nodes/`, or replace the files in the existing installed pack directory. Do not create a second nested copy of the pack.
2. Preserve the directory structure, especially `js/`, `settings_manifest.json`, and the settings helpers listed below.
3. Put the supplied `waifudb_update/magik_waifudb.py` replacement in the existing WaifuDB pack directory. Keep `character_db_modular.sqlite` beside that backend. The database does not belong in the prompt-node directory.
4. Restart ComfyUI and hard-refresh its browser page. On Firefox, use Ctrl+Shift+R.
5. Add a fresh standard or JSON node. Connect an integer source to `index` and the text/path sources you need.
6. Set the first combo's Face, No Face, Clothes, and Suffix fields. Keep Randomize off for a minimal manual test.
7. Queue a run and inspect Prompt, Current Path, CHAR_NAME, FACE, DEBUG, and the execution summary.

The custom-node folder can be named differently; relative imports and `WEB_DIRECTORY = "js"` provide asset registration.

### Breaking change from the old format

The old implementation exposed 774/789 backend inputs. The current implementation declares **27 inputs per node**: four primary inputs plus 23 text/path sockets. All other settings live inside one JSON string and frontend proxy objects.

Old workflows are not migrated. Recreate old node instances and reconnect their sockets. Invalid positional settings no longer abort the whole workflow: the frontend resets that node to defaults and shows a notice. Reconfigure before running. A saved old link layout should not be treated as a reliable current-node configuration.

The update archives preserve existing pack assets, but do not supply `danbooru_tags.js` where an installed pack uses that additional asset. Keep such existing assets.

## 3. Architecture and source map

| File | Responsibility |
|---|---|
| `__init__.py` | V3 extension registration; exports both classes and serves `js/` |
| `magik_nl_meta_prompter.py` | Standard schema, prompt assembly, phases, text sampling, LoRA application, background routes |
| `magik_nl_meta_prompter_json.py` | JSON schema, template selection/substitution, QT outputs, JSON-specific background routes |
| `magik_nl_settings.py` | Loads the settings manifest; validates JSON; merges connected values; serves LoRA filenames |
| `settings_manifest.json` | Backend settings definitions, defaults, bounds, options, and original forced-input metadata for both variants |
| `magik_nl_character_randomizer.py` | WaifuDB mapping, execution-time random selection, saved-identity locking |
| `js/magik_nl_settings_manifest.js` | Frontend copy of the settings definitions, exported as `SETTINGS_MANIFEST` |
| `js/magik_nl_settings.js` | Frontend values and virtual widget proxies; queue/workflow serialization; shared LoRA filename request |
| `js/magik_nl_meta_prompter.js` | Standard UI controller and extension hooks |
| `js/magik_nl_meta_prompter_json.js` | JSON UI controller and extension hooks |
| Both corresponding `.css` files | Variant layout, controls, previews, filters, and summary styling |
| `js/magik_nl_random_filters.js` | Shared filter controls, favorites snapshots, debounced match count |
| `js/magik_nl_search_panel.js` and `.css` | Character search/selection modal and database filter metadata |
| `presets/` | Runtime background preset files shared by the two variants |
| External `magik_waifudb.py` | SQLite character queries, random provider, match count and search routes |

### Execution flow

1. ComfyUI resolves `index`, optional MODEL/CLIP, `settings`, and connected text/path inputs.
2. `decode_settings(settings, variant, kwargs)` parses settings, overlays connected values, fills omitted defaults, and validates supplied values.
3. Python checks Test mode, computes active combo, effective phase, and clothing progression.
4. Randomize, when enabled for that combo, supplies Face/No Face identity for this run or reuses a locked snapshot.
5. Python applies the phase-active LoRA stack and collects trigger words.
6. The variant builds its Prompt, auxiliary strings, and output path.
7. `io.NodeOutput` returns outputs plus custom `ui` payloads.
8. The browser's `executed` handler updates highlighting, phase banner, last-character preview, and execution summary.

The frontend does not choose the execution-time combo from a connected input. Python is authoritative for that decision.

## 4. Inputs and outputs

### Primary inputs

| Name | Type | Meaning |
|---|---|---|
| `index` | INT, forced input | Execution index; default 0, clamped to at least 1 during execution |
| `settings` | STRING | JSON object encoded as a string; default `"{}"`; hidden by the frontend |
| `model` | MODEL, optional | Source model for the active LoRA stack |
| `clip` | CLIP, optional | Source CLIP for the active LoRA stack |

### The 23 text/path sockets

Names are case-sensitive, including spaces and punctuation in QT inputs.

| Input group | Exact names | Expected content |
|---|---|---|
| Environment | `Scene_path`, `Composition_path`, `Lighting_path`, `Style_path`, `Technical_details_path` | Server-local UTF-8 text-file paths |
| Phases | `Posing_path`, `Teasing_path`, `Groping_path`, `Group_Groping_path`, `Cunni_path`, `BJ_path`, `Action_path`, `Anaction_path`, `Group_BJ_path`, `Group_path` | Standard: text-file paths. JSON: directories containing `.json` templates |
| Auxiliary sources | `wildcards_path`, `Outfit_path` | Wildcard directory; outfit text-file path |
| Quality text | `QT+ Common`, `QT+ Anime`, `QT+ Realism`, `QT- Common`, `QT- Anime`, `QT- Realism` | Actual text, **not paths** |

These are declared forced-input STRING sockets with empty-string defaults. Connected values override identically named JSON values, even when the connected value is empty. Do not assume a JSON fallback survives an explicitly supplied empty input.

### Output order

Indices below are zero-based and are part of the API contract.

| Index | Standard output | JSON output |
|---:|---|---|
| 0 | Prompt — STRING | Prompt — STRING |
| 1 | Current Path — STRING | QT+ — STRING |
| 2 | CHAR_NAME — STRING | QT- — STRING |
| 3 | FACE — STRING | Current Path — STRING |
| 4 | DEBUG — STRING | CHAR_NAME — STRING |
| 5 | Wrapped Index — INT | FACE — STRING |
| 6 | model — MODEL | DEBUG — STRING |
| 7 | clip — CLIP | Wrapped Index — INT |
| 8 | Phase — INT | model — MODEL |
| 9 | — | clip — CLIP |
| 10 | — | Phase — INT |

`CHAR_NAME` is derived from the first comma-separated, cleaned Face tag; it falls back to `Girl` when Face is empty. It is not necessarily the database display name. `FACE` combines identity text with the node's wildcard/phase keyword extraction and enabled age-related additions. `DEBUG` contains the selected phase source/template and warnings; JSON DEBUG also includes QT text.

## 5. Settings and persistence

### Backend contract

`settings` must be a JSON **object encoded as a string**, not an object directly, array, scalar, or double-encoded JSON string. Keys are the setting names in section 20. The variant chooses its own manifest.

The decoder:

- Parses the JSON object.
- Overlays supplied execution kwargs, so connected inputs win.
- Rejects unknown keys.
- Fills omitted keys from the manifest.
- Checks string/boolean/number types. Booleans do not pass as numbers.
- Requires finite numeric values and actual integers for integer-default fields.
- Checks defined numeric minimum/maximum bounds.
- Checks listed choices except settings whose names begin with `lora_`; LoRA filename resolution and trigger-point fallback occur separately.

Nested random filters and snapshots are themselves **JSON strings inside the main object**. They are decoded by the randomization helper, not recursively by the top-level settings decoder.

### Frontend store

`node._magikSettings.proxies` is a `Map` of virtual widget-shaped objects. A proxy has `name`, `value`, `options.values`, and a `callback`. They are **not** registered ComfyUI widgets and do not belong to `node.widgets`.

`node.ui.w(name)` resolves a settings proxy first, then a real widget. UI handlers use those proxies without changing the visible control design.

A setter schedules a microtask to flush all values into the real `settings` widget. `settingsWidget.serializeValue()` serializes current values directly so API queuing does not depend on waiting for that microtask.

### Save and reload

- The settings string is the execution payload and normal saved widget value.
- `onSerialize` also writes the named backup `o.magikSettings`.
- `onConfigure` prefers the named backup to positional widget data, loads the store, and synchronizes controls.
- The `master_ui` DOM widget has serialization disabled.
- Invalid JSON/non-object saved data resets that node's frontend values to defaults and shows a recovery notice; it does not migrate older fields.
- Backend execution remains strict: malformed API settings produce an error.

The preview's normalized identity snapshot and lock, filters, favorite ID list, collapsed combo states, visible LoRA row counts, and strength locks are part of settings and survive valid save/reload.

## 6. Index, combo, phase, and clothing progression

### Combo selection

The nodes do not increment `index` themselves. With `F = Facial` and `N = active_combos`:

```text
index = max(index, 1)
wrapped_index = ((index - 1) % F) + 1
combo = ((index - 1) // F) % N + 1
```

`F` falls back to 160 if non-positive; `N` is at least 2. Manifest limits constrain normal `active_combos` values to 2–8.

With the default `F=160`, combo 1 handles indices 1–160, combo 2 handles 161–320, then cycling continues. Changing the phase thresholds does not automatically replace `F` with a sum of ranges.

### Phases

Thresholds are inclusive upper bounds. Python coerces them into a strictly increasing sequence by ensuring each threshold is at least the previous threshold plus one.

| Phase | Internal name | Default upper threshold | Default index range | Source socket |
|---:|---|---:|---|---|
| 1 | Posing | 10 | 1–10 | `Posing_path` |
| 2 | Teasing | 20 | 11–20 | `Teasing_path` |
| 3 | Groping | 30 | 21–30 | `Groping_path` |
| 4 | Group_Groping | 40 | 31–40 | `Group_Groping_path` |
| 5 | Cunni | 50 | 41–50 | `Cunni_path` |
| 6 | BJ | 70 | 51–70 | `BJ_path` |
| 7 | Action | 90 | 71–90 | `Action_path` |
| 8 | Anaction | 110 | 91–110 | `Anaction_path` |
| 9 | Group_BJ | 130 | 111–130 | `Group_BJ_path` |
| 10 | Group | 140 | 131–140 | `Group_path` |
| 11 | Facial | 160 | 141–160 | `BJ_path` |

There is no separate `Facial_path` socket: phase 11 reuses `BJ_path`.

`<phase>_enabled` disables a phase's use, not its numeric range. An index landing in a disabled phase jumps to the next enabled phase and adjusts Wrapped Index to that phase's lower bound. If no later phase is enabled, the originally computed phase remains. Combo selection occurs before this adjustment.

### Clothing progression

The separate thresholds are `lift_clothes_panties=35`, `lift_clothes_no_panties=90`, and `completely_nude=125`. They are normalized into increasing bounds and evaluated against the effective Wrapped Index to select four clothing states.

The clothing helper returns ordinary clothes in state 1, reconstructs partial-clothing descriptions in states 2/3 using checklist matches and random brace choices, and uses its final-state description in state 4. `CLOTHES_LIFTING_CHECKLIST` is a comma-separated keyword list. These transformations still apply when character Randomize is on. JSON Random Outfit also passes its sampled outfit through this helper; it is not exempt from progression.

## 7. Standard prompt construction

The standard node builds five sections:

| Section ID | Source |
|---|---|
| `line_QT` | Selected style/common QT+ and QT- strings |
| `general` | Scene/Background plus enabled Composition, Lighting, Style, Technical details |
| `male` | Participant-count paragraph derived from the phase text and configured male names/descriptions |
| `female` | Face, No Face, identity modifiers, outfit/clothing state, and wildcard text |
| `act` | Selected phase line plus pose/action triggers |

`prompt_order` defaults to `line_QT,general,male,female,act`. Duplicate IDs are ignored; unknown IDs are ignored; omitted nonempty known sections are appended in default order. The drag-card frontend edits this string.

The chosen QT text is joined in this order: style positive, common positive, style negative, common negative. The standard node has no separate QT outputs; negative QT text is included in the assembled Prompt section.

`qt_style` is `anime`, `realism`, or `none`. `none` retains common QT text but omits style-specific text.

Standard replacement tokens include `CHAR_FEMALE` and `CHAR_NAME` for the active character, and `CHAR_MALE_1` through `CHAR_MALE_4` for configured male names. The phase text determines the participant count. Standard supports four male definitions; JSON supports twelve description placeholders.

`use_Scene=true` reads a line from Scene_path. `use_Scene=false` substitutes the active combo's Background Builder result; it does not simply remove the scene contribution. Other `use_*` switches gate their corresponding general-section files.

Text files are UTF-8, one candidate per nonempty line. Ordinary random draws may repeat. Blank lines are ignored. The comment cleanup helpers act on description content; do not assume every source file implements a full comment language.

### Wildcard filenames and description cleanup

`wildcards_path` is a directory. Both variants use the following fixed filenames:

| Phase numbers | Filename |
|---|---|
| 1–5, 7, 8, 10 | `face_fuck.txt` |
| 6 | `face_fuck_mouthful.txt` |
| 9 | `face_fuck_mouthful2.txt` |
| 11 | `face_fuck_mouthful3.txt` |

These are existing internal filenames, not configurable setting names. A missing wildcard file adds a warning and returns empty text. Standard incorporates wildcard text into its subject section; JSON uses it for FACE extraction only.

Description normalization converts line breaks into commas, removes empty comma-separated items, and joins the remaining tags with comma-space separators. The comment helper strips `//` through the end of a line where it is applied. It is not a universal tokenizer or full comment parser; URLs embedded in affected description fields can also be truncated by that rule.

## 8. JSON template construction

### Template directories

JSON phase sockets point to directories, not text files. A directory's immediate `.json` filenames are listed case-insensitively, then selected using a no-repeat shuffle bag. There is no recursive directory scan. File contents are read as UTF-8 raw text.

Substitution is literal string replacement, not a JSON serialization pipeline. Inserted descriptions are not JSON-escaped. The phase-1 prefix and overall trigger words can also appear outside the template. Feed Prompt to consumers accepting text unless you validate or repair it separately.

### Placeholders

| Token | Inserted value |
|---|---|
| `scene_p_holder` | Scene_path draw when use_Scene is on; active Background Builder result otherwise; background trigger words are appended here |
| `background_p_holder` | Active combo Background Builder result independently of use_Scene |
| `style_p_holder` | Style_path draw |
| `lighting_p_holder` | Lighting_path draw |
| `framing_p_holder` | Composition_path draw |
| `medium_p_holder` | `Anime`, `Photography`, or `Indeterminate`, from qt_style |
| `outfit_p_holder` | Progression-transformed manual clothes, or progression-transformed Outfit_path draw when Random Outfit is on |
| `ID_p_holder` | Subject description: Face/No Face and identity modifiers, without outfit/wildcard text |
| `name_p_holder` | CHAR_NAME |
| `MID1_p_holder` … `MID12_p_holder` | Matching MALE_DESCRIPTION verbatim, subject to the invisible-head rule |

Example phase-1 template source:

```json
{
  "medium": "medium_p_holder",
  "character": {"name": "name_p_holder", "description": "ID_p_holder"},
  "scene": "scene_p_holder",
  "outfit": "outfit_p_holder",
  "lighting": "lighting_p_holder"
}
```

For the invisible-head rule, Python attempts to parse the pristine template before replacement. A participant object whose `description` identifies `MIDn_p_holder` and whose nested `head` value contains `not visible` receives `a man` instead of its configured description. This lookup does not turn subsequent substitution into structured JSON editing.

JSON does not implement standard `CHAR_*` automatic name substitution, the standard male paragraph, or `prompt_order`. MALE_NAME fields are retained but not inserted by the MID placeholders.

Phase 1 prepends a fixed negative-weight tag line. Other phase-specific content comes from the template directory.

### Controls intentionally unused by JSON Prompt

The Composition/Lighting/Style/Technical `use_*` switches remain in the interface/settings, but JSON directly reads its style, lighting, and framing values regardless of those switches. `Technical_details_path` has no template placeholder. `use_Scene` remains meaningful. Wildcard text still feeds FACE extraction but is not appended to JSON Prompt.

QT+ and QT- are separate outputs. Each combines selected style text first, common text second; `none` emits only common text.

## 9. Character selection and randomization

### Manual search

Search Character opens the shared WaifuDB modal. Selected identity/body/outfit buckets are written to the active combo's Face, No Face, and Clothes proxies, then the UI synchronizes. Search and Clear are disabled while character Randomize is on. Character search can include database outfits; execution-time randomization intentionally does not replace user-controlled outfits.

### Randomize ON

- The button is immediately to the right of Search Character.
- Only the executing combo draws a character.
- Selection occurs in Python during execution, including API runs, not when the toggle is clicked.
- WaifuDB supplies a synchronous provider named `PromptServer.instance.magik_waifudb_random_character`.
- All matching database character rows participate in `ORDER BY RANDOM() LIMIT 1`; series membership uses EXISTS to avoid duplication bias.
- Independent runs can select the same character again. Character selection is not a shuffle bag.
- Missing provider, missing/outdated database, bad filter data, or no eligible character stops selection with an explicit error.

Identity/eyes map to `GIRL_FACE`; body/hair/other traits map to `GIRL_NOFACE`. Secondary hair color is included only when multicolored hair is indicated. Underscores are normalized, parentheses are escaped, and duplicate mapped tags are removed. Identity fallback is database tag, original input, then `Character <id>`.

Face, No Face, Teenager, Aged Up, Slim, and their weights are disabled in the UI. The three manual identity modifiers are also suppressed in the execution-time input copy.

**Clothes Description, Random Outfit, Cleavage, and its weight remain editable and apply.** Random Outfit can disable Clothes for its own mutually exclusive source rule. Suffix, Background, LoRAs, and global settings remain editable. Stored manual values are not overwritten by a draw.

### Preview, Lock, and Copy to Manual

The last selected name, ID, and thumbnail appear under the combo header. Missing thumbnails are hidden. Preview data becomes available after an executed event; clicking Randomize alone does not fill it.

Lock stores and reuses a normalized snapshot. A locked run does not query the random provider and can retain its identity despite later database edits. Invalid snapshots error explicitly. Unlock resumes fresh selection. Other randomness and clothing progression continue while identity is locked.

Copy to Manual copies Face/No Face only, turns Randomize and Lock off, and leaves outfit, cleavage, suffix, background, and LoRAs intact. The preview remains available.

An unlocked draw queued before Lock was pressed does not replace a snapshot locked since queueing.

### Random filters and match count

Filters combine with AND: pool, series, body trait (`breast_size`), eye color, hair color, and hairstyle. Hair color checks either hair slot; hairstyle checks all four slots.

| Pool value | UI label | Eligibility |
|---|---|---|
| `all` | All characters | Entire database, constrained by other filters |
| `favorites` | Favorites | Saved favorite IDs plus other filters |
| `my_waifus` | My Waifus | Saved super-favorite IDs plus other filters |

Favorites come from browser localStorage keys `waifudb_favorites` and `waifudb_super_favorites`. Choosing a pool snapshots string character IDs into workflow settings. Refresh favorites replaces that snapshot. API executions use saved IDs; they do not read browser localStorage.

Filter metadata loads when the panel opens. A shared promise/cache avoids separate metadata fetches for every combo; the cache lasts five minutes. Saved filter values remain visible even if the database no longer lists them.

The match count uses the same query builder as selection. Changes are debounced by 250 ms; stale replies are ignored. Empty favorite pools count as zero. Zero matches are highlighted; the count does not prevent all queuing and does not reserve a character. Execution rechecks eligibility. Refresh match count checks after database changes.

When a character is locked, the count describes the filter pool for future unlocked draws, not the locked snapshot. Changed filters take effect after Unlock.

### Serialized filter and snapshot examples

```json
{
  "randomize_character_1": true,
  "random_character_filters_1": "{\"pool\":\"favorites\",\"ids\":[\"17\",\"42\"],\"series\":\"Example series\"}"
}
```

A locked snapshot must include string `id`, string `name`, and a `fields` object with string `GIRL_FACE` and `GIRL_NOFACE` values. The helper may also include a Clothes field as metadata; it does not apply that field during random execution.

## 10. Backgrounds and presets

Each combo has fixed text, a random keyword pool, draw count, location type, and location inclusion flag. The result is location (if included), fixed text, then selected keywords joined by commas.

Random text uses comma-separated items. A trailing nonnegative integer is a weight, for example `rain 3, fog 1, sunshine 2`. Each selected keyword is removed from the remaining weighted pool, so a keyword does not repeat within one background draw. The pool restarts on another execution. Weight zero contributes no copies. A requested count larger than the available unique pool stops when the pool is exhausted.

Background presets store `fix`, `random_text`, `how_many`, `location_type`, and `include_location`. Both variants use the pack-local `presets/` directory, but register separate route prefixes to avoid route collisions. Save can report `exists` and request overwrite. Load copies a preset into the combo controls.

`use_Scene=true` makes Scene_path the scene source and greys out the frontend's fixed/random background fields. JSON can still use `background_p_holder` independently of that scene choice.

## 11. LoRAs and trigger words

Each combo has up to eight ordered rows. Add/Remove changes the visible count. Removing a row shifts later row values and their strength locks forward, then resets the vacated row.

A row's model patch is active only when enabled, active for the current phase, assigned a filename other than `None`, and not set to zero for both strengths. The phase mask is an eleven-element comma-separated string, using literal `1` for active phases. Too-short masks can fall back to active when indexing raises an error; malformed content is not a complete validated mask language.

The Model/CLIP lock is a frontend editing feature:

- Editing either strength while locked updates both.
- Re-locking copies Model strength into CLIP strength.
- Lock state persists.
- Standard defaults unlocked; JSON defaults locked.
- Backend applies the two saved strengths independently. An API payload can therefore contain unequal strengths even with the UI lock flag true.

LoRA filenames are fetched once through the shared settings module, using ComfyUI's LoRA listing. A failed request clears the shared promise for a later retry. Selected files resolve through `folder_paths` during execution.

If both MODEL and CLIP are absent, both outputs remain None. If the active stack is empty, source objects pass through without cloning. Otherwise sources are cloned and patches applied in row order. A missing/corrupt LoRA or patch failure is recorded in DEBUG warnings and skipped rather than aborting the entire run.

### Trigger insertion

Enabled, phase-active rows can insert trigger text even if no LoRA filename is selected. Trigger eligibility is independent of model-patch eligibility and nonzero strengths.

| Point | Standard insertion | JSON insertion |
|---|---|---|
| `background` | Scene/Background contribution | `scene_p_holder` value |
| `character` | Before subject description | Before ID placeholder value |
| `outfit` | Outfit description | Before outfit placeholder value |
| `pose` | Separate line before action section | Before the first `body` substring following a `pose` substring |
| `action` | Start of action text | Start of a matching literal `"action": "..."` value |
| `overall` | First line of final Prompt | First line of final Prompt, ahead of phase-1 prefix |

JSON pose/action insertion is textual, not a parsed-tree operation; missing insertion anchors create warnings and skip that trigger. Unknown trigger points fall back to background with a warning.

## 12. Paths and Test mode

In Gen mode, Current Path uses the active character name plus optional suffix. Randomize ON replaces the name component with `Random`, including locked random identities.

| Configuration | Current Path example |
|---|---|
| Manual Face begins with `Alice`; no suffix | `Alice` |
| Manual character plus `Summer Outfit` suffix | `Alice_Summer_Outfit` |
| Random identity, no suffix | `Random` |
| Random identity plus `Summer Outfit` suffix | `Random_Summer_Outfit` |
| Test mode, test_path `experiments/run-1` | `experiments/run-1` verbatim |

Spaces become underscores in Gen paths; escaped parentheses are unescaped. This is not comprehensive filesystem sanitization. Slashes or other path characters are not universally removed. Current Path is only a returned string; downstream consumers decide where/how to save.

Test mode checks `test_path` before normal generation. Empty or whitespace-only values raise an error. A nonempty test path is used verbatim rather than trimmed or normalized. Gen mode permits an empty test_path.

The frontend gives empty test_path a red background, has a required-path placeholder/tooltip, and no longer shows the standalone “Required in Test mode” text beside the field.

## 13. Frontend layout and execution feedback

The combo controls are grouped into Identity, Outfit, Background, and LoRA sections. Collapse hides the combo body while keeping the header and selected-character preview accessible. Collapse state does not change backend combo selection.

Node width starts at a minimum of **5000 canvas units** in the sizing code. A wider existing width is retained; this is not a promise of 5000 physical screen pixels at every zoom level. Height uses unscaled DOM layout measurements and ComfyUI layout sizing to include socket spacing. It can shrink after collapse. Repeated sizing measurements skip unchanged dimensions, and width no longer repeatedly expands by horizontal overflow.

ResizeObserver, font readiness, and workflow restoration trigger fitting. Offscreen/unmounted zero-height measurements retain the last size. Removal disconnects observers and event handlers and disposes the settings store. LoRA grids skip rebuilding when their visible count/values have not changed.

The execution area uses a 1:2 column split: the existing summary occupies the left third, and a styled “Checklist & information” placeholder occupies the right two thirds. The placeholder has no checklist logic or execution effects. The left summary uses two columns and retains all existing fields.

### Executed payload

Standard `ui` keys are `magik_nl_phase`, `magik_nl_slot`, `magik_nl_random_character`, and `magik_nl_summary`. JSON keys use the prefix `magik_nl_json_`. Each value is an array; frontend handlers read its first item.

Summary fields are `slot`, `phase`, `index`, `character`, `path`, `random`, `locked`, and `test`. The timestamp displayed is the browser's receipt time, not measured node execution duration.

Phase and active-combo highlighting use backend execution results. No combo is highlighted before a real execution reports one. Browser-local index guesses and polling must not be reintroduced. The summary is “Last execution,” not a guarantee that its values match current edits or that downstream image generation succeeded.

The current code passes a raw dictionary to `io.NodeOutput(ui=...)`. This path was tested with mocked interfaces, but its integration with all ComfyUI/frontend versions remains a live verification point. If outputs work but highlights/previews/summary do not update, inspect the actual executed payload.

## 14. API usage

Use the registered node ID as `class_type`. Input link arrays have ComfyUI's ordinary `[source_node_id, output_index]` format. The settings value is a JSON string.

Minimal API node fragment:

```json
{
  "10": {
    "class_type": "Magik.NLMetaPrompter",
    "inputs": {
      "index": 1,
      "settings": "{\"GIRL_FACE_1\":\"Alice, blue eyes\",\"GIRL_NOFACE_1\":\"brown hair\",\"CHARACTER_CLOTHES_1\":\"blue jacket\",\"suffix_1\":\"Portrait\"}",
      "QT+ Common": "soft natural light",
      "Scene_path": "/server/prompts/scenes.txt"
    }
  }
}
```

This is a node fragment, not a complete image-generation workflow. Add the remaining sockets as required by your ComfyUI validation/workflow and connect outputs downstream. It demonstrates data shape, not a standalone sampling pipeline.

Build JSON programmatically rather than hand-escaping large settings:

```python
import json
settings = {
    "GIRL_FACE_1": "Alice, blue eyes",
    "suffix_1": "Portrait",
    "randomize_character_1": False,
}
inputs = {
    "index": 1,
    "settings": json.dumps(settings),
    "Scene_path": "/server/prompts/scenes.txt",
    "QT+ Common": "soft natural light",
}
```

To randomize with filters:

```python
settings["randomize_character_1"] = True
settings["random_character_filters_1"] = json.dumps({
    "pool": "all", "eye_color": "blue_eyes"
})
inputs["settings"] = json.dumps(settings)
```

Filter values must match database values exactly; display labels can replace underscores visually without changing serialized values. No generation seed is supplied to these nodes: upstream sampler seeds do not seed their Python random/SQLite selection automatically.

## 15. HTTP routes

All routes are relative to the ComfyUI server. Prompt-pack routes are registered at module import; WaifuDB routes require the external backend.

| Method | Path | Function |
|---|---|---|
| GET | `/magik_nl_meta_prompter/lora_options` | LoRA filename array beginning with `None` |
| POST | `/magik_nl_meta_prompter/bg_save_preset` | Save standard background preset |
| GET | `/magik_nl_meta_prompter/bg_list_presets` | List standard/shared preset names |
| POST | `/magik_nl_meta_prompter/bg_load_preset` | Load standard preset |
| POST | `/magik_nl_meta_prompter_json/bg_save_preset` | Save JSON-node background preset |
| GET | `/magik_nl_meta_prompter_json/bg_list_presets` | List JSON/shared preset names |
| POST | `/magik_nl_meta_prompter_json/bg_load_preset` | Load JSON-node preset |
| GET | `/custom_character_search/filters` | Database series/trait filter metadata |
| POST | `/custom_character_search/random_count` | Matching eligible character count |
| GET | `/custom_character_search/series_chars` | Series character search |
| GET | `/custom_character_search/char_search` | Character-name search |
| GET | `/custom_character_search/trait_filter` | Combined trait search |
| POST | `/custom_character_search/char_update` | Update character data |
| GET | `/custom_character_search/thumbnail/{char_id}` | Character thumbnail |
| GET | `/custom_character_search/auto_25` | Backend's automatic character listing |

Preset save body: `preset_name`, optional `overwrite`, and the five preset fields. List returns `status` and `presets`; load body is `{ "preset_name": "name" }` and returns `status`/`data`. Save returns `success`, `exists`, or `error` status in its JSON.

Random-count POST body is the filter **object**, unlike the settings' nested filter string. Success is `{ "count": integer }`. Validation errors return 400; database/other failures return 503 with an `error` string. The count query runs through `asyncio.to_thread`.

Other search-route parameter and response details are defined by the external WaifuDB backend and shared search panel; do not infer them from their route names when changing those components.

## 16. Randomness, caches, and performance

`fingerprint_inputs` returns a fresh random token for each evaluation. ComfyUI should rerun prompt selection rather than returning a cached prompt. This does not imply that expensive LoRA loading/patching is repeated unnecessarily.

| Cache | Limit per variant module | Invalidated/keyed by |
|---|---:|---|
| Ordinary text-file LRU | 50 files | Path and file modification time |
| Outfit shuffle bags | 20 files | Path and file modification time |
| Loaded LoRA data LRU | 12 files | Filename/path modification time |
| Patched MODEL/CLIP LRU | 8 entries | Source object identity, ordered LoRA names/strengths/mtimes |
| JSON template shuffle bags | 20 directories, JSON node only | Directory modification time and filename pool |

Cache locks protect module-level state. Patched entries hold strong references to source MODEL/CLIP and verify identity with `is`, preventing false hits from recycled object IDs. Strong references also mean caches retain objects until eviction; limits are entry counts, not RAM/VRAM byte budgets. Cache sizes are separate for standard and JSON modules.

Ordinary text draws can repeat. Outfit and JSON template shuffle bags exhaust their candidate pools before refilling and avoid the previous last pick at the refill boundary when there is more than one candidate. Bags are shared by runs using the same path within the same variant module, not saved per workflow. Restarting ComfyUI resets them.

JSON template content is read on each selected-file execution. Directory mtime refreshes the filename pool; editing an existing file does not require a directory-list reset to pick up its new text.

The earlier Firefox profile identified repeated ComfyUI widget construction/layout as the major load bottleneck, before the custom frontend initialized. Compact settings remove those hundreds of real widgets. The restored 23 text/path inputs are genuine sockets, not a return to per-setting widgets. Real-world timing after installation must still be measured; isolated checks are not browser performance benchmarks.

## 17. Troubleshooting and limitations

| Symptom | Checks/action |
|---|---|
| Frontend unchanged after update | Verify files in the installed `js/` directory, including new helpers; avoid nested/duplicate pack directories; restart after Python changes; hard-refresh |
| `Compact settings input is missing` | Python and frontend versions disagree, or old node instance remains; install the full pack and recreate it |
| Recovery notice about invalid settings | Old positional/scalar/malformed settings were reset; reconfigure the node; use newly saved format afterward |
| Connected text/path seems ignored | Verify v10 Python/helpers are installed; check exact socket name and actual upstream string; connected empty strings intentionally override JSON |
| Missing phase content | Standard needs a text file; JSON needs a template directory; phase 11 uses BJ_path; inspect DEBUG warnings |
| JSON output rejected by a JSON parser | Prompt is raw substituted text with optional prefixes; it is not guaranteed valid JSON |
| Search cannot find Face/No Face fields | Shared search panel must use `_magikSettings` proxies/current helper, not only `node.widgets` |
| Randomize fails | Verify updated WaifuDB provider, database location/schema, filters, and eligible count; no silent manual fallback |
| Zero favorite matches | Refresh saved IDs; check remaining series/trait filters; IDs removed from the database do not count |
| Changed filters do not change identity | Unlock the character first |
| Outfit controls disabled while Randomize is on | Randomize must not disable them; Random Outfit may independently disable Clothes |
| Empty Test path error | Fill a non-whitespace test_path or switch to Gen |
| LoRA doesn't patch | Check enable flag, phase mask, filename, both strengths, connected MODEL/CLIP, and DEBUG |
| Trigger fires without a LoRA file | Intentional: trigger text uses enable+phase eligibility independently of model patching |
| Summary/highlight/preview not updating | Inspect executed event keys and arrays; check that the installed variant frontend matches its Python payload |
| Large node does not fit as expected | Test normal canvas zoom and current CSS; height uses unscaled layout units; inspect host/layout extensions |

### Current implementation boundaries

- There is no compatibility migration for the old hundreds-of-widget format.
- Frontend recovery validates the saved top-level object's shape, not every value. Python validates supplied values on execution.
- Random identity does not impose user-defined selection seeds, exclusion history, or no-repeat guarantees.
- Match counts can become stale between the request and execution; there is no database reservation.
- Strength-lock equality is not enforced on API-supplied values by Python.
- The JSON-specific unused switches and MALE_NAME settings remain part of the current surface.
- Background preset handlers build filenames directly from preset names without a comprehensive path-containment check. Do not describe those endpoints as hardened against untrusted names.
- Gen paths are not fully sanitized. Text substitutions do not escape JSON values.
- Missing text/LoRA sources generally add warnings and continue; invalid settings, required Test paths, invalid random selection, and broken locked snapshots are hard failures.
- Backend code comments retain some pre-refactor descriptions. Executable code and manifests take precedence over old comments.

## 18. Maintenance instructions for LLMs

### Preserve these contracts

1. Preserve the two registered IDs and exact output order unless a breaking change is explicitly requested.
2. Keep backend settings inside compact JSON. Do not recreate hundreds of ComfyUI widgets merely to support existing handlers.
3. Keep the 23 genuine text/path sockets and connected-value precedence. Never replace kwargs with decoded settings without merging execution-time inputs.
4. Keep the Python and JS manifests synchronized. `settings_manifest.json` and `js/magik_nl_settings_manifest.js` contain the same two variant definitions. Changing one without the other changes defaults/validation between frontend and backend.
5. Read/write settings through `node.ui.w(name)` or `_magikSettings.proxies`. `node.widgets.find(...)` alone is insufficient for virtual settings.
6. Keep `settingsWidget.serializeValue`, microtask flushing, named backup restoration, and `master_ui` serialization exclusion working together.
7. Keep execution-time random selection in Python. Do not select in the browser if API workflows must behave consistently.
8. Preserve Randomize's identity-only override. Outfit, Random Outfit, Cleavage, background, suffix, and LoRA controls must retain their independent behavior.
9. Keep one execution's Prompt/FACE/CHAR_NAME/path/preview metadata consistent with its one selected identity.
10. Drive active-combo/phase feedback from executed payloads, not browser-local guesses.
11. Keep auto-fit measurements in layout units and prevent resize feedback loops. Do not add overflow to width repeatedly.
12. Distinguish standard text phases from JSON template directories and keep their documented differences.

### Safe changes and integration examples

For an external panel reading Total-like cycle size, read the relevant settings proxies (`Facial`, `active_combos`) rather than searching raw widgets. For example:

```javascript
const facial = node.ui?.w("Facial")?.value;
const combos = node.ui?.w("active_combos")?.value;
const nominalCycleLength = Number(facial) * Number(combos);
```

This is a nominal full combo cycle, not the number of enabled phases or a guaranteed upstream batch limit.

To update a setting through the frontend:

```javascript
const field = node.ui?.w("suffix_1");
if (field) {
  field.value = "Portrait";
  field.callback?.(field.value);
  node.ui.sync();
}
```

When adding a setting: update both manifests, add its frontend control, use the proxy store, document its default/type/meaning, and read the resolved kwargs in execution. If it must accept a genuine upstream connection, explicitly define the socket rather than assuming a virtual setting can be converted into one automatically.

If adding HTTP routes, avoid collisions across the standard/JSON/external packs. If changing randomness, retain or explicitly revise fingerprint/cache behavior and API execution parity. If refactoring shared frontend code, retain distinct variant behavior instead of assuming the controllers are identical.

## 19. Verification checklist

A useful regression pass covers:

- Both schemas declare the expected 27 inputs; IDs and output indices are unchanged.
- Fresh frontend nodes use a settings store and do not register one real widget per setting.
- JSON defaults, booleans, integer/float limits, unknown keys, nested filter strings, and malformed payloads behave as documented.
- Connected QT strings and server-local paths override JSON, including intentionally empty values.
- Connected index selects the correct combo and execution reports that combo.
- MODEL/CLIP pass through unchanged for an empty stack; nonempty stack caches and failures behave correctly.
- Both variants queue current settings and restore them into a newly created node instance.
- Legacy/scalar saved data shows reset notice without aborting the whole workflow.
- Randomize leaves outfit/cleavage editable; locked runs use snapshots; Copy to Manual preserves independent values.
- Search writes settings proxies, not nonexistent widgets.
- Counts use the same eligibility query as random selection, including empty favorites and duplicate series memberships.
- Collapse, strength linking, LoRA row removal/shift, and filter snapshots survive save/reload.
- Resize notifications do not grow width repeatedly; collapsing can reduce height.
- A live browser recording verifies workflow-load timing; a live ComfyUI run verifies executed UI payloads and model patching.

Development checks already performed used isolated DOM harnesses, JavaScript module syntax checks, temporary SQLite fixtures, and mocked ComfyUI interfaces for both Python execution paths. These harnesses are not bundled as installed custom-node files. They do not substitute for live ComfyUI, real model/VRAM, or browser visual testing.

## 20. Complete settings reference

The following tables are generated from the current manifest. Pattern rows combine repeated settings without dropping their defaults or limits.

- `{i}` is combo 1–8.
- `{l}` is LoRA row 1–8 within a combo.
- `{n}` is participant number: 1–4 standard, 1–12 JSON.
- `—` means that setting is absent from that variant.
- Settings marked socket are also declared real connection inputs; see precedence in section 4.
- LoRA filename options are dynamic. The manifest's `None` entry is a placeholder, not the installed filename inventory.
- Metadata step is a manifest hint, not a guaranteed UI increment or backend divisibility requirement.

| Setting name/pattern | Standard | JSON |
|---|---|---|
| `Posing` | INT; default `10` | INT; default `10` |
| `Teasing` | INT; default `20` | INT; default `20` |
| `Groping` | INT; default `30` | INT; default `30` |
| `Group_Groping` | INT; default `40` | INT; default `40` |
| `Cunni` | INT; default `50` | INT; default `50` |
| `BJ` | INT; default `70` | INT; default `70` |
| `Action` | INT; default `90` | INT; default `90` |
| `Anaction` | INT; default `110` | INT; default `110` |
| `Group_BJ` | INT; default `130` | INT; default `130` |
| `Group` | INT; default `140` | INT; default `140` |
| `Facial` | INT; default `160` | INT; default `160` |
| `lift_clothes_panties` | INT; default `35` | INT; default `35` |
| `lift_clothes_no_panties` | INT; default `90` | INT; default `90` |
| `completely_nude` | INT; default `125` | INT; default `125` |
| `CLOTHES_LIFTING_CHECKLIST` | STRING; default `"pants, shorts, jeans, skirt, shirt, dress, jacket, blazer, bikini, swimsuit, uniform, outfit"` | STRING; default `"pants, shorts, jeans, skirt, shirt, dress, jacket, blazer, bikini, swimsuit, uniform, outfit"` |
| `Posing_enabled` | BOOL; default `true` | BOOL; default `true` |
| `Teasing_enabled` | BOOL; default `true` | BOOL; default `true` |
| `Groping_enabled` | BOOL; default `true` | BOOL; default `true` |
| `Group_Groping_enabled` | BOOL; default `true` | BOOL; default `true` |
| `Cunni_enabled` | BOOL; default `true` | BOOL; default `true` |
| `BJ_enabled` | BOOL; default `true` | BOOL; default `true` |
| `Action_enabled` | BOOL; default `true` | BOOL; default `true` |
| `Anaction_enabled` | BOOL; default `true` | BOOL; default `true` |
| `Group_BJ_enabled` | BOOL; default `true` | BOOL; default `true` |
| `Group_enabled` | BOOL; default `true` | BOOL; default `true` |
| `Facial_enabled` | BOOL; default `true` | BOOL; default `true` |
| `use_Scene` | BOOL; default `true` | BOOL; default `true` |
| `use_Composition` | BOOL; default `true` | BOOL; default `true` |
| `use_Lighting` | BOOL; default `true` | BOOL; default `true` |
| `use_Style` | BOOL; default `true` | BOOL; default `true` |
| `use_Technical_details` | BOOL; default `true` | BOOL; default `true` |
| `qt_style` | STRING; default `"anime"` | STRING; default `"anime"` |
| `is_test` | BOOL; default `false` | BOOL; default `false` |
| `test_path` | STRING; default `""` | STRING; default `""` |
| `prompt_order` | STRING; default `"line_QT,general,male,female,act"` | — |
| `active_combos` | INT; default `2`; range 2…8 | INT; default `2`; range 2…8 |
| `Scene_path` | STRING; default `""`; socket | STRING; default `""`; socket |
| `Composition_path` | STRING; default `""`; socket | STRING; default `""`; socket |
| `Lighting_path` | STRING; default `""`; socket | STRING; default `""`; socket |
| `Style_path` | STRING; default `""`; socket | STRING; default `""`; socket |
| `Technical_details_path` | STRING; default `""`; socket | STRING; default `""`; socket |
| `Posing_path` | STRING; default `""`; socket | STRING; default `""`; socket |
| `Teasing_path` | STRING; default `""`; socket | STRING; default `""`; socket |
| `Groping_path` | STRING; default `""`; socket | STRING; default `""`; socket |
| `Group_Groping_path` | STRING; default `""`; socket | STRING; default `""`; socket |
| `Cunni_path` | STRING; default `""`; socket | STRING; default `""`; socket |
| `BJ_path` | STRING; default `""`; socket | STRING; default `""`; socket |
| `Action_path` | STRING; default `""`; socket | STRING; default `""`; socket |
| `Anaction_path` | STRING; default `""`; socket | STRING; default `""`; socket |
| `Group_BJ_path` | STRING; default `""`; socket | STRING; default `""`; socket |
| `Group_path` | STRING; default `""`; socket | STRING; default `""`; socket |
| `wildcards_path` | STRING; default `""`; socket | STRING; default `""`; socket |
| `Outfit_path` | STRING; default `""`; socket | STRING; default `""`; socket |
| `QT+ Common` | STRING; default `""`; socket | STRING; default `""`; socket |
| `QT+ Anime` | STRING; default `""`; socket | STRING; default `""`; socket |
| `QT+ Realism` | STRING; default `""`; socket | STRING; default `""`; socket |
| `QT- Common` | STRING; default `""`; socket | STRING; default `""`; socket |
| `QT- Anime` | STRING; default `""`; socket | STRING; default `""`; socket |
| `QT- Realism` | STRING; default `""`; socket | STRING; default `""`; socket |
| `MALE_NAME_{n}` | STRING; default `1: "Alberto"; 2: "Benny"; 3: "Carl"; 4: "Didier"` | STRING; default `1: "Alberto"; 2: "Benny"; 3: "Carl"; 4: "Didier"; 5: "Emilio"; 6: "Franco"; 7: "Gustavo"; 8: "Hector"; 9: "Ivan"; 10: "Julian"; 11: "Klaus"; 12: "Leo"` |
| `MALE_DESCRIPTION_{n}` | STRING; default `1: "has grey hair, facial hair and is wearing a blue jacket and denim pants"; 2: "has black hair, wears glasses and he is wearing a grey shirt and brown pants"; 3: "has blonde hair, facial hair and is wearing a blue shirt and blue pants"; 4: "He's a dog"` | STRING; default `1: "has grey hair, facial hair and is wearing a blue jacket and denim pants"; 2: "has black hair, wears glasses and he is wearing a grey shirt and brown pants"; 3: "has blonde hair, facial hair and is wearing a blue shirt and blue pants"; 4: "He's a dog"; 5: "has dark brown hair, a mustache and is wearing a white shirt and khaki pants"; 6: "has red hair, no facial hair and is wearing a yellow shirt and grey pants"; 7: "has curly black hair, glasses and is wearing a brown jacket and denim pants"; 8: "has short brown hair, a goatee and is wearing a black shirt and dark jeans"; 9: "has blonde hair, no facial hair and is wearing a navy jacket and grey pants"; 10: "has long black hair, a beard and is wearing a red shirt and black pants"; 11: "has grey hair, glasses and is wearing a tweed jacket and brown pants"; 12: "has dark hair, light stubble and is wearing a denim jacket and black jeans"` |
| `suffix_{i}` | STRING; default `""` | STRING; default `""` |
| `GIRL_FACE_{i}` | STRING; default `""` | STRING; default `""` |
| `GIRL_NOFACE_{i}` | STRING; default `""` | STRING; default `""` |
| `CHARACTER_CLOTHES_{i}` | STRING; default `""` | STRING; default `""` |
| `random_outfit_{i}` | BOOL; default `false` | BOOL; default `false` |
| `teenager_{i}` | BOOL; default `false` | BOOL; default `false` |
| `t_strength_{i}` | FLOAT; default `1.0`; range -20.0…20.0; step 0.1 | FLOAT; default `1.0`; range -20.0…20.0; step 0.1 |
| `aged_up_{i}` | BOOL; default `false` | BOOL; default `false` |
| `a_strength_{i}` | FLOAT; default `1.0`; range -20.0…20.0; step 0.1 | FLOAT; default `1.0`; range -20.0…20.0; step 0.1 |
| `slim_{i}` | BOOL; default `false` | BOOL; default `false` |
| `s_strength_{i}` | FLOAT; default `1.0`; range -20.0…20.0; step 0.1 | FLOAT; default `1.0`; range -20.0…20.0; step 0.1 |
| `cleavage_{i}` | BOOL; default `false` | BOOL; default `false` |
| `c_strength_{i}` | FLOAT; default `1.0`; range -20.0…20.0; step 0.1 | FLOAT; default `1.0`; range -20.0…20.0; step 0.1 |
| `lora_visible_{i}` | INT; default `2`; range 0…8 | INT; default `2`; range 0…8 |
| `lora_{i}_{l}` | STRING; default `"None"`; choices ["None"] | STRING; default `"None"`; choices ["None"] |
| `lora_enable_{i}_{l}` | BOOL; default `false` | BOOL; default `false` |
| `lora_strength_model_{i}_{l}` | FLOAT; default `1.0`; range -100.0…100.0; step 0.01 | FLOAT; default `1.0`; range -100.0…100.0; step 0.1 |
| `lora_strength_clip_{i}_{l}` | FLOAT; default `1.0`; range -100.0…100.0; step 0.01 | FLOAT; default `1.0`; range -100.0…100.0; step 0.1 |
| `lora_phases_{i}_{l}` | STRING; default `"1,1,1,1,1,1,1,1,1,1,1"` | STRING; default `"1,1,1,1,1,1,1,1,1,1,1"` |
| `lora_trigger_word_{i}_{l}` | STRING; default `""` | STRING; default `""` |
| `lora_trigger_point_{i}_{l}` | STRING; default `"background"`; choices ["background", "character", "outfit", "pose", "action", "overall"] | STRING; default `"background"`; choices ["background", "character", "outfit", "pose", "action", "overall"] |
| `bg_fix_{i}` | STRING; default `""` | STRING; default `""` |
| `bg_random_text_{i}` | STRING; default `""` | STRING; default `""` |
| `bg_how_many_{i}` | INT; default `1`; range 1…50; step 1 | INT; default `1`; range 1…50; step 1 |
| `bg_location_type_{i}` | STRING; default `"indoors"`; choices ["indoors", "outdoors"] | STRING; default `"indoors"`; choices ["indoors", "outdoors"] |
| `bg_include_location_{i}` | BOOL; default `true` | BOOL; default `true` |
| `randomize_character_{i}` | BOOL; default `false` | BOOL; default `false` |
| `random_character_locked_{i}` | BOOL; default `false` | BOOL; default `false` |
| `random_character_data_{i}` | STRING; default `""` | STRING; default `""` |
| `random_character_filters_{i}` | STRING; default `"{}"` | STRING; default `"{}"` |
| `combo_collapsed_{i}` | BOOL; default `false` | BOOL; default `false` |
| `lora_strength_locked_{i}_{l}` | BOOL; default `false` | BOOL; default `true` |

### Settings groups and interpretation

| Group | Interpretation |
|---|---|
| Phase names and `<phase>_enabled` | Global inclusive progression thresholds and phase switches |
| Clothing thresholds and checklist | Global clothing progression and keyword matching |
| `use_*`, `qt_style`, `prompt_order` | Global source/QT choices; prompt_order is standard-only |
| `is_test`, `test_path` | Global output-path override and validation |
| `active_combos` | Number of combo slots participating in index cycling |
| Real path and QT input names | Execution inputs, also included in settings definitions for defaults and merging |
| `MALE_NAME_{n}`, `MALE_DESCRIPTION_{n}` | Participant text; JSON MID placeholders only use descriptions |
| `suffix_{i}` | Active combo's output path suffix |
| `GIRL_FACE_{i}`, `GIRL_NOFACE_{i}` | Manual identity/face and body/hair descriptions |
| `CHARACTER_CLOTHES_{i}` | Manual outfit text |
| `teenager`, `aged_up`, `slim`, `cleavage` families and strengths | Description modifiers, with identity-only disabling under Randomize |
| `random_outfit_{i}` | Choose Outfit_path rather than manual outfit |
| `bg_*_{i}` | Fixed/random background settings and location options |
| `lora_*_{i}_{l}` | Row file, enable, strengths, phases, trigger text/point, and strength-lock UI state |
| `lora_visible_{i}` | Number of visible LoRA rows, not a replacement for each row's enable flag |
| `randomize_character_{i}` | Enable execution-time database identity selection |
| `random_character_locked_{i}` | Reuse saved identity snapshot |
| `random_character_data_{i}` | Snapshot JSON string |
| `random_character_filters_{i}` | Filter JSON string |
| `combo_collapsed_{i}` | Frontend-only visibility state |

The manifests are authoritative for exact allowed setting names, not arbitrary nested Identity/Outfit objects. This implementation retains flat keys inside the compact JSON object.


### Parameter checklist (v12)

The right two-thirds of the execution panel contains seven status cards: mode and output path, character source, outfit, scene/background, connected text inputs, phase-active LoRAs and prompt sources. Green means ready, amber means attention or a recoverable empty source, red means blocking and muted means disabled or not yet resolved. Connected inputs are taken from Python execution after they override JSON settings. Source checks inspect files/directories without consuming random draws. JSON phase directories are checked for immediate `.json` files. Execution warnings are included in Prompt sources.

Before execution only mode and Test path can be evaluated reliably. Other cards wait for effective connected values and active combo/phase. Editing the frontend clears resolved statuses until another execution. The left summary continues to show the last run. Checks are not polled and do not add API calls during workflow loading. An execution which raises before returning its UI payload retains the previous checklist; normal ComfyUI errors remain authoritative. File availability is a snapshot, not a guarantee of readability or valid template contents.


### Background formatting and execution picture (v13)

Both variants join the Background Builder's location, fixed text and selected random elements on one line, separated by commas. Each line in Fix becomes a comma-separated element. Newlines in Random text also delimit candidates; weights and unique random draws retain their behavior.

Last execution now displays the executed character's WaifuDB picture using `/custom_character_search/thumbnail/{char_id}`. Random and locked identities use their actual selection ID. Manual identities use the new `magik_waifudb_character_picture` provider, matching the executed name exactly against normalized `danbooru_tag` or `original_input` in SQLite; underscores become spaces and escaped parentheses are restored. Missing or ambiguous names display a placeholder. ID zero is supported. The image preserves aspect ratio with `object-fit: contain`. No picture requests happen before execution. Picture failures do not stop generation. Install the bundled latest WaifuDB backend for manual picture lookup; retain the existing database and search-panel assets.


### Natural-language descriptions (v22)

Each combo has two side-by-side pairs: GIRL_NOFACE tags / `nl_girl_description_i`, and CHARACTER_CLOTHES tags / `nl_clothing_i`. The global `use_nl` toggle defaults OFF and sits before Realism/Anime/None. With NL ON, prompt identity uses the NL girl description instead of face/body tag descriptions; manual clothing uses NL clothing. The existing clothing-stage, modifier, wildcard and LoRA-trigger rules still apply. Random Outfit continues to override manual clothing. FACE and identity/path naming remain derived from the original face tags. The compact node retains its 23 connected text inputs; new descriptions are stored in the settings JSON.

Character search populates both tag and NL fields. Its export selector controls copied/preview text (Tags, Natural language or Both); it does not prevent populating the Meta Prompter's alternate fields. NL database sentences are exported as stored, without applying tag-only trait inclusion/large-breast overrides. Random selection snapshots include NL descriptions; random identity uses the selected NL girl description, while clothing remains independently configured. Older locked snapshots may have no NL sentence: unlock and redraw or search the character again.

The standalone WaifuDB node adds `character_nl` and `export_format` (`tags`, `nl`, `both`). Its search panel fills both texts and sets the selected export mode. The main output follows that mode; face_prompt continues to use tags. Index override reads both database fields. Missing NL columns/values are returned as empty strings; this update does not generate or modify database descriptions.

Install the complete Meta Prompter folder, the included WaifuDB Python backend and `search_panel.js` in its existing frontend folder. Keep the populated SQLite database and other WaifuDB files. Restart ComfyUI and hard-refresh Firefox.


### NL clothing progression (v25)

Use NL now renders clothing progression through a shared local sentence builder. Stage 1 returns the original clothing sentence. Stages 2/3 choose one garment matched in the current clothing text and expand the configured stage template. Stage 4 uses its own template. Garment mappings are newline-separated `garment=action`, e.g. `dress=lifted`, `pants=lowered`. Simple plural forms and common plural garments select is/are; unmatched text uses `clothing` / `is adjusted`. No LLM, extra model or network request is used. Existing thresholds and Random Outfit precedence remain. Tag mode retains its tag builder.

Global settings are `nl_garment_actions`, `nl_clothing_stage_2`, `nl_clothing_stage_3`, `nl_clothing_stage_4`. A collapsed NL clothing progression panel sits below Clothes Lifting Checklist. Placeholders: `{clothing}` (original sentence), `{garment}`, `{verb}` (agreement + action), `{action}`, `{agreement}`, `{exposure}`, `{underwear}`. Unknown placeholders remain literal. Empty templates deliberately omit that stage's clothing text. NL garment mappings operate independently of the tag lifting checklist.


### Alternate prompt output (v28)

Both variants append STRING `Prompt_bis` after Phase: standard output index 9, JSON output index 11. Existing output positions remain. `Prompt` follows Use NL; `Prompt_bis` renders the opposite description mode. Both use the same executed combo, character, phase, background, outfit draw, quality inputs, LoRAs and JSON template. The alternate clothing builder uses a private random generator; it does not consume extra global draws or advance file/template bags. FACE and Current Path remain unchanged.
