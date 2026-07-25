"""
chat_processor.py — 解析 Minecraft 聊天 JSON，提取玩家名和消息，
检测 ??command 并路由到 CommandManager。
"""

import json
import logging

from command_manager import CommandManager

logger = logging.getLogger("bot")


# ── JSON 聊天组件 → 纯文本 ──

def _extract_plain(component) -> str:
    """递归提取 Component 树中的纯文本"""
    if isinstance(component, str):
        return component
    if isinstance(component, dict):
        parts = []
        if "text" in component:
            parts.append(str(component["text"]))
        if "translate" in component:
            # 翻译键直接作为 fallback
            parts.append(f"[{component['translate']}]")
        if "extra" in component:
            for child in component["extra"]:
                parts.append(_extract_plain(child))
        # 1.21+ 使用 content 格式
        if "content" in component:
            if isinstance(component["content"], dict):
                if "text" in component["content"]:
                    parts.insert(0, component["content"]["text"])
        # 处理 hoverEvent
        if "hoverEvent" in component:
            hover = component["hoverEvent"]
            if isinstance(hover, dict) and "contents" in hover:
                parts.append(_extract_plain(hover["contents"]))
        return "".join(parts)
    if isinstance(component, list):
        return "".join(_extract_plain(c) for c in component)
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

def process_chat(conn, raw_content):
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
        plain = _extract_plain(content)
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

    # 优先尝试结构化提取（获取玩家名）
    player_name = ""
    chat_msg = ""
    if plain.startswith("[玩家]") or plain.startswith("[地皮]"):
        player_name, chat_msg = _extract_player_and_msg(content)

    # 如果结构化提取失败，从纯文本中检测 ??
    if not (chat_msg and chat_msg.startswith("??")):
        chat_msg = plain

    if chat_msg and "??" in chat_msg:
        idx = chat_msg.index("??")
        command_line = chat_msg[idx + 2:].strip()
        logger.info(f"[命令] {player_name}: {command_line}")
        CommandManager.process_command(conn, command_line, player_name)


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
