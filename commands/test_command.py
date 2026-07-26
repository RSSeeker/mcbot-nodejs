"""**test — 运行功能测试框架，用户可自定义测试内容"""
import threading
import time
import logging

from command_manager import Command
from utils import send_whisper

logger = logging.getLogger("bot")

# ──────────────────────────────────────────────
#  用户自定义测试项
#  格式: (测试名称, 执行后等待秒数)
# ──────────────────────────────────────────────
_TESTS: list[tuple[str, float]] = [
    # 示例测试项（请替换为您自己的测试）
    # ("示例测试", 0.5),
]


def _run_test(player: str):
    """后台线程：依次执行测试"""
    send_whisper(player, "========== 开始功能测试 ==========")

    passed = 0
    total = len(_TESTS)

    for name, cooldown in _TESTS:
        try:
            # ──────────────────────────────────────
            #  用户自定义测试逻辑
            #  添加您的测试代码到这里
            # ──────────────────────────────────────
            if name == "示例测试":
                # 示例：发送私聊消息
                send_whisper(player, "这是一个示例测试")

            # 添加更多测试分支...

            send_whisper(player, f"  ✓ {name}")
            passed += 1

        except Exception as e:
            send_whisper(player, f"  ✗ {name}: {e}")

        if cooldown > 0:
            time.sleep(cooldown)

    send_whisper(player, f"========== 测试完成: {passed}/{total} 通过 ==========")


def _execute(conn, args: list[str], player: str):
    """后台启动测试，避免阻塞命令处理"""
    if not _TESTS:
        send_whisper(player, "未配置测试项，请编辑 commands/test_command.py 添加测试")
        return

    threading.Thread(target=_run_test, args=(player,), daemon=True).start()
    send_whisper(player, f"正在运行 {len(_TESTS)} 项测试...")


test_command = Command.literal("test").executes(_execute)