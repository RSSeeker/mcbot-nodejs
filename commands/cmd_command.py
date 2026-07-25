"""??cmd <命令> — 让 Bot 执行 Minecraft 指令"""
from command_manager import Command
from utils import send_command


def _execute(conn, args: list[str], player: str):
    if not args:
        send_command("help")
        return
    send_command(" ".join(args))


cmd_command = Command.literal("cmd").executes(_execute)
