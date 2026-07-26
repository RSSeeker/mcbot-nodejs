# mcbot-python

Minecraft Java Edition 聊天机器人，使用 **Mineflayer (Node.js)** 处理协议层，**Python** 实现命令控制、MIDI 播放等业务逻辑。

## 架构

```
┌─────────────────────────────────────┐
│  Python 控制层 (main.py)            │
│  - 命令注册/分发 (command_manager)   │
│  - MIDI 解析与播放 (midi_processor)  │
│  - 聊天解析与 ANSI 输出              │
│         │ stdin/stdout JSON Lines    │
├─────────────────────────────────────┤
│  Node.js Mineflayer 代理             │
│  - 自动处理 MC 协议（登录/心跳/加密） │
│  - 版本兼容，无需手动跟踪封包 ID      │
└──────────────┬──────────────────────┘
               │ TCP
        Minecraft 服务器
```

## 功能特性

- **Mineflayer 协议代理**：由 Node.js Mineflayer 库处理所有 MC 协议细节，兼容多版本
- **聊天监听与命令响应**：监听游戏公聊消息，响应以 `??` 开头的玩家指令
- **MIDI 音乐播放**：解析 MIDI 文件，将音符映射为 Unicode 字符通过封包发送给钢琴插件播放
- **终端 ANSI 彩色输出**：游戏聊天消息带颜色显示在控制台
- **交互式控制台**：可直接从终端发送聊天消息或 Minecraft 命令
- **Bot 重启**：游戏内 `??restart` 命令可重启整个进程

## 项目结构

```
mcbot-python/
├── main.py              # Python 入口：启动 Node 子进程、IPC 事件循环
├── mineflayer_bot.js    # Mineflayer 代理：登录、消息收发、IPC 通信
├── chat_processor.py    # 聊天解析：JSON → 纯文本 + ANSI 输出
├── command_manager.py   # 命令注册与分发系统
├── midi_processor.py    # MIDI 文件解析与播放
├── utils.py             # IPC 工具：send_chat/send_command/send_suggestion
├── ping_server.py       # 独立工具：探测服务器版本和在线人数
├── commands/
│   ├── __init__.py       # 命令注册入口
│   ├── help_command.py   # ??help — 列出所有命令
│   ├── send_command.py   # ??send — 让 Bot 发送消息
│   ├── cmd_command.py    # ??cmd  — 执行 Minecraft 指令
│   ├── respawn_command.py # ??respawn — 让 Bot 重生
│   ├── restart_command.py # ??restart — 重启 Bot 进程
│   └── midi_command.py   # ??midi  — MIDI 播放控制
├── midi/                 # MIDI 文件存放目录
├── requirements.txt      # Python 依赖
├── package.json          # Node.js 依赖
└── README.md
```

## 快速开始

### 前置要求

- Python 3.10+
- Node.js 18+
- 目标 Minecraft 服务器需启用离线模式（offline mode）

### 安装

```bash
git clone https://github.com/RSSeeker/mcbot-python.git
cd mcbot-python
pip install -r requirements.txt
npm install
```

### 配置

编辑 `main.py` 中的配置项：

```python
SERVER_HOST = "mc.weeaxe.cn"   # 服务器地址
SERVER_PORT = 25565             # 服务器端口
USERNAME = "RS_Bot"             # Bot 用户名
```

### 运行

```bash
python main.py
```

启动后进入交互式控制台：
- 直接输入文本按 Enter → Bot 发送聊天消息
- 以 `/` 开头 → Bot 执行 Minecraft 指令
- `quit` → 退出程序

### 查看在线人数

```bash
python ping_server.py
```

## 可用命令（游戏中）

| 命令 | 说明 |
|------|------|
| `??help` | 列出所有可用命令 |
| `??send <消息>` | 让 Bot 发送一条聊天消息 |
| `??cmd <指令>` | 让 Bot 执行 Minecraft 命令 |
| `??respawn` | 让 Bot 重生 |
| `??restart` | 重启 Bot 进程 |
| `??midi list` | 列出 MIDI 目录下的可用文件 |
| `??midi play <文件名>` | 播放指定 MIDI 文件 |
| `??midi stop` | 停止当前播放 |

## MIDI 播放

将 `.mid` 文件放入 `midi/` 目录后，在游戏中使用 `??midi play <文件名>` 即可播放。

此功能需要服务器安装兼容的钢琴插件，该插件需支持：
- `piano keyboard unicode` 命令切换到 Unicode 模式
- 通过 Tab Complete 封包接收 `/// ` 前缀的 Unicode 音符

## 依赖

### Python
- [mido](https://github.com/mido/mido) >= 1.3.0 — MIDI 文件解析

其余使用 Python 标准库：`subprocess`、`threading`、`json`、`re`、`logging`、`os`

### Node.js
- [mineflayer](https://github.com/PrismarineJS/mineflayer) — Minecraft 协议客户端库

## License

MIT
