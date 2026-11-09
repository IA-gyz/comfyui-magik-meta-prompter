# __init__.py
# Magik NL Meta Prompter - ComfyUI custom node pack

from typing_extensions import override
from comfy_api.latest import ComfyExtension, io

from .magik_nl_meta_prompter import MagikNLMetaPrompter
from .magik_nl_meta_prompter_json import MagikNLMetaPrompterJSON


class MagikNLMetaPrompterExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [MagikNLMetaPrompter, MagikNLMetaPrompterJSON]


async def comfy_entrypoint() -> MagikNLMetaPrompterExtension:
    return MagikNLMetaPrompterExtension()


# Serve the JavaScript / CSS assets from the 'js' subfolder
WEB_DIRECTORY = "js"
