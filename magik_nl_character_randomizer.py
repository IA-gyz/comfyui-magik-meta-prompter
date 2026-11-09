"""Execution-time WaifuDB character selection shared by both prompt nodes."""

import json

from server import PromptServer

PROVIDER_ATTRIBUTE = "magik_waifudb_random_character"


def character_fields(character):
    """Map the standard WaifuDB record to the search panel's three buckets.

    Include every database field without applying the search modal's optional
    body-size override. Preserve the database's character parameters.
    """
    hair_text = " ".join(str(character.get(key) or "") for key in (
        "hairstyle_1", "hairstyle_2", "hairstyle_3", "hairstyle_4", "others"
    )).lower()
    multicolored = "multicolored hair" in hair_text or "multicolored_hair" in hair_text

    def clean(values):
        tags = []
        seen = set()
        for value in values:
            for tag in str(value or "").split(","):
                tag = tag.strip()
                if not tag:
                    continue
                tag = tag.replace("(", "\\(").replace(")", "\\)").replace("_", " ")
                if tag not in seen:
                    seen.add(tag)
                    tags.append(tag)
        return ", ".join(tags)

    # Some database entries have no Danbooru tag. Keep a usable identity first.
    identity = character.get("danbooru_tag") or character.get("original_input")
    if not identity or not str(identity).strip():
        identity = f"Character {character['char_id']}"
    return {
        "GIRL_FACE": clean([identity, character.get("eye_color")]),
        "GIRL_NOFACE": clean([
            character.get("breast_size"), character.get("hair_color_1"),
            character.get("hair_color_2") if multicolored else "",
            *(character.get(f"hairstyle_{i}") for i in range(1, 5)),
            character.get("others"),
        ]),
        "CHARACTER_CLOTHES": clean([
            character.get("common_outfits"), character.get("clothing_pieces"),
            character.get("clothing_accessories"),
        ]),
    }


def resolve_random_character(slot, kwargs):
    """Return a per-run input copy and selection metadata; never overwrite widgets."""
    if not kwargs.get(f"randomize_character_{slot}", False):
        return kwargs, None
    if kwargs.get(f"random_character_locked_{slot}", False):
        try:
            selection = json.loads(kwargs.get(f"random_character_data_{slot}", ""))
            fields = selection["fields"]
            if not isinstance(selection.get("id"), str) or not selection["id"]:
                raise ValueError("missing character ID")
            if not isinstance(selection.get("name"), str):
                raise ValueError("missing character name")
            if not isinstance(fields, dict) or not all(
                isinstance(fields.get(key), str) for key in ("GIRL_FACE", "GIRL_NOFACE")
            ):
                raise ValueError("missing character descriptions")
        except (ValueError, TypeError, KeyError, AttributeError) as exc:
            raise RuntimeError(
                f"Locked character for combo {slot} is invalid. Unlock and generate a new character."
            ) from exc
    else:
        provider = getattr(PromptServer.instance, PROVIDER_ATTRIBUTE, None)
        if not callable(provider):
            raise RuntimeError(
                "Randomize requires the updated Magik WaifuDB backend. "
                "Replace magik_waifudb.py in its existing folder and restart ComfyUI."
            )
        try:
            filters = json.loads(kwargs.get(f"random_character_filters_{slot}", "{}") or "{}")
            if not isinstance(filters, dict):
                raise ValueError("Random character filters must be an object")
            # Empty settings work with the original unfiltered provider too.
            character = provider(filters=filters) if filters else provider()
            if not isinstance(character, dict) or not character.get("char_id"):
                raise ValueError("WaifuDB returned no valid character")
            fields = character_fields(character)
            selection = {
                "id": str(character["char_id"]),
                "name": str(character.get("original_input") or character.get("danbooru_tag") or character["char_id"]),
                "fields": fields,
                "nl_girl_description": str(character.get("nl_girl_description") or ""),
                "nl_clothing": str(character.get("nl_clothing") or ""),
            }
        except Exception as exc:
            raise RuntimeError(f"Randomize failed for combo {slot}: {exc}") from exc

    resolved = dict(kwargs)
    for name in ("GIRL_FACE", "GIRL_NOFACE"):
        resolved[f"{name}_{slot}"] = fields[name]
    resolved[f"nl_girl_description_{slot}"] = str(selection.get("nl_girl_description") or "")
    # These manual overrides are disabled in the UI and must not affect this draw.
    for name in ("teenager", "aged_up", "slim"):
        resolved[f"{name}_{slot}"] = False
    return resolved, selection


def execution_picture(character_name, selection=None):
    """Get the executed character's image ID. Picture failures never stop a run."""
    if selection and selection.get("id"):
        return str(selection["id"])
    provider = getattr(PromptServer.instance, "magik_waifudb_character_picture", None)
    if callable(provider):
        try:
            return provider(character_name)
        except Exception:
            return None
    return None
