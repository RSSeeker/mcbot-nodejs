"""
auth_handler.py — 自动处理 AuthMe 等登录插件的 /register 和 /login 提示。
"""

import logging
import re
import time

logger = logging.getLogger("auth")

# ── 配置 ──
BOT_PASSWORD = "11111"  # 机器人密码（首次 /register 后不可更改）

# 冷却时间（秒），防止重复发送
_COOLDOWN = 2

class AuthHandler:
    """检测聊天中的登录插件提示并自动回复密码"""

    # 进入 PLAY 后，如果没有收到认证提示，多少秒后主动尝试 /login
    PROACTIVE_AUTH_DELAY = 1.5  # 秒

    def __init__(self, password: str):
        self.password = password
        self._last_send = 0.0        # 上次发送时间
        self._registered = False     # 是否已注册过
        self._logged_in = False      # 是否已登录成功
        self._play_enter_time = 0.0  # 进入 PLAY 的时间（time.monotonic）
        self._proactive_count = 0    # 主动认证尝试次数

    def process(self, conn, plain_text: str) -> bool:
        """
        检测纯文本中是否包含 AuthMe 提示，如果是则自动回复。
        返回 True 表示已处理（拦截，不再触发命令系统）。
        """
        if not plain_text:
            return False

        # 已登录成功，不再处理
        if self._logged_in:
            return False

        # 冷却检查
        now = time.time()
        if now - self._last_send < _COOLDOWN:
            return False

        from utils import send_command

        # ── 登录成功（必须在登录提示之前检测，避免误判）──
        if self._is_login_success(plain_text):
            logger.info("[Auth] 登录成功！")
            self._logged_in = True
            return False

        # ── 注册提示 ──
        if self._is_register_prompt(plain_text):
            logger.info(f"[Auth] 检测到注册提示，发送 /register ...")
            send_command(f"register {self.password} {self.password}")
            self._last_send = now
            self._registered = True
            return True

        # ── 登录提示 ──
        if self._is_login_prompt(plain_text):
            logger.info(f"[Auth] 检测到登录提示，发送 /login ...")
            send_command(f"login {self.password}")
            self._last_send = now
            return True

        # ── 注册成功 ──
        if self._is_register_success(plain_text):
            logger.info("[Auth] 注册成功！")
            self._registered = True
            self._logged_in = True
            return False  # 不拦截，让消息正常显示

        return False

    # ── 中文关键词检测 ──
    _REGISTER_CN = re.compile(
        r"(请?先?注册|注册账号|/register)",
        re.IGNORECASE
    )
    _LOGIN_CN = re.compile(
        r"(请先登录|登录服务器|/login|输入密码)(?!成功)",
        re.IGNORECASE
    )
    _REGISTER_OK = re.compile(
        r"(注册成功|注册完成)",
        re.IGNORECASE
    )
    _LOGIN_OK = re.compile(
        r"(登录成功|登陆成功|已经登[录陆]过了|已帮你自动登录|successfully logged in|login\s*success)",
        re.IGNORECASE
    )

    # ── 英文关键词检测 ──
    _REGISTER_EN = re.compile(
        r"(please\s+register|type\s+/register)",
        re.IGNORECASE
    )
    _LOGIN_EN = re.compile(
        r"(please\s+log\s*in|type\s+/login|not\s+logged\s+in)",
        re.IGNORECASE
    )

    def _is_register_prompt(self, text: str) -> bool:
        return bool(self._REGISTER_CN.search(text) or self._REGISTER_EN.search(text))

    def _is_login_prompt(self, text: str) -> bool:
        return bool(self._LOGIN_CN.search(text) or self._LOGIN_EN.search(text))

    def _is_register_success(self, text: str) -> bool:
        return bool(self._REGISTER_OK.search(text))

    def is_logged_in(self) -> bool:
        """返回是否已完成登录认证"""
        return self._logged_in

    def is_authenticated(self) -> bool:
        """别名：兼容旧代码"""
        return self._logged_in

    def on_enter_play(self):
        """标记已进入 PLAY 状态，开始计时"""
        self._play_enter_time = time.monotonic()

    # 最大主动认证重试次数
    MAX_PROACTIVE_RETRIES = 3

    def check_proactive_auth(self, conn) -> bool:
        """
        如果进入 PLAY 后超过 PROACTIVE_AUTH_DELAY 秒未收到认证提示，
        主动发送 /register（首次）或 /login（后续），最多重试 3 次。
        返回 True 表示已发送。
        """
        if self._logged_in:
            return False
        if self._play_enter_time == 0:
            return False
        if self._proactive_count >= self.MAX_PROACTIVE_RETRIES:
            if self._proactive_count == self.MAX_PROACTIVE_RETRIES:
                logger.info("[Auth] 主动认证已达最大重试次数，停止尝试")
                self._proactive_count += 1  # 防止重复打印日志
            return False
        if time.monotonic() - self._play_enter_time < self.PROACTIVE_AUTH_DELAY:
            return False

        from utils import send_command

        if not self._registered:
            # 首次：尝试注册
            logger.info(f"[Auth] 未收到认证提示，主动发送 /register ({self._proactive_count + 1}/{self.MAX_PROACTIVE_RETRIES}) ...")
            send_command(f"register {self.password} {self.password}")
            self._registered = True
            self._last_send = time.time()
            self._proactive_count += 1
            return True
        elif time.time() - self._last_send >= _COOLDOWN:
            # 已注册过但未登录，发送 /login
            logger.info(f"[Auth] 已注册，主动发送 /login ({self._proactive_count + 1}/{self.MAX_PROACTIVE_RETRIES}) ...")
            send_command(f"login {self.password}")
            self._last_send = time.time()
            self._proactive_count += 1
            return True

        return False

    def _is_login_success(self, text: str) -> bool:
        return bool(self._LOGIN_OK.search(text))


# 全局实例，由 main.py 初始化
_auth_handler: AuthHandler | None = None


def init_auth(password: str):
    """初始化认证处理器"""
    global _auth_handler
    _auth_handler = AuthHandler(password)
    logger.info(f"[Auth] 已初始化，密码: {'*' * len(password)}")


def get_auth() -> AuthHandler | None:
    return _auth_handler
