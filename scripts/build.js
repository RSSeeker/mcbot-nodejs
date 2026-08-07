'use strict';

/**
 * 自动建筑（铺路 / 建塔 / 填方块区域）
 *
 * 用法:
 *   **run build fill  <x1> <y1> <z1> <x2> <y2> <z2> [方块]
 *   **run build tower <x> <y> <z> <高度> [方块]
 *   **run build road  <x1> <z1> <x2> <z2> [方块]      （在 Bot 脚下高度铺一条直线路）
 *   **run build stop
 *
 * 示例:
 *   **run build tower 100 64 100 10 stone
 *   **run build road 100 100 120 100 oak_planks
 *
 * 方块从背包取（找不到且是创造模式时自动生成）；需要目标位置下方有支撑
 */

const { Vec3 } = require('vec3');
const pathfinder = require('mineflayer-pathfinder');

const FLAG_KEY = 'build';
const SOLID = new Set(['air', 'cave_air', 'void_air', 'water', 'lava', 'flowing_water', 'flowing_lava']);

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

function rangeCells(x1, y1, z1, x2, y2, z2) {
    const cells = [];
    const xa = Math.min(x1, x2), xb = Math.max(x1, x2);
    const ya = Math.min(y1, y2), yb = Math.max(y1, y2);
    const za = Math.min(z1, z2), zb = Math.max(z1, z2);
    for (let y = ya; y <= yb; y++) {
        for (let x = xa; x <= xb; x++) {
            for (let z = za; z <= zb; z++) {
                cells.push(new Vec3(x, y, z));
            }
        }
    }
    return cells;
}

function roadCells(x1, z1, x2, z2, y) {
    const cells = [];
    const dx = x2 - x1, dz = z2 - z1;
    const steps = Math.max(Math.abs(dx), Math.abs(dz));
    for (let i = 0; i <= steps; i++) {
        const t = steps === 0 ? 0 : i / steps;
        cells.push(new Vec3(Math.round(x1 + dx * t), y, Math.round(z1 + dz * t)));
    }
    return cells;
}

// 找方块物品（背包优先，创造模式可自动生成）
async function findBlockItem(bot, name) {
    const Item = require('prismarine-item')(bot.registry);
    let item = bot.inventory.items().find(i => i.name === name) || bot.inventory.items().find(i => i.name.includes(name));
    if (!item && bot.game && bot.game.gameMode === 'creative') {
        const reg = bot.registry.itemsByName[name] || Object.values(bot.registry.itemsByName).find(i => i.name.includes(name));
        if (reg) {
            const slot = 36 + bot.quickBarSlot;
            await bot.creative.setInventorySlot(slot, new Item(reg.id, 64));
            item = bot.inventory.slots[slot];
        }
    }
    return item;
}

module.exports = async function (bot, context) {
    const { reply, args, log } = context;
    if (!bot.__scriptFlags) bot.__scriptFlags = {};
    const parseArgs = require('./lib/parse_args');
    // 参数用 | 分隔：<fill|tower|road> | <参数...> | <方块>
    const [subArg = '', ...rest] = parseArgs(args);

    const sub = subArg.toLowerCase();
    if (sub === 'stop') {
        bot.__scriptFlags[FLAG_KEY] = true;
        reply('已请求停止建筑');
        return;
    }

    if (!isAlive(bot)) {
        reply('Bot 未连接');
        return;
    }

    let positions = [];
    let blockName = 'stone';

    if (sub === 'fill') {
        const nums = rest.slice(0, 6).map(Number);
        if (nums.length < 6 || nums.some(Number.isNaN)) {
            reply('用法: **run build fill | <x1> | <y1> | <z1> | <x2> | <y2> | <z2> | <方块>');
            return;
        }
        positions = rangeCells(...nums);
        blockName = rest[6] || 'stone';
    } else if (sub === 'tower') {
        const x = Number(rest[0]), y = Number(rest[1]), z = Number(rest[2]), h = Number(rest[3]);
        if ([x, y, z, h].some(Number.isNaN) || h < 1 || h > 64) {
            reply('用法: **run build tower | <x> | <y> | <z> | <高度> | <方块>');
            return;
        }
        positions = rangeCells(x, y, z, x, y + h - 1, z);
        blockName = rest[4] || 'stone';
    } else if (sub === 'road') {
        const x1 = Number(rest[0]), z1 = Number(rest[1]), x2 = Number(rest[2]), z2 = Number(rest[3]);
        if ([x1, z1, x2, z2].some(Number.isNaN)) {
            reply('用法: **run build road | <x1> | <z1> | <x2> | <z2> | <方块>');
            return;
        }
        const y = Math.floor(bot.entity.position.y) - 1;
        positions = roadCells(x1, z1, x2, z2, y);
        blockName = rest[4] || 'stone';
    } else {
        reply('用法: **run build <fill|tower|road> | <参数...> | <方块>（参数用 | 分隔；**run build stop 停止）');
        return;
    }

    const item = await findBlockItem(bot, blockName);
    if (!item) {
        reply(`找不到方块 "${blockName}"（背包里没有，且非创造模式）`);
        return;
    }

    ensurePathfinder(bot);
    bot.__scriptFlags[FLAG_KEY] = false;

    // 从下往上、从近到远排，保证下层先铺好
    positions.sort((a, b) => (a.y - b.y) || (a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position)));
    reply(`开始建筑: ${sub}，共 ${positions.length} 个位置，方块 ${item.name}（**run build stop 停止）`);

    let placed = 0;
    let skipped = 0;
    for (const pos of positions) {
        if (bot.__scriptFlags[FLAG_KEY]) break;
        if (!isAlive(bot)) {
            log('warn', 'Bot 已断开，停止建筑');
            break;
        }

        const below = bot.blockAt(pos.offset(0, -1, 0));
        if (!below || SOLID.has(below.name)) {
            skipped++;
            continue; // 下方没有支撑（底层），等上层排完可能就有了
        }
        const cur = bot.blockAt(pos);
        if (cur && !SOLID.has(cur.name)) {
            skipped++;
            continue; // 已有方块
        }

        try {
            const held = bot.heldItem;
            if (!held || held.name !== item.name) {
                await bot.equip(item, 'hand');
            }
            await gotoNear(bot, pos, 3);
            await bot.placeBlock(below, new Vec3(0, 1, 0));
            placed++;
        } catch (err) {
            log('warn', `放置失败 @(${pos.x}, ${pos.y}, ${pos.z}): ${err.message}`);
        }
        await sleep(150);
    }

    bot.__scriptFlags[FLAG_KEY] = false;
    reply(`建筑结束：放置 ${placed} 个，跳过 ${skipped} 个`);
};
