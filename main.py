"""
main.py — mcbot Python 入口
=============================
连接 Minecraft 服务器 → 监听聊天 → 响应 ??command → MIDI 播放

用法:
    cd mcbot-python/
    pip install -r requirements.txt
    python main.py

配置项（直接在下方修改）:
    SERVER_HOST     服务器地址
    USERNAME        Bot 用户名（离线模式）
    PROTOCOL_VER    协议版本号（见 mc_protocol.py）
    MIDI_DIR        MIDI 文件存放目录
"""

import logging

from mc_protocol import Connection
from chat_processor import process_chat
from command_manager import CommandManager
from commands import register_all
from utils import set_connection, send_chat, send_command

# ── 配置 ──
SERVER_HOST = "mc.weeaxe.cn"
SERVER_PORT = 25565
USERNAME = "RS_Bot"
MIDI_DIR = "midi"

# ── 日志 ──
logging.basicConfig(
    level=logging.INFO,
    format="[%(name)s] %(message)s",
)
logger = logging.getLogger("bot")

# ── 封包 ID 常量（协议版本 769 / 1.21.4） ──
# 参考 minecraft-data 1.21.4 protocol.json (packet container mapper)
SYSTEM_CHAT_PACKET_IDS = [0x73, 0x1E]  # system_chat, profileless_chat


def main():
    # 确保 midi 目录存在
    import os
    os.makedirs(MIDI_DIR, exist_ok=True)

    # 创建连接
    conn = Connection(SERVER_HOST, SERVER_PORT)
    set_connection(conn)

    # 注册聊天处理器
    def _on_system_chat(conn, pkt_id: int, data: bytes):
        """处理聊天封包 (S→C 0x76=system_chat, 0x23=profileless_chat, 1.21.4, NBT 格式)
           system_chat: anonymousNbt(content) + bool(isActionBar)
           profileless_chat: anonymousNbt(message) + ChatType + name(NBT) + target(optional)"""
        try:
            from mc_protocol import decode_nbt_text
            content, consumed = decode_nbt_text(data, 0)
            if content:
                process_chat(conn, content)
        except Exception as e:
            logger.error(f"解析聊天封包失败: {e}")

    for chat_id in SYSTEM_CHAT_PACKET_IDS:
        conn.on_packet(chat_id)(_on_system_chat)

    # 连接 + 登录
    try:
        conn.connect()
        conn.login(USERNAME)
    except Exception as e:
        logger.error(f"登录失败: {e}")
        conn.disconnect()
        return

    # 注册命令
    register_all()

    logger.info("Bot 已就绪，等待命令...")
    print("=" * 50)
    print("  mcbot-python 已启动")
    print(f"  服务器: {SERVER_HOST}:{SERVER_PORT}")
    print(f"  用户名: {USERNAME}")
    print(f"  MIDI 目录: {MIDI_DIR}")
    print("  在游戏内发送 ??help 查看命令")
    print("=" * 50)

    # 主循环 — 控制台直接输入发送到游戏
    print("  输入消息按 Enter 发送 (以 / 开头执行命令，输入 quit 退出)")
    try:
        while conn._running:
            line = input()
            line = line.strip()
            if not line:
                continue
            if line.lower() == "quit":
                break

            if line.startswith("/"):
                cmd = line[1:]
                send_command(cmd)
                print(f"  [Cmd] /{cmd}")
            else:
                send_chat(line)
                print(f"  [Chat] {line}")
    except (EOFError, KeyboardInterrupt):
        pass
    finally:
        conn.disconnect()
        logger.info("Bot 已停止")


if __name__ == "__main__":
    main()
