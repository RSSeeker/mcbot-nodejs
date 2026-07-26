"""**send <消息> — 让 Bot 以聊天方式发送消息"""
from command_manager import Command
from utils import send_chat, send_whisper


def _execute(conn, args: list[str], player: str):
    if not args:
        send_whisper(player, "用法: **send <消息>")
        return
    send_chat(" ".join(args))


send_command = Command.literal("send").executes(_execute)