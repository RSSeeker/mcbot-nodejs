"""**respawn — 让 Bot 重生"""
from command_manager import Command
from utils import send_respawn, send_whisper


def _execute(conn, args: list[str], player: str):
    send_respawn()
    send_whisper(player, "已发送重生指令")


respawn_command = Command.literal("respawn").executes(_execute)