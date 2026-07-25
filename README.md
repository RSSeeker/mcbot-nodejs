# mcbot-python

一个纯 Python 实现的 Minecraft Java Edition (1.21.4) 聊天机器人，通过原生 TCP Socket 与 Minecraft 服务器通信，不依赖任何 Minecraft 第三方库。

## 功能特性

- **原生协议实现**：从 VarInt 编解码到 NBT 解析，完全自研 Minecraft 1.21.4 网络协议
- **聊天监听与命令响应**：监听游戏公聊消息，响应以 `??` 开头的玩家指令
- **MIDI 音乐播放**：解析 MIDI 文件，将音符映射为 Unicode 字符通过封包发送给钢琴插件播放
- **自动 AuthMe 认证**：中英文双语提示检测，支持自动注册和登录
- **压缩支持**：处理 zlib 压缩的 Minecraft 封包
- **Velocity/BungeeCord 代理**：支持登录阶段的代理转发
- **终端 ANSI 彩色输出**：游戏聊天消息带颜色显示在控制台
- **交互式控制台**：可直接从终端发送聊天消息或 Minecraft 命令

## 项目结构

```
mcbot-python/
├── main.py              # 程序入口：配置、启动、控制台循环
├── mc_protocol.py       # 核心协议层：TCP 连接、封包编解码、登录流程
├── chat_processor.py    # 聊天解析：JSON/NBT → 纯文本 + ANSI 输出
├── command_manager.py   # 命令注册与分发系统
├── auth_handler.py      # AuthMe 自动认证（中英文识别）
├── midi_processor.py    # MIDI 文件解析与播放
├── utils.py             # 工具函数：全局连接引用、快捷发送方法
├── ping_server.py       # 独立工具：探测服务器版本和在线人数
├── commands/
│   ├── __init__.py      # 命令注册入口
│   ├── help_command.py  # ??help — 列出所有命令
│   ├── send_command.py  # ??send — 让 Bot 发送消息
│   ├── cmd_command.py   # ??cmd  — 执行 Minecraft 指令
│   ├── respawn_command.py # ??respawn — 让 Bot 重生
│   └── midi_command.py  # ??midi  — MIDI 播放控制
├── midi/                # MIDI 文件存放目录
├── requirements.txt     # Python 依赖
└── README.md
```

## 快速开始

### 前置要求

- Python 3.10+
- 目标 Minecraft 服务器版本 **1.21.4**（协议版本 769）
- 服务器需启用离线模式（offline mode），或有 AuthMe 登录插件

### 安装

```bash
git clone https://github.com/RSSeeker/mcbot-python.git
cd mcbot-python
pip install -r requirements.txt
```

### 配置

编辑 `main.py` 中的配置项：

```python
SERVER_HOST = "mc.weeaxe.cn"   # 服务器地址
SERVER_PORT = 25565             # 服务器端口
BOT_USERNAME = "RS_Bot"        # Bot 用户名
```

如需修改 AuthMe 密码，编辑 `auth_handler.py` 中的 `_password` 变量。

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
| `??midi list` | 列出 MIDI 目录下的可用文件 |
| `??midi play <文件名>` | 播放指定 MIDI 文件 |
| `??midi stop` | 停止当前播放 |

## MIDI 播放

将 `.mid` 文件放入 `midi/` 目录后，在游戏中使用 `??midi play <文件名>` 即可播放。

此功能需要服务器安装兼容的钢琴插件，该插件需支持：
- `piano keyboard unicode` 命令切换到 Unicode 模式
- 通过 Tab Complete 封包接收 `/// ` 前缀的 Unicode 音符

## 依赖

- [mido](https://github.com/mido/mido) >= 1.3.0 — MIDI 文件解析

其余全部使用 Python 标准库：`socket`、`struct`、`threading`、`uuid`、`json`、`re`、`zlib`、`logging`、`os`、`time`

## 技术亮点

- 完整实现 Minecraft 1.21.4 的登录序列：Handshake → Login Start → Login Success → Login Acknowledged → Configuration → PLAY
- 支持压缩数据包（zlib）、Known Packs、Velocity/BungeeCord 代理转发
- 手写 NBT 解码器，处理 `anonymousNbt` 格式的聊天数据
- MIDI 音符到 Unicode 汉字的映射完全对齐 Java 版本 `MidiProcesser.java`

## License

MIT
