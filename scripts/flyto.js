'use strict';

/**
 * 创造飞行空中寻路（无人机模式）
 *
 * 原理：mineflayer-pathfinder 不支持飞行寻路，这里改为直线飞向目标：
 *   开启飞行 -> 面向目标 -> 按住前进 + 按高度差比例自动升/降（平滑，不抖动）
 *   到达目标附近（1 格内）自动悬停。
 *
 * 用法:
 *   **run flyto <x> <y> <z> [debug]  飞到指定坐标（仅创造/旁观模式；加 debug 打印移动日志）
 *   **run flyto stop           停止（悬停原地）
 *
 * 注意:
 *   - 直线飞行，途中撞到方块会卡住（有卡住检测，超时会自动停止）
 *   - 结束后保持飞行状态，落地请再执行 **fly off
 */

const { Vec3 } = require('vec3');
const fs = require('fs');
const path = require('path');

const FLAG_KEY = 'flyto';

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(bot) {
    return bot && bot.entity && bot._client && !bot._client.ended;
}

// 调试日志写入 logs/ 目录（追加模式）
function createDebugFile(fileName) {
    const dir = path.resolve(__dirname, '..', 'logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const stream = fs.createWriteStream(path.join(dir, fileName), { flags: 'a' });
    return {
        write(msg) { try { stream.write(msg + '\n'); } catch (e) {} },
        close() { try { stream.end(); } catch (e) {} },
    };
}

// 开启飞行（与 server.js toggleFly 相同的实现：本地零重力 + 通知服务器）
async function enableFlight(bot, log) {
    try {
        bot.creative.startFlying();
    } catch (e) {
        log('warn', '开启本地飞行失败: ' + e.message);
    }
    try {
        // 完整能力 flags：spectator=0x0f，creative=0x0e（含 allowFlying/creativeMode + flying）
        const gameMode = bot.game ? bot.game.gameMode : '';
        const flags = gameMode === 'spectator' ? 0x0f : 0x0e;
        bot._abilitiesFlags = flags;
        bot._client.write('abilities', { flags });
    } catch (e) {
        log('warn', '发送飞行状态失败（仅本地飞行）: ' + e.message);
    }
}

module.exports = async function (bot, context) {
    const { reply, args, log } = context;
    if (!bot.__scriptFlags) bot.__scriptFlags = {};

    if ((args[0] || '').toLowerCase() === 'stop') {
        bot.__scriptFlags[FLAG_KEY] = true;
        bot.setControlState('forward', false);
        bot.setControlState('jump', false);
        bot.setControlState('sneak', false);
        reply('已请求停止飞行寻路');
        return;
    }

    if (!isAlive(bot)) {
        reply('Bot 未连接');
        return;
    }

    const x = Number(args[0]), y = Number(args[1]), z = Number(args[2]);
    if ([x, y, z].some(Number.isNaN)) {
        reply('用法: **run flyto <x> <y> <z>');
        return;
    }

    const gameMode = bot.game ? bot.game.gameMode : '';
    if (gameMode !== 'creative' && gameMode !== 'spectator') {
        reply('飞行寻路仅创造/旁观模式可用');
        return;
    }

    const target = new Vec3(x, y, z);
    const debug = (args[3] || '').toLowerCase() === 'debug';
    const debugFile = debug ? createDebugFile('flyto_debug.log') : null;
    if (debugFile) debugFile.write(`=== flyto 调试开始 ${new Date().toLocaleString('zh-CN', { hour12: false })} 目标=(${x},${y},${z}) ===`);
    // 监听服务器 position 包：判断位置大跳是否来自服务器修正
    const serverPosListener = debugFile ? (packet) => {
        const p = bot.entity.position;
        const flags = packet && typeof packet.flags === 'object' ? JSON.stringify(packet.flags) : (packet ? packet.flags : '?');
        debugFile.write(`[server_pos] bot_y=${p.y.toFixed(3)} pkt_y=${packet.y} flags=${flags} tel=${packet.teleportId}`);
    } : null;
    if (serverPosListener) bot._client.on('position', serverPosListener);
    bot.__scriptFlags[FLAG_KEY] = false;
    await enableFlight(bot, log);

    // 逐轴速度函数：每个轴的速度 = 该轴距离的函数（比例 + 上限 + 死区）
    function createAxisSpeed(maxMps, k) {
        const DEADBAND = 0.35; // 该轴距离小于此值就停，避免抖动
        return (err) => {
            const abs = Math.abs(err);
            if (abs < DEADBAND) return 0;
            const s = Math.min(maxMps, abs * k);
            return err > 0 ? s : -s;
        };
    }
    const axisX = createAxisSpeed(10.9, 0.8); // 水平轴：上限原版创造飞行速度
    const axisZ = createAxisSpeed(10.9, 0.8);
    const axisY = createAxisSpeed(3.9, 1.0);  // 垂直轴：上限 3.9

    let vx = 0, vy = 0, vz = 0; // 各轴目标速度（格/秒）
    const flyTimer = setInterval(() => {
        if (!bot || !bot.entity) return;
        // 不用跳跃/潜行控制垂直，直接按比例速度走
        bot.setControlState('jump', false);
        bot.setControlState('sneak', false);
        // 已经落地时禁止继续向下压（避免低空和地面碰撞导致的弹跳）
        // 注意：mineflayer 速度单位是 格/tick，不是 格/秒，这里 /20 换算成每秒格数
        const vyTick = (bot.entity.onGround && vy < 0) ? 0 : vy / 20;
        bot.entity.velocity = new Vec3(vx / 20, vyTick, vz / 20);
    }, 25);

    reply(`开始飞行寻路 → (${x}, ${y}, ${z})（**run flyto stop 停止）`);

    let stalled = 0;
    let lastDist = Infinity;
    const startTime = Date.now();
    let debugTick = 0;
    try {
        while (!bot.__scriptFlags[FLAG_KEY]) {
            if (!isAlive(bot)) {
                log('warn', 'Bot 已断开，停止飞行寻路');
                break;
            }

            const pos = bot.entity.position;
            const delta = target.minus(pos);
            const horiz = Math.sqrt(delta.x * delta.x + delta.z * delta.z);
            const dist = delta.distanceTo(new Vec3(0, 0, 0));

            if (dist <= 1.0) {
                vx = 0; vy = 0; vz = 0;
                reply(`到达目标 (${x}, ${y}, ${z})，已悬停`);
                break;
            }

            // 卡住检测：距离连续 50 轮（约 5 秒）没有明显缩短就放弃
            if (dist >= lastDist - 0.05) {
                stalled++;
                if (stalled > 50) {
                    log('warn', '飞行卡住（可能撞到方块），停止寻路');
                    reply('飞行卡住，已停止（目标可能在墙后）');
                    break;
                }
            } else {
                stalled = 0;
            }
            lastDist = dist;

            // 逐轴速度：各轴距离通过函数算出该轴速度
            vx = axisX(delta.x);
            vy = axisY(delta.y);
            vz = axisZ(delta.z);

            // 面向目标（yaw 水平、pitch 指向目标）
            const yaw = Math.atan2(-delta.x, -delta.z);
            const pitch = horiz > 0.001 ? Math.atan2(delta.y, horiz) : (delta.y > 0 ? Math.PI / 2 : -Math.PI / 2);
            bot.look(yaw, pitch, true);
            bot.setControlState('forward', true);

            // 调试日志：每个控制周期打印移动状态
            if (debug && (debugTick++ % 2 === 0)) {
                const t = ((Date.now() - startTime) / 1000).toFixed(1);
                const p = bot.entity.position;
                const av = bot.entity.velocity;
                const line =
                    `[flyto] t=${t}s pos=(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}) ` +
                    `dst=${dist.toFixed(2)} ` +
                    `vx=${vx >= 0 ? '+' : ''}${vx.toFixed(2)} vy=${vy >= 0 ? '+' : ''}${vy.toFixed(2)} vz=${vz >= 0 ? '+' : ''}${vz.toFixed(2)} ` +
                    `av=(${av.x.toFixed(2)},${av.y.toFixed(2)},${av.z.toFixed(2)}) ` +
                    `gnd=${bot.entity.onGround ? 1 : 0} colV=${bot.entity.isCollidedVertically ? 1 : 0} ` +
                    `wtr=${bot.entity.isInWater ? 1 : 0} fwd=${bot.getControlState('forward') ? 1 : 0} ` +
                    `jmp=${bot.getControlState('jump') ? 1 : 0} snk=${bot.getControlState('sneak') ? 1 : 0}`;
                log('info', line);
                if (debugFile) debugFile.write(line);
            }

            await sleep(100);
        }
    } finally {
        if (debugFile) {
            debugFile.write('=== flyto 调试结束 ===');
            debugFile.close();
        }
        if (serverPosListener) {
            try { bot._client.removeListener('position', serverPosListener); } catch (e) {}
        }
        clearInterval(flyTimer);
        vx = 0; vy = 0; vz = 0;
        bot.setControlState('forward', false);
        bot.setControlState('jump', false);
        bot.setControlState('sneak', false);
        bot.__scriptFlags[FLAG_KEY] = false;
    }
};
