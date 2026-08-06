'use strict';

/**
 * 自动种田（收割成熟作物 + 自动补种）
 *
 * 用法:
 *   **run farm      开始种田
 *   **run farm stop 停止
 *
 * 支持: 小麦 / 胡萝卜 / 土豆 / 甜菜根（需要对应种子在背包里）
 */

const { Vec3 } = require('vec3');
const pathfinder = require('mineflayer-pathfinder');

const FLAG_KEY = 'farm';

// 作物名 -> 成熟时的 metadata
const CROPS = { wheat: 7, carrots: 7, potatoes: 7, beetroots: 3 };
// 作物名 -> 种子物品名
const SEEDS = { wheat: 'wheat_seeds', carrots: 'carrot', potatoes: 'potato', beetroots: 'beetroot_seeds' };

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(bot) {
    return bot && bot.entity && bot._client && !bot._client.ended;
}

function ensurePathfinder(bot) {
    if (!bot.pathfinder) return;
    const movements = new pathfinder.Movements(bot);
    bot.pathfinder.setMovements(movements);
}

async function gotoNear(bot, pos, radius = 3) {
    const goal = new pathfinder.goals.GoalNear(pos.x, pos.y, pos.z, radius);
    await bot.pathfinder.goto(goal);
}

module.exports = async function (bot, context) {
    const { reply, args, log } = context;
    if (!bot.__scriptFlags) bot.__scriptFlags = {};

    if ((args[0] || '').toLowerCase() === 'stop') {
        bot.__scriptFlags[FLAG_KEY] = true;
        reply('已请求停止种田');
        return;
    }

    if (!isAlive(bot)) {
        reply('Bot 未连接');
        return;
    }

    ensurePathfinder(bot);
    bot.__scriptFlags[FLAG_KEY] = false;
    reply('开始自动种田（**run farm stop 停止）');

    let harvested = 0;
    let replanted = 0;
    while (!bot.__scriptFlags[FLAG_KEY]) {
        if (!isAlive(bot)) {
            log('warn', 'Bot 已断开，停止种田');
            break;
        }

        // 找附近成熟作物
        const maturePos = bot.findBlocks({
            matching: (b) => CROPS[b.name] !== undefined && b.metadata === CROPS[b.name],
            maxDistance: 24,
            count: 64,
        });

        if (maturePos.length === 0) {
            await sleep(5000);
            continue;
        }

        for (const pos of maturePos) {
            if (bot.__scriptFlags[FLAG_KEY]) break;
            if (!isAlive(bot)) break;

            const crop = bot.blockAt(pos);
            if (!crop || CROPS[crop.name] === undefined || crop.metadata !== CROPS[crop.name]) continue;
            const cropKey = crop.name;

            try {
                await gotoNear(bot, pos, 3);
                await bot.dig(crop, false);
                harvested++;
                log('info', `收割: ${crop.name} @(${pos.x}, ${pos.y}, ${pos.z})`);
            } catch (err) {
                log('warn', `收割失败 @(${pos.x}, ${pos.y}, ${pos.z}): ${err.message}`);
                continue;
            }

            // 补种：作物下方的耕地
            try {
                const farmland = bot.blockAt(pos.offset(0, -1, 0));
                const seedName = SEEDS[cropKey];
                const seed = seedName ? bot.inventory.items().find(i => i.name === seedName) : null;
                if (seed && farmland && farmland.name === 'farmland') {
                    await bot.equip(seed, 'hand');
                    await bot.placeBlock(farmland, new Vec3(0, 1, 0));
                    replanted++;
                }
            } catch (err) {
                log('warn', `补种失败: ${err.message}`);
            }
            await sleep(150);
        }

        log('info', `本轮收割 ${harvested} 个，补种 ${replanted} 个`);
        await sleep(3000);
    }

    bot.__scriptFlags[FLAG_KEY] = false;
    reply(`种田结束，共收割 ${harvested} 个，补种 ${replanted} 个`);
};
