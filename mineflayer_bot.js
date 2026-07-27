/**
 * mineflayer_bot.js — Minecraft 协议代理层
 * ==========================================
 * 使用 Mineflayer 处理所有 MC 协议细节，
 * 通过 stdin/stdout JSON Lines 与 Python 控制层通信。
 *
 * 配置从 config.json 读取。
 */

const mineflayer = require('mineflayer');
const pathfinder = require('mineflayer-pathfinder').pathfinder;
const Movements = require('mineflayer-pathfinder').Movements;
const { GoalNear, GoalBlock, GoalFollow } = require('mineflayer-pathfinder').goals;
const { Vec3 } = require('vec3');
const fs = require('fs');
const path = require('path');

// ── 配置（支持从 Python 动态传入）──
let host = '';
let port = 25565;
let username = '';
let password = '';
let gameVersion = '1.21.4';

// 从配置文件读取默认值
const configPath = path.join(__dirname, 'config.json');
try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    host = config.server.host;
    port = config.server.port;
    username = config.bot.username;
    password = config.bot.password || '';
    gameVersion = config.server.version || '1.21.4';
} catch (e) {
    logInfo('无法读取配置文件，将等待 Python 传入配置');
}

// ── JSON 输出辅助 ──
function sendJson(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
}

function logInfo(msg) {
    process.stderr.write(`[mineflayer] ${msg}\n`);
}

// ── 全局状态 ──
let bot = null;
let autoLoginDone = false;
let movements = null;
let moveTimer = null;
let activeMoveDir = null;
let reconnectAttempts = 0;
let reconnectTimer = null;          // 防重复：同一时刻只允许一个重连定时器存在
let bowTimer = null;                // 弓拉射定时器
let isLeftClickHolding = false;     // 左键长按状态
let isRightClickHolding = false;    // 右键长按状态
const MAX_RECONNECT_DELAY = 60000;   // 最长重连间隔 60 秒
const BASE_RECONNECT_DELAY = 3000;   // 基础重连间隔 3 秒
// 视角转动后等待时间（ms），用于确保服务器收到正确的瞄准位置再执行放置/交互
let LOOK_ROTATION_DELAY_MS = 120;

// ── 创建 Bot ──
function createBot() {
    // 清理旧状态
    if (moveTimer) { clearTimeout(moveTimer); moveTimer = null; }
    if (bowTimer) { clearTimeout(bowTimer); bowTimer = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    activeMoveDir = null;
    movements = null;

    bot = mineflayer.createBot({
        host: host,
        port: parseInt(port),
        username: username,
        auth: 'offline',
        version: gameVersion,
        hideErrors: false,
    });

    // ── 加载 pathfinder 插件 ──
    bot.loadPlugin(pathfinder);

    // ═══════════════════════════════════
    //  事件 → Python
    // ═══════════════════════════════════

    bot.on('login', () => {
        logInfo(`已登录: ${username}`);
        reconnectAttempts = 0;  // 成功登录后重置重连计数
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        sendJson({
            type: 'login',
            status: 'success',
            username: username,
            host: host,
        });
    });

    // 所有消息（JSON 格式）
    bot.on('message', (jsonMsg, position) => {
        try {
            const raw = JSON.stringify(jsonMsg);
            sendJson({
                type: 'message',
                json: jsonMsg,
                raw: raw,
                position: position,
            });
        } catch (e) {
            // 忽略序列化错误
        }
    });

    // 纯文本消息（兜底）
    bot.on('messagestr', (text, msg, position) => {
        logInfo(`[MSG] ${text}`);
    });

    // 玩家聊天（Mineflayer 识别的标准聊天格式）
    bot.on('chat', (playerName, message) => {
        if (playerName === username) return;
        sendJson({
            type: 'chat',
            player: playerName,
            message: message,
        });
    });

    // 玩家加入/离开
    bot.on('playerJoined', (player) => {
        sendJson({ type: 'player_joined', username: player.username });
    });

    bot.on('playerLeft', (player) => {
        sendJson({ type: 'player_left', username: player.username });
    });

    // 被踢出
    bot.on('kicked', (reason) => {
        const text = typeof reason === 'string' ? reason : JSON.stringify(reason);
        logInfo(`被踢: ${text}`);
        sendJson({ type: 'kicked', reason: text });
        // 被踢后至少额外等待 5 秒，防止频繁重连被 ban
        scheduleReconnect(5000);
    });

    // 死亡
    bot.on('death', () => {
        logInfo('Bot 已死亡，自动重生...');
        sendJson({ type: 'death' });
        // 自动重生
        setTimeout(() => {
            bot._client.write('client_command', {
                actionId: 0,  // PERFORM_RESPAWN
            });
            logInfo('[AutoRespawn] 已发送重生请求');
        }, 1000);
    });

    // 断连
    bot.on('end', (reason) => {
        logInfo(`连接断开: ${reason}`);
        sendJson({ type: 'end', reason: reason });
        scheduleReconnect();
    });

    // 错误
    bot.on('error', (err) => {
        logInfo(`错误: ${err.message}`);
        sendJson({ type: 'error', message: err.message });
    });

    // 出生完成
    bot.on('spawn', () => {
        logInfo('Bot 已出生');
        sendJson({ type: 'spawn' });

        // 初始化 pathfinder 移动配置
        movements = new Movements(bot);
        bot.pathfinder.setMovements(movements);

        // 自动注册并登录
        if (!autoLoginDone && password) {
            autoLoginDone = true;
            setTimeout(() => {
                bot.chat(`/register ${password} ${password}`);
                logInfo(`已自动执行 /register`);
                setTimeout(() => {
                    bot.chat(`/login ${password}`);
                    logInfo(`已自动执行 /login`);
                }, 1500);
            }, 1000);
        }
    });

    return bot;
}

// ── 自动重连（单一定时器，防重复触发） ──
function scheduleReconnect(extraDelayMs = 0) {
    // 如果已有重连定时器在执行，忽略本次调用（防 end+kicked 双重触发）
    if (reconnectTimer) {
        logInfo(`重连已调度，跳过重复请求`);
        return;
    }

    reconnectAttempts++;
    // 指数退避: min(3s * 2^(n-1), 60s) + 额外延迟
    const backoff = Math.min(BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts - 1), MAX_RECONNECT_DELAY);
    const delay = backoff + extraDelayMs;

    logInfo(`将在 ${(delay / 1000).toFixed(1)} 秒后重连 (第 ${reconnectAttempts} 次, backoff=${backoff}ms, extra=${extraDelayMs}ms)...`);
    sendJson({ type: 'reconnecting', attempt: reconnectAttempts, delay });

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        logInfo(`正在重连...`);
        createBot();
    }, delay);
}

// ── 首次启动（延迟到收到 connect 命令）──
let initialized = false;

function tryInitialize() {
    if (initialized) return;
    if (!host || !username) {
        logInfo('等待 Python 传入连接配置...');
        return;
    }
    initialized = true;
    logInfo(`初始化完成: ${username} @ ${host}:${port} (${gameVersion})`);
    createBot();
}

// 如果配置文件已提供完整配置，立即启动
if (host && username) {
    setTimeout(tryInitialize, 100);
}

// ═══════════════════════════════════
//  移动辅助函数
// ═══════════════════════════════════

function stopMove() {
    if (moveTimer) {
        clearTimeout(moveTimer);
        moveTimer = null;
    }
    if (activeMoveDir) {
        // 如果正在骑乘，发送零值移动指令停止载具
        if (bot.vehicle) {
            bot.moveVehicle(0, 0);
        } else {
            bot.setControlState(activeMoveDir, false);
        }
        activeMoveDir = null;
    }
    // 停止 pathfinder 寻路
    bot.pathfinder.stop();
}

function startMove(dir, duration) {
    stopMove();
    if (bot.vehicle) {
        // 骑乘时使用 moveVehicle 控制载具
        const moveMap = {
            forward:  [0, 1.0],
            back:     [0, -1.0],
            left:     [-1.0, 0],
            right:    [1.0, 0],
        };
        const [left, forward] = moveMap[dir] || [0, 0];
        bot.moveVehicle(left, forward);
        activeMoveDir = dir;
        if (duration > 0) {
            moveTimer = setTimeout(() => {
                stopMove();
            }, duration);
        }
    } else {
        bot.setControlState(dir, true);
        activeMoveDir = dir;
        if (duration > 0) {
            moveTimer = setTimeout(() => {
                stopMove();
            }, duration);
        }
    }
}

// 计算 bot 当前看向方块的哪个面（用于 placeBlock）
function getTargetFace(block) {
    // 使用视线射线（由视角 yaw/pitch 计算）在一个合理的射程内估算命中点，
    // 然后根据命中点相对于方块中心的偏移决定放置的面。
    const eyePos = bot.entity.position.offset(0, bot.entity.height, 0);
    const bx = block.position.x + 0.5;
    const by = block.position.y + 0.5;
    const bz = block.position.z + 0.5;

    // 计算视线方向（mineflayer 中 yaw/pitch 以弧度表示）
    let dir;
    if (typeof bot.entity.yaw === 'number' && typeof bot.entity.pitch === 'number') {
        const yaw = bot.entity.yaw;
        const pitch = bot.entity.pitch;
        const dx = -Math.sin(yaw) * Math.cos(pitch);
        const dy = -Math.sin(pitch);
        const dz = Math.cos(yaw) * Math.cos(pitch);
        dir = new Vec3(dx, dy, dz);
    } else {
        // 回退到眼位向方块中心的向量
        dir = new Vec3(bx - eyePos.x, by - eyePos.y, bz - eyePos.z).normalize();
    }

    // 射线长度用一个合理的交互距离（例如 6）来近似客户端视距内的交互点
    const reach = 6;
    const hit = eyePos.plus(dir.scale(reach));

    const offX = hit.x - bx;
    const offY = hit.y - by;
    const offZ = hit.z - bz;
    const absX = Math.abs(offX);
    const absY = Math.abs(offY);
    const absZ = Math.abs(offZ);

    if (absX >= absY && absX >= absZ) return new Vec3(Math.sign(offX), 0, 0);
    if (absY >= absX && absY >= absZ) return new Vec3(0, Math.sign(offY), 0);
    return new Vec3(0, 0, Math.sign(offZ));
}

// ═══════════════════════════════════
//  Python 指令 → Mineflayer
// ═══════════════════════════════════

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
    let data;
    try {
        data = JSON.parse(line);
    } catch (e) {
        logInfo(`无效 JSON: ${line}`);
        return;
    }

    try {
        switch (data.type) {
            case 'connect':
                // 动态更新连接配置
                host = data.host || host;
                port = parseInt(data.port) || port;
                username = data.username || username;
                password = data.password || password;
                gameVersion = data.version || gameVersion;
                logInfo(`[Connect] 配置更新: ${username} @ ${host}:${port} (${gameVersion})`);
                tryInitialize();
                break;

            case 'chat':
                bot.chat(data.message);
                logInfo(`[Chat] ${data.message}`);
                break;

            case 'command':
                bot.chat('/' + data.command);
                logInfo(`[Cmd] /${data.command}`);
                break;

            case 'suggestion':
                // Command Suggestions Response (MC 1.21.4 serverbound)
                bot._client.write('command_suggestion', {
                    id: data.id,
                    suggestions: [data.text],
                });
                break;

            case 'respawn':
                bot._client.write('client_command', {
                    actionId: 0, // PERFORM_RESPAWN
                });
                logInfo('[Respawn]');
                break;

            case 'quit':
                bot.quit();
                process.exit(0);
                break;

            case 'move':
                // 基本 WASD 移动: {type:"move", dir:"forward", duration:1000}
                startMove(data.dir, data.duration || 1000);
                logInfo(`[Move] ${data.dir} ${data.duration || 1000}ms`);
                break;

            case 'jump':
                if (bot.vehicle) {
                    // 骑乘时跳跃（马）
                    bot.jump();
                    logInfo('[Jump] 载具跳跃');
                } else {
                    bot.setControlState('jump', true);
                    setTimeout(() => bot.setControlState('jump', false), 200);
                    logInfo('[Jump]');
                }
                break;

            case 'stop':
                stopMove();
                logInfo('[Stop]');
                break;

            case 'goto':
                // 寻路到坐标: {type:"goto", x:100, y:64, z:200}
                if (!movements) {
                    logInfo('[Goto] 移动配置未初始化');
                    break;
                }
                // 停止手动移动（pathfinder.goto 会自动处理）
                if (moveTimer) {
                    clearTimeout(moveTimer);
                    moveTimer = null;
                }
                if (activeMoveDir) {
                    bot.setControlState(activeMoveDir, false);
                    activeMoveDir = null;
                }
                bot.pathfinder.setMovements(movements);
                bot.pathfinder.goto(new GoalBlock(data.x, data.y, data.z))
                    .then(() => logInfo(`[Goto] 到达目标`))
                    .catch(err => logInfo(`[Goto] 寻路失败: ${err.message}`));
                logInfo(`[Goto] ${data.x} ${data.y} ${data.z}`);
                break;

            case 'follow':
                // 跟随玩家: {type:"follow", player:"xxx"}
                const target = bot.players[data.player];
                if (!target || !target.entity) {
                    logInfo(`[Follow] 找不到玩家: ${data.player}`);
                    break;
                }
                if (!movements) {
                    logInfo('[Follow] 移动配置未初始化');
                    break;
                }
                // 先停止之前的移动（但不停止 pathfinder，goto 会自动替换目标）
                if (moveTimer) {
                    clearTimeout(moveTimer);
                    moveTimer = null;
                }
                if (activeMoveDir) {
                    bot.setControlState(activeMoveDir, false);
                    activeMoveDir = null;
                }
                // 重新设置移动配置确保有效
                bot.pathfinder.setMovements(movements);
                bot.pathfinder.goto(new GoalFollow(target.entity, data.distance || 2))
                    .then(() => logInfo(`[Follow] 到达目标附近`))
                    .catch(err => logInfo(`[Follow] 跟随失败: ${err.message}`));
                logInfo(`[Follow] ${data.player} distance=${data.distance || 2}`);
                break;

            case 'look':
                // 转动视角: {type:"look", yaw:180, pitch:0}
                // 看向玩家: {type:"look", player:"xxx"}
                // 看向坐标: {type:"look", x:100, y:64, z:200}
                const waitMsForLook = LOOK_ROTATION_DELAY_MS;
                if (data.player) {
                    const lookTarget = bot.players[data.player];
                    if (!lookTarget || !lookTarget.entity) {
                        logInfo(`[Look] 找不到玩家: ${data.player}`);
                        break;
                    }
                    (async () => {
                        await bot.lookAt(lookTarget.entity.position.offset(0, 1.6, 0));
                        await new Promise(resolve => setTimeout(resolve, waitMsForLook));
                        logInfo(`[Look] 看向玩家 ${data.player}`);
                    })();
                } else if (data.x !== undefined) {
                    (async () => {
                        await bot.lookAt(new Vec3(data.x, data.y + 0.5 || 0.5, data.z));
                        await new Promise(resolve => setTimeout(resolve, waitMsForLook));
                        logInfo(`[Look] 看向坐标 ${data.x} ${data.y} ${data.z}`);
                    })();
                } else {
                    const yaw = data.yaw != null ? data.yaw : 0;
                    const pitch = data.pitch != null ? data.pitch : 0;
                    (async () => {
                        await bot.look(yaw, pitch);
                        await new Promise(resolve => setTimeout(resolve, waitMsForLook));
                        logInfo(`[Look] yaw=${yaw.toFixed(1)} pitch=${pitch.toFixed(1)}`);
                    })();
                }
                break;

            case 'attack':
                // 攻击实体
                bot.swingArm('left');
                const attackEntity = bot.entityAtCursor();
                if (attackEntity) {
                    bot.attack(attackEntity).catch(err => logInfo(`[Attack] 攻击失败: ${err.message}`));
                    logInfo(`[Attack] 攻击实体 ${attackEntity.name || attackEntity.username || '?'}`);
                } else {
                    logInfo('[Attack] 无目标实体');
                }
                break;

            case 'dig':
                // 挖掘方块
                bot.swingArm('left');
                const digBlock = bot.blockAtCursor();
                if (!digBlock) {
                    logInfo('[Dig] 无目标方块');
                    break;
                }
                const digIsCreative = bot.game && bot.game.gameMode === 'creative';
                if (digIsCreative || bot.canDigBlock(digBlock)) {
                    bot.dig(digBlock).catch(err => logInfo(`[Dig] 挖掘失败: ${err.message}`));
                    logInfo(`[Dig] 挖掘 ${digBlock.name}`);
                } else {
                    logInfo(`[Dig] 无法挖掘 ${digBlock.name}（保护或冒险模式）`);
                }
                break;

            case 'swing':
                // 仅挥臂（无实际效果）
                bot.swingArm('left');
                logInfo('[Swing] 挥臂');
                break;

            case 'attack_hold':
                // 攻击长按（持续攻击实体）
                if (isLeftClickHolding) {
                    try { bot.stopDigging(); } catch (e) {}
                    isLeftClickHolding = false;
                    logInfo('[AttackHold] 已停止之前的攻击长按');
                }
                isLeftClickHolding = true;
                bot.swingArm('left');
                const holdAttackEntity = bot.entityAtCursor();
                if (holdAttackEntity) {
                    bot.attack(holdAttackEntity).catch(err => logInfo(`[AttackHold] 攻击失败: ${err.message}`));
                    logInfo(`[AttackHold] 攻击实体 ${holdAttackEntity.name || holdAttackEntity.username || '?'}`);
                } else {
                    logInfo('[AttackHold] 无目标实体');
                }
                break;

            case 'dig_hold':
                // 挖掘长按（持续挖掘方块）
                if (isLeftClickHolding) {
                    try { bot.stopDigging(); } catch (e) {}
                    isLeftClickHolding = false;
                    logInfo('[DigHold] 已停止之前的挖掘长按');
                }
                isLeftClickHolding = true;
                bot.swingArm('left');
                const holdDigBlock = bot.blockAtCursor();
                if (holdDigBlock) {
                    const digHoldIsCreative = bot.game && bot.game.gameMode === 'creative';
                    if (digHoldIsCreative || bot.canDigBlock(holdDigBlock)) {
                        bot.dig(holdDigBlock, true).catch(err => logInfo(`[DigHold] 挖掘失败: ${err.message}`));
                        logInfo(`[DigHold] 开始挖掘 ${holdDigBlock.name}`);
                    } else {
                        logInfo(`[DigHold] 无法挖掘 ${holdDigBlock.name}`);
                    }
                } else {
                    logInfo('[DigHold] 无目标方块');
                }
                break;

            case 'place':
                // 放置方块（对准方块表面放置）
                const placeBlock = bot.blockAtCursor();
                if (!placeBlock) {
                    logInfo('[Place] 无目标方块');
                    break;
                }
                (async () => {
                    try {
                        const face = getTargetFace(placeBlock);
                        const placePos = placeBlock.position.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5);
                        try {
                            bot.lookAt(placePos);
                        } catch (e) {
                            // ignore if lookAt not available as promise
                        }
                        await new Promise(resolve => setTimeout(resolve, LOOK_ROTATION_DELAY_MS));
                        bot.placeBlock(placeBlock, face)
                            .then(() => logInfo(`[Place] 方块已放置 (面: ${face.x},${face.y},${face.z})`))
                            .catch(err => logInfo(`[Place] 放置失败: ${err.message}`));
                    } catch (err) {
                        logInfo(`[Place] 放置过程失败: ${err.message}`);
                    }
                })();
                break;

            case 'interact':
                // 与方块或实体交互（开门/开箱/拉杆/村民交易等）
                const interBlock = bot.blockAtCursor();
                if (interBlock) {
                    bot.activateBlock(interBlock)
                        .then(() => logInfo(`[Interact] 激活方块 ${interBlock.name}`))
                        .catch(err => logInfo(`[Interact] 激活方块失败: ${err.message}`));
                } else {
                    const interEntity = bot.entityAtCursor();
                    if (interEntity) {
                        bot.activateEntity(interEntity)
                            .then(() => logInfo(`[Interact] 与实体交互: ${interEntity.name || interEntity.username || '?'}`))
                            .catch(err => logInfo(`[Interact] 实体交互失败: ${err.message}`));
                    } else {
                        logInfo('[Interact] 无交互目标');
                    }
                }
                break;

            case 'use_item':
                // 使用手持物品（吃东西/射箭/投掷/放水桶等）
                const useItem = bot.heldItem;
                if (!useItem) {
                    logInfo('[UseItem] 手上无物品');
                    break;
                }
                if (useItem.name === 'crossbow') {
                    const charged = useItem.nbt?.value?.Charged?.value;
                    bot.activateItem();
                    if (charged) {
                        logInfo('[UseItem] 弩箭已射出');
                    } else {
                        logInfo('[UseItem] 弩开始上弹...');
                    }
                } else if (useItem.name === 'bow') {
                    bot.activateItem();
                    if (bowTimer) clearTimeout(bowTimer);
                    bowTimer = setTimeout(() => {
                        bot.deactivateItem();
                        logInfo('[UseItem] 弓箭已射出');
                        bowTimer = null;
                    }, 1200);
                } else {
                    bot.activateItem();
                    logInfo(`[UseItem] 使用 ${useItem.name}`);
                }
                break;

            case 'use_item_hold':
                // 使用物品长按（持续按住，如吃东西/拉弓）
                if (isRightClickHolding) {
                    try { bot.deactivateItem(); } catch (e) {}
                    isRightClickHolding = false;
                    logInfo('[UseItemHold] 已停止之前的长按');
                }
                isRightClickHolding = true;
                bot.activateItem();
                logInfo('[UseItemHold] 开始长按');
                break;

            case 'cancel':
                // 取消所有按住的操作（停止挖掘/使用物品/弓箭/移动/关闭容器）
                // 停止挖掘
                try { bot.stopDigging(); } catch (e) {}
                // 停止使用物品（拉弓、吃东西等）
                try { bot.deactivateItem(); } catch (e) {}
                // 清除弓箭定时器
                if (bowTimer) { clearTimeout(bowTimer); bowTimer = null; }
                // 重置长按状态
                isLeftClickHolding = false;
                isRightClickHolding = false;
                // 关闭已打开的容器（箱子/熔炉/工作台等）
                if (bot.currentWindow) {
                    try { bot.closeWindow(bot.currentWindow); } catch (e) {}
                    logInfo('[Cancel] 已关闭容器');
                }
                // 停止移动
                stopMove();
                // 释放所有方向键
                ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint'].forEach(dir => {
                    try { bot.setControlState(dir, false); } catch (e) {}
                });
                activeMoveDir = null;
                logInfo('[Cancel] 已取消所有操作');
                break;

            case 'sneak':
                // 潜行切换: {type:"sneak", state:true|false|null}
                const sneakState = data.state != null ? data.state : !bot.getControlState('sneak');
                bot.setControlState('sneak', sneakState);
                logInfo('[Sneak] ' + (sneakState ? 'ON' : 'OFF'));
                break;

            case 'clear_inventory':
                const isCreative = bot.game && bot.game.gameMode === 'creative';
                if (!isCreative) {
                    logInfo('[ClearInventory] 仅在创造模式可用');
                    break;
                }
                bot.chat('/clear');
                logInfo('[ClearInventory] 已执行 /clear 命令');
                break;

            case 'drop':
                // 丢出物品: {type:"drop", all:true|false}
                if (data.all) {
                    // 丢出背包中所有物品（逐个等待避免并发导致只丢一格）
                    const items = bot.inventory.items();
                    if (items.length === 0) {
                        logInfo('[Drop] 背包为空');
                        break;
                    }
                    logInfo(`[Drop] 开始丢出全部 ${items.length} 格物品...`);
                    let idx = 0;
                    function tossNext() {
                        const currentItems = bot.inventory.items();
                        if (idx >= items.length || currentItems.length === 0) {
                            logInfo('[Drop] 丢出全部完成');
                            return;
                        }
                        // 按类型匹配找到当前还存在的物品
                        const target = currentItems.find(i => i.type === items[idx].type);
                        if (target) {
                            bot.swingArm('right');
                            bot.tossStack(target);
                        }
                        idx++;
                        setTimeout(tossNext, 250);
                    }
                    tossNext();
                } else {
                    // 丢出手持物品
                    const heldItem = bot.heldItem;
                    if (heldItem) {
                        bot.swingArm('right');
                        bot.tossStack(heldItem).catch(err => logInfo(`[Drop] 失败: ${err.message}`));
                        logInfo(`[Drop] 丢出 ${heldItem.name} x${heldItem.count}`);
                    } else {
                        logInfo('[Drop] 手上无物品');
                    }
                }
                break;

            case 'slot':
                // 切换物品栏: {type:"slot", slot:1-44}
                // 1-9=快捷栏, 10-44=背包
                const slotIdx = (data.slot || 1) - 1;
                if (slotIdx >= 0 && slotIdx <= 43) {
                    if (slotIdx <= 8) {
                        bot.setQuickBarSlot(slotIdx);
                        const item = bot.inventory.slots[36 + slotIdx];
                        const itemName = item ? `${item.name} x${item.count}` : '空';
                        logInfo(`[Slot] 切换到快捷栏${slotIdx + 1}: ${itemName}`);
                    } else {
                        (async () => {
                            try {
                                const sourceSlot = slotIdx;
                                const targetSlot = bot.quickBarSlot;
                                await bot.moveSlot(sourceSlot, targetSlot);
                                const item = bot.inventory.slots[36 + targetSlot];
                                const itemName = item ? `${item.name} x${item.count}` : '空';
                                logInfo(`[Slot] 移动背包${slotIdx + 1}到快捷栏${targetSlot + 1}: ${itemName}`);
                            } catch (err) {
                                logInfo(`[Slot] 移动失败: ${err.message}`);
                            }
                        })();
                    }
                }
                break;

            // ── 直接使用物品 ──
            case 'activate_item':
                bot.activateItem();
                logInfo('[ActivateItem]');
                break;

            case 'deactivate_item':
                bot.deactivateItem();
                logInfo('[DeactivateItem]');
                break;

            // ── 装备物品 ──
            case 'equip':
                (async () => {
                    const equipItem = bot.inventory.items().find(i => i.name.includes(data.item));
                    if (!equipItem) {
                        logInfo(`[Equip] 找不到物品: ${data.item}`);
                        return;
                    }
                    try {
                        await bot.equip(equipItem, data.destination || 'hand');
                        logInfo(`[Equip] ${equipItem.name} → ${data.destination || 'hand'}`);
                    } catch (err) {
                        logInfo(`[Equip] 失败: ${err.message}`);
                    }
                })();
                break;

            // ── 骑乘 / 下马 ──
            case 'mount':
                (async () => {
                    const mountEntity = bot.entityAtCursor()
                        || bot.nearestEntity(e => e.objectType === 'Vehicle'
                            || ['boat', 'minecart', 'horse', 'donkey', 'mule', 'pig', 'strider', 'llama'].includes(e.name));
                    if (mountEntity) {
                        try {
                            await bot.mount(mountEntity);
                            logInfo(`[Mount] 已骑乘 ${mountEntity.name || '?'}`);
                        } catch (err) {
                            logInfo(`[Mount] 失败: ${err.message}`);
                        }
                    } else {
                        logInfo('[Mount] 无目标');
                    }
                })();
                break;

            case 'dismount':
                // 离开载具（通过发送潜行键模拟，Minecraft 原版下马方式）
                if (!bot.vehicle) {
                    logInfo('[Dismount] 当前未骑乘任何载具');
                    break;
                }
                bot.setControlState('sneak', true);
                setTimeout(() => {
                    bot.setControlState('sneak', false);
                    logInfo('[Dismount] 已离开载具');
                }, 100);
                break;

            // ── 通用控制状态 ──
            case 'set_control_state':
                bot.setControlState(data.control, data.state);
                logInfo(`[Control] ${data.control}=${data.state}`);
                break;

            // ── 状态查询 ──
            case 'status':
                (() => {
                    const pos = bot.entity.position;
                    sendJson({
                        type: 'status_response',
                        position: { x: Math.round(pos.x * 100) / 100, y: Math.round(pos.y * 100) / 100, z: Math.round(pos.z * 100) / 100 },
                        health: bot.health,
                        food: bot.food,
                        yaw: Math.round(bot.entity.yaw * 100) / 100,
                        pitch: Math.round(bot.entity.pitch * 100) / 100,
                        gamemode: bot.game ? bot.game.gameMode : null,
                        dimension: bot.game ? bot.game.dimension : null,
                        heldItem: bot.heldItem ? { name: bot.heldItem.name, count: bot.heldItem.count } : null,
                        isSneaking: bot.getControlState('sneak'),
                        isSprinting: bot.getControlState('sprint'),
                    });
                })();
                break;

            

            default:
                logInfo(`未知指令类型: ${data.type}`);
        }
    } catch (e) {
        logInfo(`执行指令失败: ${e.message}`);
    }
});

rl.on('close', () => {
    logInfo('stdin 关闭，退出');
    if (bot) bot.quit();
    process.exit(0);
});