"""Local NL clothing progression: keyword mappings and safe literal templates."""
import random
import re

DEFAULT_ACTIONS = "dress=lifted\nshirt=lifted\nblouse=lifted\nskirt=lifted\npants=lowered\ntrousers=lowered\nshorts=pulled aside"
DEFAULT_STAGE_2 = "{clothing} Her {garment} {verb}, showing her breasts, and her panties are aside."
DEFAULT_STAGE_3 = "{clothing} Her {garment} {verb}, showing her breasts, and her panties are removed."
DEFAULT_STAGE_4 = "She is completely nude."
PLURAL_GARMENTS = {"pants", "trousers", "shorts", "jeans", "leggings", "tights", "stockings"}


def build_nl_clothing(clothing, stage, settings, chooser=random.choice):
    text = str(clothing or "").strip()
    if stage == 1:
        return text
    default = {2: DEFAULT_STAGE_2, 3: DEFAULT_STAGE_3, 4: DEFAULT_STAGE_4}[stage]
    template = settings.get(f"nl_clothing_stage_{stage}", default)
    candidates = []
    if stage != 4:
        for line in settings.get("nl_garment_actions", DEFAULT_ACTIONS).splitlines():
            key, separator, action = line.partition("=")
            key, action = key.strip().lower(), action.strip()
            if not separator or not key or not action:
                continue
            pattern = r"(?<!\w)" + re.escape(key) + (r"(?:es)?" if key.endswith(("ss", "ch", "sh", "x", "z")) else r"s?" if key not in PLURAL_GARMENTS and not key.endswith("s") else "") + r"(?!\w)"
            match = re.search(pattern, text, re.I)
            if match:
                garment = match.group(0).lower()
                candidates.append((garment, action))
    garment, action = chooser(candidates) if candidates else ("clothing", "adjusted")
    agreement = "are" if garment in PLURAL_GARMENTS or (garment.endswith("s") and garment != "dress") else "is"
    values = {
        "clothing": text.rstrip(". ") + "." if text else "",
        "garment": garment, "action": action, "verb": f"{agreement} {action}",
        "agreement": agreement, "exposure": "showing her breasts",
        "underwear": "her panties are aside" if stage == 2 else "her panties are removed" if stage == 3 else "",
    }
    result = re.sub(r"\{(clothing|garment|action|verb|agreement|exposure|underwear)\}", lambda m: values[m.group(1)], str(template))
    return " ".join(result.split()).strip()
