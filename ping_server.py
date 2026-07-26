"""
ping_server.py — 查询 Minecraft 服务器状态

用法:
    python ping_server.py                          # 使用 config.json 中的服务器地址
    python ping_server.py --host mc.example.com    # 指定服务器
    python ping_server.py --host mc.example.com --port 25566
    python ping_server.py --host mc.example.com --version 767   # 指定协议版本
    python ping_server.py --host mc.example.com --timeout 10    # 自定义超时

也可作为模块使用:
    from ping_server import ping_server
    result = ping_server("mc.example.com", 25565)
    print(result)
"""

import argparse
import json
import os
import re
import socket
import struct
import time


# ── 协议版本号映射 ──
PROTOCOL_VERSIONS = {
    "1.21.5":  770,
    "1.21.4":  769,
    "1.21.3":  768,
    "1.21.2":  768,
    "1.21.1":  767,
    "1.21":    767,
    "1.20.6":  766,
    "1.20.5":  766,
    "1.20.4":  765,
    "1.20.2":  764,
    "1.20.1":  763,
    "1.20":    763,
    "1.19.4":  762,
    "1.19.3":  761,
    "1.19.2":  760,
    "1.19.1":  760,
    "1.19":    759,
    "1.18.2":  758,
    "1.18.1":  757,
    "1.18":    757,
    "1.17.1":  756,
    "1.17":    755,
    "1.16.5":  754,
    "1.16.4":  754,
    "1.16.3":  753,
    "1.16.2":  751,
    "1.16.1":  736,
    "1.16":    735,
    "1.15.2":  578,
    "1.15.1":  575,
    "1.15":    573,
    "1.14.4":  498,
    "1.14.3":  490,
    "1.14.2":  485,
    "1.14.1":  480,
    "1.14":    477,
    "1.13.2":  404,
    "1.13.1":  401,
    "1.13":    393,
    "1.12.2":  340,
    "1.12.1":  338,
    "1.12":    335,
    "1.11.2":  316,
    "1.11.1":  316,
    "1.11":    315,
    "1.10.2":  210,
    "1.10.1":  210,
    "1.10":    210,
    "1.9.4":   110,
    "1.9.3":   110,
    "1.9.2":   109,
    "1.9.1":   108,
    "1.9":     107,
    "1.8.9":   47,
    "1.8.8":   47,
    "1.8.7":   47,
    "1.8.6":   47,
    "1.8.5":   47,
    "1.8.4":   47,
    "1.8.3":   47,
    "1.8.2":   47,
    "1.8.1":   47,
    "1.8":     47,
    "1.7.10":  5,
    "1.7.9":   5,
    "1.7.8":   5,
    "1.7.7":   5,
    "1.7.6":   5,
    "1.7.5":   4,
    "1.7.4":   4,
    "1.7.2":   4,
}


# ── 协议解析工具 ──

def encode_varint(v: int) -> bytes:
    """编码 VarInt"""
    buf = bytearray()
    v &= 0xFFFFFFFF  # 转为无符号 32 位
    while True:
        t = v & 0x7F
        v >>= 7
        if v:
            t |= 0x80
        buf.append(t)
        if v == 0:
            break
    return bytes(buf)


def decode_varint(data: bytes, off: int = 0):
    """解码 VarInt，返回 (value, bytes_consumed)"""
    v, shift, c = 0, 0, 0
    while off + c < len(data):
        b = data[off + c]
        v |= (b & 0x7F) << shift
        c += 1
        if not (b & 0x80):
            break
        shift += 7
        if shift >= 32:
            break
    return v & 0xFFFFFFFF, c


def pack_string(s: str) -> bytes:
    """打包 Minecraft 字符串（VarInt 前缀长度）"""
    b = s.encode("utf-8")
    return encode_varint(len(b)) + b


def send_packet(sock: socket.socket, pkt_id: int, data: bytes = b""):
    """发送 Minecraft 数据包"""
    payload = encode_varint(pkt_id) + data
    sock.sendall(encode_varint(len(payload)) + payload)


def recv_packet(sock: socket.socket):
    """接收 Minecraft 数据包，返回 (packet_id, payload_data)"""
    buf = b""
    while True:
        try:
            chunk = sock.recv(8192)
        except socket.timeout:
            return None, None
        if not chunk:
            return None, None
        buf += chunk
        if len(buf) >= 1:
            try:
                length, n = decode_varint(buf, 0)
                if len(buf) >= n + length:
                    pkt_data = buf[n:n + length]
                    pkt_id, m = decode_varint(pkt_data, 0)
                    return pkt_id, pkt_data[m:]
            except (IndexError, struct.error):
                pass
        if len(buf) > 65536:
            return None, None


# ── 版本号反向映射 (protocol → 版本名) ──

PROTOCOL_TO_VERSION: dict[int, str] = {}
for _ver, _proto in PROTOCOL_VERSIONS.items():
    if _proto not in PROTOCOL_TO_VERSION:
        PROTOCOL_TO_VERSION[_proto] = _ver


def parse_version_range(version_name: str, protocol: int) -> str | None:
    """
    从 version.name 字符串中提取支持的客户端版本范围。

    ViaVersion/后端代理通常会在版本名中加入范围信息，常见格式：
    - "1.8-1.21.4" 或 "1.8.x-1.21.x"
    - "1.8.x, 1.12.x-1.21.x"
    - "Paper 1.21.4 (1.8-1.21.4)"
    - "Requires MC 1.8 - 1.21.4"

    返回提取到的范围字符串，或 None。
    """
    # 模式1: X.X[-.x] - Y.Y[-.x]（直接的版本范围）
    m = re.search(
        r'(\d+\.\d+(?:\.\d+)?(?:\.x)?)\s*[-–—]\s*(\d+\.\d+(?:\.\d+)?(?:\.x)?)',
        version_name,
    )
    if m:
        return f"{m.group(1)} ~ {m.group(2)}"

    # 模式2: Requires MC X.X - Y.Y
    m = re.search(
        r'requires?\s*MC\s+(\d+\.\d+(?:\.\d+)?)\s*[-–—]\s*(\d+\.\d+(?:\.\d+)?)',
        version_name,
        re.IGNORECASE,
    )
    if m:
        return f"{m.group(1)} ~ {m.group(2)}"

    # 模式3: 括号中的版本范围 "(1.8-1.21)"
    m = re.search(
        r'\((\d+\.\d+(?:\.\d+)?)\s*[-–—]\s*(\d+\.\d+(?:\.\d+)?)\)',
        version_name,
    )
    if m:
        return f"{m.group(1)} ~ {m.group(2)}"

    # 模式4: 逗号分隔的多个范围，如 "1.8.x, 1.12.x-1.21.x"
    # 提取第一个和最后一个版本号
    versions_in_name = re.findall(r'\d+\.\d+(?:\.\d+)?(?:\.x)?', version_name)
    if len(versions_in_name) >= 2:
        # 过滤掉明显的非版本号（如日期、端口号等）
        vnums = []
        for v in versions_in_name:
            # 确保看起来像 Minecraft 版本：1.x 或 0.x 开头
            if re.match(r'^(?:0|[1-9]\d*)\.[1-9]\d*', v):
                vnums.append(v)
        if len(vnums) >= 2:
            return f"{vnums[0]} ~ {vnums[-1]}"

    # 回退：用 protocol 号反查对应的版本作为参考
    if protocol and protocol in PROTOCOL_TO_VERSION:
        return f"== {PROTOCOL_TO_VERSION[protocol]} (protocol {protocol})"

    return None


# ── MOTD 解析 ──

def strip_minecraft_color(text: str) -> str:
    """去除 Minecraft 颜色代码（§x），返回纯文本"""
    # 先去掉 §x 色彩码（§0-§f, §k-§r, 以及 §x§R§R§G§G§B§B 格式的 RGB）
    # 标准色彩码：§[0-9a-fk-or]
    text = re.sub(r'§[0-9a-fk-or]', '', text, flags=re.IGNORECASE)
    # RGB 色彩码：§x§R§R§G§G§B§B
    text = re.sub(r'§x(?:§[0-9a-f]){6}', '', text, flags=re.IGNORECASE)
    return text


def extract_motd_lines(desc) -> list[str]:
    """从 description 字段提取 MOTD 纯文本行"""
    if isinstance(desc, str):
        lines = desc.split("\n")
    elif isinstance(desc, dict):
        # Chat component 格式
        text_parts = []

        def walk(node):
            if isinstance(node, str):
                text_parts.append(node)
            elif isinstance(node, dict):
                if "text" in node:
                    text_parts.append(node["text"])
                if "extra" in node:
                    for item in node["extra"]:
                        walk(item)
            elif isinstance(node, list):
                for item in node:
                    walk(item)

        walk(desc)
        lines = "".join(text_parts).split("\n")
    else:
        return ["(unknown)"]

    return [strip_minecraft_color(line) for line in lines if line]


# ── Legacy Ping (1.6.x 及更早) ──

def legacy_ping(host: str, port: int, timeout: float) -> dict | None:
    """对 1.6.x 及更早版本的 Minecraft 服务器进行 ping"""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        start = time.monotonic()
        sock.connect((host, port))
        # 发送 legacy ping: 0xFE 0x01 0xFA 0x00 0x0B (Minecraft 1.6) 或 0xFE (更早)
        # 发送主机名长度 + 主机名 + 协议版本
        host_bytes = host.encode("utf-8")
        payload = (
            b"\xFE\x01\xFA"
            + struct.pack(">H", 78)  # 协议魔法值 (1.6)
            + encode_varint(len(host_bytes))
            + host_bytes
            + struct.pack(">I", port)
        )
        sock.sendall(payload)
        data = sock.recv(4096)
        sock.close()
        latency = (time.monotonic() - start) * 1000

        # 解析 legacy 响应：0xFF + 长度 + 字符串(以 § 分隔)
        if data and data[0] == 0xFF:
            raw = data[3:].decode("utf-16-be", errors="replace").strip("\x00")
            # 格式: MOTD§在线§最大
            parts = raw.split("§")
            return {
                "version_name": "Legacy",
                "protocol": 0,
                "online": int(parts[1]) if len(parts) > 1 else 0,
                "max": int(parts[2]) if len(parts) > 2 else 0,
                "motd": strip_minecraft_color(parts[0]) if parts else "",
                "latency": round(latency, 1),
                "legacy": True,
            }
        return None
    except Exception:
        return None
    finally:
        try:
            sock.close()
        except Exception:
            pass


# ── 核心 Ping 逻辑 ──

def ping_server(
    host: str,
    port: int = 25565,
    protocol_version: int | None = None,
    timeout: float = 5.0,
) -> dict | None:
    """
    Ping 一个 Minecraft 服务器，返回状态信息字典。

    返回格式:
    {
        "host": str,
        "port": int,
        "version_name": str,           # 服务器版本名称（含 ViaVersion 等标记）
        "protocol": int,               # 协议版本号
        "protocol_version_name": str,  # 协议号对应的原版版本，如 "1.21.4"
        "version_range": str | None,   # 解析出的版本支持范围，如 "1.8 ~ 1.21.4"
        "online": int,
        "max": int,
        "motd": str,
        "latency": float,              # 毫秒
        "favicon": str | None,         # base64 PNG
        "players_sample": list | None, # 在线玩家列表 [{name, id}, ...]
        "mod_info": dict | None,
        "enforces_secure_chat": bool,
        "previews_chat": bool,
        "legacy": bool,                # 是否为 legacy 响应
    }
    """
    # 确定尝试的协议版本列表
    if protocol_version is not None:
        versions_to_try = [protocol_version]
    else:
        # 从最新到最旧尝试
        seen = set()
        versions_to_try = []
        for v in PROTOCOL_VERSIONS.values():
            if v not in seen:
                seen.add(v)
                versions_to_try.append(v)

    last_error = None

    for pv in versions_to_try:
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(timeout)

            start = time.monotonic()
            sock.connect((host, port))

            # Handshake: STATE=1 (Status)
            hs_data = (
                encode_varint(pv)
                + pack_string(host)
                + struct.pack(">H", port)
                + encode_varint(1)  # next_state = Status
            )
            send_packet(sock, 0x00, hs_data)

            # Status Request
            send_packet(sock, 0x00)

            pkt_id, data = recv_packet(sock)

            # Ping/Pong 可选，用于准确计算延迟
            if pkt_id == 0x00 and data:
                # 发送 Ping 包
                payload = struct.pack(">Q", int(start * 1000))
                send_packet(sock, 0x01, payload)

                _, _ = recv_packet(sock)

            sock.close()
            latency = (time.monotonic() - start) * 1000

            if pkt_id != 0x00 or not data:
                last_error = f"protocol {pv}: unexpected packet id {hex(pkt_id) if pkt_id is not None else 'None'}"
                continue

            length, n = decode_varint(data, 0)
            status_json = data[n:n + length].decode("utf-8", errors="replace")
            status = json.loads(status_json)

            # 解析各种字段
            ver = status.get("version", {})
            players = status.get("players", {})
            desc = status.get("description", "")
            favicon = status.get("favicon", None)
            mod_info = status.get("modinfo", None)

            # 1.19.1+ 安全聊天
            enforce_secure = status.get("enforcesSecureChat", False)
            previews_chat = status.get("previewsChat", False)

            motd_lines = extract_motd_lines(desc)
            motd = "\n".join(motd_lines)

            version_name = ver.get("name", "Unknown")
            protocol = ver.get("protocol", 0)
            version_range = parse_version_range(version_name, protocol)
            proto_ver_str = PROTOCOL_TO_VERSION.get(protocol)

            players_sample = players.get("sample", None)
            players_online = players.get("online", 0)
            players_max = players.get("max", 0)

            return {
                "host": host,
                "port": port,
                "version_name": version_name,
                "protocol": protocol,
                "protocol_version_name": proto_ver_str,
                "version_range": version_range,
                "online": players_online,
                "max": players_max,
                "motd": motd,
                "latency": round(latency, 1),
                "favicon": favicon,
                "players_sample": players_sample,
                "mod_info": mod_info,
                "enforces_secure_chat": enforce_secure,
                "previews_chat": previews_chat,
                "legacy": False,
            }

        except socket.timeout:
            last_error = f"protocol {pv}: connection timed out"
        except ConnectionRefusedError:
            last_error = f"protocol {pv}: connection refused"
            break  # 连接被拒绝，不需要再试
        except Exception as e:
            last_error = f"protocol {pv}: {e}"
        finally:
            try:
                sock.close()
            except Exception:
                pass

    # 现代协议全部失败？尝试 legacy ping
    legacy = legacy_ping(host, port, timeout)
    if legacy:
        legacy.update({"host": host, "port": port})
        return legacy

    if last_error:
        print(f"  [warn] 所有协议版本均失败，最后错误: {last_error}")
    return None


# ── 格式化输出 ──

def print_result(result: dict | None, host: str, port: int):
    """格式化打印 ping 结果"""
    if result is None:
        print(f"\n  ✗ 无法连接到 {host}:{port}")
        return

    width = 50
    print()
    print("  " + "=" * width)

    lat_str = f"{result['latency']}ms"
    lat_icon = ""
    if result["latency"] < 50:
        lat_icon = "[快]"
    elif result["latency"] < 150:
        lat_icon = "[中]"
    else:
        lat_icon = "[慢]"

    print(f"  Server    : {result['host']}:{result['port']}")
    print(f"  Version   : {result['version_name']} (protocol {result['protocol']})")

    # 版本支持范围
    vr = result.get("version_range")
    if vr:
        print(f"  Supports  : {vr}")

    # 协议号对应的原版版本
    pvn = result.get("protocol_version_name")
    if pvn and pvn not in (result.get("version_name") or ""):
        print(f"  Protocol  : {result['protocol']} -> {pvn}")

    print(f"  Latency   : {lat_icon} {lat_str}")
    print(f"  Players   : {result['online']}/{result['max']}")

    # MOTD
    if result["motd"]:
        motd_lines = result["motd"].split("\n")
        print(f"  MOTD      :")
        for line in motd_lines:
            print(f"    {line}")

    # 在线玩家名称
    sample = result.get("players_sample")
    if sample:
        names = [p["name"] for p in sample]
        print(f"  Online    : ({len(names)} 人)")
        # 每行最多 5 个，多列显示
        for i in range(0, len(names), 5):
            chunk = names[i:i + 5]
            print(f"    " + "  ".join(f"{n:<16}" for n in chunk))

    # 安全聊天
    if result.get("enforces_secure_chat"):
        print(f"  Chat      : secure chat enforced")

    # Mod 信息
    mod_info = result.get("mod_info")
    if mod_info:
        mod_type = mod_info.get("type", "unknown")
        mod_list = mod_info.get("modList", [])
        print(f"  Mods      : {mod_type} ({len(mod_list)} mods)")
        if mod_list:
            mod_names = [m.get("modid", "?") for m in mod_list[:8]]
            preview = ", ".join(mod_names)
            if len(mod_list) > 8:
                preview += f" ... (+{len(mod_list) - 8})"
            print(f"    {preview}")

    # Favicon 信息
    if result.get("favicon"):
        print(f"  Favicon   : available ({len(result['favicon'])} bytes base64)")

    if result.get("legacy"):
        print(f"  Type      : legacy ping")

    print("  " + "=" * width)
    print()


# ── CLI 入口 ──

def load_config_defaults() -> tuple[str, int]:
    """从 config.json 读取默认服务器地址"""
    cfg_path = os.path.join(os.path.dirname(__file__), "config.json")
    host, port = "127.0.0.1", 25565
    try:
        with open(cfg_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        server = cfg.get("server", {})
        host = server.get("host", host)
        port = server.get("port", port)
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    return host, port


def parse_args():
    default_host, default_port = load_config_defaults()
    parser = argparse.ArgumentParser(
        description="ping 一个 Minecraft 服务器",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python ping_server.py
  python ping_server.py --host mc.example.com
  python ping_server.py --host mc.example.com --port 25566
  python ping_server.py --host mc.example.com --version 767
  python ping_server.py --timeout 10
        """,
    )
    parser.add_argument(
        "--host", "-H",
        default=default_host,
        help=f"服务器地址 (默认: {default_host})",
    )
    parser.add_argument(
        "--port", "-p",
        type=int,
        default=default_port,
        help=f"服务器端口 (默认: {default_port})",
    )
    parser.add_argument(
        "--version", "-v",
        type=int,
        default=None,
        metavar="PROTO",
        help="指定协议版本号 (默认自动检测)",
    )
    parser.add_argument(
        "--timeout", "-t",
        type=float,
        default=5.0,
        help="连接超时秒数 (默认: 5)",
    )
    parser.add_argument(
        "--json", "-j",
        action="store_true",
        help="以 JSON 格式输出",
    )
    parser.add_argument(
        "--no-legacy",
        action="store_true",
        help="不尝试 legacy ping",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    print(f"Pinging {args.host}:{args.port} ...")

    result = ping_server(
        host=args.host,
        port=args.port,
        protocol_version=args.version,
        timeout=args.timeout,
    )

    # 如果现代 ping 失败但没禁止 legacy，尝试 legacy
    if result is None and not args.no_legacy:
        print("  Trying legacy ping...")
        result = legacy_ping(args.host, args.port, args.timeout)
        if result:
            result.update({"host": args.host, "port": args.port})

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print_result(result, args.host, args.port)


if __name__ == "__main__":
    main()
