"""
ping_server.py — 查询 Minecraft 服务器版本
用法: python ping_server.py
"""
import socket
import struct
import json

def encode_varint(v):
    buf = bytearray()
    while True:
        t = v & 0x7F
        v >>= 7
        if v:
            t |= 0x80
        buf.append(t)
        if v == 0:
            break
    return bytes(buf)

def decode_varint(data, off=0):
    v, shift, c = 0, 0, 0
    while True:
        b = data[off + c]
        v |= (b & 0x7F) << shift
        c += 1
        if not (b & 0x80):
            break
        shift += 7
    return v, c

def pack_string(s):
    b = s.encode("utf-8")
    return encode_varint(len(b)) + b

def send_packet(sock, pkt_id, data=b""):
    payload = encode_varint(pkt_id) + data
    sock.sendall(encode_varint(len(payload)) + payload)

def recv_packet(sock):
    buf = b""
    while True:
        buf += sock.recv(8192)
        if len(buf) >= 1:
            try:
                length, n = decode_varint(buf, 0)
                if len(buf) >= n + length:
                    pkt_data = buf[n:n + length]
                    pkt_id, m = decode_varint(pkt_data, 0)
                    return pkt_id, pkt_data[m:]
            except:
                pass
        if len(buf) > 65536:
            return None, None

for version in [767, 768, 769]:
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(5)
        sock.connect(("mc.weeaxe.cn", 25565))

        # Handshake (STATE=1 -> Status)
        hs_data = encode_varint(version) + pack_string("mc.weeaxe.cn") + struct.pack(">H", 25565) + encode_varint(1)
        send_packet(sock, 0x00, hs_data)

        # Status Request (0x00)
        send_packet(sock, 0x00)

        pkt_id, data = recv_packet(sock)
        sock.close()

        if pkt_id == 0x00 and data:
            length, _ = decode_varint(data, 0)
            status_json = data[_: _ + length].decode("utf-8", errors="replace")
            status = json.loads(status_json)
            ver = status.get("version", {})
            players = status.get("players", {})
            desc = status.get("description", "")
            print(f"[version={version}] Server: {ver.get('name')} (proto {ver.get('protocol')})")
            print(f"  Online: {players.get('online')}/{players.get('max')}")
            if desc:
                print(f"  Desc: {str(desc)[:80]}")
        else:
            print(f"[version={version}] No status response")
    except Exception as e:
        print(f"[version={version}] Error: {e}")
    print()
