"""**ping [<ip>[:端口]] — 查询 Minecraft 服务器状态（私发反馈）"""
import json
import os
import threading
import time

from command_manager import Command
from ping_server import ping_server
from utils import send_whisper


_CFG_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "config.json")
_PING_TIMEOUT = 3.0  # 秒，避免阻塞主线程太久


def _resolve_host(args: list[str]) -> tuple[str, int]:
    """从 args 或 config.json 解析 host 和 port。"""
    if args:
        raw = args[0]
        if ":" in raw:
            parts = raw.rsplit(":", 1)
            host = parts[0]
            try:
                port = int(parts[1])
            except ValueError:
                port = 25565
        else:
            host = raw
            port = 25565
        return host, port

    # 没参数：用 config.json 默认
    try:
        with open(_CFG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception:
        return "127.0.0.1", 25565
    return (
        cfg.get("server", {}).get("host", "127.0.0.1"),
        cfg.get("server", {}).get("port", 25565),
    )


def _format_result(player: str, result: dict, host: str, port: int):
    """格式化 ping 结果并私发给玩家。"""
    if result is None:
        send_whisper(player, f"[Ping] 无法连接到 {host}:{port}")
        return

    lines = []
    lines.append(f"{result['host']}:{result['port']}")

    vr = result.get("version_range")
    if vr:
        lines.append(f"  版本: {result['version_name']}  |  支持: {vr}")
    else:
        lines.append(f"  版本: {result['version_name']} (proto {result['protocol']})")

    lat = result["latency"]
    lines.append(f"  延迟: {lat}ms")

    online = result["online"]
    max_p = result["max"]
    lines.append(f"  玩家: {online}/{max_p}")

    sample = result.get("players_sample")
    if sample:
        names = [p["name"] for p in sample][:10]
        lines.append(f"  在线: {', '.join(names)}")
        if len(sample) > 10:
            lines.append(f"  ... 还有 {len(sample) - 10} 人")

    motd = result.get("motd", "")
    if motd:
        for ml in motd.split("\n")[:2]:
            if ml.strip():
                lines.append(f"  {ml.strip()[:40]}")

    for line in lines:
        send_whisper(player, f"[Ping] {line}")
        time.sleep(0.1)  # 每条间隔 0.1s，避免发送过快被踢


def _execute(conn, args: list[str], player: str):
    host, port = _resolve_host(args)
    send_whisper(player, f"[Ping] 正在查询 {host}:{port} ...")

    def _ping_worker():
        try:
            result = ping_server(host, port, timeout=_PING_TIMEOUT)
            _format_result(player, result, host, port)
        except Exception as e:
            send_whisper(player, f"[Ping] 查询失败: {e}")

    # 在后台线程执行 ping，避免阻塞主消息循环导致 bot 掉线
    t = threading.Thread(target=_ping_worker, daemon=True)
    t.start()


ping_command = Command.literal("ping").executes(_execute)