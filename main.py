"""
main.py — mcbot Python 入口
=============================
启动 Mineflayer Node.js 代理 → 监听事件 → 响应 ??command → MIDI 播放

用法:
    python main.py

配置项（直接在下方修改）:
    SERVER_HOST     服务器地址
    USERNAME        Bot 用户名（离线模式）
    MIDI_DIR        MIDI 文件存放目录
"""

import json
import logging
import os
import subprocess
import sys
import threading

from chat_processor import process_chat
from command_manager import CommandManager
from commands import register_all
from utils import set_stdin, set_username, send_chat, send_command

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


def main():
    os.makedirs(MIDI_DIR, exist_ok=True)

    set_username(USERNAME)

    # ── 启动 Node.js Mineflayer 代理 ──
    node_script = os.path.join(os.path.dirname(__file__), "mineflayer_bot.js")
    logger.info(f"启动 Mineflayer 代理: {node_script}")

    bot_proc = subprocess.Popen(
        ["node", node_script, SERVER_HOST, str(SERVER_PORT), USERNAME],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )
    set_stdin(bot_proc.stdin)

    # ── 后台线程读取 stderr ──
    def _read_stderr():
        for line in bot_proc.stderr:
            logger.info(line.strip())

    threading.Thread(target=_read_stderr, daemon=True).start()

    # ── 注册命令 ──
    register_all()

    print("=" * 50)
    print("  mcbot-python 已启动 (Mineflayer 代理)")
    print(f"  服务器: {SERVER_HOST}:{SERVER_PORT}")
    print(f"  用户名: {USERNAME}")
    print(f"  MIDI 目录: {MIDI_DIR}")
    print("  在游戏内发送 ??help 查看命令")
    print("=" * 50)
    print("  输入消息按 Enter 发送 (以 / 开头执行命令，输入 quit 退出)")

    # ── 主循环: 读取 Node stdout 事件 + 处理控制台输入 ──
    running = True

    def _process_node_events():
        """后台线程: 读取 Node 进程的 stdout JSON 事件"""
        nonlocal running
        for line in bot_proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                logger.info(f"[mineflayer] {line}")
                continue

            etype = event.get("type", "")
            if etype == "message":
                raw = event.get("raw", "")
                try:
                    json_obj = event.get("json")
                    if json_obj:
                        process_chat(json_obj)
                except Exception as e:
                    logger.error(f"处理消息失败: {e}")

            elif etype == "kicked":
                logger.warning(f"被踢出: {event.get('reason', '')}")
                running = False

            elif etype == "end":
                logger.info(f"连接断开: {event.get('reason', '')}")
                running = False

            elif etype == "error":
                logger.error(f"Mineflayer 错误: {event.get('message', '')}")

            elif etype == "login":
                logger.info("Bot 已登录 ✓")

            elif etype == "spawn":
                logger.info("Bot 已就绪，等待命令...")

    event_thread = threading.Thread(target=_process_node_events, daemon=True)
    event_thread.start()

    try:
        while running and bot_proc.poll() is None:
            try:
                line = input()
            except (EOFError, KeyboardInterrupt):
                break

            line = line.strip()
            if not line:
                continue
            if line.lower() == "quit":
                break

            if line.startswith("/"):
                send_command(line[1:])
                print(f"  [Cmd] /{line[1:]}")
            else:
                send_chat(line)
                print(f"  [Chat] {line}")
    finally:
        running = False
        # 优雅关闭 Node 进程
        try:
            bot_proc.stdin.write('{"type":"quit"}\n')
            bot_proc.stdin.flush()
            bot_proc.stdin.close()
        except Exception:
            pass
        try:
            bot_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            bot_proc.kill()
        logger.info("Bot 已停止")


if __name__ == "__main__":
    main()
