"""??help — 列出所有已注册命令"""
from command_manager import Command, CommandManager
from utils import send_chat


def _execute(conn, args: list[str], player: str):
    cmds = CommandManager.get_all()
    if not cmds:
        send_chat("没有已注册的命令")
    else:
        names = [c.name for c in cmds]
        send_chat(f"命令列表: {', '.join(names)}")


help_command = Command.literal("help").executes(_execute)
