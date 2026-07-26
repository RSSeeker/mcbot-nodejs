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
