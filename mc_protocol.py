"""
mc_protocol.py — 轻量 Minecraft Java Edition 协议实现
======================================================
仅实现 Bot 必要的封包类型：握手、登录、聊天、命令、MIDI 建议。
协议版本 769 (Minecraft 1.21.4)，可在顶部 PROTOCOL_VERSION 修改。
"""

import socket
import struct
import threading
import uuid
import logging
import zlib

logger = logging.getLogger("mc_protocol")

# ── 协议版本（可修改以适配不同服务器） ──
PROTOCOL_VERSION = 769  # 1.21.4 ;; 767=1.21.1, 768=1.21.2, 769=1.21.4

# ── 状态常量 ──
STATE_HANDSHAKING   = 0
STATE_STATUS        = 1
STATE_LOGIN         = 2
STATE_CONFIGURATION = 3
STATE_PLAY          = 4


# ═══════════════════════════════════════════════════════
#  VarInt 编解码
# ═══════════════════════════════════════════════════════

def encode_varint(value: int) -> bytes:
    """整数 → VarInt 字节"""
    result = bytearray()
    while True:
        temp = value & 0x7F
        value >>= 7
        if value != 0:
            temp |= 0x80
        result.append(temp)
        if value == 0:
            break
    return bytes(result)


def decode_varint(data: bytes, offset: int = 0) -> tuple[int, int]:
    """VarInt 字节 → (值, 消耗字节数)"""
    value = 0
    shift = 0
    consumed = 0
    while True:
        if offset + consumed >= len(data):
            raise ValueError("VarInt too short")
        b = data[offset + consumed]
        value |= (b & 0x7F) << shift
        consumed += 1
        if not (b & 0x80):
            break
        shift += 7
        if shift >= 35:
            raise ValueError("VarInt too long")
    return value, consumed


def encode_string(s: str) -> bytes:
    """字符串 → VarInt 长度前缀 + UTF-8"""
    raw = s.encode("utf-8")
    return encode_varint(len(raw)) + raw


def decode_string(data: bytes, offset: int = 0) -> tuple[str, int]:
    """字节 → (字符串, 消耗字节数)"""
    length, consumed = decode_varint(data, offset)
    start = offset + consumed
    return data[start:start + length].decode("utf-8"), consumed + length


def encode_uuid(u: uuid.UUID) -> bytes:
    return u.bytes  # 16 字节大端


def decode_nbt_text(data: bytes, offset: int = 0) -> tuple[str, int]:
    """
    从 NBT anonymousNbt 数据中提取所有字符串值（用于 System Chat 解析）。
    1.21.4 的 System Chat (0x73 S->C) 使用 NBT 格式编码聊天组件。
    返回 (拼接文本, 消耗字节数)。
    """
    texts: list[str] = []
    pos = offset

    def _read_value(tag_type: int):
        nonlocal pos
        if tag_type == 0x01:           # TAG_Byte
            pos += 1
        elif tag_type == 0x02:         # TAG_Short
            pos += 2
        elif tag_type in (0x03, 0x05): # TAG_Int / TAG_Float
            pos += 4
        elif tag_type in (0x04, 0x06): # TAG_Long / TAG_Double
            pos += 8
        elif tag_type == 0x07:         # TAG_Byte_Array
            n = struct.unpack(">i", data[pos:pos + 4])[0]
            pos += 4 + n
        elif tag_type == 0x08:         # TAG_String — 收集文本
            n = struct.unpack(">H", data[pos:pos + 2])[0]
            pos += 2
            try:
                texts.append(data[pos:pos + n].decode("utf-8"))
            except UnicodeDecodeError:
                pass
            pos += n
        elif tag_type == 0x09:         # TAG_List
            lt = data[pos]; pos += 1
            cnt = struct.unpack(">i", data[pos:pos + 4])[0]
            pos += 4
            for _ in range(cnt):
                _read_value(lt)
        elif tag_type == 0x0A:         # TAG_Compound
            while pos < len(data) and data[pos] != 0x00:
                _read_tag()
            pos += 1  # TAG_End
        elif tag_type == 0x0B:         # TAG_Int_Array
            n = struct.unpack(">i", data[pos:pos + 4])[0]
            pos += 4 + n * 4
        elif tag_type == 0x0C:         # TAG_Long_Array
            n = struct.unpack(">i", data[pos:pos + 4])[0]
            pos += 4 + n * 8

    def _read_tag():
        nonlocal pos
        tag_type = data[pos]; pos += 1
        if tag_type == 0x00:
            return  # TAG_End
        name_len = struct.unpack(">H", data[pos:pos + 2])[0]
        pos += 2 + name_len
        _read_value(tag_type)

    # anonymousNbt 以 TAG_Compound (0x0A) 开头
    if pos < len(data) and data[pos] == 0x0A:
        pos += 1
        while pos < len(data) and data[pos] != 0x00:
            _read_tag()
        pos += 1  # TAG_End

    return " ".join(t for t in texts if t), pos - offset


# ═══════════════════════════════════════════════════════
#  封包
# ═══════════════════════════════════════════════════════

class Packet:
    """封包帧格式: VarInt(总长度) + VarInt(封包ID) + 数据"""

    def __init__(self, packet_id: int, data: bytes = b""):
        self.packet_id = packet_id
        self.data = data

    def encode(self) -> bytes:
        id_bytes = encode_varint(self.packet_id)
        payload = id_bytes + self.data
        return encode_varint(len(payload)) + payload


# ═══════════════════════════════════════════════════════
#  连接管理
# ═══════════════════════════════════════════════════════

class Connection:
    """TCP 连接 + 封包收发 + 登录流程"""

    def __init__(self, host: str, port: int = 25565):
        self.host = host
        self.port = port
        self.sock: socket.socket | None = None
        self.state = STATE_HANDSHAKING
        self._running = False
        self._recv_thread: threading.Thread | None = None
        self.buffer = b""
        self._compress_threshold = -1  # -1=未启用压缩

        # packet_id → handler(conn, packet_id, payload)
        self._handlers: dict[int, callable] = {}
        # 通用监听器 (conn, packet_id, payload)
        self._listeners: list[callable] = []

    def enable_compression(self, threshold: int):
        """启用 zlib 压缩，threshold 为压缩阈值"""
        self._compress_threshold = threshold
        logger.info(f"已启用封包压缩 (threshold={threshold})")

    # ── 连接 ──

    def connect(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.connect((self.host, self.port))
        self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self._running = True
        self._recv_thread = threading.Thread(target=self._recv_loop, daemon=True)
        self._recv_thread.start()

    def disconnect(self):
        self._running = False
        if self.sock:
            try:
                self.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self.sock.close()
            self.sock = None

    # ── 原始发送 ──

    def send_packet(self, packet_id: int, data: bytes = b""):
        """发送封包（自动处理压缩）"""
        id_bytes = encode_varint(packet_id)
        payload = id_bytes + data

        if self._compress_threshold >= 0:
            # 压缩模式: VarInt(总长) + VarInt(解压后长度) + 数据
            if len(payload) >= self._compress_threshold:
                compressed = zlib.compress(payload)
                frame_data = encode_varint(len(payload)) + compressed
            else:
                frame_data = encode_varint(0) + payload
        else:
            # 无压缩: VarInt(总长) + payload
            frame_data = payload

        raw = encode_varint(len(frame_data)) + frame_data
        if self.sock:
            try:
                self.sock.sendall(raw)
            except OSError as e:
                logger.error(f"发送封包失败: {e}")

    # ── 协议封包 ──

    def send_handshake(self, next_state: int):
        """Handshake (0x00) → 状态切换"""
        data = (
            encode_varint(PROTOCOL_VERSION)
            + encode_string(self.host)
            + struct.pack(">H", self.port)
            + encode_varint(next_state)
        )
        self.send_packet(0x00, data)

    def send_login_start(self, username: str):
        """Login Start (0x00), 含 UUID (1.20.5+)"""
        data = encode_string(username) + encode_uuid(uuid.uuid4())
        self.send_packet(0x00, data)

    def send_login_acknowledged(self):
        """Login Acknowledged (0x03, LOGIN 状态 serverbound, 1.20.5+) — 确认收到 Login Success"""
        self.send_packet(0x03)

    def send_client_information(self):
        """Client Information (0x00, CONFIGURATION 状态, 协议 768+)"""
        data = (
            encode_string("zh_CN")      # locale
            + struct.pack(">b", 2)      # view distance
            + encode_varint(0)          # chat mode: FULL
            + struct.pack(">?", True)   # chat colors
            + struct.pack(">B", 0x7F)   # skin parts
            + encode_varint(1)          # main hand: RIGHT
            + struct.pack(">?", False)  # text filtering
            + struct.pack(">?", True)   # allow server listings
            + encode_varint(0)          # particle status: ALL (1.21.2+)
        )
        self.send_packet(0x00, data)

    def send_acknowledge_finish_config(self):
        """Acknowledge Finish Configuration (0x03, serverbound)"""
        self.send_packet(0x03)

    def send_select_known_packs(self):
        """Select Known Packs (0x07, CONFIGURATION serverbound) — 回复空列表"""
        self.send_packet(0x07, encode_varint(0))  # 0 entries

    def send_chat_message(self, message: str):
        """Chat Message (0x07, PLAY C->S) — 发送公聊 (1.21.4 格式)"""
        data = (
            encode_string(message)
            + struct.pack(">q", 0)          # timestamp = 0
            + struct.pack(">q", 0)          # salt = 0
            + struct.pack(">?", False)      # signature: none
            + encode_varint(0)              # offset = 0
            + b"\x00\x00\x00"              # acknowledged (3 bytes)
        )
        self.send_packet(0x07, data)

    def send_chat_command(self, command: str):
        """Chat Command (0x05, PLAY C->S) — 执行命令"""
        data = encode_string(command)
        self.send_packet(0x05, data)

    def send_client_command(self, action: int = 0):
        """Client Command (0x0A, PLAY C->S). action=0 → PERFORM_RESPAWN"""
        data = encode_varint(action)
        self.send_packet(0x0A, data)

    def send_command_suggestion(self, transaction_id: int, text: str):
        """Tab Complete (0x0D, PLAY C->S) — 用于 MIDI 传 Unicode 字符"""
        data = encode_varint(transaction_id) + encode_string(text)
        self.send_packet(0x0D, data)

    def send_keep_alive(self, keep_alive_id: int):
        """Keep Alive (0x1A, PLAY state serverbound) — 回应服务器心跳
           1.21.4: clientbound=0x27, serverbound=0x1A"""
        data = struct.pack(">q", keep_alive_id)
        self.send_packet(0x1A, data)

    def send_plugin_response(self, msg_id: int, successful: bool, data: bytes = b""):
        """
        Login Plugin Response (0x02, LOGIN state serverbound)
        格式: VarInt(MessageId) + Boolean(Successful) + Optional ByteArray(Data)
        """
        resp = encode_varint(msg_id) + struct.pack(">?", successful)
        if successful and data:
            resp += encode_varint(len(data)) + data
        self.send_packet(0x02, resp)

    # ── 封包处理 ──

    def on_packet(self, packet_id: int):
        """装饰器: 注册特定封包类型的处理器"""
        def decorator(func):
            self._handlers[packet_id] = func
            return func
        return decorator

    def add_listener(self, callback: callable):
        """注册通用封包监听器 (conn, packet_id, payload)"""
        self._listeners.append(callback)

    def remove_listener(self, callback: callable):
        """移除已注册的通用封包监听器"""
        try:
            self._listeners.remove(callback)
        except ValueError:
            pass

    def _recv_loop(self):
        """后台接收循环"""
        while self._running and self.sock:
            try:
                data = self.sock.recv(8192)
                if not data:
                    logger.warning("recv 返回空，连接可能断开")
                    break
                logger.debug(f"[RECV] 收到 {len(data)} 字节 (state={self.state})")
                self.buffer += data
                self._process_buffer()
            except (ConnectionError, OSError, TimeoutError) as e:
                if self._running:
                    logger.warning(f"连接断开: {e}")
                break
            except Exception as e:
                logger.error(f"_recv_loop 未处理异常: {e}", exc_info=True)
                break
        self._running = False

    def _process_buffer(self):
        """从缓冲区解析完整封包并分发（自动处理压缩）"""
        while True:
            if len(self.buffer) < 1:
                break
            consumed = 0
            try:
                length, len_bytes = decode_varint(self.buffer, 0)

                if self._compress_threshold >= 0:
                    # 压缩模式: VarInt(总长) + VarInt(解压后长度) + 数据
                    if len(self.buffer) < len_bytes + length:
                        break
                    frame_data = self.buffer[len_bytes:len_bytes + length]
                    consumed = len_bytes + length
                    data_len, dl_bytes = decode_varint(frame_data, 0)
                    data = frame_data[dl_bytes:]
                    if data_len > 0:
                        data = zlib.decompress(data)
                else:
                    # 无压缩: VarInt(总长) + payload
                    if len(self.buffer) < len_bytes + length:
                        break
                    data = self.buffer[len_bytes:len_bytes + length]
                    consumed = len_bytes + length

                pkt_id, id_bytes = decode_varint(data, 0)
                payload = data[id_bytes:]

                # 分发到注册的处理器
                handler = self._handlers.get(pkt_id)
                if handler:
                    try:
                        handler(self, pkt_id, payload)
                    except Exception as e:
                        logger.error(f"封包处理器错误 (id=0x{pkt_id:02X}): {e}")

                # 通用监听器
                for lst in self._listeners:
                    try:
                        lst(self, pkt_id, payload)
                    except Exception as e:
                        logger.error(f"监听器错误: {e}")

                # 清除已处理数据
                self.buffer = self.buffer[consumed:]

            except ValueError:
                break  # VarInt 不完整，等待更多数据
            except zlib.error as e:
                logger.error(f"zlib 解压失败: {e}")
                self.buffer = self.buffer[consumed:] if consumed else self.buffer
                break

    # ── 登录流程 ──

    # 已知代理/登录插件通道列表
    PLUGIN_CHANNEL_HANDLERS = {
        "velocity:player_info":   "Velocity 现代转发 (1.20.5+)",
        "bungeecord:main":        "BungeeCord 转发",
    }

    def _handle_login_plugin(self, data: bytes) -> bool:
        """
        处理 LOGIN 状态的 Plugin Request (0x04)。
        返回 True 表示该通道已处理（回复已发送），False 表示需要发送默认拒绝。
        """
        try:
            msg_id, off = decode_varint(data, 0)
            channel, off2 = decode_string(data, off)
            plugin_data = data[off2:]  # 通道剩余数据

            channel_desc = self.PLUGIN_CHANNEL_HANDLERS.get(channel, f"未知通道")
            logger.info(f"[Login Plugin] {channel_desc}: {channel} (msg_id={msg_id}, data={len(plugin_data)}B)")

            if channel == "velocity:player_info":
                # Velocity 现代转发格式 (1.20.5+):
                # 数据包含转发的玩家 UUID 和用户名（在线模式下由代理填充）
                # 离线模式下此数据为空或默认值，回复空数据即表示接受
                self.send_plugin_response(msg_id, True, b"")
                return True

            elif channel == "bungeecord:main":
                # BungeeCord 转发: 期望回复 "bungeecord:hello" 或类似握手
                self.send_plugin_response(msg_id, False)
                return True

        except Exception as e:
            logger.error(f"解析 Login Plugin Request 失败: {e}")

        return False  # 未处理，需要默认回复

    def login(self, username: str) -> bool:
        """
        完整的离线模式登录流程 (1.20.5+):
        HANDSHAKE → LOGIN → CONFIGURATION → PLAY
        """
        # Step 1: Handshake
        self.send_handshake(STATE_LOGIN)

        # Step 2: Login Start
        self.send_login_start(username)
        self.state = STATE_LOGIN
        logger.info("已发送 Login Start...")

        # Step 3: 等待 Login Success (0x02)
        login_ok = threading.Event()
        login_success = [False]

        def _on_login(conn, pkt_id, data):
            if self.state != STATE_LOGIN:
                return
            if pkt_id == 0x02:  # Login Success
                logger.info("Login Success!")
                login_success[0] = True
                login_ok.set()
            elif pkt_id == 0x04:  # Login Plugin Request
                if not self._handle_login_plugin(data):
                    # 未识别的通道，发送 Not Successful
                    try:
                        msg_id, _ = decode_varint(data, 0)
                        self.send_plugin_response(msg_id, False)
                    except Exception:
                        pass
            elif pkt_id == 0x03:  # Set Compression
                threshold, _ = decode_varint(data, 0)
                self.enable_compression(threshold)
            elif pkt_id == 0x00:  # Disconnect
                self._log_disconnect_reason(data)
                login_ok.set()

        self.add_listener(_on_login)

        if not login_ok.wait(timeout=15):
            raise TimeoutError("登录超时，未收到服务器响应")
        if not login_success[0]:
            raise ConnectionError("登录被服务器拒绝")
        if not self._running:
            raise ConnectionError("登录期间连接断开")

        # LOGIN 完成，移除登录监听器
        self.remove_listener(_on_login)

        # Step 3.5: 发送 Login Acknowledged (1.20.5+)
        self.send_login_acknowledged()
        logger.info("已发送 Login Acknowledged")

        self.state = STATE_CONFIGURATION
        logger.info("已登录，进入 CONFIGURATION 状态...")

        # Step 4: CONFIGURATION 阶段
        # 4a. 立即发送 Client Information（服务器在等这个）
        self.send_client_information()
        logger.info("已发送 Client Information")

        # 4b. 等待 Finish Configuration (0x03)
        config_done = threading.Event()

        def _on_config(conn, pkt_id, data):
            if self.state != STATE_CONFIGURATION:
                return
            if pkt_id == 0x00:  # Cookie Request (clientbound)
                key, _ = decode_string(data, 0)
                logger.info(f"Cookie Request: key={key}")
                self.send_packet(0x01, encode_string(key) + struct.pack(">?", False))
            elif pkt_id == 0x01:  # Plugin Message (brand, etc.)
                channel, off = decode_string(data, 0)
                logger.info(f"Plugin Message: channel={channel}")
                if channel == "minecraft:brand":
                    self.send_packet(0x02, encode_string(channel) + encode_string("PythonMCBot"))
            elif pkt_id == 0x04:  # Keep Alive (clientbound, CONFIGURATION state)
                self.send_packet(0x04, data)
            elif pkt_id == 0x05:  # Ping
                self.send_packet(0x05, data)  # Pong
            elif pkt_id == 0x0E:  # Known Packs (1.21.4: 0x0E)
                self.send_select_known_packs()
            elif pkt_id == 0x03:  # Finish Configuration (clientbound)
                logger.info("收到 Finish Configuration")
                self.send_acknowledge_finish_config()
                self.state = STATE_PLAY
                config_done.set()

        self.add_listener(_on_config)

        if not config_done.wait(timeout=15):
            raise TimeoutError("配置阶段超时")
        if not self._running:
            raise ConnectionError("配置阶段连接断开")

        # CONFIGURATION 完成，移除配置监听器
        self.remove_listener(_on_config)

        logger.info("配置完成，进入 PLAY 状态 ✓")

        # Step 5: 注册 PLAY 状态必需的处理器
        self._setup_play_handlers()

        return True

    def _log_disconnect_reason(self, data: bytes):
        """解析并记录服务器断开原因 (1.21.4 使用 NBT 格式)"""
        try:
            # 1.21.4: Disconnect 使用 anonymousNbt 格式
            nbt_text, _ = decode_nbt_text(data, 0)
            if nbt_text:
                logger.error(f"连接断开: {nbt_text} (原始: {data.hex()[:100]})")
                return

            # 旧格式 fallback: JSON 字符串
            reason_json, _ = decode_string(data, 0)
            import json
            reason_obj = json.loads(reason_json)

            def _extract(obj):
                if isinstance(obj, str):
                    return obj
                if isinstance(obj, dict):
                    parts = []
                    if "text" in obj:
                        parts.append(obj["text"])
                    if "translate" in obj:
                        parts.append(f"[{obj['translate']}]")
                    for e in obj.get("extra", []):
                        parts.append(_extract(e))
                    return "".join(parts)
                return str(obj)
            reason = _extract(reason_obj)
            logger.error(f"登录被拒绝: {reason} (原始: {data.hex()[:100]})")
        except Exception:
            logger.error(f"收到 Disconnect，原始数据: {data.hex()[:100]}")

    def _setup_play_handlers(self):
        """注册 PLAY 状态必需的封包处理器（Keep Alive、Disconnect 等）"""
        # Keep Alive — 必须回应，否则会被踢
        # 1.21.4: clientbound=0x27, serverbound=0x1A
        self.add_listener(self._on_play_packet)

    def _on_play_packet(self, conn, pkt_id: int, data: bytes):
        """PLAY 状态通用封包处理"""
        if self.state != STATE_PLAY:
            return
        if pkt_id == 0x27:  # Keep Alive (clientbound PLAY, 1.21.4)
            keep_alive_id = struct.unpack(">q", data[:8])[0]
            self.send_keep_alive(keep_alive_id)
        elif pkt_id == 0x1D:  # Disconnect (clientbound PLAY, 1.21.4)
            self._log_disconnect_reason(data)
            self._running = False
