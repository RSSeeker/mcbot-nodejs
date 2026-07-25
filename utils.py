"""
utils.py — 工具函数，提供发送聊天/命令的便捷方法。
"""

import logging

logger = logging.getLogger("bot")

# 全局连接引用，由 main.py 设置
_conn = None
_bot_username = ""


def set_connection(conn):
    """设置全局连接"""
    global _conn
    _conn = conn


def set_username(name: str):
    """设置 Bot 用户名（用于过滤自身消息）"""
    global _bot_username
    _bot_username = name


def get_username() -> str:
    """获取 Bot 用户名"""
    return _bot_username


def send_chat(message: str):
    """通过 Bot 发送公聊消息"""
    if _conn is None:
        logger.warning("连接未初始化，无法发送消息")
        return
    _conn.send_chat_message(message)
    logger.info(f"[Bot → Chat] {message}")


def send_command(command: str):
    """通过 Bot 执行 Minecraft 命令"""
    if _conn is None:
        logger.warning("连接未初始化，无法执行命令")
        return
    _conn.send_chat_command(command)
    logger.info(f"[Bot → Cmd] {command}")
