"""
command_manager.py — 命令注册与分发，支持引号参数解析。
"""

import logging
from typing import Callable

logger = logging.getLogger("bot")


class Command:
    """命令定义：名称 + 执行回调"""

    def __init__(self, name: str, execute_fn: Callable):
        self.name = name
        self.execute = execute_fn  # (conn, args: list[str], player: str) -> None

    @classmethod
    def literal(cls, name: str):
        """链式构建：.literal("name").executes(fn)"""
        cmd = cls(name, None)
        return cmd

    def executes(self, fn: Callable):
        self.execute = fn
        return self


class CommandManager:
    """全局命令注册表"""

    _commands: list[Command] = []

    @classmethod
    def register(cls, command: Command):
        cls._commands.append(command)
        logger.info(f"[注册命令] {command.name}")

    @classmethod
    def get_all(cls) -> list[Command]:
        return list(cls._commands)

    @classmethod
    def process_command(cls, input_line: str, player: str):
        """解析 **xxx 并执行对应命令"""
        parts = _split_preserve_quotes(input_line)
        if not parts:
            return
        main_cmd = parts[0]
        args = parts[1:] if len(parts) > 1 else []

        for cmd in cls._commands:
            if cmd.name == main_cmd:
                try:
                    cmd.execute(None, args, player)
                except Exception as e:
                    logger.error(f"执行命令 {main_cmd} 时出错: {e}")
                    from utils import send_whisper
                    send_whisper(player, f"命令执行失败: {e}")
                return

        # 未找到命令
        logger.info(f"未知命令: {main_cmd}")


def _split_preserve_quotes(input_line: str) -> list[str]:
    """空格分割，但保留引号内的内容为一个参数（去除引号）"""
    if not input_line or not input_line.strip():
        return []

    parts = []
    current = []
    in_single = False
    in_double = False

    for ch in input_line:
        if ch == "'" and not in_double:
            in_single = not in_single
            continue
        if ch == '"' and not in_single:
            in_double = not in_double
            continue
        if ch == " " and not in_single and not in_double:
            if current:
                parts.append("".join(current))
                current = []
            continue
        current.append(ch)

    if current:
        parts.append("".join(current))

    return parts