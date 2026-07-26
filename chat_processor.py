"""
chat_processor.py — 解析 Minecraft 聊天 JSON，提取玩家名和消息，
检测 ??command 并路由到 CommandManager。
"""

import json
import logging

from command_manager import CommandManager
from utils import get_username, get_command_prefix

logger = logging.getLogger("bot")


# ── JSON 聊天组件 → 纯文本 ──

def _extract_plain(component, include_hover: bool = True) -> str:
    """递归提取 Component 树中的纯文本
    include_hover=False 时跳过 hoverEvent/show_text 内的点击动作文本"""
    if isinstance(component, str):
        return component
    if isinstance(component, dict):
        parts = []
        if "text" in component:
            parts.append(str(component["text"]))
        if "translate" in component:
            # 处理 with 参数（翻译占位符的实际内容）
            with_items = component.get("with")
            if with_items:
                for w in with_items:
                    parts.append(_extract_plain(w, include_hover))
            else:
                # 无 with 时使用翻译键作为 fallback
                parts.append(f"[{component['translate']}]")
        if "extra" in component:
            for child in component["extra"]:
                parts.append(_extract_plain(child, include_hover))
        # 1.21+ 使用 content 格式
        if "content" in component:
            if isinstance(component["content"], dict):
                if "text" in component["content"]:
                    parts.insert(0, component["content"]["text"])
        # 处理 hoverEvent（仅在 include_hover=True 时）
        if include_hover and "hoverEvent" in component:
            hover = component["hoverEvent"]
            if isinstance(hover, dict) and "contents" in hover:
                parts.append(_extract_plain(hover["contents"], include_hover))
        return "".join(parts)
    if isinstance(component, list):
        return "".join(_extract_plain(c, include_hover) for c in component)
    return ""


# ── JSON 聊天组件 → ANSI 终端输出 ──

ANSI_COLORS = {
    "black":         "\033[30m",
    "dark_blue":     "\033[34m",
    "dark_green":    "\033[32m",
    "dark_aqua":     "\033[36m",
    "dark_red":      "\033[31m",
    "dark_purple":   "\033[35m",
    "gold":          "\033[33m",
    "gray":          "\033[37m",
    "dark_gray":     "\033[90m",
    "blue":          "\033[94m",
    "green":         "\033[92m",
    "aqua":          "\033[96m",
    "red":           "\033[91m",
    "light_purple":  "\033[95m",
    "yellow":        "\033[93m",
    "white":         "\033[97m",
}

RESET = "\033[0m"
BOLD = "\033[1m"
ITALIC = "\033[3m"
UNDERLINE = "\033[4m"
STRIKETHROUGH = "\033[9m"


def _render_ansi(component, inherited_color: str | None = None) -> str:
    """渲染 Component 为带 ANSI 颜色的字符串"""
    if isinstance(component, str):
        return component

    if isinstance(component, dict):
        color = component.get("color", inherited_color)
        parts = []

        # 样式前缀
        prefix = ""
        if color and color in ANSI_COLORS:
            prefix += ANSI_COLORS[color]
        if component.get("bold"):
            prefix += BOLD
        if component.get("italic"):
            prefix += ITALIC
        if component.get("underlined"):
            prefix += UNDERLINE
        if component.get("strikethrough"):
            prefix += STRIKETHROUGH

        text = component.get("text", "")
        if "translate" in component:
            # 处理 with 参数（翻译占位符的实际内容）
            with_items = component.get("with")
            if with_items:
                for w in with_items:
                    parts.append(_render_ansi(w, color))
                text = ""  # 已通过 with 展开，不再追加 translate key
            else:
                text = f"[{component['translate']}]"
        # 1.21+ content format
        if "content" in component:
            if isinstance(component["content"], dict):
                text = component["content"].get("text", text)

        if text:
            if prefix:
                parts.append(f"{prefix}{text}{RESET}")
            else:
                parts.append(text)

        for child in component.get("extra", []):
            parts.append(_render_ansi(child, color))

        # hoverEvent 内容
        if "hoverEvent" in component:
            hover = component["hoverEvent"]
            if isinstance(hover, dict):
                contents = hover.get("contents")
                if contents is not None:
                    parts.append(_render_ansi(contents, color))

        return "".join(parts)

    if isinstance(component, list):
        return "".join(_render_ansi(c, inherited_color) for c in component)

    return ""


# ── 主处理入口 ──

def process_chat(raw_content):
    """
    处理聊天内容：JSON 聊天组件 或 NBT 提取的纯文本。
    打印到终端 → 提取纯文本 → 检测 ??command。
    """
    plain = ""  # 提取的纯文本

    # 尝试 JSON 解析
    try:
        if isinstance(raw_content, str):
            content = json.loads(raw_content)
        else:
            content = raw_content
    except (json.JSONDecodeError, TypeError):
        content = None

    if content is not None:
        # JSON 聊天组件 → 彩色输出 + 提取纯文本
        ansi = _render_ansi(content)
        if ansi.strip():
            print(ansi)
        # 用于命令检测的纯文本：不包含 hover 点击动作文本
        plain = _extract_plain(content, include_hover=False)
    elif isinstance(raw_content, str):
        # NBT 提取的纯文本
        plain = raw_content
        if plain.strip():
            print(plain)
    else:
        return

    # 调试：打印解析出的纯文本
    if plain.strip():
        logger.info(f"[纯文本] {plain[:300]}")

    # 尝试从 plain 文本中提取发送者和消息
    import re
    bot_name = get_username()
    player_name = ""
    chat_msg = ""

    # 格式1: 私聊 [发送者 -> me] 消息
    pm = re.match(r'\[(\w+)\s*->\s*me\]\s*(.*)', plain)
    if pm:
        player_name = pm.group(1)
        chat_msg = pm.group(2).strip()
        # 跳过 Bot 自己的消息
        if bot_name and player_name == bot_name:
            return

    # 格式2: 公聊 [频道]发送者 >> 消息
    if not chat_msg:
        m = re.match(r'(?:\[.*?\]\s*)?(\w+)\s*>>\s*(.*)', plain)
        if m:
            player_name = m.group(1)
            chat_msg = m.group(2).strip()
            # 跳过 Bot 自己的消息
            if bot_name and player_name == bot_name:
                return

    if not chat_msg:
        # 尝试结构化提取 [玩家] / [地皮] 格式
        if plain.startswith("[玩家]") or plain.startswith("[地皮]"):
            player_name, chat_msg = _extract_player_and_msg(content)
        if not chat_msg:
            chat_msg = plain

    # 只响应以配置的前缀开头的消息
    prefix = get_command_prefix()
    if chat_msg and prefix and chat_msg.startswith(prefix):
        command_line = chat_msg[len(prefix):].strip()
        if command_line:
            logger.info(f"[命令] {player_name}: {command_line}")
            CommandManager.process_command(command_line, player_name)


def _extract_player_and_msg(content) -> tuple[str, str]:
    """
    从 Component 树中提取玩家名和聊天消息。
    假设格式: [玩家] <hover含玩家名> 消息
    """
    player_name = ""
    chat_msg = ""

    if isinstance(content, dict):
        children = content.get("extra", [])
        if len(children) >= 2:
            # children[0] 是 "[玩家]" 文本节点
            # children[1] 是包含 hoverEvent 的玩家名节点
            name_node = children[1] if len(children) > 1 else {}
            if isinstance(name_node, dict):
                hover = name_node.get("hoverEvent", {})
                if isinstance(hover, dict):
                    hover_contents = hover.get("contents", {})
                    if isinstance(hover_contents, dict):
                        inner_children = hover_contents.get("extra", [])
                        if len(inner_children) > 1:
                            player_name = _extract_plain(inner_children[1])
                    elif isinstance(hover_contents, list):
                        if len(hover_contents) > 1:
                            player_name = _extract_plain(hover_contents[1])

            # 第 2 个 extra 是消息内容
            if len(children) > 2:
                chat_msg = _extract_plain(children[2])

    return player_name, chat_msg
