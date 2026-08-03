/**
 * ai_controller.js — AI 自主控制模块
 * ==========================================
 * 使用 Ollama 的 Function Calling 能力，让 Qwen 等模型
 * 实时感知游戏状态并自主决策控制 Bot。
 *
 * 核心流程:
 *   1. 收集游戏状态 (位置/附近实体/背包/聊天等)
 *   2. 发送给 AI 模型 + 可用工具列表
 *   3. AI 返回 tool_calls → 执行对应动作
 *   4. 等待间隔后循环
 */

const { Vec3 } = require('vec3');

const TOOLS = [
    {
        type: 'function',
        function: {
            name: 'move_forward',
            description: '向前移动，可指定持续时间(秒)',
            parameters: {
                type: 'object',
                properties: {
                    seconds: { type: 'number', description: '移动持续时间(秒)，默认0.5' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'move_back',
            description: '向后移动',
            parameters: {
                type: 'object',
                properties: {
                    seconds: { type: 'number', description: '移动持续时间(秒)，默认0.5' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'move_left',
            description: '向左移动',
            parameters: {
                type: 'object',
                properties: {
                    seconds: { type: 'number', description: '移动持续时间(秒)，默认0.5' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'move_right',
            description: '向右移动',
            parameters: {
                type: 'object',
                properties: {
                    seconds: { type: 'number', description: '移动持续时间(秒)，默认0.5' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'stop_moving',
            description: '停止所有移动',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'jump',
            description: '跳跃一次',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'look_at',
            description: '转动视角看向指定方向或目标',
            parameters: {
                type: 'object',
                properties: {
                    yaw: { type: 'number', description: '水平角度(-180~180)' },
                    pitch: { type: 'number', description: '垂直角度(-90~90)' },
                },
                required: ['yaw', 'pitch'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'attack',
            description: '攻击准星处的实体',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'dig_block',
            description: '挖掘准星处的方块',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'place_block',
            description: '在准星处放置方块',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'say_chat',
            description: '在游戏公聊中发送消息',
            parameters: {
                type: 'object',
                properties: {
                    message: { type: 'string', description: '要发送的消息内容' },
                },
                required: ['message'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'use_item',
            description: '使用手中物品(右键)',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'switch_slot',
            description: '切换到指定快捷栏槽位(1-9)',
            parameters: {
                type: 'object',
                properties: {
                    slot: { type: 'integer', description: '槽位编号1-9', minimum: 1, maximum: 9 },
                },
                required: ['slot'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'sneak',
            description: '切换潜行状态',
            parameters: {
                type: 'object',
                properties: {
                    state: { type: 'boolean', description: 'true=潜行, false=站立' },
                },
                required: ['state'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'sprint',
            description: '切换疾跑状态',
            parameters: {
                type: 'object',
                properties: {
                    state: { type: 'boolean', description: 'true=疾跑, false=正常' },
                },
                required: ['state'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'goto_coordinates',
            description: '寻路到指定坐标',
            parameters: {
                type: 'object',
                properties: {
                    x: { type: 'integer', description: '目标X坐标' },
                    y: { type: 'integer', description: '目标Y坐标' },
                    z: { type: 'integer', description: '目标Z坐标' },
                },
                required: ['x', 'y', 'z'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'wait',
            description: '等待一段时间，不做任何操作',
            parameters: {
                type: 'object',
                properties: {
                    reason: { type: 'string', description: '等待的原因(用于日志)' },
                },
            },
        },
    },
];

class AIController {
    constructor(ollamaClient, getBotFn, logFn, ioRef) {
        this.ollama = ollamaClient;
        this.getBot = getBotFn;
        this.log = logFn;
        this.io = ioRef;

        this.enabled = false;
        this.loopTimer = null;
        this.loopDelay = 4000;
        this.activeControls = new Set();
        this.moveTimer = null;

        this.movements = null;
        this.GoalNear = null;

        this.systemPrompt = `你是一个 Minecraft 机器人，拥有自主行动能力。
你的目标是扮演一个智能的 Minecraft 玩家，根据游戏中的状态做出合理的决策。

行为准则:
- 观察周围环境后做出合理行动
- 如果附近有怪物，可以攻击或躲避
- 可以收集资源（挖掘方块）
- 可以和玩家聊天互动
- 保持生存（注意生命值和饥饿值）
- 每次决策时调用 1-3 个工具函数
- 如果没有特别需要做的事情，调用 wait 等待
- 回复要简短，用中文`;

        this.messages = [];
        this.resetConversation();
    }

    resetConversation() {
        this.messages = [
            { role: 'system', content: this.systemPrompt },
        ];
    }

    /**
     * 收集当前游戏状态
     */
    _getGameState() {
        const bot = this.getBot();
        if (!bot || !bot.entity) return null;

        const state = {
            health: Math.round(bot.health || 0),
            food: Math.round(bot.food || 0),
            position: {
                x: Math.round(bot.entity.position.x),
                y: Math.round(bot.entity.position.y),
                z: Math.round(bot.entity.position.z),
            },
            yaw: Math.round(bot.entity.yaw * 180 / Math.PI),
            pitch: Math.round(bot.entity.pitch * 180 / Math.PI),
            gamemode: bot.game?.gameMode || 'survival',
            dimension: bot.game?.dimension || 'overworld',
            is_sneaking: bot.getControlState('sneak'),
            is_sprinting: bot.getControlState('sprint'),
            held_item: bot.heldItem ? bot.heldItem.displayName || bot.heldItem.name : '空手',
            nearby_entities: [],
            nearby_players: [],
            hotbar: [],
        };

        try {
            const entities = Object.values(bot.entities || {});
            for (const ent of entities) {
                if (!ent || ent === bot.entity) continue;
                const dist = bot.entity.position.distanceTo(ent.position);
                if (dist > 30) continue;
                const info = {
                    name: ent.name || ent.username || 'unknown',
                    type: ent.type || ent.mobType || 'unknown',
                    distance: Math.round(dist),
                    x: Math.round(ent.position.x),
                    y: Math.round(ent.position.y),
                    z: Math.round(ent.position.z),
                };
                if (ent.type === 'player' || ent.username) {
                    state.nearby_players.push(info);
                } else {
                    state.nearby_entities.push(info);
                }
            }
        } catch (e) {}

        try {
            const slots = bot.inventory?.slots || [];
            for (let i = 36; i < 45; i++) {
                const item = slots[i];
                if (item) {
                    state.hotbar.push({
                        slot: i - 35,
                        name: item.displayName || item.name,
                        count: item.count,
                    });
                }
            }
        } catch (e) {}

        try {
            const block = bot.blockAtCursor();
            if (block) {
                state.looking_at_block = {
                    name: block.displayName || block.name,
                    position: { x: block.position.x, y: block.position.y, z: block.position.z },
                };
            }
        } catch (e) {}

        try {
            const atkEntity = bot.entityAtCursor();
            if (atkEntity) {
                state.looking_at_entity = {
                    name: atkEntity.name || atkEntity.username || 'unknown',
                    type: atkEntity.type || 'unknown',
                };
            }
        } catch (e) {}

        return state;
    }

    /**
     * 格式化状态为提示文本
     */
    _formatState(state) {
        if (!state) return 'Bot 未连接，无法获取状态。';

        let text = `当前状态:\n`;
        text += `生命: ${state.health}/20 | 饥饿: ${state.food}/20\n`;
        text += `坐标: (${state.position.x}, ${state.position.y}, ${state.position.z})\n`;
        text += `朝向: Yaw=${state.yaw}° Pitch=${state.pitch}°\n`;
        text += `模式: ${state.gamemode} | 维度: ${state.dimension}\n`;
        text += `手持: ${state.held_item}\n`;
        if (state.is_sneaking) text += `[潜行中] `;
        if (state.is_sprinting) text += `[疾跑中] `;

        if (state.looking_at_block) {
            text += `\n准星方块: ${state.looking_at_block.name} @(${state.looking_at_block.position.x},${state.looking_at_block.position.y},${state.looking_at_block.position.z})`;
        }
        if (state.looking_at_entity) {
            text += `\n准星实体: ${state.looking_at_entity.name}(${state.looking_at_entity.type})`;
        }

        if (state.nearby_players.length > 0) {
            text += `\n附近玩家: `;
            state.nearby_players.forEach(p => {
                text += `${p.name}(距${p.distance}m) `;
            });
        }

        if (state.nearby_entities.length > 0) {
            text += `\n附近实体: `;
            state.nearby_entities.forEach(e => {
                text += `${e.name}(距${e.distance}m) `;
            });
        }

        if (state.hotbar.length > 0) {
            text += `\n快捷栏: `;
            state.hotbar.forEach(item => {
                text += `[${item.slot}]${item.name}x${item.count} `;
            });
        }

        return text;
    }

    /**
     * 执行 AI 返回的工具调用
     */
    async _executeToolCalls(toolCalls) {
        const bot = this.getBot();
        if (!bot) return [];

        const results = [];

        for (const tc of toolCalls) {
            const fnName = tc.function?.name;
            const fnArgs = tc.function?.arguments || {};
            let result = '';

            try {
                switch (fnName) {
                    case 'move_forward':
                        this._stopAllMove();
                        bot.setControlState('forward', true);
                        this.activeControls.add('forward');
                        const fwdSec = (fnArgs.seconds || 0.5) * 1000;
                        this.moveTimer = setTimeout(() => this._stopAllMove(), fwdSec);
                        result = `向前移动 ${fnArgs.seconds || 0.5}秒`;
                        break;
                    case 'move_back':
                        this._stopAllMove();
                        bot.setControlState('back', true);
                        this.activeControls.add('back');
                        const backSec = (fnArgs.seconds || 0.5) * 1000;
                        this.moveTimer = setTimeout(() => this._stopAllMove(), backSec);
                        result = `向后移动 ${fnArgs.seconds || 0.5}秒`;
                        break;
                    case 'move_left':
                        this._stopAllMove();
                        bot.setControlState('left', true);
                        this.activeControls.add('left');
                        const leftSec = (fnArgs.seconds || 0.5) * 1000;
                        this.moveTimer = setTimeout(() => this._stopAllMove(), leftSec);
                        result = `向左移动 ${fnArgs.seconds || 0.5}秒`;
                        break;
                    case 'move_right':
                        this._stopAllMove();
                        bot.setControlState('right', true);
                        this.activeControls.add('right');
                        const rightSec = (fnArgs.seconds || 0.5) * 1000;
                        this.moveTimer = setTimeout(() => this._stopAllMove(), rightSec);
                        result = `向右移动 ${fnArgs.seconds || 0.5}秒`;
                        break;
                    case 'stop_moving':
                        this._stopAllMove();
                        bot.pathfinder?.stop();
                        result = '已停止移动';
                        break;
                    case 'jump':
                        bot.setControlState('jump', true);
                        setTimeout(() => bot.setControlState('jump', false), 200);
                        result = '跳跃';
                        break;
                    case 'look_at':
                        const yaw = (fnArgs.yaw || 0) * Math.PI / 180;
                        const pitch = (fnArgs.pitch || 0) * Math.PI / 180;
                        await bot.look(yaw, pitch, true);
                        result = `看向 Yaw=${fnArgs.yaw}° Pitch=${fnArgs.pitch}°`;
                        break;
                    case 'attack':
                        bot.swingArm('left');
                        const atkEntity = bot.entityAtCursor();
                        if (atkEntity) {
                            await bot.attack(atkEntity);
                            result = `攻击了 ${atkEntity.name || atkEntity.username || '实体'}`;
                        } else {
                            result = '攻击(无目标)';
                        }
                        break;
                    case 'dig_block':
                        bot.swingArm('left');
                        const digBlock = bot.blockAtCursor();
                        if (digBlock && bot.canDigBlock(digBlock)) {
                            await bot.dig(digBlock, false);
                            result = `挖掘了 ${digBlock.displayName || digBlock.name}`;
                        } else {
                            result = '挖掘失败(无法挖掘或准星无方块)';
                        }
                        break;
                    case 'place_block':
                        const placeBlock = bot.blockAtCursor();
                        if (placeBlock) {
                            const face = this._getTargetFace(placeBlock);
                            await bot.placeBlock(placeBlock, face);
                            result = '放置了方块';
                        } else {
                            result = '放置失败(无目标)';
                        }
                        break;
                    case 'say_chat':
                        const msg = (fnArgs.message || '').substring(0, 200);
                        if (msg) {
                            bot.chat(msg);
                            result = `发送公聊: ${msg}`;
                        } else {
                            result = '未发送(消息为空)';
                        }
                        break;
                    case 'use_item':
                        bot.activateItem();
                        setTimeout(() => bot.deactivateItem(), 300);
                        result = '使用了手中物品';
                        break;
                    case 'switch_slot':
                        const slot = fnArgs.slot || 1;
                        const targetSlot = Math.max(1, Math.min(9, slot));
                        await bot.setQuickBarSlot(targetSlot - 1);
                        result = `切换到槽位 ${targetSlot}`;
                        break;
                    case 'sneak':
                        const sneakState = !!fnArgs.state;
                        bot.setControlState('sneak', sneakState);
                        bot._client.write('entity_action', {
                            entityId: bot.entity.id,
                            actionId: sneakState ? 0 : 1,
                            jumpBoost: 0
                        });
                        result = sneakState ? '开始潜行' : '停止潜行';
                        break;
                    case 'sprint':
                        bot.setControlState('sprint', !!fnArgs.state);
                        result = fnArgs.state ? '开始疾跑' : '停止疾跑';
                        break;
                    case 'goto_coordinates':
                        const { x, y, z } = fnArgs;
                        if (bot.pathfinder && this.movements && this.GoalNear) {
                            bot.pathfinder.setMovements(this.movements);
                            const goal = new this.GoalNear(x, y, z, 1);
                            bot.pathfinder.setGoal(goal);
                            result = `寻路到 (${x}, ${y}, ${z})`;
                        } else {
                            result = '寻路不可用';
                        }
                        break;
                    case 'wait':
                        result = `等待: ${fnArgs.reason || '无特别原因'}`;
                        break;
                    default:
                        result = `未知工具: ${fnName}`;
                }
            } catch (err) {
                result = `执行 ${fnName} 失败: ${err.message}`;
            }

            results.push({ tool: fnName, result });
            this.log('info', `[AI动作] ${fnName}: ${result}`);
        }

        return results;
    }

    _stopAllMove() {
        const bot = this.getBot();
        if (!bot) return;
        for (const ctrl of this.activeControls) {
            bot.setControlState(ctrl, false);
        }
        this.activeControls.clear();
        if (this.moveTimer) {
            clearTimeout(this.moveTimer);
            this.moveTimer = null;
        }
    }

    _getTargetFace(block) {
        const bot = this.getBot();
        if (!bot) return new Vec3(0, 1, 0);
        const dx = -Math.sin(bot.entity.yaw) * Math.cos(bot.entity.pitch);
        const dy = -Math.sin(bot.entity.pitch);
        const dz = Math.cos(bot.entity.yaw) * Math.cos(bot.entity.pitch);
        const bx = block.position.x + 0.5;
        const by = block.position.y + 0.5;
        const bz = block.position.z + 0.5;
        const offX = (bot.entity.position.x + dx * 6) - bx;
        const offY = (bot.entity.position.y + bot.entity.height + dy * 6) - by;
        const offZ = (bot.entity.position.z + dz * 6) - bz;
        const absX = Math.abs(offX);
        const absY = Math.abs(offY);
        const absZ = Math.abs(offZ);
        if (absX >= absY && absX >= absZ) return new Vec3(Math.sign(offX), 0, 0);
        if (absY >= absX && absY >= absZ) return new Vec3(0, Math.sign(offY), 0);
        return new Vec3(0, 0, Math.sign(offZ));
    }

    /**
     * 主决策循环（单次）
     */
    async _decisionCycle() {
        if (!this.enabled) return;

        const state = this._getGameState();
        if (!state) {
            this.log('warn', '[AI控制] Bot 未连接，跳过决策');
            return;
        }

        const stateText = this._formatState(state);
        this.messages.push({ role: 'user', content: stateText });

        if (this.messages.length > 30) {
            this.messages = [
                this.messages[0],
                ...this.messages.slice(-20),
            ];
        }

        try {
            const response = await this.ollama.chatWithTools(this.messages, TOOLS, {
                temperature: 0.3,
            });

            if (response.tool_calls && response.tool_calls.length > 0) {
                const results = await this._executeToolCalls(response.tool_calls);
                const resultsText = results.map(r => `${r.tool}: ${r.result}`).join('\n');
                this.messages.push({
                    role: 'assistant',
                    content: response.content || '',
                    tool_calls: response.tool_calls,
                });
                this.messages.push({
                    role: 'tool',
                    content: resultsText,
                });
                this.io?.emit('ai_controller_log', {
                    thought: response.content,
                    actions: results,
                });
            } else if (response.content) {
                this.messages.push({
                    role: 'assistant',
                    content: response.content,
                });
                this.io?.emit('ai_controller_log', {
                    thought: response.content,
                    actions: [],
                });
            }
        } catch (err) {
            this.log('error', `[AI控制] 决策失败: ${err.message}`);
        }
    }

    /**
     * 启动自主控制循环
     */
    start() {
        if (this.enabled) return;
        this.enabled = true;
        this.resetConversation();
        this.log('info', '[AI控制] 自主控制已启动');
        this.io?.emit('ai_controller_status', { enabled: true });
        this._runLoop();
    }

    _runLoop() {
        if (!this.enabled) return;
        this._decisionCycle().finally(() => {
            if (this.enabled) {
                this.loopTimer = setTimeout(() => this._runLoop(), this.loopDelay);
            }
        });
    }

    /**
     * 停止自主控制循环
     */
    stop() {
        this.enabled = false;
        if (this.loopTimer) {
            clearTimeout(this.loopTimer);
            this.loopTimer = null;
        }
        this._stopAllMove();
        this.log('info', '[AI控制] 自主控制已停止');
        this.io?.emit('ai_controller_status', { enabled: false });
    }

    /**
     * 设置循环间隔
     */
    setDelay(ms) {
        this.loopDelay = Math.max(1000, Math.min(30000, ms));
    }
}

module.exports = { AIController, TOOLS };