/**
 * server.js — mcbot 纯 Node.js 网页控制台
 * ==========================================
 * Express + SocketIO + Mineflayer 一体化服务，
 * 无需 Python，启动后在浏览器访问 http://localhost:5000
 *
 * 启动方式:
 *   node server.js
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const Movements = require('mineflayer-pathfinder').Movements;
const { GoalBlock, GoalFollow } = require('mineflayer-pathfinder').goals;
const { Vec3 } = require('vec3');
const { mineflayer: mineflayerViewer } = require('prismarine-viewer');

// ── 加载配置 ──
const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const CMD_PREFIX = config.command_prefix || '**';

// ── Express + SocketIO ──
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'templates')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'templates', 'index.html')));
app.get('/api/config', (req, res) => res.json({ ...config, viewer_port: viewerPort }));

// ── 全局状态 ──
let bot = null;
let movements = null;
let moveTimer = null;
let activeMoveDir = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let shouldReconnect = true;
let restarting = false;
let bowTimer = null;
let isLeftClickHolding = false;
let isRightClickHolding = false;
let flyTimer = null;
let isFlying = false;
let viewer = null;
let viewerPort = config.viewer_port || 3000;
let viewerViewDistance = config.viewer_view_distance || 10;
const MAX_RECONNECT_DELAY = 60000;
const BASE_RECONNECT_DELAY = 3000;
const LOOK_ROTATION_DELAY_MS = 120;

const currentStatus = {
    connected: false,
    position: { x: 0, y: 0, z: 0 },
    health: 0, food: 0, saturation: 0,
    gamemode: '', dimension: '',
    yaw: 0, pitch: 0,
    heldItem: '',
    isSprinting: false, isSneaking: false,
    isCrawling: false, isRiding: false, isFlying: false,
    username: '', host: '', port: 0,
};
const chatLog = [];
const eventLog = [];
let statusInterval = null;

// ── 日志辅助 ──
function log(level, msg) {
    const ts = new Date().toLocaleTimeString();
    console.log(`[${ts}] [${level}] ${msg}`);
    io.emit('log', { level, msg: `[${level}] ${msg}` });
}

function addEvent(etype, msg) {
    eventLog.push({ type: etype, msg, time: Date.now() / 1000 });
    if (eventLog.length > 200) eventLog.shift();
}

// ═══════════════════════════════════
//  Bot 创建
// ═══════════════════════════════════

function createBot(overrides = {}) {
    if (moveTimer) { clearTimeout(moveTimer); moveTimer = null; }
    if (bowTimer) { clearTimeout(bowTimer); bowTimer = null; }
    if (flyTimer) { clearTimeout(flyTimer); flyTimer = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (viewer) { closeViewer(); }
    shouldReconnect = true;
    activeMoveDir = null;
    movements = null;
    isFlying = false;

    const botOpts = {
        host: overrides.host || config.server.host,
        port: parseInt(overrides.port || config.server.port),
        username: overrides.username || config.bot.username,
        auth: 'offline',
        version: overrides.version || config.server.version || '1.21.4',
        hideErrors: false,
    };
    const password = overrides.password || config.bot.password || '';
    if (overrides.viewer_port) viewerPort = parseInt(overrides.viewer_port) || 3000;
    if (overrides.viewer_view_distance) viewerViewDistance = parseInt(overrides.viewer_view_distance) || 10;
    const trackPlayers = overrides.track_players
        ? overrides.track_players.split(',').map(s => s.trim()).filter(Boolean)
        : (config.track_players || []);

    bot = mineflayer.createBot(botOpts);
    bot.loadPlugin(pathfinder);

    currentStatus.username = botOpts.username;
    currentStatus.host = botOpts.host;
    currentStatus.port = botOpts.port;

    bot.on('login', () => {
        log('info', `已登录: ${botOpts.username}`);
        reconnectAttempts = 0;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        io.emit('bot_event', { type: 'login', data: {} });
    });

    bot.on('message', (jsonMsg) => {
        try {
            const text = extractPlain(jsonMsg, false);
            if (text) {
                chatLog.push({ sender: '[系统]', message: text, time: Date.now() / 1000 });
                io.emit('chat_msg', { sender: '[系统]', message: text });
                processChatCommand(jsonMsg);
            }
        } catch (e) {}
    });

    bot.on('chat', (playerName, message) => {
        if (!bot) return;
        if (playerName === bot.username) return;
        chatLog.push({ sender: playerName, message, time: Date.now() / 1000 });
        io.emit('chat_msg', { sender: playerName, message });
        processChatCommand(message);
    });

    bot.on('playerJoined', (player) => {
        io.emit('bot_event', { type: 'player_joined', data: { username: player.username } });
    });
    bot.on('playerLeft', (player) => {
        io.emit('bot_event', { type: 'player_left', data: { username: player.username } });
    });

    bot.on('kicked', (reason) => {
        const text = typeof reason === 'string' ? reason : JSON.stringify(reason);
        log('warn', `被踢: ${text}`);
        io.emit('bot_event', { type: 'kicked', data: { reason: text } });
        scheduleReconnect(5000);
    });

    bot.on('death', () => {
        log('info', 'Bot 已死亡，自动重生...');
        io.emit('bot_event', { type: 'death', data: {} });
        setTimeout(() => {
            bot._client.write('client_command', { actionId: 0 });
            log('info', '[AutoRespawn] 已发送重生请求');
        }, 1000);
    });

    bot.on('end', (reason) => {
        log('warn', `连接断开: ${reason}`);
        io.emit('bot_event', { type: 'end', data: { reason } });
        currentStatus.connected = false;
        io.emit('status', currentStatus);
        closeViewer();
        scheduleReconnect();
    });

    bot.on('error', (err) => {
        log('error', `错误: ${err.message}`);
        io.emit('bot_event', { type: 'error', data: { message: err.message } });
    });

    bot.on('spawn', () => {
        log('info', 'Bot 已就绪');
        io.emit('bot_event', { type: 'spawn', data: {} });
        currentStatus.connected = true;
        io.emit('bot_connected', {
            username: botOpts.username,
            host: botOpts.host,
            port: botOpts.port,
        });

        movements = new Movements(bot);
        bot.pathfinder.setMovements(movements);

        startViewer();

        if (password) {
            setTimeout(() => {
                if (restarting || !bot) return;
                bot.chat(`/register ${password} ${password}`);
                setTimeout(() => { if (!restarting && bot) bot.chat(`/login ${password}`); }, 1500);
            }, 1000);
        }

        startStatusPolling();
    });

    return bot;
}

function scheduleReconnect(extraDelayMs = 0) {
    if (!shouldReconnect) return;
    if (reconnectTimer) return;
    reconnectAttempts++;
    const backoff = Math.min(BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts - 1), MAX_RECONNECT_DELAY);
    const delay = backoff + extraDelayMs;
    log('info', `将在 ${(delay / 1000).toFixed(1)} 秒后重连 (第 ${reconnectAttempts} 次)`);
    io.emit('bot_event', { type: 'reconnecting', data: { attempt: reconnectAttempts, delay } });
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        createBot();
    }, delay);
}

function doProcessRestart() {
    restarting = true;
    shouldReconnect = false;
    if (bot) {
        try { bot.quit(); } catch (e) {}
    }
    server.close(() => {
        process.exit(100);
    });
    setTimeout(() => process.exit(100), 3000);
}

// ── 状态轮询 ──
function startStatusPolling() {
    if (statusInterval) clearInterval(statusInterval);
    statusInterval = setInterval(() => {
        if (!bot || !currentStatus.connected) return;
        const pos = bot.entity.position;
        currentStatus.position = {
            x: Math.round(pos.x * 10) / 10,
            y: Math.round(pos.y * 10) / 10,
            z: Math.round(pos.z * 10) / 10,
        };
        currentStatus.health = Math.round(bot.health * 10) / 10;
        currentStatus.food = bot.food;
        currentStatus.saturation = Math.round((bot.foodSaturation || 0) * 10) / 10;
        currentStatus.gamemode = bot.game ? bot.game.gameMode : '';
        currentStatus.dimension = bot.game ? bot.game.dimension : '';
        currentStatus.yaw = Math.round((bot.entity.yaw * 180 / Math.PI) * 10) / 10;
        currentStatus.pitch = Math.round((bot.entity.pitch * 180 / Math.PI) * 10) / 10;
        currentStatus.isSneaking = bot.getControlState('sneak');
        currentStatus.isSprinting = bot.getControlState('sprint');
        currentStatus.isCrawling = bot.entity.pose === 'swimming';
        currentStatus.isRiding = !!bot.entity.vehicle;
        currentStatus.isFlying = isFlying;
        const held = bot.heldItem;
        currentStatus.heldItem = held ? (held.displayName || held.name) : '空手';
        io.emit('status', currentStatus);
    }, 1000);
}

// ── 画面渲染（Viewer）──
function startViewer() {
    if (!bot) return;
    try {
        viewer = mineflayerViewer(bot, {
            port: viewerPort,
            firstPerson: true,
            viewDistance: viewerViewDistance,
        });
        log('info', `画面渲染已启动，端口: ${viewerPort}, 视距: ${viewerViewDistance}`);
        io.emit('viewer_status', { active: true, port: viewerPort });
    } catch (err) {
        log('warn', `画面渲染启动失败: ${err.message}`);
    }
}

function closeViewer() {
    if (viewer) {
        try { viewer.close(); } catch (e) {}
        viewer = null;
        io.emit('viewer_status', { active: false });
    }
}

// ═══════════════════════════════════
//  SocketIO 事件处理
// ═══════════════════════════════════

io.on('connection', (socket) => {
    log('info', 'Web 客户端已连接');
    socket.emit('status', currentStatus);
    socket.emit('chat_history', chatLog.slice(-50));

    socket.on('connect_bot', (data = {}) => {
        if (bot && currentStatus.connected) {
            socket.emit('log', { level: 'warning', msg: 'Bot 已连接，请先断开' });
            return;
        }
        try {
            createBot(data);
            addEvent('success', `Bot 已连接到 ${currentStatus.host}:${currentStatus.port}`);
        } catch (e) {
            socket.emit('log', { level: 'error', msg: `连接失败: ${e.message}` });
            socket.emit('bot_error', { msg: e.message });
        }
    });

    socket.on('disconnect_bot', () => {
        shouldReconnect = false;
        isFlying = false;
        if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
        closeViewer();
        if (bot) {
            try { bot.quit(); } catch (e) {}
            bot = null;
        }
        currentStatus.connected = false;
        io.emit('status', currentStatus);
        io.emit('bot_disconnected');
        addEvent('info', 'Bot 已断开');
    });

    socket.on('restart_bot', () => {
        io.emit('log', { level: 'info', msg: '正在进程级重启...' });
        addEvent('info', '进程级重启');
        doProcessRestart();
    });

    socket.on('chat', (data) => {
        const msg = (data.message || '').trim();
        if (!msg || !bot) return;
        bot.chat(msg);
        chatLog.push({ sender: bot.username, message: msg, time: Date.now() / 1000 });
        io.emit('chat_msg', { sender: bot.username, message: msg });
    });

    socket.on('command', (data) => {
        const cmd = (data.command || '').trim();
        if (!cmd || !bot) return;
        bot.chat('/' + cmd);
        addEvent('cmd', '/' + cmd);
    });

    socket.on('move', (data) => {
        if (!bot) return;
        const dir = data.direction;
        const dur = data.duration || 1000;
        startMove(dir, dur);
    });

    socket.on('jump', () => {
        if (!bot) return;
        if (bot.vehicle) {
            bot.jump();
        } else {
            bot.setControlState('jump', true);
            setTimeout(() => bot.setControlState('jump', false), 200);
        }
    });

    socket.on('stop', () => {
        if (!bot) return;
        stopMove();
    });

    socket.on('sneak', (data) => {
        if (!bot) return;
        const state = data && data.state !== undefined ? data.state : !bot.getControlState('sneak');
        bot.setControlState('sneak', state);
    });

    socket.on('sprint', (data) => {
        if (!bot) return;
        const state = data && data.state !== undefined ? data.state : !bot.getControlState('sprint');
        bot.setControlState('sprint', state);
    });

    socket.on('action', (data) => {
        if (!bot) return;
        const action = data.action;
        handleAction(action);
        addEvent('action', action);
    });

    socket.on('look', (data) => {
        if (!bot) return;
        const yaw = data.yaw != null ? parseFloat(data.yaw) * Math.PI / 180 : 0;
        const pitch = data.pitch != null ? parseFloat(data.pitch) * Math.PI / 180 : 0;
        bot.look(yaw, pitch, true);
    });

    socket.on('rotate', (data) => {
        if (!bot) return;
        const dyaw = (parseFloat(data.dyaw) || 0) * Math.PI / 180;
        const dpitch = (parseFloat(data.dpitch) || 0) * Math.PI / 180;
        const newYaw = bot.entity.yaw + dyaw;
        let newPitch = bot.entity.pitch + dpitch;
        const maxPitch = Math.PI / 2 - 0.01;
        if (newPitch > maxPitch) newPitch = maxPitch;
        if (newPitch < -maxPitch) newPitch = -maxPitch;
        bot.look(newYaw, newPitch, true);
    });

    socket.on('goto', (data) => {
        if (!bot || !movements) return;
        stopMove();
        bot.pathfinder.setMovements(movements);
        bot.pathfinder.goto(new GoalBlock(data.x, data.y, data.z))
            .then(() => log('info', `到达目标`))
            .catch(err => log('warn', `寻路失败: ${err.message}`));
        addEvent('goto', `(${data.x}, ${data.y}, ${data.z})`);
    });

    socket.on('follow', (data) => {
        if (!bot || !movements) return;
        const target = bot.players[data.player];
        if (!target || !target.entity) return;
        stopMove();
        bot.pathfinder.setMovements(movements);
        bot.pathfinder.goto(new GoalFollow(target.entity, data.distance || 2))
            .then(() => log('info', `到达目标附近`))
            .catch(err => log('warn', `跟随失败: ${err.message}`));
        addEvent('follow', `${data.player}`);
    });

    socket.on('switch_slot', (data) => {
        if (!bot) return;
        const slot = (data.slot || 1) - 1;
        if (slot >= 0 && slot <= 8) bot.setQuickBarSlot(slot);
    });

    socket.on('move_to_hotbar', () => {
        if (!bot) return;
        moveToHotbar();
    });

    socket.on('equip', (data) => {
        if (!bot) return;
        equipItem(data.item, data.destination || 'hand');
    });

    socket.on('unequip', (data) => {
        if (!bot) return;
        unequipItem(data.destination || 'hand');
    });

    socket.on('whisper', (data) => {
        if (!bot) return;
        bot.chat(`/msg ${data.player} ${data.message}`);
    });

    socket.on('look_at', (data) => {
        if (!bot) return;
        if (data.player) {
            const target = bot.players[data.player];
            if (target && target.entity) {
                bot.lookAt(target.entity.position.offset(0, 1.6, 0));
            }
        } else if (data.x !== undefined) {
            bot.lookAt(new Vec3(data.x, (data.y || 0) + 0.5, data.z));
        }
    });

    socket.on('activate_item', () => {
        if (!bot) return;
        bot.activateItem();
    });

    socket.on('deactivate_item', () => {
        if (!bot) return;
        bot.deactivateItem();
    });

    socket.on('set_control', (data) => {
        if (!bot) return;
        bot.setControlState(data.control, data.state);
    });

    socket.on('pick_block', () => {
        if (!bot) return;
        pickBlock();
    });

    socket.on('fly', (data) => {
        if (!bot) return;
        const state = data && data.state !== undefined ? data.state : !isFlying;
        toggleFly(state);
    });

    socket.on('request_status', () => {
        if (bot && currentStatus.connected) {
            socket.emit('status', currentStatus);
        }
    });

    socket.on('disconnect', () => {
        shouldReconnect = false;
        isFlying = false;
        log('info', 'Web 客户端已断开，关闭 Bot');
        if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
        closeViewer();
        if (bot) {
            try { bot.quit(); } catch (e) {}
            bot = null;
        }
        currentStatus.connected = false;
        io.emit('status', currentStatus);
        io.emit('bot_disconnected');
        addEvent('info', 'Web 客户端断开，Bot 已关闭');
    });
});

// ═══════════════════════════════════
//  移动辅助
// ═══════════════════════════════════

function stopMove() {
    if (moveTimer) { clearTimeout(moveTimer); moveTimer = null; }
    if (activeMoveDir && bot) {
        bot.setControlState(activeMoveDir, false);
        activeMoveDir = null;
    }
    if (bot) bot.pathfinder.stop();
}

function startMove(dir, duration) {
    if (!bot) return;
    stopMove();
    bot.setControlState(dir, true);
    activeMoveDir = dir;
    if (duration > 0) {
        moveTimer = setTimeout(() => stopMove(), duration);
    }
}

function getTargetFace(block) {
    const eyePos = bot.entity.position.offset(0, bot.entity.height, 0);
    const bx = block.position.x + 0.5;
    const by = block.position.y + 0.5;
    const bz = block.position.z + 0.5;
    const yaw = bot.entity.yaw;
    const pitch = bot.entity.pitch;
    const dx = -Math.sin(yaw) * Math.cos(pitch);
    const dy = -Math.sin(pitch);
    const dz = Math.cos(yaw) * Math.cos(pitch);
    const dir = new Vec3(dx, dy, dz);
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
//  动作处理
// ═══════════════════════════════════

function handleAction(action) {
    if (!bot) return;
    switch (action) {
        case 'attack':
            bot.swingArm('left');
            const atkEntity = bot.entityAtCursor();
            if (atkEntity) {
                Promise.resolve(bot.attack(atkEntity)).catch(err => log('warn', `攻击失败: ${err.message}`));
            }
            break;
        case 'attack_hold':
            if (isLeftClickHolding) {
                try { bot.stopDigging(); } catch (e) {}
                isLeftClickHolding = false;
            }
            isLeftClickHolding = true;
            bot.swingArm('left');
            const holdEntity = bot.entityAtCursor();
            if (holdEntity) {
                Promise.resolve(bot.attack(holdEntity)).catch(err => log('warn', `攻击失败: ${err.message}`));
            }
            break;
        case 'dig':
            bot.swingArm('left');
            const digBlock = bot.blockAtCursor();
            if (digBlock) {
                const creative = bot.game && bot.game.gameMode === 'creative';
                if (creative || bot.canDigBlock(digBlock)) {
                    Promise.resolve(bot.dig(digBlock, false)).catch(err => log('warn', `挖掘失败: ${err.message}`));
                }
            }
            break;
        case 'dig_hold':
            if (isLeftClickHolding) {
                try { bot.stopDigging(); } catch (e) {}
                isLeftClickHolding = false;
            }
            isLeftClickHolding = true;
            bot.swingArm('left');
            const holdDig = bot.blockAtCursor();
            if (holdDig) {
                const creative2 = bot.game && bot.game.gameMode === 'creative';
                if (creative2 || bot.canDigBlock(holdDig)) {
                    Promise.resolve(bot.dig(holdDig, true)).catch(err => log('warn', `挖掘失败: ${err.message}`));
                }
            }
            break;
        case 'place':
            (async () => {
                const placeBlock = bot.blockAtCursor();
                if (!placeBlock) { log('warn', '无目标方块'); return; }
                try {
                    const face = getTargetFace(placeBlock);
                    const placePos = placeBlock.position.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5);
                    try { bot.lookAt(placePos); } catch (e) {}
                    await new Promise(r => setTimeout(r, LOOK_ROTATION_DELAY_MS));
                    await bot.placeBlock(placeBlock, face);
                    log('info', `方块已放置`);
                } catch (err) {
                    log('warn', `放置失败: ${err.message}`);
                }
            })();
            break;
        case 'interact':
            const interEntity = bot.entityAtCursor();
            if (interEntity) {
                Promise.resolve(bot.useOn(interEntity)).catch(err => log('warn', `交互失败: ${err.message}`));
            } else {
                const interBlock = bot.blockAtCursor();
                if (interBlock) {
                    Promise.resolve(bot.activateBlock(interBlock)).catch(err => log('warn', `交互失败: ${err.message}`));
                }
            }
            break;
        case 'use_item':
            bot.activateItem();
            bot.deactivateItem();
            break;
        case 'use_item_hold':
            if (isRightClickHolding) {
                bot.deactivateItem();
                isRightClickHolding = false;
            }
            isRightClickHolding = true;
            bot.activateItem();
            break;
        case 'drop':
            const held = bot.heldItem;
            if (held) {
                bot.swingArm('right');
                Promise.resolve(bot.tossStack(held)).catch(err => log('warn', `丢出失败: ${err.message}`));
            }
            break;
        case 'drop_all':
            const items = bot.inventory.items();
            if (items.length === 0) { log('info', '背包为空'); break; }
            let idx = 0;
            function tossNext() {
                const curItems = bot.inventory.items();
                if (idx >= items.length || curItems.length === 0) { log('info', '丢出全部完成'); return; }
                const target = curItems.find(i => i.type === items[idx].type);
                if (target) {
                    bot.swingArm('right');
                    bot.tossStack(target);
                }
                idx++;
                setTimeout(tossNext, 250);
            }
            tossNext();
            break;
        case 'dismount':
            if (!bot.vehicle) { log('info', '当前未骑乘'); break; }
            bot.setControlState('sneak', true);
            setTimeout(() => { bot.setControlState('sneak', false); log('info', '已离开载具'); }, 100);
            break;
        case 'cancel':
            stopMove();
            if (isLeftClickHolding) { try { bot.stopDigging(); } catch (e) {} isLeftClickHolding = false; }
            if (isRightClickHolding) { bot.deactivateItem(); isRightClickHolding = false; }
            if (isFlying) { toggleFly(false); }
            bot.clearControlStates();
            bot.pathfinder.stop();
            break;
        case 'respawn':
            bot._client.write('client_command', { actionId: 0 });
            break;
    }
}

function pickBlock() {
    if (!bot) return;
    const block = bot.blockAtCursor();
    if (!block) {
        log('warn', '未瞄准任何方块');
        return;
    }
    const blockName = block.name;
    let item = bot.registry.itemsByName[blockName];
    if (!item) {
        const shortName = blockName.replace(/^minecraft:/, '');
        item = bot.registry.itemsByName[shortName];
    }
    if (!item) {
        log('warn', `找不到方块 "${blockName}" 对应的物品`);
        return;
    }
    if (bot.game && bot.game.gameMode === 'creative') {
        const hotbarSlot = 36 + bot.quickBarSlot;
        try {
            const Item = require('prismarine-item')(bot.registry);
            bot.creative.setInventorySlot(hotbarSlot, new Item(item.id, 1));
            log('info', `已选取方块: ${item.displayName || item.name}`);
            addEvent('pick_block', item.displayName || item.name);
        } catch (err) {
            log('warn', `选取方块失败: ${err.message}`);
        }
    } else {
        const existing = bot.inventory.items().find(i => i.name === item.name);
        if (existing) {
            bot.setQuickBarSlot(existing.slot - 36);
            log('info', `已切换到: ${item.displayName || item.name}`);
            addEvent('pick_block', item.displayName || item.name);
        } else {
            log('warn', `背包中没有 "${item.displayName || item.name}"`);
        }
    }
}

function toggleFly(state) {
    if (!bot) return;
    const gameMode = bot.game ? bot.game.gameMode : '';
    if (gameMode !== 'creative' && gameMode !== 'spectator') {
        log('warn', '飞行仅在创造/旁观模式下可用');
        return;
    }
    if (state) {
        if (isFlying) return;
        isFlying = true;
        try {
            bot.creative.startFlying();
        } catch (e) {
            bot.setControlState('jump', true);
            bot.setControlState('jump', false);
            setTimeout(() => {
                bot.setControlState('jump', true);
                bot.setControlState('jump', false);
            }, 150);
        }
        if (flyTimer) { clearInterval(flyTimer); flyTimer = null; }
        flyTimer = setInterval(() => {
            if (!bot || !isFlying) {
                if (flyTimer) { clearInterval(flyTimer); flyTimer = null; }
                return;
            }
            const jumpHeld = bot.getControlState('jump');
            const sneakHeld = bot.getControlState('sneak');
            if (jumpHeld && !sneakHeld) {
                bot.entity.velocity = new Vec3(bot.entity.velocity.x, 0.5, bot.entity.velocity.z);
            } else if (sneakHeld && !jumpHeld) {
                bot.entity.velocity = new Vec3(bot.entity.velocity.x, -0.5, bot.entity.velocity.z);
            } else {
                bot.entity.velocity = new Vec3(bot.entity.velocity.x, 0, bot.entity.velocity.z);
            }
        }, 50);
        log('info', '飞行模式已开启 (空格上升，Shift下降)');
        addEvent('fly', 'start');
    } else {
        if (!isFlying) return;
        isFlying = false;
        if (flyTimer) { clearInterval(flyTimer); flyTimer = null; }
        try {
            bot.creative.stopFlying();
        } catch (e) {}
        bot.setControlState('jump', false);
        bot.setControlState('sneak', false);
        log('info', '飞行模式已关闭');
        addEvent('fly', 'stop');
    }
}

async function equipItem(itemName, destination) {
    const equipItem = bot.inventory.items().find(i => i.name.includes(itemName));
    if (!equipItem) { log('warn', `找不到物品: ${itemName}`); return; }
    try {
        await bot.equip(equipItem, destination);
        log('info', `${equipItem.name} → ${destination}`);
    } catch (err) {
        log('warn', `装备失败: ${err.message}`);
    }
}

async function unequipItem(destination) {
    try {
        await bot.unequip(destination);
        log('info', `已取消装备: ${destination}`);
    } catch (err) {
        log('warn', `取消装备失败: ${err.message}`);
    }
}

async function moveToHotbar() {
    const inventoryItems = bot.inventory.items();
    const hotbarSlots = [36, 37, 38, 39, 40, 41, 42, 43, 44];
    const emptyHotbarSlots = hotbarSlots.filter(s => !bot.inventory.slots[s]);
    if (emptyHotbarSlots.length === 0) { log('info', '快捷栏已满'); return; }
    const itemsNotInHotbar = inventoryItems.filter(i => i.slot < 36 || i.slot > 44);
    if (itemsNotInHotbar.length === 0) { log('info', '背包无物品可移动'); return; }
    let movedCount = 0;
    for (let i = 0; i < Math.min(emptyHotbarSlots.length, itemsNotInHotbar.length); i++) {
        try {
            await bot.moveSlot(itemsNotInHotbar[i].slot, emptyHotbarSlots[i]);
            movedCount++;
        } catch (err) {
            log('warn', `移动失败: ${err.message}`);
        }
    }
    log('info', `已移动 ${movedCount} 件物品到快捷栏`);
}

// ═══════════════════════════════════
//  聊天命令系统
// ═══════════════════════════════════

function extractPlain(component, includeHover = true) {
    if (typeof component === 'string') return component;
    if (Array.isArray(component)) return component.map(c => extractPlain(c, includeHover)).join('');
    if (typeof component === 'object' && component !== null) {
        let parts = [];
        if (component.text) parts.push(String(component.text));
        if (component.translate) {
            if (component.with) {
                for (const w of component.with) parts.push(extractPlain(w, includeHover));
            } else {
                parts.push(`[${component.translate}]`);
            }
        }
        if (component.extra) {
            for (const child of component.extra) parts.push(extractPlain(child, includeHover));
        }
        if (component.content && typeof component.content === 'object' && component.content.text) {
            parts.unshift(component.content.text);
        }
        if (includeHover && component.hoverEvent) {
            const h = component.hoverEvent;
            if (h && h.contents) parts.push(extractPlain(h.contents, includeHover));
        }
        return parts.join('');
    }
    return '';
}

function processChatCommand(rawContent) {
    let plain = '';
    if (typeof rawContent === 'string') {
        plain = rawContent;
    } else {
        plain = extractPlain(rawContent, false);
    }

    if (!plain || !plain.trim()) return;
    log('info', `[纯文本] ${plain.substring(0, 300)}`);

    const botName = bot ? bot.username : '';
    let playerName = '';
    let chatMsg = '';

    const pmMatch = plain.match(/\[(\w+)\s*->\s*me\]\s*(.*)/);
    if (pmMatch) {
        playerName = pmMatch[1];
        chatMsg = pmMatch[2].trim();
        if (botName && playerName === botName) return;
    }

    if (!chatMsg) {
        const m = plain.match(/(?:\[.*?\]\s*)?(\w+)\s*>>\s*(.*)/);
        if (m) {
            playerName = m[1];
            chatMsg = m[2].trim();
            if (botName && playerName === botName) return;
        }
    }

    if (!chatMsg) chatMsg = plain;

    if (chatMsg && chatMsg.startsWith(CMD_PREFIX) && playerName) {
        const commandLine = chatMsg.substring(CMD_PREFIX.length).trim();
        if (commandLine) {
            log('info', `[命令] ${playerName}: ${commandLine}`);
            executeCommand(commandLine, playerName);
        }
    }
}

function executeCommand(line, playerName) {
    const parts = line.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    function reply(msg) {
        const MAX_LEN = 200;
        if (msg.includes(' | ')) {
            const items = msg.split(' | ');
            let current = '';
            for (const item of items) {
                if (current && (current.length + item.length + 3) > MAX_LEN) {
                    sendChunk(current);
                    current = item;
                } else {
                    current = current ? current + ' | ' + item : item;
                }
            }
            if (current) sendChunk(current);
        } else {
            for (let i = 0; i < msg.length; i += MAX_LEN) {
                sendChunk(msg.substring(i, i + MAX_LEN));
            }
        }

        function sendChunk(chunk) {
            if (playerName) {
                bot.chat(`/msg ${playerName} ${chunk}`);
            } else {
                bot.chat(chunk);
            }
        }
    }

    switch (cmd) {
        case 'help':
            const helpList = [
                '**help - 列出所有命令',
                '**send <消息> - 发送消息',
                '**cmd <MC指令> - 执行Minecraft指令',
                '**respawn - 重生',
                '**move <方向> [时间ms] - 移动 (forward/back/left/right)',
                '**jump - 跳跃',
                '**stop - 停止',
                '**goto <x> <y> <z> - 寻路',
                '**follow <玩家> [距离] - 跟随',
                '**attack [时间] - 攻击',
                '**dig [时间] - 挖掘',
                '**place - 放置方块',
                '**interact - 交互',
                '**use - 使用物品',
                '**usehold [时间] - 长按使用',
                '**sneak - 切换潜行',
                '**sprint - 切换疾跑',
                '**drop - 丢出物品',
                '**dropall - 丢出全部',
                '**slot <1-9> - 切换格子',
                '**look [yaw] [pitch] - 绝对视角',
                '**rotate <水平°> [垂直°] - 旋转视角',
                '**cancel - 取消操作',
                '**dismount - 下马',
                '**equip <物品名> <槽位> - 装备',
                '**unequip <槽位> - 卸下',
                '**movetohotbar - 背包物品移入快捷栏',
                '**pickblock - 选取准星方块',
                '**fly [on/off] - 切换飞行模式',
                '**ping - 延迟测试',
                '**restart - 进程级重启',
            ];
            reply(helpList.join(' | '));
            break;
        case 'send':
            if (args.length > 0) bot.chat(args.join(' '));
            break;
        case 'cmd':
            if (args.length > 0) bot.chat('/' + args.join(' '));
            break;
        case 'restart':
            reply('正在进程级重启...');
            doProcessRestart();
            break;
        case 'respawn':
            bot._client.write('client_command', { actionId: 0 });
            reply('已发送重生请求');
            break;
        case 'move':
            if (args.length > 0) {
                const dir = args[0];
                const dur = args.length > 1 ? parseInt(args[1]) : 1000;
                startMove(dir, dur);
                reply(`移动: ${dir} ${dur}ms`);
            }
            break;
        case 'jump':
            if (bot.vehicle) bot.jump();
            else { bot.setControlState('jump', true); setTimeout(() => bot.setControlState('jump', false), 200); }
            reply('跳跃');
            break;
        case 'stop':
            stopMove();
            reply('已停止');
            break;
        case 'goto':
            if (args.length >= 3) {
                if (!movements) break;
                stopMove();
                bot.pathfinder.setMovements(movements);
                bot.pathfinder.goto(new GoalBlock(parseInt(args[0]), parseInt(args[1]), parseInt(args[2])))
                    .then(() => { log('info', '到达目标'); reply('到达目标'); })
                    .catch(err => { log('warn', `寻路失败: ${err.message}`); reply(`寻路失败: ${err.message}`); });
            }
            break;
        case 'follow':
            if (args.length > 0) {
                if (!movements) break;
                const target = bot.players[args[0]];
                if (!target || !target.entity) { reply(`找不到玩家: ${args[0]}`); break; }
                stopMove();
                bot.pathfinder.setMovements(movements);
                bot.pathfinder.goto(new GoalFollow(target.entity, args.length > 1 ? parseFloat(args[1]) : 2))
                    .then(() => { log('info', '到达目标附近'); reply('到达目标附近'); })
                    .catch(err => { log('warn', `跟随失败: ${err.message}`); reply(`跟随失败: ${err.message}`); });
            }
            break;
        case 'attack':
            handleAction(args.length > 0 ? 'attack_hold' : 'attack');
            if (args.length > 0) setTimeout(() => { if (isLeftClickHolding) { try { bot.stopDigging(); } catch (e) {} isLeftClickHolding = false; } }, parseInt(args[0]));
            reply('攻击');
            break;
        case 'dig':
            handleAction(args.length > 0 ? 'dig_hold' : 'dig');
            if (args.length > 0) setTimeout(() => { if (isLeftClickHolding) { try { bot.stopDigging(); } catch (e) {} isLeftClickHolding = false; } }, parseInt(args[0]));
            reply('挖掘');
            break;
        case 'place':
            handleAction('place');
            reply('放置方块');
            break;
        case 'interact':
            handleAction('interact');
            reply('交互');
            break;
        case 'use':
            handleAction('use_item');
            reply('使用物品');
            break;
        case 'usehold':
            handleAction('use_item_hold');
            if (args.length > 0) setTimeout(() => { if (isRightClickHolding) { bot.deactivateItem(); isRightClickHolding = false; } }, parseInt(args[0]));
            reply(args.length > 0 ? `长按使用 ${args[0]}ms` : '长按使用');
            break;
        case 'sneak':
            bot.setControlState('sneak', !bot.getControlState('sneak'));
            reply(bot.getControlState('sneak') ? '已潜行' : '已取消潜行');
            break;
        case 'sprint':
            bot.setControlState('sprint', !bot.getControlState('sprint'));
            reply(bot.getControlState('sprint') ? '已疾跑' : '已取消疾跑');
            break;
        case 'drop':
            handleAction('drop');
            reply('丢出物品');
            break;
        case 'dropall':
            handleAction('drop_all');
            reply('丢出全部');
            break;
        case 'slot':
            if (args.length > 0) {
                const s = parseInt(args[0]) - 1;
                if (s >= 0 && s <= 8) { bot.setQuickBarSlot(s); reply(`切换到第 ${args[0]} 格`); }
            }
            break;
        case 'look':
            if (args.length >= 2) {
                const y = parseFloat(args[0]) * Math.PI / 180;
                const p = parseFloat(args[1]) * Math.PI / 180;
                bot.look(y, p, true);
                reply(`视角: yaw=${args[0]} pitch=${args[1]}`);
            } else if (args.length === 1) {
                bot.look(parseFloat(args[0]) * Math.PI / 180, 0, true);
                reply(`视角: yaw=${args[0]}`);
            }
            break;
        case 'rotate':
            if (args.length >= 1) {
                const dy = (parseFloat(args[0]) || 0) * Math.PI / 180;
                const dp = args.length >= 2 ? (parseFloat(args[1]) || 0) * Math.PI / 180 : 0;
                const ny = bot.entity.yaw + dy;
                let np = bot.entity.pitch + dp;
                const mp = Math.PI / 2 - 0.01;
                if (np > mp) np = mp;
                if (np < -mp) np = -mp;
                bot.look(ny, np, true);
                reply(`旋转: yaw${args[0] >= 0 ? '+' : ''}${args[0]}° pitch${args.length >= 2 ? (args[1] >= 0 ? '+' : '') + args[1] : '+0'}°`);
            }
            break;
        case 'cancel':
            handleAction('cancel');
            reply('已取消');
            break;
        case 'dismount':
            handleAction('dismount');
            reply('下马');
            break;
        case 'equip':
            if (args.length >= 1) {
                equipItem(args[0], args.length >= 2 ? args[1] : 'hand');
                reply(`装备 ${args[0]}`);
            }
            break;
        case 'unequip':
            if (args.length >= 1) {
                unequipItem(args[0]);
                reply(`卸下 ${args[0]}`);
            }
            break;
        case 'movetohotbar':
            moveToHotbar();
            reply('背包物品移入快捷栏');
            break;
        case 'pickblock':
            pickBlock();
            reply('选取方块');
            break;
        case 'fly':
            if (args.length > 0) {
                const flyState = args[0].toLowerCase();
                if (flyState === 'on' || flyState === '1' || flyState === 'true') {
                    toggleFly(true);
                } else if (flyState === 'off' || flyState === '0' || flyState === 'false') {
                    toggleFly(false);
                } else {
                    reply('用法: **fly on/off');
                }
            } else {
                toggleFly(!isFlying);
            }
            reply(isFlying ? '飞行模式已开启' : '飞行模式已关闭');
            break;
        case 'ping':
            const start = Date.now();
            bot.chat('/ping');
            bot.once('message', () => {
                const ping = Date.now() - start;
                reply(`Pong! ${ping}ms`);
            });
            break;
        default:
            log('info', `未知命令: ${cmd}`);
            reply(`未知命令: ${cmd}，输入 **help 查看可用命令`);
    }
}

// ═══════════════════════════════════
//  启动
// ═══════════════════════════════════

const PORT = process.env.PORT || 5001;
server.listen(PORT, '0.0.0.0', () => {
    console.log('='.repeat(50));
    console.log('  mcbot 网页控制面板 (纯 Node.js)');
    console.log(`  打开浏览器访问: http://localhost:${PORT}`);
    console.log('='.repeat(50));
    console.log('自动连接 Bot...');
    createBot();
});