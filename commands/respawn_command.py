"""??respawn — 让 Bot 重生"""
from command_manager import Command
from utils import send_respawn


def _execute(conn, args: list[str], player: str):
    send_respawn()


respawn_command = Command.literal("respawn").executes(_execute)
