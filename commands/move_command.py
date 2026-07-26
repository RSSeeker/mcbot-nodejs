"""
移动相关命令:
  ??move <方向> [时长]  — 基本 WASD 移动（forward/back/left/right）
  ??jump              — 跳跃
  ??stop              — 停止所有移动
  ??goto <x> <y> <z>  — 寻路到坐标
  ??follow <玩家>     — 跟随玩家
"""

from command_manager import Command
from utils import send_chat, send_move, send_jump, send_stop, send_goto, send_follow

MOVE_DIRS = {
    "forward": "forward", "f": "forward",
    "back": "back", "b": "back",
    "left": "left", "l": "left",
    "right": "right", "r": "right",
}


def _move_execute(conn, args: list[str], player: str):
    if not args:
        send_chat("用法: ??move <forward/back/left/right> [时长毫秒]")
        return
    dir_arg = args[0].lower()
    if dir_arg not in MOVE_DIRS:
        send_chat(f"方向: forward/back/left/right")
        return
    duration = int(args[1]) if len(args) > 1 else 1000
    send_move(MOVE_DIRS[dir_arg], duration)


def _jump_execute(conn, args: list[str], player: str):
    send_jump()


def _stop_execute(conn, args: list[str], player: str):
    send_stop()


def _goto_execute(conn, args: list[str], player: str):
    if len(args) < 3:
        send_chat("用法: ??goto <x> <y> <z>")
        return
    try:
        x, y, z = int(args[0]), int(args[1]), int(args[2])
    except ValueError:
        send_chat("坐标需为整数")
        return
    send_goto(x, y, z)


def _follow_execute(conn, args: list[str], player: str):
    if not args:
        send_chat("用法: ??follow <玩家名>")
        return
    send_follow(args[0])


move_command = Command.literal("move").executes(_move_execute)
jump_command = Command.literal("jump").executes(_jump_execute)
stop_command = Command.literal("stop").executes(_stop_execute)
goto_command = Command.literal("goto").executes(_goto_execute)
follow_command = Command.literal("follow").executes(_follow_execute)
