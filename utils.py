"""
utils.py — 工具函数，通过 JSON Lines IPC 与 Mineflayer 代理通信。
"""

import json
import logging
import sys

logger = logging.getLogger("bot")

# 全局状态
_bot_stdin = sys.stdin  # Node 子进程的 stdin（实际写入用）
_bot_username = ""
_command_prefix = "??"


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
    """设置指令前缀（如 ??、!、/ 等）"""
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


def send_command(command: str):
    """通过 Bot 执行 Minecraft 命令"""
    _send_json({"type": "command", "command": command})
    logger.info(f"[Bot → Cmd] {command}")


def send_suggestion(tx_id: int, text: str):
    """发送命令建议（MIDI 音符用）"""
    _send_json({"type": "suggestion", "id": tx_id, "text": text})


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


def send_rightclick():
    """右键点击（使用物品/放置方块/交互）"""
    _send_json({"type": "rightclick"})


def send_sneak(state: bool | None = None):
    """潜行切换: True=蹲下, False=起身, None=切换"""
    _send_json({"type": "sneak", "state": state})
    logger.info(f"[Bot → Sneak] {state}")


def send_drop(drop_all: bool = False):
    """丢出物品: drop_all=False 丢出手持, drop_all=True 丢出全部"""
    _send_json({"type": "drop", "all": drop_all})
    logger.info(f"[Bot → Drop] {'全部' if drop_all else '手持'}")


def send_switch_slot(slot: int):
    """切换物品栏: slot 1-9"""
    _send_json({"type": "slot", "slot": slot})
    logger.info(f"[Bot → Slot] {slot}")
