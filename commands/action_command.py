"""
动作命令:
  ??leftclick  — 左键（攻击视线中的实体 / 挖掘方块）
  ??rightclick — 右键（使用手中物品 / 放置方块 / 交互）
  ??sneak      — 切换潜行（蹲下/起身）
  ??drop       — 丢出手持物品
  ??dropall    — 丢出背包全部物品
  ??slot <N>   — 切换到物品栏第 N 格 (1-9)
"""

from command_manager import Command
from utils import send_chat, send_leftclick, send_rightclick, send_sneak, send_drop, send_switch_slot


def _leftclick_execute(conn, args: list[str], player: str):
    send_leftclick()


def _rightclick_execute(conn, args: list[str], player: str):
    send_rightclick()


def _sneak_execute(conn, args: list[str], player: str):
    send_sneak()
    send_chat("已切换潜行状态")


def _drop_execute(conn, args: list[str], player: str):
    send_drop(drop_all=False)


def _dropall_execute(conn, args: list[str], player: str):
    send_drop(drop_all=True)


def _slot_execute(conn, args: list[str], player: str):
    if not args:
        send_chat("用法: ??slot <1-9>")
        return
    try:
        slot = int(args[0])
    except ValueError:
        send_chat("请输入 1-9 的数字")
        return
    if slot < 1 or slot > 9:
        send_chat("请输入 1-9 的数字")
        return
    send_switch_slot(slot)


leftclick_command = Command.literal("leftclick").executes(_leftclick_execute)
rightclick_command = Command.literal("rightclick").executes(_rightclick_execute)
sneak_command = Command.literal("sneak").executes(_sneak_execute)
drop_command = Command.literal("drop").executes(_drop_execute)
dropall_command = Command.literal("dropall").executes(_dropall_execute)
slot_command = Command.literal("slot").executes(_slot_execute)
