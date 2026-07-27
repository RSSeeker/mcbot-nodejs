"""
test.py — Bot 控制功能测试脚本

用法:
    python test.py              # 运行全部测试
    python test.py --quick      # 快速测试（只测基础功能）
    python test.py --interactive  # 交互式手动测试

测试项目::

    [1] 连接测试       — Bot 启动并连接服务器
    [2] 聊天测试       — 发送公聊/私聊/指令
    [3] 移动测试       — WASD 移动 & 跳跃
    [4] 视角测试       — look 转动视角
    [5] 动作测试       — 潜行/取消/状态查询
    [6] 物品测试       — 切换格子/丢出/装备
    [7] 组合测试       — 综合场景
"""

import argparse
import logging
import sys
import threading
import time
import traceback

from bot_controller import BotController

logging.basicConfig(
    level=logging.INFO,
    format="[%(name)s] %(message)s",
)
logger = logging.getLogger("test")

PASS = "✓"
FAIL = "✗"
SKIP = "○"


# ═══════════════════════════════════
#  测试框架
# ═══════════════════════════════════

_results: list[tuple[str, bool, str]] = []


def test(name: str):
    """测试装饰器"""
    def decorator(fn):
        def wrapper(bot):
            try:
                fn(bot)
                _results.append((name, True, ""))
                print(f"  {PASS} {name}")
            except Exception as e:
                _results.append((name, False, str(e)))
                print(f"  {FAIL} {name} — {e}")
                traceback.print_exc()
        return wrapper
    return decorator


def ensure_spawned(bot: BotController, timeout: float = 20.0):
    """等待 Bot 出生完成"""
    spawned = threading.Event()

    def on_spawn(_event):
        spawned.set()

    bot.on("spawn", on_spawn)

    start = time.time()
    while not spawned.is_set():
        if time.time() - start > timeout:
            raise TimeoutError("Bot 出生超时")
        if not bot.is_connected():
            raise RuntimeError("Bot 连接断开")
        time.sleep(0.3)


import threading


# ═══════════════════════════════════
#  测试用例
# ═══════════════════════════════════

@test("连接与登录")
def test_connect(bot):
    """Bot 能成功启动、连接服务器并出生"""
    ensure_spawned(bot)
    status = bot.get_status()
    if status is None:
        raise RuntimeError("无法获取状态")
    assert status.get("health", 0) > 0, "血量异常"
    logger.info(f"  位置: {status['position']}, 血量: {status['health']}")


@test("发送公聊")
def test_chat_public(bot):
    """Bot 能在公聊发送消息"""
    bot.chat("test_chat_public: 公聊测试消息")


@test("发送私聊")
def test_whisper(bot):
    """Bot 能私聊（发送 /tell 给自己）"""
    bot.whisper(bot.username, "test_whisper: 私聊测试消息")


@test("执行 MC 指令")
def test_run_command(bot):
    """Bot 能执行 Minecraft 指令"""
    bot.run_command("me 正在测试指令执行")


@test("向前移动")
def test_move_forward(bot):
    """Bot 向前移动"""
    bot.move_forward(1500)
    time.sleep(2)
    status = bot.get_status()
    assert status is not None, "无法获取状态"


@test("后退移动")
def test_move_back(bot):
    """Bot 后退移动"""
    bot.move_back(800)
    time.sleep(1.2)


@test("跳跃测试")
def test_jump(bot):
    """Bot 跳跃"""
    bot.jump()
    time.sleep(0.5)
    bot.jump()
    time.sleep(0.5)
    bot.jump()


@test("停止移动")
def test_stop(bot):
    """停止所有移动"""
    bot.move_forward(5000)  # 长时移动
    time.sleep(0.5)
    bot.stop()  # 立即停止
    time.sleep(0.5)


@test("转动视角")
def test_look(bot):
    """设置视角角度"""
    bot.look(90, 0)
    time.sleep(0.3)
    bot.look(180, -45)
    time.sleep(0.3)
    bot.look(0, 0)
    time.sleep(0.3)


@test("看向坐标")
def test_look_at(bot):
    """看向指定坐标"""
    status = bot.get_status()
    if status:
        pos = status["position"]
        bot.look_at(pos["x"] + 5, pos["y"], pos["z"] + 5)
        time.sleep(0.5)


@test("潜行切换")
def test_sneak(bot):
    """潜行开关"""
    bot.sneak(True)
    time.sleep(0.5)
    bot.sneak(False)
    time.sleep(0.3)
    bot.sneak()  # 切换模式
    time.sleep(0.3)
    bot.sneak()  # 切回


@test("疾跑切换")
def test_sprint(bot):
    """疾跑开关"""
    bot.sprint(True)
    time.sleep(0.5)
    bot.sprint(False)
    time.sleep(0.3)
    bot.sprint()  # 切换模式
    time.sleep(0.3)
    bot.sprint()  # 切回


@test("取消操作")
def test_cancel(bot):
    """取消所有操作"""
    bot.cancel()


@test("切换物品栏")
def test_switch_slot(bot):
    """切换到物品栏格子"""
    for slot in range(1, 5):
        bot.switch_slot(slot)
        time.sleep(0.2)


@test("丢出手持物品")
def test_drop(bot):
    """丢出一个物品"""
    bot.drop()


@test("状态查询")
def test_get_status(bot):
    """查询 Bot 当前状态"""
    status = bot.get_status()
    assert status is not None, "无法获取状态"
    logger.info(
        f"  位置=({status['position']['x']}, {status['position']['y']}, {status['position']['z']})"
        f"  血量={status['health']}  饱食={status['food']}"
        f"  手持={status.get('heldItem')}  模式={status.get('gamemode')}"
    )


@test("攻击")
def test_attack(bot):
    """攻击实体"""
    bot.attack()


@test("交互")
def test_interact(bot):
    """右键交互"""
    bot.interact()


@test("组合场景: 移动+跳跃")
def test_combo_move_jump(bot):
    """向前移动的同时跳跃"""
    bot.move_forward(100)
    time.sleep(0.1)
    bot.jump()
    time.sleep(0.4)
    bot.jump()
    time.sleep(0.5)
    bot.stop()


# ═══════════════════════════════════
#  快速测试（仅基础功能）
# ═══════════════════════════════════

QUICK_TESTS = [
    test_connect,
    test_chat_public,
    test_move_forward,
    test_jump,
    test_stop,
    test_get_status,
    test_cancel,
]

# ═══════════════════════════════════
#  全部测试
# ═══════════════════════════════════

ALL_TESTS = [
    test_connect,
    test_chat_public,
    test_whisper,
    test_run_command,
    test_move_forward,
    test_move_back,
    test_jump,
    test_stop,
    test_look,
    test_look_at,
    test_sneak,
    test_sprint,
    test_cancel,
    test_switch_slot,
    test_drop,
    test_get_status,
    test_attack,
    test_interact,
    test_combo_move_jump,
]


# ═══════════════════════════════════
#  交互测试
# ═══════════════════════════════════

def run_interactive(bot: BotController):
    """交互式手动测试"""
    print("\n" + "=" * 50)
    print("  交互测试模式")
    print("=" * 50)
    print("  可用方法:")
    print("    bot.chat(msg)        — 公聊")
    print("    bot.move_forward(ms) — 前进")
    print("    bot.move_back(ms)    — 后退")
    print("    bot.move_left(ms)    — 左移")
    print("    bot.move_right(ms)   — 右移")
    print("    bot.jump()           — 跳跃")
    print("    bot.stop()           — 停止")
    print("    bot.look(yaw, pitch) — 视角")
    print("    bot.attack()         — 攻击")
    print("    bot.interact()       — 交互")
    print("    bot.place()          — 放置方块")
    print("    bot.use_item()       — 使用物品")
    print("    bot.sneak()          — 潜行")
    print("    bot.sprint()         — 疾跑")
    print("    bot.drop()           — 丢出物品")
    print("    bot.switch_slot(n)   — 换格子")
    print("    bot.cancel()         — 取消操作")
    print("    bot.get_status()     — 查询状态")
    print("    bot.equip(name)      — 装备物品")
    print("    bot.mount()          — 骑乘")
    print("    bot.dismount()       — 下马")
    print("    bot.respawn()        — 重生")
    print("    quit                 — 退出")
    print("=" * 50)
    print("  直接输入 Python 表达式即可执行")
    print()

    time.sleep(0.5)

    while True:
        try:
            cmd = input(">>> ").strip()
        except (EOFError, KeyboardInterrupt):
            break

        if not cmd:
            continue
        if cmd.lower() == "quit":
            break

        try:
            result = eval(cmd)
            if result is not None:
                print(result)
        except Exception as e:
            print(f"错误: {e}")


# ═══════════════════════════════════
#  主入口
# ═══════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="Bot 控制功能测试")
    parser.add_argument("--quick", action="store_true", help="快速测试（仅基础功能）")
    parser.add_argument("--interactive", action="store_true", help="交互式手动测试")
    parser.add_argument("--skip-connect", action="store_true", help="跳过连接（测试连接过程）")
    args = parser.parse_args()

    print("=" * 50)
    print("  mcbot-python 控制功能测试")
    print("=" * 50)

    bot = BotController()

    if args.skip_connect:
        try:
            bot.connect()
            ensure_spawned(bot)
        except Exception as e:
            logger.error(f"连接失败: {e}")
            sys.exit(1)

    if args.interactive:
        if not args.skip_connect:
            bot.connect()
            ensure_spawned(bot)
        run_interactive(bot)
        bot.disconnect()
        return

    # 自动连接并运行测试
    logger.info("正在连接 Bot...")
    try:
        bot.connect()
        ensure_spawned(bot)
    except Exception as e:
        logger.error(f"连接/出生失败: {e}")
        bot.disconnect()
        sys.exit(1)

    test_list = QUICK_TESTS if args.quick else ALL_TESTS
    mode = "快速" if args.quick else "完整"

    print(f"\n  运行 {mode}测试 ({len(test_list)} 项)\n")

    for test_fn in test_list:
        test_fn(bot)
        time.sleep(0.3)  # 测试间隔，避免指令堆积

    # 汇总
    passed = sum(1 for _, ok, _ in _results if ok)
    failed = len(_results) - passed

    print("\n" + "=" * 50)
    print(f"  测试完成: {PASS} 通过 {passed} 项  {FAIL} 失败 {failed} 项")
    print("=" * 50)

    if failed > 0:
        print("\n  失败详情:")
        for name, ok, err in _results:
            if not ok:
                print(f"    {FAIL} {name}: {err}")

    # 清理
    bot.disconnect()

    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())