"""
player_tracker.py — 指定玩家上下线检测模块

从 config.json 读取 track_players 列表，若列表为空则功能关闭。
当被追踪的玩家上线/下线时，在终端中以醒目方式显示。
"""

import json
import logging
import os

from utils import get_username

logger = logging.getLogger("bot")

_CFG_PATH = os.path.join(os.path.dirname(__file__), "config.json")

# 终端醒目样式
_GREEN = "\033[92m"
_RED = "\033[91m"
_BOLD = "\033[1m"
_RESET = "\033[0m"
_SEPARATOR = "=" * 50


def _load_track_players() -> list[str]:
    """从 config.json 加载需要追踪的玩家名列表"""
    try:
        with open(_CFG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        players = cfg.get("track_players", [])
        if isinstance(players, list):
            return [p.strip() for p in players if isinstance(p, str) and p.strip()]
        return []
    except Exception:
        return []


def _is_tracking_enabled() -> bool:
    """检查追踪功能是否启用"""
    return len(_load_track_players()) > 0


def handle_player_joined(username: str):
    """处理玩家上线事件"""
    track_players = _load_track_players()
    if not track_players:
        return

    bot_name = get_username()
    if username == bot_name:
        return

    if username in track_players:
        msg = f"[玩家追踪] {username} 上线了！"
        logger.info(msg)
        print(f"\n{_SEPARATOR}")
        print(f"  {_BOLD}{_GREEN}▲ {msg}{_RESET}")
        print(f"{_SEPARATOR}\n")


def handle_player_left(username: str):
    """处理玩家下线事件"""
    track_players = _load_track_players()
    if not track_players:
        return

    bot_name = get_username()
    if username == bot_name:
        return

    if username in track_players:
        msg = f"[玩家追踪] {username} 下线了！"
        logger.info(msg)
        print(f"\n{_SEPARATOR}")
        print(f"  {_BOLD}{_RED}▼ {msg}{_RESET}")
        print(f"{_SEPARATOR}\n")