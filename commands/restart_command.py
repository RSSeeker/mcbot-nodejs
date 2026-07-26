"""**restart — 重启 Bot"""
import os
import sys
from command_manager import Command


def _execute(conn, args: list[str], player: str):
    from utils import send_quit
    send_quit()
    os.execv(sys.executable, [sys.executable] + sys.argv)


restart_command = Command.literal("restart").executes(_execute)