"""**cmd <命令> — 让 Bot 执行 Minecraft 指令"""
from command_manager import Command
from utils import send_command, send_whisper


def _execute(conn, args: list[str], player: str):
    if not args:
        send_whisper(player, "用法: **cmd <指令>，如 **cmd time set day")
        return
    command_str = " ".join(args)
    send_command(command_str)
    send_whisper(player, f"已执行: /{command_str}")


cmd_command = Command.literal("cmd").executes(_execute)