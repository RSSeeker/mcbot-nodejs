"""??ping [<ip>[:端口]] — 查询 Minecraft 服务器状态（私发反馈）"""
import json
import os
import threading

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
    lines.append(f"§a{result['host']}:{result['port']}§r")

    vr = result.get("version_range")
    if vr:
        lines.append(f"  版本: §e{result['version_name']}§r  |  支持: §b{vr}§r")
    else:
        lines.append(f"  版本: §e{result['version_name']}§r (proto {result['protocol']})")

    lat = result["latency"]
    lat_color = "§a" if lat < 50 else ("§e" if lat < 150 else "§c")
    lines.append(f"  延迟: {lat_color}{lat}ms§r")

    online = result["online"]
    max_p = result["max"]
    pct = online / max_p * 100 if max_p > 0 else 0
    pct_color = "§a" if pct < 50 else ("§e" if pct < 80 else "§c")
    lines.append(f"  玩家: {pct_color}{online}/{max_p}§r")

    sample = result.get("players_sample")
    if sample:
        names = [p["name"] for p in sample][:10]
        lines.append(f"  在线: §7{', '.join(names)}§r")
        if len(sample) > 10:
            lines.append(f"  §7... 还有 {len(sample) - 10} 人§r")

    motd = result.get("motd", "")
    if motd:
        for ml in motd.split("\n")[:2]:
            if ml.strip():
                lines.append(f"  §f{ml.strip()[:40]}§r")

    for line in lines:
        send_whisper(player, f"[Ping] {line}")


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
