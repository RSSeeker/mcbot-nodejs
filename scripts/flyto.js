'use strict';

/**
 * 创造飞行空中寻路（无人机模式）
 *
 * 原理：mineflayer-pathfinder 不支持飞行寻路，这里改为直线飞向目标：
 *   开启飞行 -> 面向目标 -> 按住前进 + 根据高度差自动升/降（复用跳跃/潜行控制）
 *   到达目标附近（1 格内）自动悬停。
 *
 * 用法:
 *   **run flyto <x> <y> <z>    飞到指定坐标（仅创造/旁观模式）
 *   **run flyto stop           停止（悬停原地）
 *
 * 注意:
 *   - 直线飞行，途中撞到方块会卡住（有卡住检测，超时会自动停止）
 *   - 结束后保持飞行状态，落地请再执行 **fly off
 */

const { Vec3 } = require('vec3');

const FLAG_KEY = 'flyto';

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(bot) {
    return bot && bot.entity && bot._client && !bot._client.ended;
}

// 开启飞行（与 server.js toggleFly 相同的实现：本地零重力 + 通知服务器）
async function enableFlight(bot, log) {
    try {
        bot.creative.startFlying();
    } catch (e) {
        log('warn', '开启本地飞行失败: ' + e.message);
    }
    try {
        if (!bot._abilitiesFlags) bot._abilitiesFlags = 0;
        bot._abilitiesFlags |= 0x02;
        bot._client.write('abilities', { flags: bot._abilitiesFlags });
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
    bot.__scriptFlags[FLAG_KEY] = false;
    await enableFlight(bot, log);

    // 飞行垂向速度控制（与 server.js 的飞行逻辑一致，用 jump/sneak 控制）
    const flyTimer = setInterval(() => {
        if (!bot || !bot.entity) return;
        const v = bot.entity.velocity;
        const jump = bot.getControlState('jump');
        const sneak = bot.getControlState('sneak');
        if (jump && !sneak) {
            bot.entity.velocity = new Vec3(v.x, 0.5, v.z);
        } else if (sneak && !jump) {
            bot.entity.velocity = new Vec3(v.x, -0.5, v.z);
        } else {
            bot.entity.velocity = new Vec3(v.x, 0, v.z);
        }
    }, 50);

    reply(`开始飞行寻路 → (${x}, ${y}, ${z})（**run flyto stop 停止）`);

    let stalled = 0;
    let lastDist = Infinity;
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

            // 面向目标（yaw 管水平，pitch 管俯仰），水平按住前进
            const yaw = Math.atan2(-delta.x, -delta.z);
            const pitch = horiz > 0.001 ? Math.atan2(delta.y, horiz) : (delta.y > 0 ? Math.PI / 2 : -Math.PI / 2);
            bot.look(yaw, pitch, true);
            bot.setControlState('forward', true);

            // 垂直方向：目标在上按住跳跃，在下按住潜行，带死区避免抖动
            bot.setControlState('jump', delta.y > 0.6);
            bot.setControlState('sneak', delta.y < -0.6);

            await sleep(100);
        }
    } finally {
        clearInterval(flyTimer);
        bot.setControlState('forward', false);
        bot.setControlState('jump', false);
        bot.setControlState('sneak', false);
        bot.__scriptFlags[FLAG_KEY] = false;
    }
};
