'use strict';

/**
 * 自动挖隧道
 *
 * 用法:
 *   **run mine <方向> [长度] [宽] [高]
 *   方向: forward / back / left / right（相对 Bot 当前朝向）
 *   默认: forward, 长度 20, 宽 1, 高 2
 *   示例: **run mine forward 50 2 2
 *   **run mine stop    停止
 *
 * 每挖 5 格会在脚下放一个火把（背包有火把时）
 */

const { Vec3 } = require('vec3');
const pathfinder = require('mineflayer-pathfinder');

const FLAG_KEY = 'mine';

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

function getAxes(yaw) {
    // 相对朝向的前后左右（取主轴方向，保证是整格移动）
    const rawForward = new Vec3(-Math.sin(yaw), 0, Math.cos(yaw));
    const forward = Math.abs(rawForward.x) > Math.abs(rawForward.z)
        ? new Vec3(Math.sign(rawForward.x), 0, 0)
        : new Vec3(0, 0, Math.sign(rawForward.z));
    const right = new Vec3(forward.z, 0, -forward.x); // 横向（左右对称，符号无所谓）
    return { forward, right };
}

async function tryPlaceTorch(bot, belowPos) {
    try {
        const torch = bot.inventory.items().find(i => i.name === 'torch' || i.name === 'wall_torch');
        if (!torch) return false;
        const ground = bot.blockAt(belowPos);
        if (!ground || ground.name === 'air') return false;
        await bot.equip(torch, 'hand');
        await bot.placeBlock(ground, new Vec3(0, 1, 0));
        return true;
    } catch (e) {
        return false;
    }
}

module.exports = async function (bot, context) {
    const { reply, args, log } = context;
    if (!bot.__scriptFlags) bot.__scriptFlags = {};

    if ((args[0] || '').toLowerCase() === 'stop') {
        bot.__scriptFlags[FLAG_KEY] = true;
        reply('已请求停止挖矿');
        return;
    }

    if (!isAlive(bot)) {
        reply('Bot 未连接');
        return;
    }

    const dir = (args[0] || 'forward').toLowerCase();
    if (!['forward', 'back', 'left', 'right'].includes(dir)) {
        reply('用法: **run mine <方向> [长度] [宽] [高]  方向: forward/back/left/right');
        return;
    }
    const length = args[1] ? parseInt(args[1], 10) : 20;
    const width = args[2] ? parseInt(args[2], 10) : 1;
    const height = args[3] ? parseInt(args[3], 10) : 2;
    if (Number.isNaN(length) || length < 1 || length > 200) { reply('长度范围: 1-200'); return; }
    if (Number.isNaN(width) || width < 1 || width > 9) { reply('宽度范围: 1-9'); return; }
    if (Number.isNaN(height) || height < 1 || height > 6) { reply('高度范围: 1-6'); return; }

    const yaw = bot.entity.yaw;
    let axes = getAxes(yaw);
    if (dir === 'back') axes = { forward: axes.forward.scaled(-1), right: axes.right };
    if (dir === 'left') axes = { forward: axes.right.scaled(-1), right: axes.forward };
    if (dir === 'right') axes = { forward: axes.right, right: axes.forward.scaled(-1) };
    const forward = axes.forward;
    const right = axes.right;

    ensurePathfinder(bot);
    bot.__scriptFlags[FLAG_KEY] = false;
    reply(`开始挖隧道: 方向 ${dir}，长度 ${length}，宽 ${width}，高 ${height}（**run mine stop 停止）`);

    let dug = 0;
    const start = bot.entity.position.floored();
    for (let i = 0; i < length && !bot.__scriptFlags[FLAG_KEY]; i++) {
        if (!isAlive(bot)) {
            log('warn', 'Bot 已断开，停止挖矿');
            break;
        }

        // 挖前方横截面（脚底到头顶）
        for (let dy = 0; dy < height; dy++) {
            for (let dw = -Math.floor(width / 2); dw <= Math.floor((width - 1) / 2); dw++) {
                const target = start.plus(forward.scaled(i + 1)).offset(right.x * dw, dy, right.z * dw);
                const block = bot.blockAt(target);
                if (!block) continue;
                if (['air', 'cave_air', 'void_air', 'water', 'lava', 'flowing_water', 'flowing_lava'].includes(block.name)) continue;
                try {
                    await bot.dig(block, false);
                    dug++;
                } catch (err) {
                    log('warn', `挖掘失败 @(${target.x}, ${target.y}, ${target.z}): ${err.message}`);
                }
                await sleep(80);
            }
        }

        // 前进一格
        const next = start.plus(forward.scaled(i + 1));
        try {
            await bot.pathfinder.goto(new pathfinder.goals.GoalBlock(next.x, next.y, next.z));
        } catch (err) {
            log('warn', `前进失败: ${err.message}`);
        }

        // 每 5 格放个火把（放脚下）
        if ((i + 1) % 5 === 0) {
            if (await tryPlaceTorch(bot, next.offset(0, -1, 0))) log('info', `放置火把 @(${next.x}, ${next.y - 1}, ${next.z})`);
        }
    }

    bot.__scriptFlags[FLAG_KEY] = false;
    reply(`挖矿结束，共挖了 ${dug} 个方块`);
};
