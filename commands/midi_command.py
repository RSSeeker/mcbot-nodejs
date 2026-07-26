"""??midi list|play <file>|stop — MIDI 音乐播放"""
import os

from command_manager import Command
from midi_processor import MidiProcessor
from utils import send_chat


def _execute(conn, args: list[str], player: str):
    if not args:
        send_chat("用法: ??midi list|play <文件名>|stop")
        return

    action = args[0].lower()

    if action == "list":
        midi_dir = "midi"
        if not os.path.isdir(midi_dir):
            send_chat("midi/ 目录不存在")
            return
        files = os.listdir(midi_dir)
        if not files:
            send_chat("midi/ 目录为空")
        else:
            send_chat(f"MIDI 文件: {', '.join(files)}")

    elif action == "play":
        if len(args) < 2:
            send_chat("用法: ??midi play <文件名>")
            return
        filename = args[1]
        filepath = os.path.join("midi", filename)
        if not os.path.isfile(filepath):
            send_chat(f"Play failed: 文件 {filename} 不存在")
            return
        send_chat(f"开始播放: {filename}")
        MidiProcessor.play(filepath)

    elif action == "stop":
        MidiProcessor.stop()
        send_chat("MIDI 播放已停止")

    else:
        send_chat(f"未知子命令: {action}")


midi_command = Command.literal("midi").executes(_execute)
