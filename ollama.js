/**
 * ollama.js — Ollama LLM 集成模块
 * ==========================================
 * 负责与本地 Ollama 服务通信，提供 AI 对话能力。
 *
 * 使用方式:
 *   const { OllamaClient } = require('./ollama');
 *   const ollama = new OllamaClient(config.ollama);
 *   const reply = await ollama.chat([{ role: 'user', content: '你好' }]);
 */

const http = require('http');

class OllamaClient {
    /**
     * @param {object} config - Ollama 配置
     * @param {string} config.host - Ollama 服务地址 (默认 http://localhost:11434)
     * @param {string} config.model - 模型名称 (默认 qwen2.5:latest)
     * @param {string} config.system_prompt - 系统提示词
     * @param {number} config.timeout - 请求超时(ms) (默认 60000)
     * @param {number} config.max_history - 最大对话历史条数 (默认 20)
     */
    constructor(config = {}) {
        this.host = config.host || 'http://localhost:11434';
        this.model = config.model || 'qwen2.5:latest';
        this.systemPrompt = config.system_prompt ||
            '你是一个 Minecraft 游戏中的 AI 助手机器人。请用简洁、友好的中文回复。' +
            '回复尽量简短，控制在游戏聊天栏的长度限制内。';
        this.timeout = config.timeout || 60000;
        this.maxHistory = config.max_history || 20;
        this.conversations = new Map();
        this.autoReplyEnabled = false;
        this.autoReplyTargets = [];
    }

    /**
     * 发送聊天请求到 Ollama /api/chat
     * @param {Array<{role: string, content: string}>} messages
     * @param {object} [options]
     * @param {string} [options.model] - 覆盖默认模型
     * @returns {Promise<string>} AI 回复内容
     */
    async chat(messages, options = {}) {
        const model = options.model || this.model;
        const payload = JSON.stringify({
            model,
            messages,
            stream: false,
            options: {
                temperature: 0.7,
                top_p: 0.9,
            },
        });

        const body = await this._post('/api/chat', payload);
        return body.message ? body.message.content : '';
    }

    /**
     * 发送带工具调用的聊天请求 (Function Calling)
     * @param {Array<{role: string, content: string}>} messages
     * @param {Array<object>} tools - 工具定义数组
     * @param {object} [options]
     * @returns {Promise<{content: string|null, tool_calls: Array|null}>}
     */
    async chatWithTools(messages, tools, options = {}) {
        const model = options.model || this.model;
        const payload = JSON.stringify({
            model,
            messages,
            tools,
            stream: false,
            options: {
                temperature: 0.5,
                top_p: 0.9,
            },
        });

        const body = await this._post('/api/chat', payload);
        const msg = body.message || {};
        return {
            content: msg.content || null,
            tool_calls: msg.tool_calls || null,
        };
    }

    /**
     * 发送生成请求到 Ollama /api/generate
     * @param {string} prompt
     * @param {object} [options]
     * @returns {Promise<string>}
     */
    async generate(prompt, options = {}) {
        const model = options.model || this.model;
        const payload = JSON.stringify({
            model,
            prompt,
            system: this.systemPrompt,
            stream: false,
            options: {
                temperature: 0.7,
                top_p: 0.9,
            },
        });

        const body = await this._post('/api/generate', payload);
        return body.response || '';
    }

    /**
     * 获取可用模型列表
     * @returns {Promise<Array<{name: string, size: number}>>}
     */
    async listModels() {
        const body = await this._get('/api/tags');
        return (body.models || []).map(m => ({
            name: m.name,
            size: m.size,
        }));
    }

    /**
     * 获取带对话历史的回复
     * @param {string} sessionId - 会话 ID
     * @param {string} userMessage - 用户消息
     * @param {object} [options]
     * @returns {Promise<string>}
     */
    async chatWithHistory(sessionId, userMessage, options = {}) {
        if (!this.conversations.has(sessionId)) {
            this.conversations.set(sessionId, []);
        }
        const history = this.conversations.get(sessionId);

        const messages = [
            { role: 'system', content: this.systemPrompt },
            ...history,
            { role: 'user', content: userMessage },
        ];

        const reply = await this.chat(messages, options);

        history.push({ role: 'user', content: userMessage });
        history.push({ role: 'assistant', content: reply });

        if (history.length > this.maxHistory) {
            history.splice(0, history.length - this.maxHistory);
        }

        return reply;
    }

    /**
     * 清除会话历史
     * @param {string} sessionId
     */
    clearHistory(sessionId) {
        this.conversations.delete(sessionId);
    }

    /**
     * 清除所有会话历史
     */
    clearAllHistory() {
        this.conversations.clear();
    }

    /**
     * 设置自动回复
     * @param {boolean} enabled
     * @param {string[]} targets - 要自动回复的玩家列表（空数组表示所有玩家）
     */
    setAutoReply(enabled, targets = []) {
        this.autoReplyEnabled = enabled;
        this.autoReplyTargets = targets;
    }

    /**
     * 检查是否需要对某玩家自动回复
     * @param {string} playerName
     * @returns {boolean}
     */
    shouldAutoReply(playerName) {
        if (!this.autoReplyEnabled) return false;
        if (this.autoReplyTargets.length === 0) return true;
        return this.autoReplyTargets.includes(playerName);
    }

    /**
     * 检查 Ollama 服务是否可用
     * @returns {Promise<boolean>}
     */
    async checkHealth() {
        try {
            await this._get('/api/tags');
            return true;
        } catch {
            return false;
        }
    }

    /**
     * HTTP POST 请求
     * @param {string} path
     * @param {string} body
     * @returns {Promise<object>}
     */
    _post(path, body) {
        return new Promise((resolve, reject) => {
            const url = new URL(path, this.host);
            const client = url.protocol === 'https:' ? require('https') : http;
            const req = client.request({
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
                timeout: this.timeout,
            }, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error(`解析 Ollama 响应失败: ${data.substring(0, 200)}`));
                    }
                });
            });
            req.on('error', (err) => {
                reject(new Error(`Ollama 请求失败: ${err.message}`));
            });
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Ollama 请求超时'));
            });
            req.write(body);
            req.end();
        });
    }

    /**
     * HTTP GET 请求
     * @param {string} path
     * @returns {Promise<object>}
     */
    _get(path) {
        return new Promise((resolve, reject) => {
            const url = new URL(path, this.host);
            const client = url.protocol === 'https:' ? require('https') : http;
            client.get(url.href, { timeout: this.timeout }, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error(`解析 Ollama 响应失败: ${data.substring(0, 200)}`));
                    }
                });
            }).on('error', (err) => {
                reject(new Error(`Ollama 请求失败: ${err.message}`));
            });
        });
    }
}

module.exports = { OllamaClient };