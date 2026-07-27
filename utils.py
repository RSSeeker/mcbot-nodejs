"""
utils.py — 工具函数，通过 JSON Lines IPC 与 Mineflayer 代理通信。
"""

import json
import logging
import os
import sys

logger = logging.getLogger("bot")

# ── 自动从 config.json 加载初始配置 ──
_CFG_PATH = os.path.join(os.path.dirname(__file__), "config.json")
try:
    with open(_CFG_PATH, "r", encoding="utf-8") as _f:
        _init_cfg = json.load(_f)
    _bot_username = _init_cfg.get("bot", {}).get("username", "")
    _command_prefix = _init_cfg.get("command_prefix", "**")
except Exception:
    _bot_username = ""
    _command_prefix = "**"

# 全局状态
_bot_stdin = sys.stdin  # Node 子进程的 stdin（实际写入用）


def set_stdin(fd):
    """设置 Node 子进程 stdin 写入句柄"""
    global _bot_stdin
    _bot_stdin = fd


def set_username(name: str):
    """设置 Bot 用户名（用于过滤自身消息）"""
    global _bot_username
    _bot_username = name


def get_username() -> str:
    """获取 Bot 用户名"""
    return _bot_username


def set_command_prefix(prefix: str):
    """设置指令前缀（如 **、!、/ 等）"""
    global _command_prefix
    _command_prefix = prefix


def get_command_prefix() -> str:
    """获取当前指令前缀"""
    return _command_prefix


def _send_json(obj: dict):
    """向 Node 进程发送 JSON 指令"""
    if _bot_stdin is None:
        logger.warning("Node 进程未连接，无法发送指令")
        return
    try:
        line = json.dumps(obj, ensure_ascii=False) + "\n"
        _bot_stdin.write(line)
        _bot_stdin.flush()
    except Exception as e:
        logger.error(f"发送指令失败: {e}")


def send_chat(message: str):
    """通过 Bot 发送公聊消息"""
    _send_json({"type": "chat", "message": message})
    logger.info(f"[Bot → Chat] {message}")


def send_whisper(player: str, message: str):
    """通过 /tell 私发消息给指定玩家"""
    send_command(f"tell {player} {message}")
    logger.info(f"[Bot → Whisper] {player}: {message}")


def send_command(command: str):
    """通过 Bot 执行 Minecraft 命令"""
    _send_json({"type": "command", "command": command})
    logger.info(f"[Bot → Cmd] {command}")


def send_respawn():
    """发送重生指令"""
    _send_json({"type": "respawn"})


def send_quit():
    """发送退出指令"""
    _send_json({"type": "quit"})


def send_move(direction: str, duration: int = 1000):
    """基本 WASD 移动: forward/back/left/right"""
    _send_json({"type": "move", "dir": direction, "duration": duration})
    logger.info(f"[Bot → Move] {direction} {duration}ms")


def send_jump():
    """跳跃"""
    _send_json({"type": "jump"})


def send_stop():
    """停止所有移动"""
    _send_json({"type": "stop"})


def send_goto(x: int, y: int, z: int):
    """寻路到目标坐标"""
    _send_json({"type": "goto", "x": x, "y": y, "z": z})
    logger.info(f"[Bot → Goto] {x} {y} {z}")


def send_follow(player: str, distance: float = 2.0):
    """跟随指定玩家"""
    _send_json({"type": "follow", "player": player, "distance": distance})
    logger.info(f"[Bot → Follow] {player}")


def send_leftclick():
    """左键点击（攻击/挖掘）"""
    _send_json({"type": "leftclick"})


def send_leftclick_hold():
    """左键长按（持续按住）"""
    _send_json({"type": "leftclick_hold"})
    logger.info("[Bot → LeftClickHold]")


def send_rightclick():
    """右键点击（使用物品/放置方块/交互）"""
    _send_json({"type": "rightclick"})


def send_rightclick_hold():
    """右键长按（持续按住使用物品）"""
    _send_json({"type": "rightclick_hold"})
    logger.info("[Bot → RightClickHold]")


def send_sneak(state: bool | None = None):
    """潜行切换: True=蹲下, False=起身, None=切换"""
    _send_json({"type": "sneak", "state": state})
    logger.info(f"[Bot → Sneak] {state}")


def send_drop(drop_all: bool = False):
    """丢出物品: drop_all=False 丢出手持, drop_all=True 丢出全部"""
    _send_json({"type": "drop", "all": drop_all})
    logger.info(f"[Bot → Drop] {'全部' if drop_all else '手持'}")


def send_clear_inventory():
    """创造模式清除物品栏"""
    _send_json({"type": "clear_inventory"})
    logger.info("[Bot → ClearInventory]")


def send_switch_slot(slot: int):
    """切换物品栏: slot 1-9"""
    _send_json({"type": "slot", "slot": slot})
    logger.info(f"[Bot → Slot] {slot}")


def send_cancel():
    """取消所有操作（停止挖掘/使用物品/弓箭/移动）"""
    _send_json({"type": "cancel"})
    logger.info("[Bot → Cancel]")


def send_activate_item():
    """开始使用手持物品（吃东西/拉弓上弹等）"""
    _send_json({"type": "activate_item"})
    logger.info("[Bot → ActivateItem]")


def send_deactivate_item():
    """停止使用手持物品（放箭/停止进食等）"""
    _send_json({"type": "deactivate_item"})
    logger.info("[Bot → DeactivateItem]")


def send_equip(item_name: str, destination: str = "hand"):
    """装备物品: destination = hand/head/torso/legs/feet/off-hand"""
    _send_json({"type": "equip", "item": item_name, "destination": destination})
    logger.info(f"[Bot → Equip] {item_name} → {destination}")


def send_mount():
    """骑乘视线中的实体或最近的坐骑"""
    _send_json({"type": "mount"})
    logger.info("[Bot → Mount]")


def send_dismount():
    """从坐骑上下来"""
    _send_json({"type": "dismount"})
    logger.info("[Bot → Dismount]")


def send_set_control_state(control: str, state: bool):
    """通用控制状态: forward/back/left/right/jump/sneak/sprint"""
    _send_json({"type": "set_control_state", "control": control, "state": state})
    logger.info(f"[Bot → Control] {control}={state}")


def send_status_request():
    """请求 Bot 状态（位置、血量等），由事件线程异步返回"""
    _send_json({"type": "status"})
    logger.info("[Bot → StatusRequest]")


def send_look(yaw: float | None = None, pitch: float = 0.0, *,
              player: str | None = None,
              x: float | None = None, y: float | None = None, z: float | None = None):
    """转动视角: 绝对角度 / 看向玩家 / 看向坐标"""
    if player:
        _send_json({"type": "look", "player": player})
        logger.info(f"[Bot → Look] 看向玩家 {player}")
    elif x is not None:
        _send_json({"type": "look", "x": x, "y": y or 0, "z": z or 0})
        logger.info(f"[Bot → Look] 看向坐标 {x} {y} {z}")
    else:
        _send_json({"type": "look", "yaw": yaw or 0, "pitch": pitch})
        logger.info(f"[Bot → Look] yaw={yaw} pitch={pitch}")