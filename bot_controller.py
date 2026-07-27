"""
bot_controller.py — Bot 控制统一 API

封装了所有 Bot 控制功能，可直接 import 使用：

    from bot_controller import BotController

    bot = BotController()
    bot.connect()
    bot.chat("Hello!")
    bot.move_forward(2000)
    bot.jump()
    bot.disconnect()
"""

import json
import logging
import math
import os
import subprocess
import threading
import time

from utils import (
    set_stdin,
    send_chat, send_whisper, send_command,
    send_respawn, send_quit,
    send_move, send_jump, send_stop, send_goto, send_follow,
    send_leftclick, send_rightclick, send_cancel, send_sneak, send_drop, send_switch_slot,
    send_look,
    send_activate_item, send_deactivate_item, send_equip, send_mount, send_dismount,
    send_set_control_state, send_status_request,
)

logger = logging.getLogger("bot.controller")


class BotController:
    """Minecraft Bot 控制器

    使用示例::

        # 使用配置文件
        bot = BotController()
        bot.connect()
        bot.chat("Hello!")
        bot.disconnect()

        # 直接指定参数
        bot = BotController(
            host="mc.hypixel.net",
            port=25565,
            username="MyBot",
            password="mypassword",
            command_prefix="!!"
        )
        bot.connect()
    """

    def __init__(
        self,
        config_path: str | None = None,
        *,
        host: str | None = None,
        port: int | None = None,
        version: str | None = None,
        username: str | None = None,
        password: str | None = None,
        command_prefix: str | None = None
    ):
        """
        初始化 Bot 控制器

        Args:
            config_path: 配置文件路径，默认读取 config.json
            host: 服务器地址（覆盖配置文件）
            port: 服务器端口（覆盖配置文件）
            version: Minecraft 版本（覆盖配置文件）
            username: Bot 玩家名（覆盖配置文件）
            password: 登录密码（覆盖配置文件）
            command_prefix: 命令前缀（覆盖配置文件）
        """
        # 加载配置文件作为默认值
        if config_path is None:
            config_path = os.path.join(os.path.dirname(__file__), "config.json")
        with open(config_path, "r", encoding="utf-8") as f:
            self._cfg = json.load(f)

        self._proc: subprocess.Popen | None = None
        self._running = False
        self._status: dict | None = None
        self._status_event = threading.Event()
        self._event_handlers: dict[str, list] = {}
        self._event_lock = threading.Lock()

        # 使用参数覆盖配置文件
        self.host = host if host is not None else self._cfg["server"]["host"]
        self.port = port if port is not None else self._cfg["server"]["port"]
        self.version = version if version is not None else self._cfg["server"].get("version", "1.21.4")
        self.username = username if username is not None else self._cfg["bot"]["username"]
        self.password = password if password is not None else self._cfg["bot"].get("password", "")
        self.command_prefix = command_prefix if command_prefix is not None else self._cfg.get("command_prefix", "**")

    # ═══════════════════════════════════
    #  生命周期
    # ═══════════════════════════════════

    def connect(self, timeout: float = 30.0) -> "BotController":
        """启动 Bot 并连接到 Minecraft 服务器

        Args:
            timeout: 等待登录超时秒数
        Returns:
            self（支持链式调用）
        Raises:
            RuntimeError: 启动失败或超时
        """
        if self._running:
            return self

        node_script = os.path.join(os.path.dirname(__file__), "mineflayer_bot.js")
        logger.info(f"启动 Mineflayer 代理: {node_script}")

        self._proc = subprocess.Popen(
            ["node", node_script],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )

        set_stdin(self._proc.stdin)
        self._running = True

        # 后台读取 stderr
        threading.Thread(target=self._read_stderr, daemon=True).start()
        # 后台读取 stdout
        threading.Thread(target=self._read_stdout, daemon=True).start()

        # 发送连接配置给 Node 进程
        self._send_connect_config()

        # 等待进程启动
        start = time.time()
        while time.time() - start < timeout:
            if self._proc.poll() is not None:
                raise RuntimeError("Bot 进程意外退出")
            time.sleep(0.5)

        # 更新全局状态（用于命令前缀匹配等）
        from utils import set_username, set_command_prefix
        set_username(self.username)
        set_command_prefix(self.command_prefix)

        logger.info(f"Bot 控制器已就绪 ✓ 连接到 {self.host}:{self.port}")
        return self

    def _send_connect_config(self):
        """向 Node 进程发送连接配置"""
        connect_config = {
            "type": "connect",
            "host": self.host,
            "port": self.port,
            "version": self.version,
            "username": self.username,
            "password": self.password,
        }
        try:
            line = json.dumps(connect_config, ensure_ascii=False) + "\n"
            self._proc.stdin.write(line)
            self._proc.stdin.flush()
            logger.info(f"已发送连接配置: {self.host}:{self.port}")
        except Exception as e:
            logger.error(f"发送连接配置失败: {e}")

    def disconnect(self):
        """断开连接，关闭 Bot 进程"""
        if not self._running:
            return
        self._running = False

        if self._proc and self._proc.stdin:
            try:
                send_quit()
                self._proc.stdin.flush()
                self._proc.stdin.close()
            except Exception:
                pass

        if self._proc:
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()
        logger.info("Bot 已断开 ✓")

    def is_connected(self) -> bool:
        """返回 Bot 是否仍在运行"""
        return self._running and self._proc is not None and self._proc.poll() is None

    def wait(self, seconds: float):
        """休眠指定秒数（方便测试脚本使用）"""
        time.sleep(seconds)

    def restart(self):
        """重启 Bot 进程"""
        self.disconnect()
        time.sleep(2)
        self.connect()

    # ═══════════════════════════════════
    #  事件系统
    # ═══════════════════════════════════

    def on(self, event_type: str, handler):
        """注册事件回调

        Args:
            event_type: 事件类型 (login/spawn/death/chat/message/kicked/end/error
                         /player_joined/player_left/reconnecting/status_response)
            handler: 回调函数 callback(event_dict)
        """
        with self._event_lock:
            if event_type not in self._event_handlers:
                self._event_handlers[event_type] = []
            self._event_handlers[event_type].append(handler)

    def get_status(self, timeout: float = 3.0) -> dict | None:
        """查询 Bot 当前状态

        Returns:
            包含 position/health/food/yaw/pitch/gamemode/dimension/heldItem
            等字段的字典，超时返回 None
        """
        self._status = None
        self._status_event.clear()
        send_status_request()
        if self._status_event.wait(timeout):
            return self._status
        return None

    # ═══════════════════════════════════
    #  聊天
    # ═══════════════════════════════════

    def chat(self, message: str):
        """发送公聊消息"""
        send_chat(message)

    def whisper(self, player: str, message: str):
        """私聊某玩家（/tell）"""
        send_whisper(player, message)

    def run_command(self, command: str):
        """执行 Minecraft 指令（/xxx）"""
        send_command(command)

    # ═══════════════════════════════════
    #  移动
    # ═══════════════════════════════════

    def move(self, direction: str, duration: int = 1000):
        """基本 WASD 移动

        Args:
            direction: 方向: forward / back / left / right
            duration: 持续时间(毫秒)，默认 1000
        """
        send_move(direction, duration)

    def move_forward(self, duration: int = 1000):
        """向前移动"""
        self.move("forward", duration)

    def move_back(self, duration: int = 1000):
        """向后移动"""
        self.move("back", duration)

    def move_left(self, duration: int = 1000):
        """向左移动"""
        self.move("left", duration)

    def move_right(self, duration: int = 1000):
        """向右移动"""
        self.move("right", duration)

    def jump(self):
        """跳跃"""
        send_jump()

    def stop(self):
        """停止所有移动"""
        send_stop()

    def goto(self, x: int, y: int, z: int):
        """寻路到目标坐标（自动绕过障碍）"""
        send_goto(x, y, z)

    def follow(self, player: str, distance: float = 2.0):
        """跟随指定玩家"""
        send_follow(player, distance)

    # ═══════════════════════════════════
    #  动作
    # ═══════════════════════════════════

    def left_click(self):
        """左键（攻击实体 / 挖掘方块）"""
        send_leftclick()

    def right_click(self):
        """右键（放置方块 / 激活方块 / 交互实体 / 使用物品）"""
        send_rightclick()

    def sneak(self, state: bool | None = None):
        """潜行切换

        Args:
            state: True=蹲下, False=起身, None=切换
        """
        send_sneak(state)

    def sprint(self, state: bool | None = None):
        """疾跑切换

        Args:
            state: True=开始疾跑, False=停止疾跑, None=切换
        """
        if state is None:
            status = self.get_status()
            current_sprint = status.get("isSprinting", False) if status else False
            state = not current_sprint
        send_set_control_state("sprint", state)

    def cancel(self):
        """取消所有操作（停止挖掘/使用物品/弓箭/移动）"""
        send_cancel()

    # ═══════════════════════════════════
    #  视角
    # ═══════════════════════════════════

    def look(self, yaw: float, pitch: float = 0.0):
        """设置视角角度

        Args:
            yaw: 水平角度 (-180~180)
            pitch: 垂直角度 (-90~90)
        """
        yaw_rad = math.radians(yaw)
        pitch_rad = math.radians(pitch)
        send_look(yaw=yaw_rad, pitch=pitch_rad)

    def look_at_player(self, player: str):
        """看向指定玩家"""
        send_look(player=player)

    def look_at(self, x: float, y: float, z: float):
        """看向坐标"""
        send_look(x=x, y=y, z=z)

    # ═══════════════════════════════════
    #  物品
    # ═══════════════════════════════════

    def use_item(self):
        """开始使用手持物品（吃东西/拉弓/上弹等）"""
        send_activate_item()

    def stop_use_item(self):
        """停止使用手持物品（放箭/停止进食等）"""
        send_deactivate_item()

    def drop(self):
        """丢出手持物品"""
        send_drop(drop_all=False)

    def drop_all(self):
        """丢出背包全部物品"""
        send_drop(drop_all=True)

    def switch_slot(self, slot: int):
        """切换到物品栏指定格 (1-44)"""
        send_switch_slot(slot)

    def equip(self, item_name: str, destination: str = "hand"):
        """装备物品

        Args:
            item_name: 物品名称（部分匹配，如 "diamond_sword"）
            destination: 装备位置: hand/head/torso/legs/feet/off-hand
        """
        send_equip(item_name, destination)

    # ═══════════════════════════════════
    #  实体交互
    # ═══════════════════════════════════

    def mount(self):
        """骑乘视线中的实体或最近的坐骑"""
        send_mount()

    def dismount(self):
        """从坐骑上下来"""
        send_dismount()

    # ═══════════════════════════════════
    #  控制状态
    # ═══════════════════════════════════

    def set_control_state(self, control: str, state: bool):
        """设置控制状态（持续按住/松开）

        Args:
            control: forward / back / left / right / jump / sneak / sprint
            state: True=按住, False=松开
        """
        send_set_control_state(control, state)

    # ═══════════════════════════════════
    #  其他
    # ═══════════════════════════════════

    def respawn(self):
        """重生（死亡后使用）"""
        send_respawn()

    def quit_bot(self):
        """退出 Bot（等同于 disconnect）"""
        self.disconnect()

    def __enter__(self):
        return self.connect()

    def __exit__(self, *args):
        self.disconnect()

    # ═══════════════════════════════════
    #  内部
    # ═══════════════════════════════════

    def _read_stderr(self):
        try:
            for line in self._proc.stderr:
                logger.info(f"[mineflayer] {line.strip()}")
        except Exception:
            pass

    def _read_stdout(self):
        try:
            for line in self._proc.stdout:
                if not self._running:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue

                etype = event.get("type", "")

                if etype == "status_response":
                    self._status = event
                    self._status_event.set()

                if etype in self._event_handlers:
                    with self._event_lock:
                        handlers = list(self._event_handlers[etype])
                    for handler in handlers:
                        try:
                            handler(event)
                        except Exception as e:
                            logger.error(f"事件处理失败 [{etype}]: {e}")
        except Exception:
            pass