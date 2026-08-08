'use strict';

/**
 * ⚠️ 仅 Weeaxe 服务器（mc.weeaxe.cn）可用：依赖服务器钢琴插件（/piano keyboard unicode + tab_complete 符号触发）
 * NBS 音符方块谱演奏脚本
 *
 * 参照 WeeaxeBot-main/index.js 的演奏实现移植：
 *   1. 用 @nbsjs/core 解析 .nbs 谱面文件
 *   2. 把「乐器 + 音高」映射成 Unicode 字符（scripts/instr_map.js，原样提取自 WeeaxeBot）
 *   3. 通过 tab_complete 数据包发送 "/// 字符"，触发服务器钢琴插件的 unicode 键盘发声
 *   4. 按谱面曲速逐 tick 播放，平均音符多时自动多开小号分担（多音响度）
 *
 * 用法（游戏内聊天，经 **run 调用）：
 *   **run playnbs <歌曲名.nbs> | [参数...]   播放 songs/ 目录下的歌曲（参数无序）
 *   **run playnbs stop                       停止当前播放并下线小号
 *   **run playnbs list | [关键词]            列出 / 搜索歌曲
 *
 * 参数（无序，写哪个激活哪个）:
 *   1bot / single / solo: 强制单 bot 演奏
 *   once（默认）: 单曲播放一次 | loop: 单曲循环
 *   list: 列表播放一次（从当前歌按字母序往下播）| listloop: 列表循环
 *   random: 随机播放 | random_once: 随机不重复（播完一轮重置）
 *
 * 多 bot：约束分配，每 bot 7 秒窗口 ≤ 450 包且 1 秒窗口 ≤ 280 包；切歌复用小号，结束时延迟回收。
 *
 * 歌曲文件放到项目根目录的 songs/ 文件夹下。
 */

const fs = require('fs');
const path = require('path');
const { fromArrayBuffer } = require('@nbsjs/core');
// ===== 内联 parse_args =====
// 统一参数解析：所有脚本的参数之间用 | 分隔（参数内部可含空格）
// 例: **run playmidi My Song | 2 | pitch
// server.js 先把整条命令按空白切分传入 args，这里拼回原始文本再按 | 拆分，
// 空段保留（用于省略中间参数，如 "song | | pitch" 表示速度用默认值）
function parseArgs(args) {
    const joined = (args || []).join(' ').trim();
    if (!joined) return [];
    return joined.split('|').map((s) => s.trim());
}

// ===== 内联 child_bot（复用本文件的 sleep/isClientAlive）=====
// 子 bot 创建：playnbs / playmidi 共用的多 bot 逻辑
// 同一服务器、offline 模式，先过验证码再注册，然后登录、切 unicode 键盘、传送到主 bot 本体

const CHILD_LOGIN_WAIT = 5000; // 等待出生（spawn）的最长时间



// 发包频率限制器：每个 bot 每 7 秒最多发 MAX_PACKETS_PER_WINDOW 个 tab_complete 包，
// 与 Paper 的 packet-limiter（500 包/7s）同款滑动窗口语义。
// 450 = 500 的 90%，给 GC 抖动 / TPS 波动 / ViaVersion 封装等留生产余量
const MAX_PACKETS_PER_WINDOW = 450; // 7 秒上限
const RATE_WINDOW_MS = 7000;
const MAX_PACKETS_PER_1S = 280;     // 1 秒上限
const RATE_1S_MS = 1000;
// 发包限速开关（false 关闭）
const RATE_LIMIT_ENABLED = true;

// 协同限速：每 bot 7 秒 ≤ MAX_PACKETS_PER_WINDOW 且 1 秒 ≤ MAX_PACKETS_PER_1S
function makeRateLimiter() {
    if (!RATE_LIMIT_ENABLED) {
        // 不限速：每次调用立即返回
        return async function waitSlot() {};
    }
    const times = [];
    return async function waitSlot() {
        for (;;) {
            const now = performance.now();
            while (times.length && now - times[0] >= RATE_WINDOW_MS) times.shift();
            let idx1 = 0;
            while (idx1 < times.length && now - times[idx1] >= RATE_1S_MS) idx1++;
            const c7 = times.length;
            const c1 = times.length - idx1;
            let wait = 0;
            if (c7 >= MAX_PACKETS_PER_WINDOW) wait = Math.max(wait, times[0] + RATE_WINDOW_MS - now);
            if (c1 >= MAX_PACKETS_PER_1S) wait = Math.max(wait, times[idx1] + RATE_1S_MS - now);
            if (wait <= 0) break;
            await sleep(wait);
        }
        times.push(performance.now());
    };
}

// 等小号收到匹配的消息（用于确认注册/登录完成），带超时兜底
function waitChildMessage(child, pattern, timeoutMs) {
    return new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            child.removeListener('message', onMsg);
            child.removeListener('chat', onChat);
            resolve();
        };
        const timer = setTimeout(finish, timeoutMs);
        const onMsg = (jsonMsg) => {
            try {
                const text = typeof jsonMsg === 'string' ? jsonMsg : (jsonMsg && jsonMsg.toString ? jsonMsg.toString() : '');
                if (pattern.test(text)) finish();
            } catch (e) {}
        };
        const onChat = (name, msg) => {
            if (pattern.test(String(msg || ''))) finish();
        };
        child.on('message', onMsg);
        child.on('chat', onChat);
    });
}

// 创建子 bot：主名+序号（如 RS_Bot1、RS_Bot2），出生后注册/登录/切键/传送到主 bot
// 返回 child；5 秒内没 spawn 则判定登录失败返回 null
async function createChildBot(bot, index, config, isCancelled = () => false, log = null) {
    const mineflayer = require('mineflayer');
    const MAX_DUP_RETRIES = 5; // 同名重复登录（duplicate_login）最多换 5 个序号
    for (let attempt = 0; attempt < MAX_DUP_RETRIES; attempt++) {
        const username = bot.username + index; // 序号命名：主名+序号
        const child = mineflayer.createBot({
            host: config.server.host,
            port: parseInt(config.server.port, 10),
            username,
            auth: 'offline',
            version: String(config.server.version || '1.21.4'),
            hideErrors: true,
        });
        const password = config.bot.password || '';

        // 服务器可能要求先输验证码（/captcha <code>）才能注册
        let captchaSent = false;
        let abandoned = false;
        let retryDup = false;
        const handleCaptchaText = (text) => {
            if (!text || captchaSent || abandoned) return;
            const s = String(text);
            // 只响应服务器下发的验证码请求（带“验证码/注册”等语境），
            // 避免把自己发出的 /captcha 回显当成新请求导致死循环
            if (!/captcha/i.test(s) || !/验证码|注册|请使用|请输入|require|register/i.test(s)) return;
            const m = s.match(/\/captcha\s+([A-Za-z0-9]+)/i);
            if (m) {
                captchaSent = true;
                try { child.chat('/captcha ' + m[1]); } catch (e) {}
            }
        };
        child.on('message', (jsonMsg) => {
            try {
                const text = typeof jsonMsg === 'string' ? jsonMsg : (jsonMsg && jsonMsg.toString ? jsonMsg.toString() : '');
                if (log) log('info', `[子bot ${child.username}] 收到: ${text}`);
                handleCaptchaText(text);
            } catch (e) {}
        });
        child.on('chat', (name, msg) => {
            if (log) log('info', `[子bot ${child.username}] 聊天 ${name}: ${msg}`);
            handleCaptchaText(msg);
        });

        let spawned = false;
        let resolveReady;
        const readyPromise = new Promise((res) => { resolveReady = res; });
        child.on('spawn', () => {
            if (abandoned) return;
            spawned = true;

            // 依次：等验证码 → 注册（等确认） → 登录（等确认） → 切 unicode 键盘 → 传送到主 bot 本体
            const setup = async () => {
                if (abandoned) return;
                try {
                    if (password) {
                        child.chat(`/register ${password} ${password}`);
                        // 注册成功或已注册过则继续
                        await waitChildMessage(child, /注册成功|注册完成|已注册|你已经登陆过了/, 2500);
                        if (abandoned) return;
                        child.chat(`/login ${password}`);
                        // 登录成功则继续
                        await waitChildMessage(child, /登录成功|已成功登录|已登录|欢迎回来/, 2500);
                        if (abandoned) return;
                    }
                    child.chat('/piano keyboard unicode');
                    await sleep(600);
                    if (abandoned) return;
                    // 直接传送到主 bot 本体
                    child.chat('/tp ' + bot.username);
                } catch (e) { /* 忽略 */ }
                resolveReady();
            };

            const start = Date.now();
            const waitTimer = setInterval(() => {
                if (abandoned) { clearInterval(waitTimer); return; }
                if (captchaSent || Date.now() - start > 6000) {
                    clearInterval(waitTimer);
                    // 发出验证码后稍等再注册，保证指令顺序
                    setTimeout(() => setup().catch(() => resolveReady()), captchaSent ? 800 : 0);
                }
            }, 200);
        });
        child.on('error', (err) => {
            if (log) log('warn', `[子bot ${child.username}] 错误: ${err && err.message ? err.message : err}`);
        });
        child.on('kicked', (reason) => {
            let text = '';
            try { text = typeof reason === 'string' ? reason : JSON.stringify(reason); } catch (e) { text = String(reason); }
            if (log) log('warn', `[子bot ${child.username}] 被踢: ${text}`);
            // 同名重复登录：换序号重试
            if (text.includes('duplicate_login')) {
                retryDup = true;
                abandoned = true;
                try { child.removeAllListeners(); } catch (e) {}
            }
        });

        // 等待出生（最多 CHILD_LOGIN_WAIT 毫秒；被取消则立即放弃），失败则放弃该小号
        const deadline = Date.now() + CHILD_LOGIN_WAIT;
        while (!spawned && !retryDup && Date.now() < deadline && !isCancelled()) await sleep(100);
        if (retryDup) {
            if (log) log('warn', `[子bot ${username}] 重复登录，换序号 ${index + 1} 重试`);
            try { child.end(); } catch (e) {}
            try { child.quit(); } catch (e) {}
            index++;
            continue;
        }
        if (!spawned || isCancelled()) {
            // 防止“僵尸小号”晚到连接后继续注册/切键/传送，干扰服务端状态
            abandoned = true;
            try { child.removeAllListeners(); } catch (e) {}
            try { child.end(); } catch (e) {}
            try { child.quit(); } catch (e) {}
            return null;
        }
        // 等注册/登录/传送流程完成（最多 8 秒），确保小号就绪再开始播放
        await Promise.race([readyPromise, sleep(8000)]);
        if (isCancelled()) {
            // 创建期间被停止：退掉刚登录的小号
            abandoned = true;
            try { child.removeAllListeners(); } catch (e) {}
            try { child.quit(); } catch (e) {}
            return null;
        }
        return child;
    }
    if (log) log('warn', `[子bot] 连续 ${MAX_DUP_RETRIES} 次重复登录，放弃该小号`);
    return null;
}

// ===== 内联 note_alloc =====
// 音符的“约束分配”：保证每个 bot 在任意 7 秒窗口内的包数 ≤ safeLimit。
//
// 原理：按时间轴顺序处理每个音符，把它分给“最近 7 秒窗口负载最低”的 bot（贪心平衡）；
// 若某个 bot 的窗口已满（bestLoad >= safeLimit），说明当前 bot 数不够，
// 增加一个 bot 从头重新分配，直到全部满足或达到 maxBots。
// 这样不是“轮询”，而是真正的逐 bot 7 秒窗口约束。
//
// notes: [{ seconds }]，按时间升序
// 返回 { botCount, assign, fits, maxLoad }
//   assign[i] = 第 i 个音符分配的 bot 下标；fits=false 表示 maxBots 内无法满足

function allocateBots(notes, safeLimit7s, maxBots, safeLimit1s = 280, windowSec = 7, window1s = 1) {
    const n = notes.length;
    if (n === 0) return { botCount: 1, assign: [], fits: true, maxLoad7: 0, maxLoad1: 0 };
    for (let botCount = 1; botCount <= maxBots; botCount++) {
        // 每个 bot 维护时间数组 + 两个 head 指针（7s / 1s 滑动窗口，O(1) 均摊）
        const queues = Array.from({ length: botCount }, () => ({ arr: [], h7: 0, h1: 0 }));
        const assign = new Array(n);
        let fits = true;
        for (let i = 0; i < n; i++) {
            const t = notes[i].seconds;
            let best = 0, bestNorm = Infinity;
            for (let b = 0; b < botCount; b++) {
                const q = queues[b];
                while (q.h7 < q.arr.length && q.arr[q.h7] < t - windowSec) q.h7++;
                while (q.h1 < q.arr.length && q.arr[q.h1] < t - window1s) q.h1++;
                const load7 = q.arr.length - q.h7;
                const load1 = q.arr.length - q.h1;
                const norm = Math.max(load7 / safeLimit7s, load1 / safeLimit1s);
                if (norm < bestNorm) { bestNorm = norm; best = b; }
            }
            const q = queues[best];
            const load7 = q.arr.length - q.h7;
            const load1 = q.arr.length - q.h1;
            if (load7 >= safeLimit7s || load1 >= safeLimit1s) { fits = false; break; }
            q.arr.push(t);
            assign[i] = best;
        }
        if (fits) {
            // 独立验证：统计每个 bot 的实际 7s 与 1s 窗口峰值
            let maxLoad7 = 0, maxLoad1 = 0;
            const perBot = Array.from({ length: botCount }, () => []);
            for (let i = 0; i < n; i++) perBot[assign[i]].push(notes[i].seconds);
            for (const times of perBot) {
                let l7 = 0, l1 = 0;
                for (let right = 0; right < times.length; right++) {
                    while (times[right] - times[l7] > windowSec) l7++;
                    while (times[right] - times[l1] > window1s) l1++;
                    const c7 = right - l7 + 1;
                    const c1 = right - l1 + 1;
                    if (c7 > maxLoad7) maxLoad7 = c7;
                    if (c1 > maxLoad1) maxLoad1 = c1;
                }
            }
            return { botCount, assign, fits: true, maxLoad7, maxLoad1 };
        }
    }
    // 达到 maxBots 仍不满足：返回贪心结果（由限速器兜底，最多只是拖慢）
    return { botCount: maxBots, assign: null, fits: false, maxLoad7: 0, maxLoad1: 0 };
}
// 最多同时使用的 bot 数（1 主 + 9 小号）
const MAX_BOTS = 9; // 1 主 + 最多 8 个小号
const instrCharMap = {
  0: "一丁丂七丄丅丆万丈三上下丌不与丏丐丑丒专且丕世丗丘丙业丛东丝丞丟丠両丢丣两严並丧丨丩个丫丬中丮丯丰丱串丳临丵丶丷丸丹为主丼丽举丿乀乁乂乃乄久乆乇么义乊之乌乍乎乏乐乑乒乓乔乕乖乗".split(''),
  1: "亀亁亂亃亄亅了亇予争亊事二亍于亏亐云互亓五井亖亗亘亙亚些亜亝亞亟亠亡亢亣交亥亦产亨亩亪享京亭亮亯亰亱亲亳亴亵亶亷亸亹人亻亼亽亾亿什仁仂仃仄仅仆仇仈仉今介仌仍从仏仐仑仒仓仔仕他仗".split(''),
  2: "伀企伂伃伄伅伆伇伈伉伊伋伌伍伎伏伐休伒伓伔伕伖众优伙会伛伜伝伞伟传伡伢伣伤伥伦伧伨伩伪伫伬伭伮伯估伱伲伳伴伵伶伷伸伹伺伻似伽伾伿佀佁佂佃佄佅但佇佈佉佊佋佌位低住佐佑佒体佔何佖佗".split(''),
  3: "侀侁侂侃侄侅來侇侈侉侊例侌侍侎侏侐侑侒侓侔侕侖侗侘侙侚供侜依侞侟侠価侢侣侤侥侦侧侨侩侪侫侬侭侮侯侰侱侲侳侴侵侶侷侸侹侺侻侼侽侾便俀俁係促俄俅俆俇俈俉俊俋俌俍俎俏俐俑俒俓俔俕俖俗".split(''),
  4: "倀倁倂倃倄倅倆倇倈倉倊個倌倍倎倏倐們倒倓倔倕倖倗倘候倚倛倜倝倞借倠倡倢倣値倥倦倧倨倩倪倫倬倭倮倯倰倱倲倳倴倵倶倷倸倹债倻值倽倾倿偀偁偂偃偄偅偆假偈偉偊偋偌偍偎偏偐偑偒偓偔偕偖偗".split(''),
  5: "傀傁傂傃傄傅傆傇傈傉傊傋傌傍傎傏傐傑傒傓傔傕傖傗傘備傚傛傜傝傞傟傠傡傢傣傤傥傦傧储傩傪傫催傭傮傯傰傱傲傳傴債傶傷傸傹傺傻傼傽傾傿僀僁僂僃僄僅僆僇僈僉僊僋僌働僎像僐僑僒僓僔僕僖僗".split(''),
  6: "儀儁儂儃億儅儆儇儈儉儊儋儌儍儎儏儐儑儒儓儔儕儖儗儘儙儚儛儜儝儞償儠儡儢儣儤儥儦儧儨儩優儫儬儭儮儯儰儱儲儳儴儵儶儷儸儹儺儻儼儽儾儿兀允兂元兄充兆兇先光兊克兌免兎兏児兑兒兓兔兕兖兗".split(''),
  7: "冀冁冂冃冄内円冇冈冉冊冋册再冎冏冐冑冒冓冔冕冖冗冘写冚军农冝冞冟冠冡冢冣冤冥冦冧冨冩冪冫冬冭冮冯冰冱冲决冴况冶冷冸冹冺冻冼冽冾冿净凁凂凃凄凅准凇凈凉凊凋凌凍凎减凐凑凒凓凔凕凖凗".split(''),
  8: "刀刁刂刃刄刅分切刈刉刊刋刌刍刎刏刐刑划刓刔刕刖列刘则刚创刜初刞刟删刡刢刣判別刦刧刨利刪别刬刭刮刯到刱刲刳刴刵制刷券刹刺刻刼刽刾刿剀剁剂剃剄剅剆則剈剉削剋剌前剎剏剐剑剒剓剔剕剖剗".split(''),
  9: "劀劁劂劃劄劅劆劇劈劉劊劋劌劍劎劏劐劑劒劓劔劕劖劗劘劙劚力劜劝办功加务劢劣劤劥劦劧动助努劫劬劭劮劯劰励劲劳労劵劶劷劸効劺劻劼劽劾势勀勁勂勃勄勅勆勇勈勉勊勋勌勍勎勏勐勑勒勓勔動勖勗".split(''),
  10: "匀匁匂匃匄包匆匇匈匉匊匋匌匍匎匏匐匑匒匓匔匕化北匘匙匚匛匜匝匞匟匠匡匢匣匤匥匦匧匨匩匪匫匬匭匮匯匰匱匲匳匴匵匶匷匸匹区医匼匽匾匿區十卂千卄卅卆升午卉半卋卌卍华协卐卑卒卓協单卖南".split(''),
  11: "厀厁厂厃厄厅历厇厈厉厊压厌厍厎厏厐厑厒厓厔厕厖厗厘厙厚厛厜厝厞原厠厡厢厣厤厥厦厧厨厩厪厫厬厭厮厯厰厱厲厳厴厵厶厷厸厹厺去厼厽厾县叀叁参參叄叅叆叇又叉及友双反収叏叐发叒叓叔叕取受".split(''),
  12: "吀吁吂吃各吅吆吇合吉吊吋同名后吏吐向吒吓吔吕吖吗吘吙吚君吜吝吞吟吠吡吢吣吤吥否吧吨吩吪含听吭吮启吰吱吲吳吴吵吶吷吸吹吺吻吼吽吾吿呀呁呂呃呄呅呆呇呈呉告呋呌呍呎呏呐呑呒呓呔呕呖呗".split(''),
  13: "咀咁咂咃咄咅咆咇咈咉咊咋和咍咎咏咐咑咒咓咔咕咖咗咘咙咚咛咜咝咞咟咠咡咢咣咤咥咦咧咨咩咪咫咬咭咮咯咰咱咲咳咴咵咶咷咸咹咺咻咼咽咾咿哀品哂哃哄哅哆哇哈哉哊哋哌响哎哏哐哑哒哓哔哕哖哗".split(''),
  14: "唀唁唂唃唄唅唆唇唈唉唊唋唌唍唎唏唐唑唒唓唔唕唖唗唘唙唚唛唜唝唞唟唠唡唢唣唤唥唦唧唨唩唪唫唬唭售唯唰唱唲唳唴唵唶唷唸唹唺唻唼唽唾唿啀啁啂啃啄啅商啇啈啉啊啋啌啍啎問啐啑啒啓啔啕啖啗".split(''),
  15: "喀喁喂喃善喅喆喇喈喉喊喋喌喍喎喏喐喑喒喓喔喕喖喗喘喙喚喛喜喝喞喟喠喡喢喣喤喥喦喧喨喩喪喫喬喭單喯喰喱喲喳喴喵営喷喸喹喺喻喼喽喾喿嗀嗁嗂嗃嗄嗅嗆嗇嗈嗉嗊嗋嗌嗍嗎嗏嗐嗑嗒嗓嗔嗕嗖嗗".split('')
};

const SONG_DIR = path.resolve(__dirname, '..', 'songs');
const PLAY_PREFIX = '/// ';
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// 会话状态挂在 bot 上：脚本每次被 require 都是全新的模块，
// 只有挂在 bot 上，stop 命令才能中断正在播放的循环。
function getSession(bot) {
    if (!bot.__nbsSession) {
        bot.__nbsSession = { token: 0, childBots: [], playing: false };
    }
    return bot.__nbsSession;
}

function stopPlayback(bot, reply) {
    const session = bot.__nbsSession;
    if (!session) {
        if (reply) reply('当前没有播放任务');
        return [];
    }
    session.token++; // 让正在播放的循环立即退出
    session.playing = false;
    const old = session.childBots;
    session.childBots = [];
    for (const entry of old) {
        try {
            if (entry && entry.child && entry.child._client && !entry.child._client.ended) entry.child.quit();
        } catch (e) { /* 忽略子 bot 退出错误 */ }
    }
    if (reply) reply('已停止播放');
    return old.map((e) => e && e.child).filter(Boolean);
}

// 延迟回收小号：3 秒后再断开，给服务端清理时间；期间名字保留，避免新小号同名冲突
function delayedQuitChildren(bot, session) {
    const old = session.childBots;
    session.childBots = [];
    const reserved = (bot.__childNamesReserved = bot.__childNamesReserved || new Set());
    for (const entry of old) {
        const c = entry && entry.child;
        if (!c || !c._client || c._client.ended) continue;
        reserved.add(c.username);
        setTimeout(() => {
            try { if (c._client && !c._client.ended) c.quit(); } catch (e) {}
            // 真正断开后才释放名字，避免新小号同名重复登录（duplicate_login）
            let released = false;
            const release = () => { if (!released) { released = true; reserved.delete(c.username); } };
            if (c._client && !c._client.ended) {
                try { c.once('end', release); } catch (e) {}
            } else {
                release();
            }
            setTimeout(release, 3000); // 兜底：最多再保留 3 秒
        }, 3000);
    }
}

// 选一个未被“延迟回收中”占用的槽位名（RS_Bot1..N）
function nextChildIndex(bot) {
    const reserved = bot.__childNamesReserved || new Set();
    const used = new Set(((bot.__nbsSession && bot.__nbsSession.childBots) || []).map((e) => e && e.child && e.child.username).filter(Boolean));
    let k = 1;
    while (reserved.has(bot.username + k) || used.has(bot.username + k)) k++;
    return k;
}

function isClientAlive(target) {
    return target && target._client && !target._client.ended;
}

// 每个 bot 独立的发包限速器（服务端有发包频率限制，超了会被踢）
const botLimiters = new Map();
function limiterFor(bot) {
    let lim = botLimiters.get(bot);
    if (!lim) {
        lim = makeRateLimiter();
        botLimiters.set(bot, lim);
    }
    return lim;
}

// 预处理：把每一 tick 上所有层里的音符，转换成 "/// 字符" 形式
function buildTabList(song) {
    const songLength = song.getLength();
    const rows = [];
    for (let tick = 0; tick <= songLength; tick++) {
        const row = [];
        // 从最上层往下取（与 WeeaxeBot 一致，顶层音符优先）
        for (let i = song.layers.getTotal() - 1; i >= 0; i--) {
            const layer = song.layers.all[i];
            if (!layer || !layer.notes || layer.notes.getTotal() === 0) continue;
            const note = layer.notes.all[tick];
            if (!note) continue;
            // 乐器编号 0-15 -> 字符表；音高 key 0-87 -> 字符下标 key+4（WeeaxeBot 原版偏移）
            const ch = instrCharMap[note.instrument]?.[note.key + 4] ?? '';
            if (ch) row.push(PLAY_PREFIX + ch);
        }
        rows.push(row);
    }
    return rows;
}

async function playNBS(bot, session, filePath, reply, log, config, options = {}) {
    const { singleBot = false, playMode = 'once' } = options;
    // 先停掉上一次播放
    const oldChildren = stopPlayback(bot, null);
    const token = ++session.token;
    session.playing = true;

    // 等待旧小号完全断开再建同名新小号，避免服务器端重复登录/键盘状态冲突
    if (oldChildren.length) {
        log('info', `等待 ${oldChildren.length} 个旧小号断开...`);
        for (const c of oldChildren) {
            if (c && c._client && !c._client.ended) {
                try {
                    await Promise.race([
                        new Promise((res) => c.once('end', res)),
                        sleep(2000),
                    ]);
                } catch (e) {}
            }
        }
    }

    // 歌曲列表（按文件名字母排序，全路径，含子目录）；快照化，播放期间不受外部文件变化影响
    const allSongs = [];
    const walk = (dir) => {
        if (!fs.existsSync(dir)) return;
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) walk(full);
            else if (ent.isFile() && ent.name.toLowerCase().endsWith('.nbs')) allSongs.push(full);
        }
    };
    walk(SONG_DIR);
    allSongs.sort((a, b) => path.basename(a).toLowerCase().localeCompare(path.basename(b).toLowerCase()));
    const playlist = [...allSongs];
    let curIdx = allSongs.findIndex(s => path.basename(s).toLowerCase() === path.basename(filePath).toLowerCase());
    if (curIdx < 0) { allSongs.push(filePath); allSongs.sort((a, b) => path.basename(a).toLowerCase().localeCompare(path.basename(b).toLowerCase())); curIdx = allSongs.indexOf(filePath); }

    const isStopped = () => token !== session.token;

    // 准备一首歌：解析 NBS + 预处理 + 约束分配
    async function prepareSong(file) {
        let song;
        try {
            song = fromArrayBuffer(new Uint8Array(fs.readFileSync(file)).buffer);
        } catch (err) {
            throw new Error(`读取/解析 NBS 失败 ${path.basename(file)}: ${err.message}`);
        }
        const songLength = song.getLength();
        const songSpeed = song.getTimePerTick();
        const songName = song.name || path.basename(file);
        const rows = buildTabList(song);
        const totalNotes = rows.reduce((sum, row) => sum + row.length, 0);
        const flatNotes = [];
        for (let j = 0; j < rows.length; j++) {
            const row = rows[j];
            if (!row || row.length === 0) continue;
            for (let k = 0; k < row.length; k++) flatNotes.push({ seconds: j * songSpeed / 1000 });
        }
        let assign = null, botCount;
        if (singleBot) {
            botCount = 1;
        } else {
            const alloc = allocateBots(flatNotes, MAX_PACKETS_PER_WINDOW, MAX_BOTS, MAX_PACKETS_PER_1S);
            botCount = alloc.botCount;
            assign = alloc.assign;
            if (alloc.fits) log('info', `约束分配：${botCount} 个 bot，每 bot 7s 窗口最多 ${alloc.maxLoad7} 包（≤${MAX_PACKETS_PER_WINDOW}）、1s 窗口最多 ${alloc.maxLoad1} 包（≤${MAX_PACKETS_PER_1S}）`);
            else log('warn', `${MAX_BOTS} 个 bot 仍无法满足约束，限速器兜底`);
        }
        log('info', `正在播放: ${songName}，曲长 ${songLength} tick，速度 ${songSpeed}ms/tick，预计 ${(songLength * songSpeed / 1000).toFixed(1)}s | 音符 ${totalNotes}，需要 ${botCount} 个 bot${singleBot ? '（强制单 bot）' : ''}`);
        return { rows, songSpeed, songName, botCount, assign };
    }

    // 动态调整小号数量：切歌时复用小号（只增不减，避免登录风暴），结束时统一延迟回收
    async function adjustBots(wantedBotCount) {
        const wanted = Math.max(0, wantedBotCount - 1);
        while (session.childBots.length < wanted) {
            if (isStopped()) break;
            const k = nextChildIndex(bot);
            const child = await createChildBot(bot, k, config, isStopped, log).catch(() => null);
            if (isStopped()) {
                if (child) { try { child.quit(); } catch (e) {} }
                break;
            }
            if (child) {
                session.childBots.push({ token, child });
                log('info', `子 bot ${child.username} 已就绪`);
            } else {
                log('warn', `子 bot ${k} 登录失败，继续用现有 bot 播放`);
            }
        }
    }

    // 播放一首歌，返回 true=正常播完，false=被停/断开
    async function playSong(prep) {
        const { rows, songSpeed, assign } = prep;
        const botList = [...session.childBots.map((e) => e.child), bot];
        try { bot.chat('/piano keyboard unicode'); } catch (e) {}
        let nextTick = performance.now();
        let transactionId = 1;
        let flatIdx = 0;
        let childDied = false;
        for (let j = 0; j < rows.length; j++) {
            if (isStopped()) break;
            if (!isClientAlive(bot)) {
                log('warn', '主 bot 已断开，停止播放');
                return false;
            }
            const now = performance.now();
            const waitMs = Math.ceil(nextTick - now);
            if (waitMs > 0) await sleep(waitMs);
            nextTick += songSpeed;
            const row = rows[j];
            if (!row || row.length === 0) continue;
            const alive = botList.filter((b) => b && isClientAlive(b));
            if (alive.length === 0) return false;
            let fallback = 0;
            for (let i = 0; i < row.length; i++, flatIdx++) {
                if (isStopped()) break;
                let sender;
                let usedFallback = false;
                if (assign && assign[flatIdx] !== undefined) {
                    const target = botList[assign[flatIdx]];
                    if (target && isClientAlive(target)) {
                        sender = target;
                    } else {
                        // 指定 bot 掉线 → 退到存活 bot 接盘
                        sender = alive[fallback % alive.length];
                        fallback++;
                        usedFallback = true;
                    }
                } else {
                    sender = alive[fallback % alive.length];
                    fallback++;
                }
                // 小号掉线接盘：暂停 1s 泄压，避免主 bot 1s 窗口瞬时冲高（绝对安全模式）
                if (usedFallback && !childDied) {
                    childDied = true;
                    log('warn', '[playnbs] 小号掉线，主 bot 接盘，暂停 1s 泄压');
                    await sleep(1000);
                }
                await limiterFor(sender)();
                try {
                    sender._client.write('tab_complete', { transactionId: transactionId++, text: row[i] });
                } catch (err) {
                    log('warn', `发送音符失败: ${err.message}`);
                }
            }
        }
        return !isStopped();
    }

    // 决定下一首
    const playedSet = new Set(); // random_once 的已播集合
    function pickNext(idx) {
        if (playMode === 'once') return null;
        if (playMode === 'loop') return idx;
        if (playMode === 'list') return (idx + 1 < playlist.length) ? idx + 1 : null;
        if (playMode === 'listloop') return (idx + 1) % playlist.length;
        if (playMode === 'random_once') {
            if (playlist.length <= 1) return idx;
            playedSet.add(playlist[idx]);
            if (playedSet.size >= playlist.length) playedSet.clear(); // 播完所有再重置
            let ni;
            do { ni = Math.floor(Math.random() * playlist.length); } while (playedSet.has(playlist[ni]));
            return ni;
        }
        if (playMode === 'random') {
            if (playlist.length <= 1) return idx;
            let ni;
            do { ni = Math.floor(Math.random() * playlist.length); } while (ni === idx);
            return ni;
        }
        return null;
    }

    const MODE_NAMES = { once: '单曲播放一次', loop: '单曲循环', list: '列表播放一次', listloop: '列表循环', random: '随机播放', random_once: '随机不重复播放' };
    reply(`播放模式: ${MODE_NAMES[playMode]}${playMode !== 'once' ? `，从 ${path.basename(filePath)} 开始` : ''}`);

    // 主循环：每首播完提前算下一首的 bot 量，动态增减小号
    let playedSongs = 0;
    let prep = await prepareSong(filePath).catch((err) => { reply(err.message); return null; });
    if (!prep) { stopPlayback(bot, null); session.playing = false; return; }
    await adjustBots(prep.botCount);

    while (prep && !isStopped()) {
        reply(`开始播放: ${path.relative(SONG_DIR, playlist[curIdx])}`);
        const ok = await playSong(prep);
        playedSongs++;
        if (!ok) break;
        const ni = pickNext(curIdx);
        if (ni === null) {
            if (playMode === 'list') reply('列表播放完毕');
            break;
        }
        curIdx = ni;
        prep = await prepareSong(playlist[curIdx]).catch((err) => { reply(err.message); return null; });
        if (!prep) break;
        await adjustBots(prep.botCount);
    }

    delayedQuitChildren(bot, session);
    session.token++;
    session.playing = false;
    reply(`播放结束（共播放 ${playedSongs} 首）`);
}

function listSongs(keyword) {
    const results = [];
    if (fs.existsSync(SONG_DIR)) {
        const walk = (dir) => {
            for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, ent.name);
                if (ent.isDirectory()) walk(full);
                else if (ent.isFile() && ent.name.toLowerCase().endsWith('.nbs')) results.push(full);
            }
        };
        walk(SONG_DIR);
    }
    const kw = (keyword || '').toLowerCase();
    return kw ? results.filter((f) => path.basename(f).toLowerCase().includes(kw)) : results;
}

module.exports = async function (bot, context) {
    const { reply, args, log, config } = context;
    const session = getSession(bot);
    // 参数用 | 分隔（曲名可含空格）；除歌名外其余参数无序
    const params = parseArgs(args);
    let restParams = params.slice(1);
    let rawName = params[0] || '';
    const sub = rawName.toLowerCase();
    if (sub === 'play') { rawName = params[1] || ''; restParams = params.slice(2); } // 兼容 playnbs play | <歌名>

    if (sub === 'stop') {
        stopPlayback(bot, reply);
        return;
    }

    if (sub === 'list') {
        const matched = listSongs(params[1] || '');
        reply(`songs/ 目录下共 ${matched.length} 首匹配歌曲：`);
        const names = matched.slice(0, 15).map((f) => '  ' + path.relative(SONG_DIR, f));
        reply(names.length ? names.join('\n') : '（没有找到 .nbs 文件，请先放歌到 songs/ 文件夹）');
        return;
    }

    if (!rawName || rawName === 'help') {
        reply('用法: **run playnbs <歌曲名.nbs> | [参数...] | stop | list | <关键词>');
        reply('参数无序: 1bot/single/solo 强制单 bot | once/loop/list/listloop/random 播放模式');
        reply(`歌曲文件放到项目根目录 songs/ 文件夹（${SONG_DIR}）`);
        return;
    }

    // 无序参数解析 + 校验（1bot + 播放模式）
    let singleBot = false;
    let playMode = 'once';
    const seenKinds = new Set();
    const dupes = [];
    const invalid = [];
    for (const raw of restParams) {
        if (!raw) continue;
        const tok = raw.toLowerCase();
        let kind = null;
        if (/^(1bot|single|solo)$/.test(tok)) kind = 'single';
        else if (/^(once|loop|list|listloop|random|random_once)$/.test(tok)) kind = 'playmode';
        else { invalid.push(raw); continue; }
        if (seenKinds.has(kind)) { dupes.push(raw); continue; }
        seenKinds.add(kind);
        if (kind === 'single') singleBot = true;
        else playMode = tok;
    }
    if (dupes.length || invalid.length) {
        const parts = [];
        if (dupes.length) parts.push('重复/冲突: ' + dupes.join('、'));
        if (invalid.length) parts.push('无法识别: ' + invalid.join('、'));
        reply('参数有误：' + parts.join('；'));
        reply('参数: 1bot/single/solo | once/loop/list/listloop/random（无序，重复/冲突会报错）');
        return;
    }

    // 播放中禁止再次启动：服务器端会在重复启动时把 bot 踢下线（internal error），
    // 需要先 **run playnbs stop 再播放新歌
    if (session.playing) {
        reply('正在播放中，请先 **run playnbs stop 再重新播放');
        return;
    }

    // 路径安全校验：只允许 songs/ 目录内的文件（防止 ../ 越权）
    if (!fs.existsSync(SONG_DIR)) fs.mkdirSync(SONG_DIR, { recursive: true });
    let target = path.resolve(SONG_DIR, rawName);
    if (!target.startsWith(SONG_DIR + path.sep)) {
        reply('非法路径，只允许 songs/ 目录内的歌曲');
        return;
    }
    // 自动补 .nbs 后缀
    if (!fs.existsSync(target) && !target.toLowerCase().endsWith('.nbs')) {
        const alt = target + '.nbs';
        if (fs.existsSync(alt)) target = alt;
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        reply(`歌曲不存在: songs/${rawName}（可用 **run playnbs list 查看）`);
        return;
    }
    if (!target.toLowerCase().endsWith('.nbs')) {
        reply('只支持 .nbs 音符方块谱文件');
        return;
    }

    await playNBS(bot, session, target, reply, log, config, { singleBot, playMode });
};
