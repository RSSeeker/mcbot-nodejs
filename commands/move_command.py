"""
移动相关命令:
  **move <方向> [时长]  — 基本 WASD 移动（forward/back/left/right）
  **jump              — 跳跃
  **stop              — 停止所有移动
  **goto <x> <y> <z>  — 寻路到坐标
  **follow <玩家>     — 跟随玩家
"""

from command_manager import Command
from utils import send_whisper, send_move, send_jump, send_stop, send_goto, send_follow

MOVE_DIRS = {
    "forward": "forward", "f": "forward",
    "back": "back", "b": "back",
    "left": "left", "l": "left",
    "right": "right", "r": "right",
}


def _move_execute(conn, args: list[str], player: str):
    if not args:
        send_whisper(player, "用法: **move <forward/back/left/right> [时长毫秒]")
        return
    dir_arg = args[0].lower()
    if dir_arg not in MOVE_DIRS:
        send_whisper(player, "方向: forward/back/left/right")
        return
    duration = int(args[1]) if len(args) > 1 else 1000
    send_move(MOVE_DIRS[dir_arg], duration)
    send_whisper(player, f"正在{dir_arg}移动 {duration}ms")


def _jump_execute(conn, args: list[str], player: str):
    send_jump()
    send_whisper(player, "已跳跃")


def _stop_execute(conn, args: list[str], player: str):
    send_stop()
    send_whisper(player, "已停止所有移动")


def _goto_execute(conn, args: list[str], player: str):
    if len(args) < 3:
        send_whisper(player, "用法: **goto <x> <y> <z>")
        return
    try:
        x, y, z = int(args[0]), int(args[1]), int(args[2])
    except ValueError:
        send_whisper(player, "坐标需为整数")
        return
    send_goto(x, y, z)
    send_whisper(player, f"正在寻路到 ({x}, {y}, {z})")


def _follow_execute(conn, args: list[str], player: str):
    if not args:
        send_whisper(player, "用法: **follow <玩家名>")
        return
    send_follow(args[0])
    send_whisper(player, f"正在跟随 {args[0]}")


move_command = Command.literal("move").executes(_move_execute)
jump_command = Command.literal("jump").executes(_jump_execute)
stop_command = Command.literal("stop").executes(_stop_execute)
goto_command = Command.literal("goto").executes(_goto_execute)
follow_command = Command.literal("follow").executes(_follow_execute)