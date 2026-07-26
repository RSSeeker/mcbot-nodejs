"""
动作命令:
  **look <偏航> [俯仰] — 设置视角角度（如 **look 180 0）
  **look at <玩家>     — 看向指定玩家
  **leftclick          — 左键（攻击视线中的实体 / 挖掘方块）
  **rightclick         — 右键（放置方块 / 激活方块 / 实体交互 / 使用物品）
  **cancel             — 取消所有操作（停止挖掘/使用物品/弓箭/移动）
  **sneak              — 切换潜行（蹲下/起身）
  **drop               — 丢出手持物品
  **dropall            — 丢出背包全部物品
  **slot <N>           — 切换到物品栏第 N 格 (1-9)
"""

from command_manager import Command
from utils import send_whisper, send_leftclick, send_rightclick, send_cancel, send_look, send_sneak, send_drop, send_switch_slot


def _leftclick_execute(conn, args: list[str], player: str):
    send_leftclick()
    send_whisper(player, "已执行左键点击")


def _rightclick_execute(conn, args: list[str], player: str):
    send_rightclick()
    send_whisper(player, "已执行右键点击")


def _sneak_execute(conn, args: list[str], player: str):
    send_sneak()
    send_whisper(player, "已切换潜行状态")


def _drop_execute(conn, args: list[str], player: str):
    send_drop(drop_all=False)
    send_whisper(player, "已丢出手持物品")


def _dropall_execute(conn, args: list[str], player: str):
    send_drop(drop_all=True)
    send_whisper(player, "已丢出全部物品")


def _slot_execute(conn, args: list[str], player: str):
    if not args:
        send_whisper(player, "用法: **slot <1-9>")
        return
    try:
        slot = int(args[0])
    except ValueError:
        send_whisper(player, "请输入 1-9 的数字")
        return
    if slot < 1 or slot > 9:
        send_whisper(player, "请输入 1-9 的数字")
        return
    send_switch_slot(slot)


def _cancel_execute(conn, args: list[str], player: str):
    send_cancel()
    send_whisper(player, "已取消所有操作")


import math

def _look_execute(conn, args: list[str], player: str):
    if not args:
        send_whisper(player, "用法: **look <偏航> [俯仰]  或  **look at <玩家>")
        return
    if args[0] == "at":
        if len(args) < 2:
            send_whisper(player, "用法: **look at <玩家>")
            return
        send_look(player=args[1])
        send_whisper(player, f"正在看向 {args[1]}")
        return
    try:
        yaw_deg = float(args[0])
        pitch_deg = float(args[1]) if len(args) > 1 else 0.0
    except ValueError:
        send_whisper(player, "角度必须是数字，如 **look 90 0")
        return
    yaw_rad = math.radians(yaw_deg)
    pitch_rad = math.radians(pitch_deg)
    send_look(yaw=yaw_rad, pitch=pitch_rad)


leftclick_command = Command.literal("leftclick").executes(_leftclick_execute)
rightclick_command = Command.literal("rightclick").executes(_rightclick_execute)
look_command = Command.literal("look").executes(_look_execute)
cancel_command = Command.literal("cancel").executes(_cancel_execute)
sneak_command = Command.literal("sneak").executes(_sneak_execute)
drop_command = Command.literal("drop").executes(_drop_execute)
dropall_command = Command.literal("dropall").executes(_dropall_execute)
slot_command = Command.literal("slot").executes(_slot_execute)