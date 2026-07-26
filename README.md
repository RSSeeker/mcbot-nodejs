# mcbot-python

Minecraft Java Edition 聊天机器人，使用 **Mineflayer (Node.js)** 处理协议层，**Python** 实现命令控制等业务逻辑。

## 架构

```
┌─────────────────────────────────────┐
│  Python 控制层 (main.py)            │
│  - 命令注册/分发 (command_manager)   │
│  - 聊天解析与 ANSI 输出              │
│  - bot_controller: 统一控制 API      │
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

- **Mineflayer 协议代理**：Node.js Mineflayer 处理所有 MC 协议细节，兼容多版本
- **聊天监听与命令响应**：监听公聊/私聊消息，响应 `command_prefix` 开头的玩家指令
- **终端 ANSI 彩色输出**：游戏聊天消息带颜色显示在控制台
- **交互式控制台**：终端可直接发送聊天/Bot 命令/MC 指令
- **WASD 移动 & 寻路**：方向移动、跳跃、坐标寻路、跟随玩家
- **动作交互**：左键攻击/挖掘、右键使用/放置、潜行、丢物品、切格子、使用物品
- **实体交互**：骑乘、下马、装备物品
- **状态查询**：实时查询 Bot 位置/血量/饱食度/手持物品
- **自动恢复**：死亡自动重生、断连自动重连（指数退避）
- **测试命令**：游戏内 `**test` 运行 16 项自动化功能测试

## 项目结构

```
mcbot-python/
├── main.py               # Python 入口：启动 Node 子进程、IPC 事件循环
├── mineflayer_bot.js     # Mineflayer 代理：登录、消息收发、IPC 通信
├── bot_controller.py     # Bot 统一控制 API（可直接 import 使用）
├── chat_processor.py     # 聊天解析：JSON → 纯文本 + ANSI 输出
├── command_manager.py    # 命令注册与分发系统
├── utils.py              # IPC 工具函数（自动读取 config.json）
├── test.py               # 功能测试脚本（18 项测试）
├── ping_server.py        # 独立工具：探测服务器版本和在线人数
├── commands/
│   ├── __init__.py         # 命令注册入口
│   ├── help_command.py     # ??help — 列出所有命令
│   ├── send_command.py     # ??send — 让 Bot 发送消息
│   ├── cmd_command.py      # ??cmd  — 执行 Minecraft 指令
│   ├── respawn_command.py  # ??respawn — 让 Bot 重生
│   ├── restart_command.py  # ??restart — 重启 Bot 进程
│   ├── move_command.py     # ??move/jump/stop/goto/follow — 移动控制
│   ├── action_command.py   # ??leftclick/rightclick/sneak/drop/dropall/slot/look/cancel
│   └── test_command.py     # ??test — 运行功能测试
├── config.json             # 配置文件（服务器/用户名/密码/指令前缀）
├── config.example.json     # 配置文件模板
├── requirements.txt        # Python 依赖
├── package.json            # Node.js 依赖
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

- 直接输入文本 → Bot 发送聊天消息
- `??` 开头 → 执行 Bot 命令（同游戏内）
- `/` 开头 → Bot 执行 Minecraft 指令
- `quit` → 退出程序

### 运行测试

```bash
python test.py              # 完整测试（18 项）
python test.py --quick      # 快速测试（基础功能）
python test.py --interactive # 交互模式
```

### 查看在线人数

```bash
python ping_server.py
```

## 可用命令（游戏中）

> 所有命令执行反馈均以 `/tell` 私发指令发出者，不会刷公屏。

| 命令 | 说明 |
|------|------|
| `**help` | 列出所有可用命令 |
| `**send <消息>` | 让 Bot 发送公聊消息 |
| `**cmd <指令>` | 让 Bot 执行 Minecraft 指令 |
| `**move <方向> [毫秒]` | 移动：forward/back/left/right，默认1000ms |
| `**jump` | 跳跃 |
| `**stop` | 停止所有移动 |
| `**goto <x> <y> <z>` | 寻路到目标坐标 |
| `**follow <玩家>` | 跟随指定玩家 |
| `**look <偏航> [俯仰]` | 设置视角角度 |
| `**look at <玩家>` | 看向指定玩家 |
| `**leftclick` | 左键（攻击实体 / 挖掘方块） |
| `**rightclick` | 右键（使用物品 / 放置方块 / 交互） |
| `**sneak` | 切换潜行状态（蹲下/起身） |
| `**drop` | 丢出手持物品 |
| `**dropall` | 丢出全部物品 |
| `**slot <1-9>` | 切换到物品栏第 N 格 |
| `**cancel` | 取消所有操作 |
| `**respawn` | 重生 |
| `**restart` | 重启 Bot 进程 |
| `**test` | 运行 16 项功能测试 |

> 指令前缀通过 `config.json` 中的 `command_prefix` 修改。

## Python API 使用

`bot_controller.py` 提供统一控制接口，可在脚本中直接 import：

```python
from bot_controller import BotController

# 方式1：使用配置文件
bot = BotController()
bot.connect()

# 方式2：直接指定参数（覆盖配置文件）
bot = BotController(
    host="mc.hypixel.net",
    port=25565,
    version="1.21.4",
    username="MyBot",
    password="mypassword",
    command_prefix="!!"
)
bot.connect()

# 常用操作
bot.chat("Hello!")               # 公聊
bot.whisper("玩家名", "你好")      # 私聊
bot.move_forward(3000)            # 前进 3 秒
bot.jump()                        # 跳跃
bot.look(90, 0)                   # 设置视角
bot.left_click()                  # 攻击
bot.right_click()                 # 交互
bot.sneak(True)                   # 蹲下
bot.switch_slot(1)                # 切第 1 格
bot.drop()                        # 丢物品
bot.equip("diamond_sword")        # 装备物品
bot.mount()                       # 骑乘
bot.dismount()                    # 下马
status = bot.get_status()         # 查询状态

bot.disconnect()

# 也支持上下文管理器，自动断开
with BotController() as bot:
    bot.chat("自动连接和断开")
```

### BotController 参数说明

| 参数 | 类型 | 说明 |
|------|------|------|
| `config_path` | str | 配置文件路径（默认 `config.json`） |
| `host` | str | 服务器地址（覆盖配置文件） |
| `port` | int | 服务器端口（覆盖配置文件） |
| `version` | str | Minecraft 版本（覆盖配置文件） |
| `username` | str | Bot 玩家名（覆盖配置文件） |
| `password` | str | 登录密码（覆盖配置文件） |
| `command_prefix` | str | 命令前缀（覆盖配置文件） |

所有参数均为可选，如果不指定则使用 `config.json` 中的默认值。

## 依赖

### Python

全部使用标准库：`subprocess`、`threading`、`json`、`re`、`logging`、`os`、`time`、`argparse`

### Node.js

- [mineflayer](https://github.com/PrismarineJS/mineflayer) — Minecraft 协议客户端库
- [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) — 寻路与移动插件

## License

MIT