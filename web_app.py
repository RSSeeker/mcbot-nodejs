"""
web_app.py — mcbot 网页可视化控制面板
======================================
基于 Flask + Flask-SocketIO 的 Web 控制台，
提供实时状态监控、移动控制、动作按钮、聊天等功能。

启动方式:
    python web_app.py

然后浏览器打开 http://localhost:5000
"""

import logging
import json
import os
import threading
import time

from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit

from bot_controller import BotController
from chat_processor import _extract_plain, process_chat
from commands import register_all

logger = logging.getLogger("web")
logging.basicConfig(level=logging.INFO, format="[%(name)s] %(message)s")

app = Flask(__name__, template_folder=os.path.join(os.path.dirname(__file__), "templates"))
app.config["SECRET_KEY"] = "mcbot-web-console"
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

# 加载配置文件
_config_path = os.path.join(os.path.dirname(__file__), "config.json")
with open(_config_path, "r", encoding="utf-8") as _f:
    _config = json.load(_f)

register_all()

bot: BotController | None = None
_last_config_overrides: dict = {}
_status_thread: threading.Thread | None = None
_status_running = False

# ── 状态缓存 ──
_current_status: dict = {
    "connected": False,
    "position": {"x": 0, "y": 0, "z": 0},
    "health": 0,
    "food": 0,
    "saturation": 0,
    "gamemode": "",
    "dimension": "",
    "yaw": 0,
    "pitch": 0,
    "heldItem": "",
    "isSprinting": False,
    "isSneaking": False,
    "isCrawling": False,
    "isRiding": False,
    "username": "",
    "host": "",
    "port": 0,
}
_chat_log: list[dict] = []
_event_log: list[dict] = []


# ═══════════════════════════════════
#  Flask 路由
# ═══════════════════════════════════

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/status")
def api_status():
    return jsonify(_current_status)


@app.route("/api/chat")
def api_chat():
    return jsonify(_chat_log[-100:])


@app.route("/api/events")
def api_events():
    return jsonify(_event_log[-50:])


@app.route("/api/config")
def api_config():
    return jsonify(_config)


# ═══════════════════════════════════
#  SocketIO 事件
# ═══════════════════════════════════

@socketio.on("connect")
def on_connect():
    logger.info("Web 客户端已连接")
    emit("status", _current_status)
    emit("chat_history", _chat_log[-50:])


@socketio.on("connect_bot")
def on_connect_bot(data: dict | None = None):
    global bot, _last_config_overrides
    if bot is not None and bot.is_connected():
        emit("log", {"level": "warning", "msg": "Bot 已连接，请先断开"})
        return

    try:
        overrides = {}
        if data:
            for key in ["host", "port", "version", "username", "password", "command_prefix"]:
                if key in data:
                    overrides[key] = data[key]
            if "port" in overrides:
                overrides["port"] = int(overrides["port"])
        _last_config_overrides = overrides.copy()

        bot = BotController(**overrides)
        bot.connect()

        bot.on("login", lambda e: _handle_event("login", e))
        bot.on("spawn", lambda e: _handle_event("spawn", e))
        bot.on("death", lambda e: _handle_event("death", e))
        bot.on("kicked", lambda e: _handle_event("kicked", e))
        bot.on("end", lambda e: _handle_event("end", e))
        bot.on("error", lambda e: _handle_event("error", e))
        bot.on("player_joined", lambda e: _handle_event("player_joined", e))
        bot.on("player_left", lambda e: _handle_event("player_left", e))
        bot.on("chat", lambda e: _handle_chat(e))
        bot.on("message", lambda e: _handle_message(e))

        _current_status["connected"] = True
        _current_status["username"] = bot.username
        _current_status["host"] = bot.host
        _current_status["port"] = bot.port

        _start_status_polling()
        _add_event("success", f"Bot 已连接到 {bot.host}:{bot.port}")
        emit("log", {"level": "success", "msg": f"Bot 已连接到 {bot.host}:{bot.port}"})
        emit("bot_connected", {
            "username": bot.username,
            "host": bot.host,
            "port": bot.port,
        })
    except Exception as e:
        _add_event("error", f"连接失败: {e}")
        emit("log", {"level": "error", "msg": f"连接失败: {e}"})
        emit("bot_error", {"msg": str(e)})


@socketio.on("disconnect_bot")
def on_disconnect_bot():
    global bot
    _stop_status_polling()
    if bot:
        try:
            bot.disconnect()
        except Exception:
            pass
        bot = None
    _current_status["connected"] = False
    _add_event("info", "Bot 已断开")
    emit("log", {"level": "info", "msg": "Bot 已断开"})
    emit("bot_disconnected")


@socketio.on("restart_bot")
def on_restart_bot():
    global bot
    _stop_status_polling()
    if bot:
        try:
            bot.disconnect()
        except Exception:
            pass
        bot = None
    _current_status["connected"] = False
    emit("bot_disconnected")
    _add_event("info", "Bot 正在重启...")
    emit("log", {"level": "info", "msg": "Bot 正在重启..."})
    try:
        bot = BotController(**_last_config_overrides)
        bot.connect()
        bot.on("login", lambda e: _handle_event("login", e))
        bot.on("spawn", lambda e: _handle_event("spawn", e))
        bot.on("death", lambda e: _handle_event("death", e))
        bot.on("kicked", lambda e: _handle_event("kicked", e))
        bot.on("end", lambda e: _handle_event("end", e))
        bot.on("error", lambda e: _handle_event("error", e))
        bot.on("player_joined", lambda e: _handle_event("player_joined", e))
        bot.on("player_left", lambda e: _handle_event("player_left", e))
        bot.on("chat", lambda e: _handle_chat(e))
        bot.on("message", lambda e: _handle_message(e))
        _current_status["connected"] = True
        _current_status["username"] = bot.username
        _current_status["host"] = bot.host
        _current_status["port"] = bot.port
        _start_status_polling()
        _add_event("success", f"Bot 已重启并连接到 {bot.host}:{bot.port}")
        emit("log", {"level": "success", "msg": f"Bot 已重启并连接到 {bot.host}:{bot.port}"})
        emit("bot_connected", {
            "username": bot.username,
            "host": bot.host,
            "port": bot.port,
        })
    except Exception as e:
        _add_event("error", f"重启失败: {e}")
        emit("log", {"level": "error", "msg": f"重启失败: {e}"})
        emit("bot_error", {"msg": str(e)})


@socketio.on("chat")
def on_chat(data: dict):
    msg = data.get("message", "").strip()
    if not msg:
        return
    if bot and bot.is_connected():
        bot.chat(msg)
        _chat_log.append({"sender": bot.username, "message": msg, "time": time.time()})
        emit("chat_msg", {"sender": bot.username, "message": msg})


@socketio.on("command")
def on_command(data: dict):
    cmd = data.get("command", "").strip()
    if not cmd:
        return
    if bot and bot.is_connected():
        bot.run_command(cmd)
        _add_event("cmd", f"/{cmd}")
        emit("log", {"level": "info", "msg": f"执行命令: /{cmd}"})


@socketio.on("move")
def on_move(data: dict):
    direction = data.get("direction", "")
    duration = data.get("duration", 1000)
    if bot and bot.is_connected():
        bot.move(direction, duration)


@socketio.on("jump")
def on_jump():
    if bot and bot.is_connected():
        bot.jump()


@socketio.on("stop")
def on_stop():
    if bot and bot.is_connected():
        bot.stop()


@socketio.on("sneak")
def on_sneak(data: dict | None = None):
    if bot and bot.is_connected():
        state = data.get("state") if data else None
        bot.sneak(state)


@socketio.on("sprint")
def on_sprint(data: dict | None = None):
    if bot and bot.is_connected():
        state = data.get("state") if data else None
        bot.sprint(state)


@socketio.on("action")
def on_action(data: dict):
    action = data.get("action", "")
    if not bot or not bot.is_connected():
        return
    action_map = {
        "attack": bot.attack,
        "attack_hold": bot.attack_hold,
        "dig": bot.dig,
        "dig_hold": bot.dig_hold,
        "place": bot.place,
        "interact": bot.interact,
        "use_item": bot.use_item,
        "use_item_hold": bot.use_item_hold,
        "drop": bot.drop,
        "drop_all": bot.drop_all,
        "dismount": bot.dismount,
        "cancel": bot.cancel,
        "respawn": bot.respawn,
    }
    fn = action_map.get(action)
    if fn:
        fn()
        _add_event("action", action)
        emit("log", {"level": "info", "msg": f"动作: {action}"})


@socketio.on("look")
def on_look(data: dict):
    if not bot or not bot.is_connected():
        return
    yaw = data.get("yaw")
    pitch = data.get("pitch", 0)
    if yaw is not None:
        bot.look(float(yaw), float(pitch))


@socketio.on("rotate")
def on_rotate(data: dict):
    if not bot or not bot.is_connected():
        return
    dyaw = data.get("dyaw", 0)
    dpitch = data.get("dpitch", 0)
    bot.rotate(float(dyaw), float(dpitch))


@socketio.on("goto")
def on_goto(data: dict):
    if not bot or not bot.is_connected():
        return
    x = data.get("x", 0)
    y = data.get("y", 0)
    z = data.get("z", 0)
    bot.goto(int(x), int(y), int(z))
    _add_event("goto", f"({x}, {y}, {z})")
    emit("log", {"level": "info", "msg": f"寻路到 ({x}, {y}, {z})"})


@socketio.on("follow")
def on_follow(data: dict):
    if not bot or not bot.is_connected():
        return
    player = data.get("player", "")
    distance = data.get("distance", 2.0)
    bot.follow(player, float(distance))
    _add_event("follow", f"{player} (距离={distance})")
    emit("log", {"level": "info", "msg": f"跟随 {player}"})


@socketio.on("switch_slot")
def on_switch_slot(data: dict):
    if not bot or not bot.is_connected():
        return
    slot = data.get("slot", 1)
    bot.switch_slot(int(slot))


@socketio.on("move_to_hotbar")
def on_move_to_hotbar():
    if not bot or not bot.is_connected():
        return
    bot.move_to_hotbar()
    _add_event("action", "背包物品 → 快捷栏")
    emit("log", {"level": "info", "msg": "正在将背包物品移动到快捷栏..."})


@socketio.on("equip")
def on_equip(data: dict):
    if not bot or not bot.is_connected():
        return
    item_name = data.get("item", "").strip()
    destination = data.get("destination", "hand")
    if not item_name:
        return
    bot.equip(item_name, destination)
    _add_event("equip", f"{item_name} → {destination}")
    emit("log", {"level": "info", "msg": f"装备物品: {item_name} → {destination}"})


@socketio.on("unequip")
def on_unequip(data: dict):
    if not bot or not bot.is_connected():
        return
    destination = data.get("destination", "hand")
    bot.unequip(destination)
    _add_event("unequip", destination)
    emit("log", {"level": "info", "msg": f"取消装备: {destination}"})


@socketio.on("whisper")
def on_whisper(data: dict):
    if not bot or not bot.is_connected():
        return
    player = data.get("player", "").strip()
    message = data.get("message", "").strip()
    if not player or not message:
        return
    bot.whisper(player, message)
    _add_event("whisper", f"→ {player}: {message}")
    emit("log", {"level": "info", "msg": f"私聊 {player}: {message}"})


@socketio.on("look_at")
def on_look_at(data: dict):
    if not bot or not bot.is_connected():
        return
    player = data.get("player", "").strip()
    x = data.get("x")
    y = data.get("y")
    z = data.get("z")
    if player:
        bot.look_at_player(player)
        _add_event("look", f"看向玩家 {player}")
        emit("log", {"level": "info", "msg": f"看向玩家 {player}"})
    elif x is not None and y is not None and z is not None:
        bot.look_at(float(x), float(y), float(z))
        _add_event("look", f"看向坐标 ({x}, {y}, {z})")
        emit("log", {"level": "info", "msg": f"看向坐标 ({x}, {y}, {z})"})


@socketio.on("activate_item")
def on_activate_item():
    if not bot or not bot.is_connected():
        return
    bot.activate_item()
    emit("log", {"level": "info", "msg": "开始使用物品"})


@socketio.on("deactivate_item")
def on_deactivate_item():
    if not bot or not bot.is_connected():
        return
    bot.deactivate_item()
    emit("log", {"level": "info", "msg": "停止使用物品"})


@socketio.on("set_control")
def on_set_control(data: dict):
    if not bot or not bot.is_connected():
        return
    control = data.get("control", "")
    state = data.get("state", False)
    bot.set_control_state(control, state)


@socketio.on("request_status")
def on_request_status():
    if bot and bot.is_connected():
        st = bot.get_status(timeout=2.0)
        if st:
            _update_status_from_bot(st)
        emit("status", _current_status)


# ═══════════════════════════════════
#  内部函数
# ═══════════════════════════════════

def _start_status_polling():
    global _status_thread, _status_running
    _status_running = True
    _status_thread = threading.Thread(target=_status_poll_loop, daemon=True)
    _status_thread.start()


def _stop_status_polling():
    global _status_running
    _status_running = False


def _status_poll_loop():
    while _status_running:
        if bot and bot.is_connected():
            try:
                st = bot.get_status(timeout=2.0)
                if st:
                    _update_status_from_bot(st)
                    socketio.emit("status", _current_status)
            except Exception:
                pass
        time.sleep(1.0)


def _update_status_from_bot(st: dict):
    pos = st.get("position", {})
    _current_status["position"] = {
        "x": round(pos.get("x", 0), 1),
        "y": round(pos.get("y", 0), 1),
        "z": round(pos.get("z", 0), 1),
    }
    _current_status["health"] = round(st.get("health", 0), 1)
    _current_status["food"] = st.get("food", 0)
    _current_status["saturation"] = round(st.get("saturation", 0), 1)
    _current_status["gamemode"] = st.get("gamemode", "")
    _current_status["dimension"] = st.get("dimension", "")
    _current_status["yaw"] = round(st.get("yaw", 0), 1)
    _current_status["pitch"] = round(st.get("pitch", 0), 1)
    _current_status["isSprinting"] = st.get("isSprinting", False)
    _current_status["isSneaking"] = st.get("isSneaking", False)
    _current_status["isCrawling"] = st.get("isCrawling", False)
    _current_status["isRiding"] = st.get("isRiding", False)
    held = st.get("heldItem")
    if held and isinstance(held, dict):
        _current_status["heldItem"] = held.get("name", held.get("displayName", str(held)))
    else:
        _current_status["heldItem"] = str(held) if held else "空手"


def _handle_event(etype: str, event: dict):
    msgs = {
        "login": "Bot 已登录",
        "spawn": "Bot 已就绪",
        "death": "Bot 死亡",
        "kicked": f"被踢出: {event.get('reason', '')}",
        "end": f"连接断开: {event.get('reason', '')}",
        "error": f"错误: {event.get('message', '')}",
        "player_joined": f"玩家加入: {event.get('username', '?')}",
        "player_left": f"玩家离开: {event.get('username', '?')}",
    }
    msg = msgs.get(etype, f"{etype}: {event}")
    _add_event(etype, msg)
    socketio.emit("log", {"level": "info", "msg": msg})
    socketio.emit("bot_event", {"type": etype, "data": event})


def _handle_chat(event: dict):
    sender = event.get("player", event.get("sender", "?"))
    message = event.get("message", "")
    _chat_log.append({"sender": sender, "message": message, "time": time.time()})
    socketio.emit("chat_msg", {"sender": sender, "message": message})
    try:
        process_chat(message)
    except Exception:
        pass


def _handle_message(event: dict):
    json_obj = event.get("json")
    if json_obj:
        try:
            text = _extract_plain(json_obj, include_hover=False)
            if text:
                _chat_log.append({"sender": "[系统]", "message": text, "time": time.time()})
                socketio.emit("chat_msg", {"sender": "[系统]", "message": text})
        except Exception:
            pass
        try:
            process_chat(json_obj)
        except Exception:
            pass


def _add_event(etype: str, msg: str):
    _event_log.append({"type": etype, "msg": msg, "time": time.time()})
    if len(_event_log) > 200:
        _event_log.pop(0)


# ═══════════════════════════════════
#  启动
# ═══════════════════════════════════

def main():
    print("=" * 50)
    print("  mcbot 网页控制面板")
    print("  打开浏览器访问: http://localhost:5000")
    print("=" * 50)
    socketio.run(app, host="0.0.0.0", port=5000, debug=False, allow_unsafe_werkzeug=True)


if __name__ == "__main__":
    main()