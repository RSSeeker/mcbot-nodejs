"""??respawn — 让 Bot 重生"""
from command_manager import Command


def _execute(conn, args: list[str], player: str):
    conn.send_client_command(action=0)  # PERFORM_RESPAWN


respawn_command = Command.literal("respawn").executes(_execute)
