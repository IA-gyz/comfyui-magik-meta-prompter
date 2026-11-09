"""Compact frontend-owned settings; no legacy workflow migration."""
import json
import math
from pathlib import Path
from aiohttp import web
from server import PromptServer
import folder_paths
MANIFEST = json.loads(Path(__file__).with_name("settings_manifest.json").read_text())

def decode_settings(settings, variant, connected=None):
    try:
        values = json.loads(settings)
    except (TypeError, ValueError) as error:
        raise ValueError("Node settings must contain valid JSON") from error
    if not isinstance(values, dict):
        raise ValueError("Node settings must be a JSON object")
    values.update(connected or {})
    definitions = MANIFEST[variant]
    unknown = set(values) - set(definitions)
    if unknown:
        raise ValueError("Unknown node setting: " + next(iter(unknown)))
    result = {key: definition.get("default", "") for key, definition in definitions.items()}
    for key, value in values.items():
        default = result[key]
        valid = (isinstance(value, bool) if isinstance(default, bool)
            else isinstance(value, (int, float)) and not isinstance(value, bool) if isinstance(default, (int, float))
            else isinstance(value, str))
        if not valid:
            raise ValueError(f"Invalid value type for node setting {key}")
        if isinstance(default, (int, float)) and not isinstance(default, bool):
            if not math.isfinite(value):
                raise ValueError(f"Non-finite node setting {key}")
            if isinstance(default, int) and not isinstance(value, int):
                raise ValueError(f"Node setting {key} must be an integer")
            for limit, check in (("min", lambda a,b: a < b), ("max", lambda a,b: a > b)):
                if limit in definitions[key] and check(value, definitions[key][limit]):
                    raise ValueError(f"Node setting {key} is outside its allowed range")
        choices = definitions[key].get("options")
        if choices and not key.startswith("lora_") and value not in choices:
            raise ValueError(f"Invalid choice for node setting {key}")
        result[key] = value
    return result

@PromptServer.instance.routes.get("/magik_nl_meta_prompter/lora_options")
async def lora_options(request):
    return web.json_response(["None"] + [name for name in folder_paths.get_filename_list("loras") if name != "None"])


@PromptServer.instance.routes.post("/magik_nl_meta_prompter/path_exists")
async def path_exists(request):
    import asyncio
    import os
    data = await request.json()
    path = data.get("path", "") if isinstance(data, dict) else ""
    if not isinstance(path, str):
        return web.json_response({"error": "path must be text"}, status=400)
    resolved = path if os.path.isabs(path) else os.path.join(folder_paths.get_output_directory(), path)
    exists = await asyncio.to_thread(os.path.exists, resolved) if path else False
    return web.json_response({"exists": exists})
