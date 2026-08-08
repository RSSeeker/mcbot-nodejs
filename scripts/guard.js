'use strict';

/**
 * 守卫模式：跟随指定玩家，自动攻击附近的敌对生物
 *
 * 用法:
 *   **run guard <玩家名> [半径]   开始守卫（默认半径 8 格）
 *   **run guard stop              停止守卫
 */

const pathfinder = require('mineflayer-pathfinder');

const FLAG_KEY = 'guard';

// 友好生物白名单（其余 mob 一律视为威胁）
const FRIENDLY = new Set([
    'cow', 'pig', 'sheep', 'chicken', 'rabbit', 'villager', 'wandering_trader',
    'cat', 'wolf', 'horse', 'donkey', 'mule', 'llama', 'trader_llama', 'mooshroom',
    'turtle', 'panda', 'parrot', 'fox', 'bee', 'dolphin', 'squid', 'glow_squid',
    'bat', 'ocelot', 'axolotl', 'goat', 'frog', 'tadpole', 'allay', 'camel',
    'sniffer', 'armadillo', 'iron_golem', 'snow_golem',
]);

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(bot) {
    return bot && bot.entity && bot._client && !bot._client.ended;
}

function ensurePathfinder(bot) {
    if (!bot.pathfinder) return;
    bot.pathfinder.setMovements(new pathfinder.Movements(bot));
}

module.exports = async function (bot, context) {
    const { reply, args, log } = context;
    if (!bot.__scriptFlags) bot.__scriptFlags = {};
    // 内联 parse_args：参数用 | 分隔（参数内部可含空格）
    function parseArgs(args) {
        const joined = (args || []).join(' ').trim();
        if (!joined) return [];
        return joined.split('|').map((s) => s.trim());
    }
    // 参数用 | 分隔：玩家名 | 半径
    const [targetArg = '', radiusArg = ''] = parseArgs(args);

    if (targetArg.toLowerCase() === 'stop') {
        bot.__scriptFlags[FLAG_KEY] = true;
        reply('已请求停止守卫');
        return;
    }

    if (!isAlive(bot)) {
        reply('Bot 未连接');
        return;
    }

    const targetName = targetArg;
    if (!targetName) {
        reply('用法: **run guard <玩家名> | <半径>');
        return;
    }
    const radius = radiusArg ? parseFloat(radiusArg) : 8;
    if (Number.isNaN(radius) || radius < 2 || radius > 32) {
        reply('半径范围: 2-32');
        return;
    }

    ensurePathfinder(bot);
    bot.__scriptFlags[FLAG_KEY] = false;
    reply(`开始守卫 ${targetName}（警戒半径 ${radius} 格，**run guard stop 停止）`);

    while (!bot.__scriptFlags[FLAG_KEY]) {
        if (!isAlive(bot)) {
            log('warn', 'Bot 已断开，停止守卫');
            break;
        }

        const player = bot.players[targetName];
        if (!player || !player.entity) {
            await sleep(2000);
            continue;
        }
        const anchor = player.entity.position;

        // 找警戒范围内最近的敌对生物
        let threat = null;
        let threatDist = radius;
        for (const ent of Object.values(bot.entities)) {
            if (!ent || ent === bot.entity || ent.type !== 'mob') continue;
            const mobName = (ent.mobType || '').toLowerCase().replace(/^minecraft:/, '');
            if (FRIENDLY.has(mobName)) continue;
            const d = ent.position.distanceTo(anchor);
            if (d <= threatDist) {
                threat = ent;
                threatDist = d;
            }
        }

        if (threat) {
            try {
                log('info', `发现威胁: ${threat.mobType || threat.name || '未知'}，开始攻击`);
                while (threat && bot.entities[threat.id] && !bot.__scriptFlags[FLAG_KEY] && isAlive(bot)) {
                    await bot.pathfinder.goto(new pathfinder.goals.GoalNear(threat.position.x, threat.position.y, threat.position.z, 2));
                    await bot.lookAt(threat.position.offset(0, 1, 0), true);
                    await bot.attack(threat);
                    await sleep(350);
                    threat = bot.entities[threat.id];
                }
                log('info', '威胁已清除');
            } catch (err) {
                log('warn', `战斗失败: ${err.message}`);
                await sleep(1000);
            }
        } else {
            // 无威胁时跟随目标
            try {
                await bot.pathfinder.goto(new pathfinder.goals.GoalFollow(player.entity, 3));
            } catch (err) {
                await sleep(1000);
            }
        }
        await sleep(500);
    }

    bot.__scriptFlags[FLAG_KEY] = false;
    reply('守卫已停止');
};
