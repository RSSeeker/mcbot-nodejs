"""
动作命令:
  **look <偏航> [俯仰]  — 设置视角角度（如 **look 180 0）
  **look at <玩家>      — 看向指定玩家
  **attack [时间]        — 攻击视线中的实体
                           时间参数: 指定长按毫秒数，如 **attack 2000（长按2秒）
  **dig [时间]           — 挖掘视线中的方块
                           时间参数: 指定长按毫秒数，如 **dig 2000（长按2秒）
  **place               — 放置方块（对准方块表面）
  **interact            — 与方块或实体交互（开门/开箱/村民交易等）
  **mount               — 骑乘视线中的载具或生物（船/矿车/马/猪/炽足兽等）
  **dismount            — 离开当前载具
  **use                 — 使用手持物品（吃东西/射箭/投掷/放水桶等）
  **usehold [时间]       — 长按使用手持物品（如 **usehold 2000）
  **cancel              — 取消所有操作（停止挖掘/使用物品/弓箭/移动/关闭容器）
  **sneak               — 切换潜行（蹲下/起身）
  **drop                — 丢出手持物品
  **dropall             — 丢出背包全部物品
  **clear               — 创造模式清除物品栏
  **slot <N>            — 切换到物品栏第 N 格 (1-9)
"""

from command_manager import Command
from utils import send_whisper, send_attack, send_attack_hold, send_dig, send_dig_hold, send_place, send_interact, send_mount, send_dismount, send_use_item, send_use_item_hold, send_cancel, send_look, send_sneak, send_drop, send_clear_inventory, send_switch_slot
import threading
import time


def _attack_execute(conn, args: list[str], player: str):
    """攻击实体"""
    duration = None
    if args:
        try:
            duration = int(args[0])
            if duration <= 0:
                duration = None
        except ValueError:
            pass
    
    if duration:
        send_attack_hold()
        send_whisper(player, f"攻击长按开始，持续 {duration}ms")
        
        def release():
            send_cancel()
            send_whisper(player, "攻击长按结束")
        
        threading.Thread(target=lambda: (time.sleep(duration/1000), release()), daemon=True).start()
    else:
        send_attack()
        send_whisper(player, "已执行攻击")


def _dig_execute(conn, args: list[str], player: str):
    """挖掘方块"""
    duration = None
    if args:
        try:
            duration = int(args[0])
            if duration <= 0:
                duration = None
        except ValueError:
            pass
    
    if duration:
        send_dig_hold()
        send_whisper(player, f"挖掘长按开始，持续 {duration}ms")
        
        def release():
            send_cancel()
            send_whisper(player, "挖掘长按结束")
        
        threading.Thread(target=lambda: (time.sleep(duration/1000), release()), daemon=True).start()
    else:
        send_dig()
        send_whisper(player, "已执行挖掘")


def _place_execute(conn, args: list[str], player: str):
    """放置方块"""
    send_place()
    send_whisper(player, "已执行放置方块")


def _mount_execute(conn, args: list[str], player: str):
    """骑乘载具或生物"""
    send_mount()
    send_whisper(player, "正在尝试骑乘...")

def _dismount_execute(conn, args: list[str], player: str):
    """离开载具"""
    send_dismount()
    send_whisper(player, "已离开载具")

def _interact_execute(conn, args: list[str], player: str):
    """与方块或实体交互"""
    send_interact()
    send_whisper(player, "已执行交互")


def _use_execute(conn, args: list[str], player: str):
    """使用手持物品"""
    send_use_item()
    send_whisper(player, "已执行使用物品")


def _usehold_execute(conn, args: list[str], player: str):
    """长按使用手持物品"""
    duration = 2000  # 默认2秒
    if args:
        try:
            d = int(args[0])
            if d > 0:
                duration = d
        except ValueError:
            pass
    
    send_use_item_hold()
    send_whisper(player, f"使用物品长按开始，持续 {duration}ms")
    
    def release():
        send_cancel()
        send_whisper(player, "使用物品长按结束")
    
    threading.Thread(target=lambda: (time.sleep(duration/1000), release()), daemon=True).start()


def _sneak_execute(conn, args: list[str], player: str):
    send_sneak()
    send_whisper(player, "已切换潜行状态")


def _drop_execute(conn, args: list[str], player: str):
    send_drop(drop_all=False)
    send_whisper(player, "已丢出手持物品")


def _dropall_execute(conn, args: list[str], player: str):
    send_drop(drop_all=True)
    send_whisper(player, "已丢出全部物品")


def _clear_execute(conn, args: list[str], player: str):
    send_clear_inventory()
    send_whisper(player, "已尝试清除物品栏（仅创造模式可用）")


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


attack_command = Command.literal("attack").executes(_attack_execute)
dig_command = Command.literal("dig").executes(_dig_execute)
place_command = Command.literal("place").executes(_place_execute)
interact_command = Command.literal("interact").executes(_interact_execute)
mount_command = Command.literal("mount").executes(_mount_execute)
dismount_command = Command.literal("dismount").executes(_dismount_execute)
use_command = Command.literal("use").executes(_use_execute)
usehold_command = Command.literal("usehold").executes(_usehold_execute)
look_command = Command.literal("look").executes(_look_execute)
cancel_command = Command.literal("cancel").executes(_cancel_execute)
sneak_command = Command.literal("sneak").executes(_sneak_execute)
drop_command = Command.literal("drop").executes(_drop_execute)
dropall_command = Command.literal("dropall").executes(_dropall_execute)
clear_command = Command.literal("clear").executes(_clear_execute)
slot_command = Command.literal("slot").executes(_slot_execute)