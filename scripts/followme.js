'use strict';

/**
 * 持续跟随玩家：保持在他旁边
 *
 * - 玩家在地上：用寻路走路跟着
 * - 玩家在天上/高度差大：自动开启创造飞行追上去，悬停在他旁边并持续追踪高度
 *
 * 用法:
 *   **run followme <玩家名> [距离]   开始跟随（默认距离 3 格）
 *   **run followme stop              停止
 *
 * 注意:
 *   - 空中飞行仅创造/旁观模式可用
 *   - 空中是直线飞行，玩家隔山/隔墙时可能卡住（有自动停止保护）
 */

const { Vec3 } = require('vec3');
const pathfinder = require('mineflayer-pathfinder');

const FLAG_KEY = 'followme';
// 这些方块不算“地面”（玩家站在上面视为在空中）
const AIR_LIKE = new Set(['air', 'cave_air', 'void_air', 'water', 'lava', 'flowing_water', 'flowing_lava']);

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(bot) {
    return bot && bot.entity && bot._client && !bot._client.ended;
}

module.exports = async function (bot, context) {
    const { reply, args, log } = context;
    if (!bot.__scriptFlags) bot.__scriptFlags = {};

    if ((args[0] || '').toLowerCase() === 'stop') {
        bot.__scriptFlags[FLAG_KEY] = true;
        bot.pathfinder?.stop();
        bot.setControlState('forward', false);
        bot.setControlState('jump', false);
        bot.setControlState('sneak', false);
        reply('已请求停止跟随');
        return;
    }

    const targetName = args[0];
    if (!targetName) {
        reply('用法: **run followme <玩家名> [距离]');
        return;
    }
    const keepDist = args[1] ? parseFloat(args[1]) : 3;
    if (Number.isNaN(keepDist) || keepDist < 1 || keepDist > 16) {
        reply('距离范围: 1-16');
        return;
    }

    if (!isAlive(bot)) {
        reply('Bot 未连接');
        return;
    }

    const gameMode = bot.game ? bot.game.gameMode : '';
    const canFly = gameMode === 'creative' || gameMode === 'spectator';

    // 飞行状态管理（与 server.js 的飞行实现一致）
    let flying = false;
    let flyTimer = null;

    function enableFly() {
        if (flying) return;
        flying = true;
        try { bot.creative.startFlying(); } catch (e) { log('warn', '开启飞行失败: ' + e.message); }
        try {
            if (!bot._abilitiesFlags) bot._abilitiesFlags = 0;
            bot._abilitiesFlags |= 0x02;
            bot._client.write('abilities', { flags: bot._abilitiesFlags });
        } catch (e) { log('warn', '发送飞行状态失败（仅本地飞行）: ' + e.message); }
        flyTimer = setInterval(() => {
            if (!bot || !bot.entity) return;
            const v = bot.entity.velocity;
            const jump = bot.getControlState('jump');
            const sneak = bot.getControlState('sneak');
            if (jump && !sneak) bot.entity.velocity = new Vec3(v.x, 0.5, v.z);
            else if (sneak && !jump) bot.entity.velocity = new Vec3(v.x, -0.5, v.z);
            else bot.entity.velocity = new Vec3(v.x, 0, v.z);
        }, 50);
        log('info', '已切换为飞行跟随');
    }

    function disableFly() {
        if (!flying) return;
        flying = false;
        if (flyTimer) { clearInterval(flyTimer); flyTimer = null; }
        try { bot.creative.stopFlying(); } catch (e) {}
        try {
            if (bot._abilitiesFlags) {
                bot._abilitiesFlags &= ~0x02;
                bot._client.write('abilities', { flags: bot._abilitiesFlags });
            }
        } catch (e) {}
        bot.setControlState('jump', false);
        bot.setControlState('sneak', false);
        log('info', '已切换为地面跟随');
    }

    if (!bot.pathfinder) {
        reply('寻路不可用');
        return;
    }
    bot.pathfinder.setMovements(new pathfinder.Movements(bot));
    bot.__scriptFlags[FLAG_KEY] = false;
    reply(`开始持续跟随 ${targetName}（距离 ${keepDist} 格，**run followme stop 停止）`);

    // 卡住保护：飞行时距离长时间不缩短就暂停追击
    let stalled = 0;
    let lastFlyDist = Infinity;

    try {
        while (!bot.__scriptFlags[FLAG_KEY]) {
            if (!isAlive(bot)) {
                log('warn', 'Bot 已断开，停止跟随');
                break;
            }

            const player = bot.players[targetName];
            if (!player || !player.entity) {
                // 目标不在可见范围内：悬停/停下等待
                bot.pathfinder?.stop();
                bot.setControlState('forward', false);
                bot.setControlState('jump', false);
                bot.setControlState('sneak', false);
                await sleep(2000);
                continue;
            }

            const anchor = player.entity.position;
            const my = bot.entity.position;
            const dx = anchor.x - my.x;
            const dz = anchor.z - my.z;
            const dy = anchor.y - my.y;
            const horiz = Math.sqrt(dx * dx + dz * dz);
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

            // 玩家脚下不是实体方块 = 玩家在空中；或高度差够不着 → 起飞追
            const blockBelowPlayer = bot.blockAt(anchor.offset(0, -1, 0));
            const playerInAir = blockBelowPlayer && AIR_LIKE.has(blockBelowPlayer.name);
            const needFly = playerInAir || dy > 1.5 || dy < -2.5;

            if (needFly && canFly) {
                if (!flying) {
                    bot.pathfinder?.stop();
                    enableFly();
                }

                if (dist <= keepDist + 0.5) {
                    // 已在目标旁边：悬停（持续追踪高度），不算卡住
                    bot.setControlState('forward', false);
                    stalled = 0;
                } else {
                    // 追击中：卡住检测（约 9 秒没接近就暂停）
                    if (dist >= lastFlyDist - 0.1) {
                        stalled++;
                        if (stalled > 30) {
                            log('warn', '飞行跟随卡住（可能隔墙），暂停追击');
                            bot.setControlState('forward', false);
                            bot.setControlState('jump', false);
                            bot.setControlState('sneak', false);
                            stalled = 0;
                            await sleep(3000);
                            lastFlyDist = Infinity;
                            continue;
                        }
                    } else {
                        stalled = 0;
                    }
                    lastFlyDist = dist;

                    // 面向玩家并推进
                    const yaw = Math.atan2(-dx, -dz);
                    const pitch = horiz > 0.001 ? Math.atan2(dy, horiz) : (dy > 0 ? Math.PI / 2 : -Math.PI / 2);
                    bot.look(yaw, pitch, true);
                    bot.setControlState('forward', true);
                }
                // 高度差持续追踪（悬停时也会微调高度）
                bot.setControlState('jump', dy > 0.6);
                bot.setControlState('sneak', dy < -0.6);
            } else if (needFly && !canFly) {
                // 想飞但模式不允许：提示一次，只做地面跟随
                log('warn', `目标飞得太高，但当前模式(${gameMode})不能飞行，只能地面跟随`);
                if (flying) disableFly();
                try {
                    await bot.pathfinder.goto(new pathfinder.goals.GoalFollow(player.entity, keepDist));
                } catch (err) {
                    await sleep(1000);
                }
            } else {
                if (flying) disableFly();
                if (dist > keepDist + 0.5) {
                    try {
                        await bot.pathfinder.goto(new pathfinder.goals.GoalFollow(player.entity, keepDist));
                    } catch (err) {
                        await sleep(1000);
                    }
                } else {
                    bot.pathfinder?.stop();
                }
            }

            await sleep(300);
        }
    } finally {
        if (flying) disableFly();
        bot.pathfinder?.stop();
        bot.setControlState('forward', false);
        bot.setControlState('jump', false);
        bot.setControlState('sneak', false);
        bot.__scriptFlags[FLAG_KEY] = false;
    }

    reply('跟随结束');
};
