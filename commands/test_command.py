"""??test — 运行功能测试，使用当前 Bot 连接执行一系列操作"""
import threading
import time
import logging

from command_manager import Command
from utils import (
    send_whisper,
    send_move, send_jump, send_stop,
    send_look,
    send_leftclick, send_rightclick,
    send_sneak, send_cancel, send_drop, send_switch_slot,
    send_activate_item, send_deactivate_item,
)

logger = logging.getLogger("bot")

# 测试项列表: (名称, 间隔秒数)
_TESTS: list[tuple[str, float]] = [
    ("私聊消息", 0.0),
    ("前进移动", 1.8),
    ("后退移动", 1.2),
    ("跳跃", 0.0),
    ("左移", 1.2),
    ("右移", 1.2),
    ("转动视角", 0.0),
    ("潜行切换", 0.0),
    ("切物品栏", 0.0),
    ("丢出物品", 0.0),
    ("停止移动", 0.0),
    ("取消所有操作", 0.0),
    ("左键挥臂", 0.0),
    ("右键交互", 0.0),
    ("使用物品", 0.0),
    ("停止使用物品", 0.0),
]


def _run_test(player: str):
    """后台线程：依次执行测试"""
    send_whisper(player, "========== 开始功能测试 ==========")

    passed = 0
    total = len(_TESTS)

    for name, cooldown in _TESTS:
        try:
            if name == "私聊消息":
                send_whisper(player, "test: 私聊测试")
            elif name == "前进移动":
                send_move("forward", 1500)
            elif name == "后退移动":
                send_move("back", 800)
            elif name == "跳跃":
                send_jump()
                time.sleep(0.3)
                send_jump()
            elif name == "左移":
                send_move("left", 1000)
            elif name == "右移":
                send_move("right", 1000)
            elif name == "转动视角":
                send_look(yaw=90, pitch=0)
                time.sleep(0.3)
                send_look(yaw=180, pitch=-45)
                time.sleep(0.3)
                send_look(yaw=0, pitch=0)
            elif name == "潜行切换":
                send_sneak(True)
                time.sleep(0.5)
                send_sneak(False)
            elif name == "切物品栏":
                for s in [1, 3, 5, 1]:
                    send_switch_slot(s)
                    time.sleep(0.15)
            elif name == "丢出物品":
                send_drop(drop_all=False)
            elif name == "停止移动":
                send_stop()
            elif name == "取消所有操作":
                send_cancel()
            elif name == "左键挥臂":
                send_leftclick()
            elif name == "右键交互":
                send_rightclick()
            elif name == "使用物品":
                send_activate_item()
            elif name == "停止使用物品":
                send_deactivate_item()

            send_whisper(player, f"  ✓ {name}")
            passed += 1

        except Exception as e:
            send_whisper(player, f"  ✗ {name}: {e}")

        if cooldown > 0:
            time.sleep(cooldown)

    send_whisper(player, f"========== 测试完成: {passed}/{total} 通过 ==========")


def _execute(conn, args: list[str], player: str):
    """后台启动测试，避免阻塞命令处理"""
    threading.Thread(target=_run_test, args=(player,), daemon=True).start()
    send_whisper(player, f"正在运行 {len(_TESTS)} 项测试...")


test_command = Command.literal("test").executes(_execute)
