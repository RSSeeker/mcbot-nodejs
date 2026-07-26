# mcbot-python

Minecraft Java Edition 聊天机器人，使用 **Mineflayer (Node.js)** 处理协议层，**Python** 实现命令控制等业务逻辑。

## 架构

```
┌─────────────────────────────────────┐
│  Python 控制层 (main.py)            │
│  - 命令注册/分发 (command_manager)   │
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
- **聊天监听与命令响应**：监听游戏公聊和私聊消息，响应以可配置前缀（默认 `??`）开头的玩家指令
- **终端 ANSI 彩色输出**：游戏聊天消息带颜色显示在控制台
- **交互式控制台**：可直接从终端发送聊天消息或 Minecraft 命令
- **WASD 移动 & 寻路**：支持方向移动、跳跃、坐标寻路、跟随玩家
- **动作交互**：左键攻击/挖掘、右键使用/放置、潜行切换、物品丢出、物品栏切换
- **Bot 重启**：游戏内 `??restart` 命令可重启整个进程
- **自动恢复**：死亡自动重生、断连自动重连（指数退避）

## 项目结构

```
mcbot-python/
├── main.py              # Python 入口：启动 Node 子进程、IPC 事件循环
├── mineflayer_bot.js    # Mineflayer 代理：登录、消息收发、IPC 通信
├── chat_processor.py    # 聊天解析：JSON → 纯文本 + ANSI 输出
├── command_manager.py   # 命令注册与分发系统
├── utils.py             # IPC 工具：send_chat/send_command
├── ping_server.py       # 独立工具：探测服务器版本和在线人数
├── commands/
│   ├── __init__.py        # 命令注册入口
│   ├── help_command.py    # ??help — 列出所有命令
│   ├── send_command.py    # ??send — 让 Bot 发送消息
│   ├── cmd_command.py     # ??cmd  — 执行 Minecraft 指令
│   ├── respawn_command.py # ??respawn — 让 Bot 重生
│   ├── restart_command.py # ??restart — 重启 Bot 进程
│   ├── move_command.py    # ??move/jump/stop/goto/follow — 移动控制
│   └── action_command.py  # ??leftclick/rightclick/sneak/drop/dropall/slot — 动作交互
├── config.json            # 配置文件（服务器/用户名/密码/指令前缀）
├── config.example.json    # 配置文件模板
├── requirements.txt       # Python 依赖
├── package.json           # Node.js 依赖
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

复制 `config.example.json` 为 `config.json` 并编辑：

```json
{
    "server": {
        "host": "服务器地址",
        "port": 25565,
        "version": "1.21.4"
    },
    "bot": {
        "username": "Bot名称",
        "password": "登录密码（无密码留空）"
    },
    "command_prefix": "??"
}
```

| 字段 | 说明 |
|------|------|
| `server.host` | Minecraft 服务器地址 |
| `server.port` | 服务器端口 |
| `server.version` | 游戏版本 |
| `bot.username` | Bot 用户名 |
| `bot.password` | 登录密码（离线模式留空） |
| `command_prefix` | 游戏内指令前缀，可改为 `!`、`/` 等 |

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
| `??move <方向> [毫秒]` | 让 Bot 移动：forward/back/left/right |
| `??jump` | 让 Bot 跳跃 |
| `??stop` | 停止所有移动 |
| `??goto <x> <y> <z>` | 寻路到目标坐标 |
| `??follow <玩家> [距离]` | 跟随指定玩家 |
| `??respawn` | 让 Bot 重生 |
| `??restart` | 重启 Bot 进程 |
| `??leftclick` | 左键（攻击实体 / 挖掘方块） |
| `??rightclick` | 右键（使用物品 / 放置方块 / 交互） |
| `??sneak` | 切换潜行状态（蹲下/起身） |
| `??drop` | 丢出手持物品 |
| `??dropall` | 丢出背包中全部物品 |
| `??slot <1-9>` | 切换到物品栏第 N 格 |

> 指令前缀可通过 `config.json` 中的 `command_prefix` 修改。支持公聊和私聊两种触发方式。

## 依赖

### Python

所有依赖使用 Python 标准库：`subprocess`、`threading`、`json`、`re`、`logging`、`os`

### Node.js
- [mineflayer](https://github.com/PrismarineJS/mineflayer) — Minecraft 协议客户端库
- [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) — 寻路与移动插件

## License

MIT
