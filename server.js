/**
 * server.js — mcbot 纯 Node.js 网页控制台
 * ==========================================
 * Express + SocketIO + Mineflayer 一体化服务，
 * 无需 Python，启动后在浏览器访问 http://localhost:5001
 *
 * 启动方式:
 *   node server.js
 */

const express = require('express');
const http = require('http');
const net = require('net');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const Movements = require('mineflayer-pathfinder').Movements;
const { GoalBlock, GoalFollow } = require('mineflayer-pathfinder').goals;
const { Vec3 } = require('vec3');
const { mineflayer: mineflayerViewer } = require('prismarine-viewer');
const { OllamaClient } = require('./ollama');
const { AIController } = require('./ai_controller');

// ── 加载配置 ──
const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const CMD_PREFIX = config.command_prefix || '**';
const REPLY_MODE = config.reply_mode || 'whisper';

// ── 聊天日志记录器 ──
const LOG_CHAT_ENABLED = config.log_chat_enabled !== false;
const LOG_DIR = path.resolve(__dirname, config.log_dir || './logs');
let logFilePath = null;
let logStream = null;

function initLogFile() {
    if (!LOG_CHAT_ENABLED) return;
    try {
        if (!fs.existsSync(LOG_DIR)) {
            fs.mkdirSync(LOG_DIR, { recursive: true });
        }
        const dateStr = new Date().toISOString().split('T')[0];
        logFilePath = path.join(LOG_DIR, `chat_${dateStr}.log`);
        logStream = fs.createWriteStream(logFilePath, { flags: 'a' });
        writeLog('SYSTEM', '=== 日志记录已启动 ===');
    } catch (e) {
        console.error(`[日志] 初始化日志文件失败: ${e.message}`);
    }
}

function writeLog(type, message) {
    if (!LOG_CHAT_ENABLED || !logStream) return;
    try {
        const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        const line = `[${ts}] [${type}] ${message}\n`;
        logStream.write(line);
    } catch (e) {}
}

function closeLog() {
    if (logStream) {
        try {
            writeLog('SYSTEM', '=== 日志记录已停止 ===');
            logStream.end();
        } catch (e) {}
        logStream = null;
        logFilePath = null;
    }
}

// ── Ollama AI 客户端 ──
const ollama = new OllamaClient(config.ollama || {});
let ollamaAvailable = false;

// ── AI 自主控制器（io 初始化后赋值）──
let aiController;

// ── 聊天内容安全过滤 ──
function sanitizeChat(text) {
    if (!text) return '';
    let result = '';
    for (const ch of text) {
        const code = ch.codePointAt(0);
        if (ch === '\u00a7') continue;
        if (code === 0x2026) { result += '...'; continue; }
        if (code === 0x2018 || code === 0x2019) { result += "'"; continue; }
        if (code === 0x201c || code === 0x201d) { result += '"'; continue; }
        if (code === 0x2013 || code === 0x2014) { result += '-'; continue; }
        if (code === 0x00a0) { result += ' '; continue; }
        if (code < 0x20 && code !== 0x0a) continue;
        if (code >= 0x7f && code < 0xa0) continue;
        if (code >= 0xd800 && code <= 0xdfff) continue;
        if (code > 0x10ffff) continue;
        result += ch;
    }
    return result.trim();
}

/**
 * 发送拆分后的消息（用于 AI 自动回复等场景）
 * @param {string} msg - 完整消息
 * @param {string} targetPlayer - 私聊目标玩家名（空字符串则公聊）
 * @param {number} maxLen - 每段最大长度
 */
function sendSplitMessage(msg, targetPlayer, maxLen = 200) {
    if (!bot || !msg) return;
    const clean = sanitizeChat(msg);
    if (!clean) return;
    for (let i = 0; i < clean.length; i += maxLen) {
        const chunk = clean.substring(i, i + maxLen);
        if (targetPlayer && REPLY_MODE === 'whisper') {
            bot.chat(`/msg ${targetPlayer} ${chunk}`);
        } else {
            bot.chat(chunk);
        }
    }
}

// ── Express + SocketIO ──
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ── AI 自主控制器（仅当 config.ai_enabled 时初始化）──
if (config.ai_enabled !== false) {
    aiController = new AIController(
        ollama,
        () => bot,
        (level, msg) => log(level, msg),
        io
    );
} else {
    aiController = null;
    log('info', 'AI 功能已在配置中禁用');
}

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

    let connectTimer = setTimeout(() => {
        if (!currentStatus.connected) {
            log('warn', `连接超时 (${botOpts.host}:${botOpts.port})，请检查服务器是否在线`);
            io.emit('bot_event', { type: 'error', data: { message: `连接超时: ${botOpts.host}:${botOpts.port}` } });
            try { bot.end(); } catch (e) {}
        }
    }, 15000);

    initLogFile();

    currentStatus.username = botOpts.username;
    currentStatus.host = botOpts.host;
    currentStatus.port = botOpts.port;

    bot.on('login', () => {
        clearTimeout(connectTimer);
        log('info', `已登录: ${botOpts.username}`);
        writeLog('LOGIN', `Bot ${botOpts.username} 已登录服务器`);
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
                writeLog('SYSTEM', text);
                processChatCommand(jsonMsg);
            }
        } catch (e) {}
    });

    bot.on('chat', (playerName, message) => {
        if (!bot) return;
        if (playerName === bot.username) return;
        chatLog.push({ sender: playerName, message, time: Date.now() / 1000 });
        io.emit('chat_msg', { sender: playerName, message });
        writeLog('CHAT', `${playerName}: ${message}`);
        processChatCommand(message);
    });

    bot.on('playerJoined', (player) => {
        io.emit('bot_event', { type: 'player_joined', data: { username: player.username } });
        writeLog('JOIN', `${player.username} 加入了游戏`);
    });
    bot.on('playerLeft', (player) => {
        io.emit('bot_event', { type: 'player_left', data: { username: player.username } });
        writeLog('LEAVE', `${player.username} 离开了游戏`);
    });

    bot.on('kicked', (reason) => {
        clearTimeout(connectTimer);
        const text = typeof reason === 'string' ? reason : JSON.stringify(reason);
        log('warn', `被踢: ${text}`);
        writeLog('KICK', `Bot 被踢出: ${text}`);
        io.emit('bot_event', { type: 'kicked', data: { reason: text } });
        scheduleReconnect(5000);
    });

    bot.on('death', () => {
        log('info', 'Bot 已死亡，自动重生...');
        writeLog('DEATH', 'Bot 已死亡，自动重生');
        io.emit('bot_event', { type: 'death', data: {} });
        setTimeout(() => {
            bot._client.write('client_command', { actionId: 0 });
            log('info', '[AutoRespawn] 已发送重生请求');
        }, 1000);
    });

    bot.on('end', (reason) => {
        clearTimeout(connectTimer);
        log('warn', `连接断开: ${reason}`);
        writeLog('DISCONNECT', `连接断开: ${reason}`);
        io.emit('bot_event', { type: 'end', data: { reason } });
        currentStatus.connected = false;
        io.emit('status', currentStatus);
        if (aiController) aiController.stop();
        closeViewer();
        closeLog();
        scheduleReconnect();
    });

    bot.on('error', (err) => {
        clearTimeout(connectTimer);
        log('error', `错误: ${err.message}`);
        writeLog('ERROR', `Bot 错误: ${err.message}`);
        io.emit('bot_event', { type: 'error', data: { message: err.message } });
    });

    bot.on('spawn', () => {
        log('info', 'Bot 已就绪');
        writeLog('SPAWN', 'Bot 已出生并就绪');
        io.emit('bot_event', { type: 'spawn', data: {} });
        currentStatus.connected = true;
        io.emit('bot_connected', {
            username: botOpts.username,
            host: botOpts.host,
            port: botOpts.port,
        });
        io.emit('ai_status', { available: ollamaAvailable, model: ollama.model, config_enabled: config.ai_enabled !== false });

        movements = new Movements(bot);
        bot.pathfinder.setMovements(movements);

        if (aiController) {
            aiController.movements = movements;
            aiController.GoalNear = require('mineflayer-pathfinder').goals.GoalNear;
        }

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
function checkPort(port) {
    return new Promise((resolve) => {
        const tester = net.createServer();
        tester.once('error', () => resolve(false));
        tester.once('listening', () => {
            tester.close();
            resolve(true);
        });
        tester.listen(port);
    });
}

async function startViewer() {
    if (!bot) return;

    let port = viewerPort;
    let available = await checkPort(port);

    if (!available) {
        log('warn', `端口 ${port} 已被占用，尝试其他端口...`);
        for (let offset = 1; offset <= 10; offset++) {
            port = viewerPort + offset;
            available = await checkPort(port);
            if (available) {
                viewerPort = port;
                log('info', `找到可用端口: ${port}`);
                break;
            }
        }
    }

    if (!available) {
        log('warn', `画面渲染启动失败: 端口 ${viewerPort}-${viewerPort + 10} 均被占用`);
        io.emit('viewer_status', { active: false });
        return;
    }

    // 临时修补 http.Server.listen，捕获 EADDRINUSE 异步错误防止进程崩溃
    const origListen = http.Server.prototype.listen;
    let viewerError = null;
    http.Server.prototype.listen = function (...args) {
        this.once('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                viewerError = err;
            }
        });
        return origListen.apply(this, args);
    };

    try {
        mineflayerViewer(bot, {
            port: port,
            firstPerson: true,
            viewDistance: viewerViewDistance,
        });
    } catch (err) {
        viewerError = err;
    }

    // 恢复原始 listen 方法
    http.Server.prototype.listen = origListen;

    if (viewerError) {
        log('warn', `画面渲染启动失败: ${viewerError.message}`);
        io.emit('viewer_status', { active: false });
        return;
    }

    viewer = true;
    log('info', `画面渲染已启动，端口: ${port}, 视距: ${viewerViewDistance}`);
    io.emit('viewer_status', { active: true, port: port });
}

function closeViewer() {
    if (viewer && bot && bot.viewer) {
        viewer = null;
        io.emit('viewer_status', { active: false });
        try {
            bot.viewer.close();
        } catch (e) {}
    }
}

// ═══════════════════════════════════
//  SocketIO 事件处理
// ═══════════════════════════════════

io.on('connection', (socket) => {
    log('info', 'Web 客户端已连接');
    socket.emit('status', currentStatus);
    socket.emit('chat_history', chatLog.slice(-50));
    socket.emit('ai_status', { available: ollamaAvailable, model: ollama.model, config_enabled: config.ai_enabled !== false });

    // 如果 Bot 已在线，通知新客户端
    if (bot && currentStatus.connected) {
        socket.emit('bot_connected', {
            username: currentStatus.username,
            host: currentStatus.host,
            port: currentStatus.port,
        });
        if (viewer) {
            socket.emit('viewer_status', { active: true, port: viewerPort });
        }
    }

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
        closeLog();
        if (bot) {
            try { bot.quit(); } catch (e) {}
            bot = null;
        }
        currentStatus.connected = false;
        io.emit('status', currentStatus);
        io.emit('bot_disconnected');
        if (aiController) aiController.stop();
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
        writeLog('BOT_CHAT', `${bot.username}: ${msg}`);
    });

    socket.on('command', (data) => {
        const cmd = (data.command || '').trim();
        if (!cmd || !bot) return;
        bot.chat('/' + cmd);
        writeLog('BOT_CMD', `/${cmd}`);
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
        bot.setControlState('jump', true);
        setTimeout(() => bot.setControlState('jump', false), 200);
    });

    socket.on('stop', () => {
        if (!bot) return;
        stopMove();
    });

    socket.on('sneak', (data) => {
        if (!bot) return;
        const state = data && data.state !== undefined ? data.state : !bot.getControlState('sneak');
        bot.setControlState('sneak', state);
        bot._client.write('entity_action', {
            entityId: bot.entity.id,
            actionId: state ? 0 : 1,
            jumpBoost: 0
        });
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
        writeLog('ACTION', `Bot 执行动作: ${action}`);
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

    socket.on('unequipall', () => {
        if (!bot) return;
        unequipAll().then(r => socket.emit('chatmsg', { type: 'info', message: r.msg }));
    });

    socket.on('whisper', (data) => {
        if (!bot) return;
        bot.chat(`/msg ${data.player} ${data.message}`);
        writeLog('WHISPER', `→ ${data.player}: ${data.message}`);
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

    socket.on('ai_chat', async (data) => {
        if (config.ai_enabled === false) {
            socket.emit('ai_reply', { message: 'AI 功能已在配置中禁用', model: '' });
            return;
        }
        if (!ollamaAvailable) {
            socket.emit('ai_reply', { message: 'AI 服务未连接，请确保 Ollama 已启动', model: '' });
            return;
        }
        const message = (data.message || '').trim();
        if (!message) return;
        socket.emit('ai_typing', true);
        try {
            const reply = await ollama.chatWithHistory('web', message);
            socket.emit('ai_reply', { message: sanitizeChat(reply), model: ollama.model });
        } catch (err) {
            socket.emit('ai_reply', { message: `AI 请求失败: ${err.message}`, model: ollama.model });
        }
        socket.emit('ai_typing', false);
    });

    socket.on('ai_set_mode', (data) => {
        const enabled = data.enabled === true || data.enabled === 'true' || data.enabled === 'on';
        ollama.setAutoReply(enabled);
        socket.emit('ai_mode_changed', { enabled: ollama.autoReplyEnabled });
    });

    socket.on('ai_get_models', async () => {
        try {
            const models = await ollama.listModels();
            socket.emit('ai_models', models);
        } catch (err) {
            socket.emit('ai_models', []);
        }
    });

    socket.on('ai_clear', () => {
        ollama.clearAllHistory();
        socket.emit('ai_cleared', {});
    });

    socket.on('disconnect', () => {
        log('info', 'Web 客户端已断开（Bot 继续保持在线）');
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
            bot._client.write('entity_action', {
                entityId: bot.entity.id,
                actionId: 0,
                jumpBoost: 0
            });
            setTimeout(() => {
                bot.setControlState('sneak', false);
                bot._client.write('entity_action', {
                    entityId: bot.entity.id,
                    actionId: 1,
                    jumpBoost: 0
                });
                log('info', '已离开载具');
            }, 100);
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

async function unequipAll() {
    const slots = ['head', 'torso', 'legs', 'feet', 'off-hand'];
    const equipped = [];
    for (const slot of slots) {
        const item = bot.inventory.slots[bot.getEquipmentDestSlot(slot)];
        if (item) equipped.push(slot);
    }
    if (equipped.length === 0) {
        log('info', '没有可卸下的装备');
        return { success: false, msg: '没有可卸下的装备' };
    }
    const emptySlots = bot.inventory.emptySlotCount();
    if (emptySlots < equipped.length) {
        log('warn', `背包空间不足 (需要${equipped.length}格, 空${emptySlots}格)`);
        return { success: false, msg: `背包空间不足 (需要${equipped.length}格, 空${emptySlots}格)` };
    }
    let count = 0;
    for (const slot of equipped) {
        try {
            await bot.unequip(slot);
            count++;
        } catch (err) {
            log('warn', `卸下 ${slot} 失败: ${err.message}`);
        }
    }
    log('info', `已卸下 ${count} 件装备`);
    return { success: true, msg: `已卸下 ${count} 件装备` };
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
            writeLog('COMMAND', `${playerName}: ${CMD_PREFIX}${commandLine}`);
            executeCommand(commandLine, playerName);
        }
    } else if (chatMsg && playerName && !chatMsg.startsWith(CMD_PREFIX)) {
        handleAutoReply(chatMsg, playerName);
    }
}

function executeCommand(line, playerName) {
    const parts = line.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    function reply(msg) {
        const MAX_LEN = 200;
        const clean = sanitizeChat(msg);
        if (!clean) return;
        writeLog('CMD_REPLY', `→ ${playerName || '公聊'}: ${clean.substring(0, 200)}`);
        if (clean.includes(' | ')) {
            const items = clean.split(' | ');
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
            for (let i = 0; i < clean.length; i += MAX_LEN) {
                sendChunk(clean.substring(i, i + MAX_LEN));
            }
        }

        function sendChunk(chunk) {
            if (playerName && REPLY_MODE === 'whisper') {
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
                '**look [yaw] [pitch] - 绝对视角，**look at <玩家名> - 看向玩家',
                '**rotate <水平°> [垂直°] - 旋转视角',
                '**cancel - 取消操作',
                '**dismount - 下马',
                '**equip <物品名> <槽位> - 装备',
                '**unequip <槽位> - 卸下装备',
                '**unequipall - 卸下全部装备',
                '**movetohotbar - 背包物品移入快捷栏',
                '**pickblock - 选取准星方块',
                '**itemid - 查看手中物品ID',
                '**fly [on/off] - 切换飞行模式',
                '**give <物品名> [数量] - 创造模式获取物品',
                '**ping [地址] - 延迟测试/服务器信息',
                '**restart - 进程级重启',
            ];
            if (config.ai_enabled !== false) {
                helpList.push(
                    '**ai <消息> - 与AI对话',
                    '**aimode [on/off] - 切换AI自动回复',
                    '**aimodel [模型名] - 切换/查看AI模型',
                    '**aimodels - 列出可用AI模型',
                    '**aiclear - 清除AI对话历史',
                    '**aicontrol [on/off/status] - AI自主控制',
                    '**aidelay <毫秒> - 设置AI控制间隔'
                );
            }
            reply(helpList.join(' | '));
            break;
        case 'send':
            if (args.length === 0) {
                reply('用法: **send <消息>');
                break;
            }
            bot.chat(args.join(' '));
            break;
        case 'cmd':
            if (args.length === 0) {
                reply('用法: **cmd <MC指令>');
                break;
            }
            bot.chat('/' + args.join(' '));
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
            if (args.length === 0) {
                reply('用法: **move <方向> [时间ms]  方向: forward/back/left/right');
                break;
            }
            {
                const dirs = ['forward', 'back', 'left', 'right'];
                const dir = args[0].toLowerCase();
                if (!dirs.includes(dir)) {
                    reply(`无效方向: ${args[0]}, 可选: forward/back/left/right`);
                    break;
                }
                const dur = args.length > 1 ? parseInt(args[1]) : 1000;
                if (isNaN(dur) || dur < 0) {
                    reply('时间必须大于等于0 (ms)');
                    break;
                }
                startMove(dir, dur);
                reply(`移动: ${dir} ${dur}ms`);
            }
            break;
        case 'jump':
            bot.setControlState('jump', true);
            setTimeout(() => bot.setControlState('jump', false), 200);
            reply('跳跃');
            break;
        case 'stop':
            stopMove();
            reply('已停止');
            break;
        case 'goto':
            if (args.length < 3) {
                reply('用法: **goto <x> <y> <z>');
                break;
            }
            {
                const x = parseInt(args[0]), y = parseInt(args[1]), z = parseInt(args[2]);
                if (isNaN(x) || isNaN(y) || isNaN(z)) {
                    reply('坐标必须为整数');
                    break;
                }
                if (!movements) break;
                stopMove();
                bot.pathfinder.setMovements(movements);
                bot.pathfinder.goto(new GoalBlock(x, y, z))
                    .then(() => { log('info', '到达目标'); reply('到达目标'); })
                    .catch(err => { log('warn', `寻路失败: ${err.message}`); reply(`寻路失败: ${err.message}`); });
            }
            break;
        case 'follow':
            if (args.length === 0) {
                reply('用法: **follow <玩家名> [距离]');
                break;
            }
            {
                if (!movements) break;
                const target = bot.players[args[0]];
                if (!target || !target.entity) { reply(`找不到玩家: ${args[0]}`); break; }
                const dist = args.length > 1 ? parseFloat(args[1]) : 2;
                if (args.length > 1 && (isNaN(dist) || dist < 0)) {
                    reply('距离必须大于等于0');
                    break;
                }
                stopMove();
                bot.pathfinder.setMovements(movements);
                bot.pathfinder.goto(new GoalFollow(target.entity, dist))
                    .then(() => { log('info', '到达目标附近'); reply('到达目标附近'); })
                    .catch(err => { log('warn', `跟随失败: ${err.message}`); reply(`跟随失败: ${err.message}`); });
            }
            break;
        case 'attack':
            {
                const dur = args.length > 0 ? parseInt(args[0]) : 0;
                if (args.length > 0 && (isNaN(dur) || dur <= 0)) {
                    reply('用法: **attack [持续ms]  时间必须大于0');
                    break;
                }
                handleAction(dur > 0 ? 'attack_hold' : 'attack');
                if (dur > 0) setTimeout(() => { if (isLeftClickHolding) { try { bot.stopDigging(); } catch (e) {} isLeftClickHolding = false; } }, dur);
                reply(dur > 0 ? `持续攻击 ${dur}ms` : '攻击');
            }
            break;
        case 'dig':
            {
                const dur = args.length > 0 ? parseInt(args[0]) : 0;
                if (args.length > 0 && (isNaN(dur) || dur <= 0)) {
                    reply('用法: **dig [持续ms]  时间必须大于0');
                    break;
                }
                handleAction(dur > 0 ? 'dig_hold' : 'dig');
                if (dur > 0) setTimeout(() => { if (isLeftClickHolding) { try { bot.stopDigging(); } catch (e) {} isLeftClickHolding = false; } }, dur);
                reply(dur > 0 ? `持续挖掘 ${dur}ms` : '挖掘');
            }
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
            {
                const dur = args.length > 0 ? parseInt(args[0]) : 0;
                if (args.length > 0 && (isNaN(dur) || dur <= 0)) {
                    reply('用法: **usehold [持续ms]  时间必须大于0');
                    break;
                }
                handleAction('use_item_hold');
                if (dur > 0) setTimeout(() => { if (isRightClickHolding) { bot.deactivateItem(); isRightClickHolding = false; } }, dur);
                reply(dur > 0 ? `长按使用 ${dur}ms` : '长按使用');
            }
            break;
        case 'sneak':
            const sneakState = !bot.getControlState('sneak');
            bot.setControlState('sneak', sneakState);
            bot._client.write('entity_action', {
                entityId: bot.entity.id,
                actionId: sneakState ? 0 : 1,
                jumpBoost: 0
            });
            reply(sneakState ? '已潜行' : '已取消潜行');
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
            if (args.length === 0) {
                reply('用法: **slot <1-9>');
                break;
            }
            {
                const s = parseInt(args[0]) - 1;
                if (isNaN(s) || s < 0 || s > 8) {
                    reply('格子在1-9之间');
                    break;
                }
                bot.setQuickBarSlot(s);
                reply(`切换到第 ${args[0]} 格`);
            }
            break;
        case 'look':
            if (args.length >= 1 && args[0].toLowerCase() === 'at' && args.length >= 2) {
                const lookTarget = bot.players[args[1]];
                if (lookTarget && lookTarget.entity) {
                    bot.lookAt(lookTarget.entity.position.offset(0, 1.6, 0));
                    reply(`看向玩家 ${args[1]}`);
                } else {
                    reply(`找不到玩家: ${args[1]}`);
                }
            } else if (args.length >= 2 && !isNaN(parseFloat(args[0])) && !isNaN(parseFloat(args[1]))) {
                const y = parseFloat(args[0]) * Math.PI / 180;
                const p = parseFloat(args[1]) * Math.PI / 180;
                bot.look(y, p, true);
                reply(`视角: yaw=${args[0]} pitch=${args[1]}`);
            } else if (args.length === 1 && !isNaN(parseFloat(args[0]))) {
                bot.look(parseFloat(args[0]) * Math.PI / 180, 0, true);
                reply(`视角: yaw=${args[0]}`);
            } else {
                reply('用法: **look <yaw> [pitch] 或 **look at <玩家名>');
            }
            break;
        case 'rotate':
            if (args.length === 0) {
                reply('用法: **rotate <水平°> [垂直°]');
                break;
            }
            {
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
            if (args.length === 0) {
                reply('用法: **equip <物品名> [槽位]  槽位: head/torso/legs/feet/off-hand');
                break;
            }
            equipItem(args[0], args.length >= 2 ? args[1] : 'hand');
            reply(`装备 ${args[0]}`);
            break;
        case 'unequip':
            if (args.length === 0) {
                reply('用法: **unequip <槽位>  槽位: head/torso/legs/feet/off-hand');
                break;
            }
            unequipItem(args[0]);
            reply(`卸下 ${args[0]}`);
            break;
        case 'unequipall':
            unequipAll().then(r => reply(r.msg));
            break;
        case 'movetohotbar':
            moveToHotbar();
            reply('背包物品移入快捷栏');
            break;
        case 'pickblock':
            pickBlock();
            reply('选取方块');
            break;
        case 'itemid':
            {
                if (!bot || !bot.heldItem) {
                    reply('手中没有物品');
                    break;
                }
                const item = bot.heldItem;
                reply([
                    `名称: ${item.displayName || item.name}`,
                    `ID: ${item.type}`,
                    `Name: ${item.name}`,
                    `数量: ${item.count}`,
                    item.nbt ? `NBT: ${JSON.stringify(item.nbt).substring(0, 100)}` : '',
                ].filter(Boolean).join(' | '));
            }
            break;
        case 'give':
            if (args.length === 0) {
                reply('用法: **give <物品名> [数量]');
                break;
            }
            if (bot.game && bot.game.gameMode !== 'creative') {
                reply('仅创造模式可用');
                break;
            }
            {
                const itemName = args[0].toLowerCase();
                const count = args.length > 1 ? parseInt(args[1]) : 1;
                if (args.length > 1 && (isNaN(count) || count < 1 || count > 64)) {
                    reply('数量范围: 1-64');
                    break;
                }
                let item = bot.registry.itemsByName[itemName];
                if (!item) {
                    const shortName = itemName.replace(/^minecraft:/, '');
                    item = bot.registry.itemsByName[shortName];
                }
                if (!item) {
                    reply(`未知物品: ${itemName}`);
                    break;
                }
                try {
                    const Item = require('prismarine-item')(bot.registry);
                    const hotbarSlot = 36 + bot.quickBarSlot;
                    bot.creative.setInventorySlot(hotbarSlot, new Item(item.id, count));
                    reply(`已获取: ${item.displayName || item.name}${count > 1 ? ` x${count}` : ''}`);
                } catch (err) {
                    reply(`获取失败: ${err.message}`);
                }
            }
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
            const mc = require('minecraft-protocol');
            let pingHost, pingPort;

            if (args.length > 0) {
                // **ping <host>[:port]  ping 外部服务器
                const addr = args[0];
                const colonIdx = addr.lastIndexOf(':');
                pingHost = colonIdx > 0 ? addr.substring(0, colonIdx) : addr;
                pingPort = colonIdx > 0 ? parseInt(addr.substring(colonIdx + 1)) || 25565 : 25565;
                reply(`正在 Ping ${pingHost}:${pingPort}...`);
            } else {
                // **ping   ping 当前服务器
                pingHost = bot.mc_srv.host;
                pingPort = bot.mc_srv.port;
            }

            mc.ping({ host: pingHost, port: pingPort }, (err, results) => {
                if (err || !results) {
                    reply(`Ping 失败: ${err ? err.message : '无响应'}`);
                    return;
                }
                const motd = (typeof results.description === 'string')
                    ? results.description
                    : results.description?.text || results.description?.extra?.map(e => e.text).join('') || '';
                const motdClean = motd.replace(/§./g, '').replace(/\n/g, ' ').trim().substring(0, 80);
                const version = results.version?.name || '?';
                const online = results.players?.online ?? '?';
                const max = results.players?.max ?? '?';
                const latency = results.latency != null ? `${results.latency}ms` : '?';

                reply(`[${pingHost}] ${motdClean || '无MOTD'} | 版本: ${version} | 在线: ${online}/${max} | 延迟: ${latency}`);
            });
            break;
        case 'ai':
            if (config.ai_enabled === false) {
                reply('AI 功能已在配置中禁用');
                break;
            }
            if (!ollamaAvailable) {
                reply('AI 服务未连接，请确保 Ollama 已启动');
                break;
            }
            if (args.length === 0) {
                reply('用法: **ai <消息>');
                break;
            }
            handleAiChat(args.join(' '), playerName, reply);
            break;
        case 'aimode':
            if (config.ai_enabled === false) {
                reply('AI 功能已在配置中禁用');
                break;
            }
            if (!ollamaAvailable) {
                reply('AI 服务未连接，请确保 Ollama 已启动');
                break;
            }
            if (args.length > 0) {
                const mode = args[0].toLowerCase();
                if (mode === 'on' || mode === '1' || mode === 'true') {
                    ollama.setAutoReply(true);
                    reply('AI 自动回复已开启');
                } else if (mode === 'off' || mode === '0' || mode === 'false') {
                    ollama.setAutoReply(false);
                    reply('AI 自动回复已关闭');
                } else {
                    reply('用法: **aimode on/off');
                }
            } else {
                ollama.setAutoReply(!ollama.autoReplyEnabled);
                reply(ollama.autoReplyEnabled ? 'AI 自动回复已开启' : 'AI 自动回复已关闭');
            }
            break;
        case 'aimodel':
            if (config.ai_enabled === false) {
                reply('AI 功能已在配置中禁用');
                break;
            }
            if (!ollamaAvailable) {
                reply('AI 服务未连接，请确保 Ollama 已启动');
                break;
            }
            if (args.length > 0) {
                ollama.model = args[0];
                reply(`AI 模型已切换为: ${args[0]}`);
            } else {
                reply(`当前 AI 模型: ${ollama.model}`);
            }
            break;
        case 'aimodels':
            if (config.ai_enabled === false) {
                reply('AI 功能已在配置中禁用');
                break;
            }
            handleListModels(reply);
            break;
        case 'aiclear':
            if (config.ai_enabled === false) {
                reply('AI 功能已在配置中禁用');
                break;
            }
            ollama.clearAllHistory();
            reply('AI 对话历史已清除');
            break;
        case 'aicontrol':
            if (config.ai_enabled === false) {
                reply('AI 功能已在配置中禁用');
                break;
            }
            if (!ollamaAvailable) {
                reply('AI 服务未连接，请确保 Ollama 已启动');
                break;
            }
            if (!aiController) {
                reply('AI 控制器未初始化');
                break;
            }
            if (args.length > 0) {
                const ctrlMode = args[0].toLowerCase();
                if (ctrlMode === 'on' || ctrlMode === '1' || ctrlMode === 'true') {
                    aiController.start();
                    reply('AI 自主控制已开启');
                } else if (ctrlMode === 'off' || ctrlMode === '0' || ctrlMode === 'false') {
                    aiController.stop();
                    reply('AI 自主控制已停止');
                } else if (ctrlMode === 'status') {
                    reply(`AI 自主控制: ${aiController.enabled ? '运行中' : '已停止'} | 间隔: ${aiController.loopDelay}ms`);
                } else {
                    reply('用法: **aicontrol on/off/status');
                }
            } else {
                if (aiController.enabled) {
                    aiController.stop();
                    reply('AI 自主控制已停止');
                } else {
                    aiController.start();
                    reply('AI 自主控制已开启');
                }
            }
            break;
        case 'aidelay':
            if (config.ai_enabled === false) {
                reply('AI 功能已在配置中禁用');
                break;
            }
            if (!ollamaAvailable) {
                reply('AI 服务未连接，请确保 Ollama 已启动');
                break;
            }
            if (args.length > 0) {
                const delay = parseInt(args[0]);
                if (isNaN(delay) || delay < 1000 || delay > 30000) {
                    reply('间隔范围: 1000-30000 毫秒');
                } else {
                    aiController.setDelay(delay);
                    reply(`AI 控制间隔已设为 ${delay}ms`);
                }
            } else {
                reply(`当前 AI 控制间隔: ${aiController.loopDelay}ms`);
            }
            break;
        default:
            log('info', `未知命令: ${cmd}`);
            reply(`未知命令: ${cmd}，输入 **help 查看可用命令`);
    }
}

// ═══════════════════════════════════
//  AI 功能
// ═══════════════════════════════════

async function handleAiChat(message, playerName, replyFn) {
    if (!ollamaAvailable) {
        replyFn('AI 服务未连接，请确保 Ollama 已启动');
        return;
    }
    try {
        replyFn('AI思考中...');
        const sessionId = playerName || 'global';
        const aiReply = await ollama.chatWithHistory(sessionId, message);
        if (aiReply) {
            replyFn(sanitizeChat(aiReply));
        } else {
            replyFn('AI 未返回有效回复');
        }
    } catch (err) {
        log('error', `AI 请求失败: ${err.message}`);
        replyFn(`AI 请求失败: ${err.message}`);
    }
}

async function handleListModels(replyFn) {
    if (!ollamaAvailable) {
        replyFn('AI 服务未连接，请确保 Ollama 已启动');
        return;
    }
    try {
        const models = await ollama.listModels();
        if (models.length === 0) {
            replyFn('未找到可用模型，请确保 Ollama 已启动并拉取了模型');
            return;
        }
        const modelList = models.map(m => m.name).join(' | ');
        replyFn(`可用模型: ${modelList}`);
    } catch (err) {
        log('error', `获取模型列表失败: ${err.message}`);
        replyFn(`获取模型列表失败: ${err.message}，请确保 Ollama 服务已启动`);
    }
}

/**
 * 处理 AI 自动回复，在收到聊天消息时调用
 * @param {string} message - 聊天消息内容
 * @param {string} playerName - 发送者名称
 */
async function handleAutoReply(message, playerName) {
    if (!ollamaAvailable) return;
    if (!ollama.shouldAutoReply(playerName)) return;
    if (!bot) return;

    try {
        const aiReply = await ollama.chatWithHistory(playerName, message);
        if (aiReply) {
            sendSplitMessage(aiReply, playerName);
            const shortReply = sanitizeChat(aiReply).substring(0, 100);
            chatLog.push({ sender: bot.username, message: `[AI→${playerName}] ${shortReply}`, time: Date.now() / 1000 });
            io.emit('chat_msg', { sender: bot.username, message: `[AI→${playerName}] ${shortReply}` });
            writeLog('AI_REPLY', `→ ${playerName}: ${shortReply}`);
        }
    } catch (err) {
        log('error', `AI 自动回复失败: ${err.message}`);
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

    // 检查 Ollama 服务状态（仅当 AI 功能启用时）
    if (config.ai_enabled !== false) {
        ollama.checkHealth().then(available => {
            ollamaAvailable = available;
            if (available) {
                console.log('[Ollama] AI 服务已连接');
                ollama.listModels().then(models => {
                    const names = models.map(m => m.name).join(', ');
                    console.log(`[Ollama] 可用模型: ${names || '无'}`);
                }).catch(() => {});
            } else {
                console.log('[Ollama] AI 服务未连接，AI 功能已禁用');
            }
        }).catch(() => {
            ollamaAvailable = false;
            console.log('[Ollama] AI 服务检测失败，AI 功能已禁用');
        });
    } else {
        console.log('[AI] 已在配置中禁用，跳过初始化');
    }
});