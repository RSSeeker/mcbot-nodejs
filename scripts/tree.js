'use strict';

/**
 * 自动砍树 + 种树苗
 *
 * 用法:
 *   **run tree      开始（找最近的一棵树砍光并补种）
 *   **run tree stop 停止
 *
 * 支持: 橡木 / 云杉 / 白桦 / 丛林木 / 金合欢 / 深色橡木 / 红树 / 樱花
 * 注意: 特别高的树如果够不到会跳过，属于尽力而为
 */

const { Vec3 } = require('vec3');
const pathfinder = require('mineflayer-pathfinder');

const FLAG_KEY = 'tree';

const LOGS = new Set([
    'oak_log', 'spruce_log', 'birch_log', 'jungle_log',
    'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log',
    'crimson_stem', 'warped_stem',
]);

// 原木 -> 对应树苗
const SAPLINGS = {
    oak_log: 'oak_sapling',
    spruce_log: 'spruce_sapling',
    birch_log: 'birch_sapling',
    jungle_log: 'jungle_sapling',
    acacia_log: 'acacia_sapling',
    dark_oak_log: 'dark_oak_sapling',
    mangrove_log: 'mangrove_propagule',
    cherry_log: 'cherry_sapling',
};

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

async function gotoNear(bot, pos, radius = 3) {
    await bot.pathfinder.goto(new pathfinder.goals.GoalNear(pos.x, pos.y, pos.z, radius));
}

// BFS 找出与起点相连的所有原木（一棵树）
function findTree(bot, startPos, maxLogs = 200) {
    const tree = [];
    const visited = new Set();
    const queue = [startPos.clone().floored()];
    visited.add(queue[0].toString());
    while (queue.length > 0 && tree.length < maxLogs) {
        const cur = queue.shift();
        const block = bot.blockAt(cur);
        if (!block || !LOGS.has(block.name)) continue;
        tree.push(cur);
        for (const dir of [
            [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
        ]) {
            const next = cur.offset(dir[0], dir[1], dir[2]);
            const key = next.toString();
            if (visited.has(key)) continue;
            visited.add(key);
            queue.push(next);
        }
    }
    return tree;
}

module.exports = async function (bot, context) {
    const { reply, args, log } = context;
    if (!bot.__scriptFlags) bot.__scriptFlags = {};

    if ((args[0] || '').toLowerCase() === 'stop') {
        bot.__scriptFlags[FLAG_KEY] = true;
        reply('已请求停止砍树');
        return;
    }

    if (!isAlive(bot)) {
        reply('Bot 未连接');
        return;
    }

    ensurePathfinder(bot);
    bot.__scriptFlags[FLAG_KEY] = false;
    reply('开始自动砍树（**run tree stop 停止）');

    let chopped = 0;
    let planted = 0;
    while (!bot.__scriptFlags[FLAG_KEY]) {
        if (!isAlive(bot)) {
            log('warn', 'Bot 已断开，停止砍树');
            break;
        }

        const logPos = bot.findBlocks({ matching: (b) => LOGS.has(b.name), maxDistance: 32, count: 1 });
        if (logPos.length === 0) {
            await sleep(3000);
            continue;
        }

        // 取最近一棵树的所有原木，从下往上砍（矮的先砍，方便爬到高处）
        const tree = findTree(bot, logPos[0]);
        if (tree.length === 0) continue;
        tree.sort((a, b) => (a.y - b.y) || (a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position)));

        for (const pos of tree) {
            if (bot.__scriptFlags[FLAG_KEY]) break;
            if (!isAlive(bot)) break;
            const block = bot.blockAt(pos);
            if (!block || !LOGS.has(block.name)) continue;
            try {
                await gotoNear(bot, pos, 3);
                await bot.dig(block, false);
                chopped++;
                log('info', `砍掉 ${block.name} @(${pos.x}, ${pos.y}, ${pos.z})`);
            } catch (err) {
                log('warn', `砍树失败 @(${pos.x}, ${pos.y}, ${pos.z}): ${err.message}`);
            }
            await sleep(100);
        }

        // 补种：在树根位置下方的泥土上种树苗
        try {
            const base = tree.reduce((min, p) => (p.y < min.y ? p : min), tree[0]);
            const ground = bot.blockAt(base.offset(0, -1, 0));
            const logType = bot.blockAt(base).name;
            const saplingName = SAPLINGS[logType];
            const sapling = saplingName ? bot.inventory.items().find(i => i.name === saplingName) : null;
            if (sapling && ground && (ground.name === 'dirt' || ground.name === 'grass_block' || ground.name === 'podzol' || ground.name === 'mud')) {
                await gotoNear(bot, ground.position, 2);
                await bot.equip(sapling, 'hand');
                await bot.placeBlock(ground, new Vec3(0, 1, 0));
                planted++;
                log('info', `种下 ${saplingName} @(${ground.position.x}, ${ground.position.y + 1}, ${ground.position.z})`);
            }
        } catch (err) {
            log('warn', `补种失败: ${err.message}`);
        }

        log('info', `本轮砍掉 ${chopped} 个原木，种下 ${planted} 棵`);
        await sleep(2000);
    }

    bot.__scriptFlags[FLAG_KEY] = false;
    reply(`砍树结束，共砍 ${chopped} 个原木，种下 ${planted} 棵`);
};
