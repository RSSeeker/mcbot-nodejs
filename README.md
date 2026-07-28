# mcbot-web

Minecraft Java Edition 网页控制台机器人，**纯 Node.js** 实现，基于 **Mineflayer + Express + SocketIO**。
启动后在浏览器中可视化控制 Bot。

## 架构

```
┌──────────────────────────────────────────────┐
│  Node.js 控制层 (server.js)                   │
│  - Express 静态文件服务                        │
│  - SocketIO 实时 WebSocket 通信               │
│  - Mineflayer 协议代理（同一进程，无 IPC）      │
│  - 聊天命令系统（**command）                   │
│  - 状态轮询 & 事件转发                         │
│    │ TCP                                      │
└────┼──────────────────────────────────────────┘
     │
  Minecraft 服务器
```

## 功能特性

- **Mineflayer 协议代理**：Node.js Mineflayer 处理所有 MC 协议细节，兼容多版本
- **Web 控制台**：SocketIO 实时 Web 面板，可视化移动控制、视角转动、状态监控
- **聊天监听与命令响应**：监听公聊/私聊消息，响应 `command_prefix` 开头的玩家指令
- **WASD 移动 & 寻路**：方向移动、跳跃、疾跑、坐标寻路、跟随玩家
- **视角转动**：D-pad 方向键/键盘箭头增量旋转视角，支持绝对角度设置
- **动作交互**：攻击实体、挖掘方块、放置方块、与方块/实体交互（开门/开箱/骑乘等）、使用物品、潜行、疾跑、丢物品、切格子
- **背包管理**：背包物品移入快捷栏、装备/卸下物品
- **实体交互**：骑乘、下马
- **状态查询**：实时查询 Bot 位置/血量/饱食度/手持物品/潜行/疾跑/爬行/骑乘状态
- **自动恢复**：死亡自动重生、断连自动重连（指数退避）、Web 面板一键重启

## 项目结构

```
mcbot-web/
├── server.js            # 主入口：Express + SocketIO + Mineflayer
├── mineflayer_bot.js    # 备用：独立 Mineflayer 代理（Python IPC 模式）
├── templates/
│   └── index.html       # Web 控制台前端页面
├── config.json           # 配置文件（服务器/用户名/密码/指令前缀）
├── config.example.json   # 配置文件模板
├── package.json          # Node.js 依赖
└── README.md
```

## 快速开始

### 前置要求

- Node.js 18+
- 目标 Minecraft 服务器需启用离线模式（offline mode）

### 安装

```bash
git clone https://github.com/RSSeeker/mcbot-python.git
cd mcbot-python
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
    "command_prefix": "**",
    "track_players": ["玩家名1", "玩家名2"]
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

### 启动

```bash
npm start
```

启动后在浏览器打开 `http://localhost:5001`，可视控制面板功能包括：

- **连接配置**：网页顶部填写服务器/用户名/密码等
- **移动控制**：D-pad 方向键 + 跳跃/潜行/疾跑切换按钮，支持键盘 WASD/Q/E/F/Shift/Ctrl
- **视角转动**：独立的视角 D-pad，键盘方向键控制，支持 Yaw/Pitch 精确输入
- **状态面板**：实时显示坐标、血量、饱食度、视角、手持物品、潜行/疾跑/爬行/骑乘状态
- **物品栏**：快捷栏 1-9 点击切换，一键移入背包物品
- **动作按钮**：攻击、挖掘、放置、交互、使用、下马、丢物品
- **聊天面板**：实时公聊/私聊/系统消息，支持聊天输入和 Minecraft 指令执行
- **寻路/跟随**：输入坐标或玩家名进行导航
- **装备控制**：指定物品名装备到指定槽位，一键卸下
- **重启**：Bot 连接后一键重启

## 可用命令（游戏中）

| 命令 | 说明 |
|------|------|
| `**help` | 列出所有可用命令 |
| `**send <消息>` | 让 Bot 发送公聊消息 |
| `**cmd <指令>` | 让 Bot 执行 Minecraft 指令 |
| `**move <方向> [毫秒]` | 移动：forward/back/left/right，默认1000ms |
| `**jump` | 跳跃 |
| `**stop` | 停止所有移动 |
| `**goto <x> <y> <z>` | 寻路到目标坐标 |
| `**follow <玩家> [距离]` | 跟随指定玩家 |
| `**look <偏航> [俯仰]` | 设置绝对视角角度 |
| `**rotate <水平°> [垂直°]` | 旋转视角（增量角度，如 `**rotate 90 -30`） |
| `**attack [时间]` | 攻击视线中的实体，时间参数指定长按毫秒数 |
| `**dig [时间]` | 挖掘视线中的方块，时间参数指定长按毫秒数 |
| `**place` | 放置方块（对准方块表面） |
| `**interact` | 与方块/实体交互（开门/开箱/拉杆/村民交易/骑乘载具等） |
| `**dismount` | 离开当前载具 |
| `**use` | 使用手持物品 |
| `**usehold [时间]` | 长按使用手持物品，默认2000ms |
| `**sneak` | 切换潜行状态（蹲下/起身） |
| `**sprint` | 切换疾跑状态 |
| `**drop` | 丢出手持物品 |
| `**dropall` | 丢出全部物品 |
| `**slot <1-9>` | 切换到快捷栏第 N 格 |
| `**equip <物品名> <槽位>` | 装备物品到指定槽位（hand/off-hand/head/torso/legs/feet） |
| `**unequip <槽位>` | 卸下指定槽位的物品 |
| `**movetohotbar` | 将背包物品移入快捷栏的空位 |
| `**cancel` | 取消所有操作 |
| `**respawn` | 重生 |
| `**ping` | 延迟测试 |

> 指令前缀通过 `config.json` 中的 `command_prefix` 修改。

## 依赖

- [mineflayer](https://github.com/PrismarineJS/mineflayer) — Minecraft 协议客户端库
- [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) — 寻路与移动插件
- [express](https://expressjs.com/) — HTTP 服务器
- [socket.io](https://socket.io/) — WebSocket 实时通信

## License

MIT