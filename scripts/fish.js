'use strict';

/**
 * 自动钓鱼机
 *
 * 用法（游戏内聊天）:
 *   **run fish [次数]     开始钓鱼（不填次数则一直钓）
 *   **run fish stop       停止钓鱼（当前这竿钓完即停）
 *
 * 前置条件: 背包里有钓鱼竿，Bot 站在水域旁边
 */

const FLAG_KEY = 'fish';

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(bot) {
    return bot && bot.entity && bot._client && !bot._client.ended;
}

module.exports = async function (bot, context) {
    const { reply, args, log } = context;
    if (!bot.__scriptFlags) bot.__scriptFlags = {};
    const parseArgs = require('./lib/parse_args');
    // 参数用 | 分隔：次数
    const [roundsArg = ''] = parseArgs(args);

    if (roundsArg.toLowerCase() === 'stop') {
        bot.__scriptFlags[FLAG_KEY] = true;
        reply('已请求停止钓鱼，当前这竿钓完即停');
        return;
    }

    if (!isAlive(bot)) {
        reply('Bot 未连接');
        return;
    }

    const rod = bot.inventory.items().find(i => i.name && i.name.includes('fishing_rod'));
    if (!rod) {
        reply('背包里没有钓鱼竿');
        return;
    }
    try {
        await bot.equip(rod, 'hand');
    } catch (err) {
        reply(`装备钓鱼竿失败: ${err.message}`);
        return;
    }

    const maxRounds = roundsArg ? parseInt(roundsArg, 10) : Infinity;
    if (Number.isNaN(maxRounds) || maxRounds < 1) {
        reply('次数必须是正整数');
        return;
    }

    bot.__scriptFlags[FLAG_KEY] = false;
    reply(`开始自动钓鱼${Number.isFinite(maxRounds) ? `，计划 ${maxRounds} 竿` : ''}（**run fish stop 停止）`);

    let rounds = 0;
    while (!bot.__scriptFlags[FLAG_KEY]) {
        if (!isAlive(bot)) {
            log('warn', 'Bot 已断开，停止钓鱼');
            break;
        }
        if (rounds >= maxRounds) break;
        rounds++;
        try {
            await bot.fish();
            log('info', `第 ${rounds} 竿钓到了东西`);
            await sleep(1200); // 等收竿动画，避免立刻重抛
        } catch (err) {
            log('warn', `第 ${rounds} 竿失败: ${err.message}，稍后重试`);
            await sleep(1500);
        }
    }

    bot.__scriptFlags[FLAG_KEY] = false;
    reply(`钓鱼结束，共完成 ${rounds} 竿`);
};
