"""??restart — 重启 Bot"""
from command_manager import Command


def _execute(conn, args: list[str], player: str):
    # 断开当前连接
    conn.disconnect()
    # 用当前 Python 进程替换自身
    import os
    import sys
    os.execv(sys.executable, [sys.executable] + sys.argv)


restart_command = Command.literal("restart").executes(_execute)
