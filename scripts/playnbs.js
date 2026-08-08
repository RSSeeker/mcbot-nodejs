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
 *   **run playnbs <歌曲名.nbs> | [1bot]   播放 songs/ 目录下的歌曲（1bot 强制单 bot 演奏）
 *   **run playnbs stop                    停止当前播放并下线小号
 *   **run playnbs list | [关键词]         列出 / 搜索歌曲
 *
 * 歌曲文件放到项目根目录的 songs/ 文件夹下。
 */

const fs = require('fs');
const path = require('path');
const { fromArrayBuffer } = require('@nbsjs/core');
const parseArgs = require('./lib/parse_args');
// 强制重载共享模块（server.js 只清理脚本自身的缓存，依赖模块需要手动清）
const childBotPath = require.resolve('./lib/child_bot');
delete require.cache[childBotPath];
const { createChildBot, makeRateLimiter, MAX_PACKETS_PER_WINDOW } = require(childBotPath);
const { allocateBots } = require('./lib/note_alloc');
// 最多同时使用的 bot 数（1 主 + 9 小号）
const MAX_BOTS = 10;
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

// 只清理属于本次播放（token）的小号，不递增 token，避免旧实例收尾时误杀新开始的播放
function cleanupPlayback(bot, token) {
    const session = bot.__nbsSession;
    if (!session) return;
    session.childBots = session.childBots.filter((entry) => {
        if (!entry || entry.token !== token) return true;
        try {
            if (entry.child && entry.child._client && !entry.child._client.ended) entry.child.quit();
        } catch (e) {}
        return false;
    });
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

async function playNBS(bot, session, filePath, reply, log, config, singleBot = false) {
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

    // 读取并解析 NBS
    let song;
    try {
        const songFile = fs.readFileSync(filePath);
        song = fromArrayBuffer(new Uint8Array(songFile).buffer);
    } catch (err) {
        reply('读取/解析 NBS 文件失败: ' + err.message);
        return;
    }

    const songLength = song.getLength();
    const songSpeed = song.getTimePerTick();
    const songName = song.name || path.basename(filePath);
    log('info', `正在播放: ${songName}，曲长 ${songLength} tick，速度 ${songSpeed}ms/tick，预计 ${(songLength * songSpeed / 1000).toFixed(1)}s`);

    // 预处理音符
    const rows = buildTabList(song);
    const totalNotes = rows.reduce((sum, row) => sum + row.length, 0);

    // 多 bot：约束分配——把每个音符按时间轴贪心分给“7 秒窗口负载最低”的 bot，
    // 保证每个 bot 任意 7 秒窗口 ≤ MAX_PACKETS_PER_WINDOW（450，500 留 10% 余量），上限 MAX_BOTS
    const flatNotes = [];
    for (let j = 0; j < rows.length; j++) {
        const row = rows[j];
        if (!row || row.length === 0) continue;
        for (let k = 0; k < row.length; k++) flatNotes.push({ seconds: j * songSpeed / 1000 });
    }
    let alloc = null;
    let botNum;
    if (singleBot) {
        botNum = 1;
    } else {
        alloc = allocateBots(flatNotes, MAX_PACKETS_PER_WINDOW, MAX_BOTS);
        botNum = alloc.botCount;
        if (alloc.fits) log('info', `约束分配：${botNum} 个 bot，每 bot 7 秒窗口最多 ${alloc.maxLoad} 包（上限 ${MAX_PACKETS_PER_WINDOW}）`);
        else log('warn', `${MAX_BOTS} 个 bot 仍无法满足约束，限速器兜底`);
    }
    log('info', `音符总数 ${totalNotes}，需要 ${botNum} 个 bot${singleBot ? '（强制单 bot）' : ''}`);

    // 串行创建小号（各自独立连接/注册），失败不影响主 bot 播放
    if (botNum > 1) {
        for (let k = 1; k < botNum; k++) {
            if (token !== session.token) break; // **stop 后不再创建新小号
            const child = await createChildBot(bot, k, config, () => token !== session.token).catch(() => null);
            if (token !== session.token) {
                // 创建期间被 stop：退掉刚创建的小号
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
    if (token !== session.token) {
        cleanupPlayback(bot, token); // 等待小号期间被 stop 了，只清自己的小号
        return;
    }

    // 旧会话已完全停稳（旧小号断开、循环退出）后再切 unicode 键盘，
    // 避免切键与旧会话的收尾/发包竞争导致服务端钢琴插件异常踢人
    try { bot.chat('/piano keyboard unicode'); } catch (e) {}

    // 小号在前、主 bot 兜底（与 WeeaxeBot 一致）
    const botList = [...session.childBots.map((e) => e.child), bot];

    // 逐 tick 播放：按预分配结果发给指定 bot，掉线则退到存活 bot，限速器兜底
    let nextTick = performance.now();
    let transactionId = 1;
    let flatIdx = 0;
    for (let j = 0; j < rows.length; j++) {
        if (token !== session.token) break; // 停止控制
        if (!isClientAlive(bot)) {
            log('warn', '主 bot 已断开，停止播放');
            break;
        }

        const now = performance.now();
        // now 已包含上一 tick 的发包耗时，直接等下一个节拍即可，无需额外补偿
        const waitMs = Math.ceil(nextTick - now);
        if (waitMs > 0) await sleep(waitMs);
        nextTick += songSpeed;

        const row = rows[j];
        if (!row || row.length === 0) continue;

        const alive = botList.filter((b) => b && isClientAlive(b));
        if (alive.length === 0) break;
        let fallback = 0;
        for (let i = 0; i < row.length; i++, flatIdx++) {
            if (token !== session.token) break;
            let sender;
            if (alloc && alloc.assign && alloc.assign[flatIdx] !== undefined) {
                const target = botList[alloc.assign[flatIdx]];
                sender = (target && isClientAlive(target)) ? target : alive[fallback % alive.length];
                if (sender !== target) fallback++;
            } else {
                sender = alive[fallback % alive.length];
                fallback++;
            }
            // 每个 bot 独立限速，防止“发包过多”被踢
            await limiterFor(sender)();
            try {
                sender._client.write('tab_complete', {
                    transactionId: transactionId++,
                    text: row[i],
                });
            } catch (err) {
                log('warn', `发送音符失败: ${err.message}`);
            }
        }
    }

    // 收尾：下掉小号、复位状态
    const finished = token === session.token;
    cleanupPlayback(bot, token);
    session.playing = false;
    if (finished) reply(`播放结束: ${songName}`);
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
    // 参数用 | 分隔（曲名可含空格）；歌曲名后的参数可为 1bot/single/solo 强制单 bot 演奏
    const params = parseArgs(args);
    let singleBot = false;
    if (params[1] && /^(1bot|single|solo)$/i.test(params[1])) {
        singleBot = true;
        params.splice(1, 1);
    }
    const [rawName = '', listKeyword = ''] = params;
    const sub = rawName.toLowerCase();

    if (sub === 'stop') {
        stopPlayback(bot, reply);
        return;
    }

    if (sub === 'list') {
        const matched = listSongs(listKeyword);
        reply(`songs/ 目录下共 ${matched.length} 首匹配歌曲：`);
        const names = matched.slice(0, 15).map((f) => '  ' + path.relative(SONG_DIR, f));
        reply(names.length ? names.join('\n') : '（没有找到 .nbs 文件，请先放歌到 songs/ 文件夹）');
        return;
    }

    let fileName = rawName;
    if (sub === 'play') fileName = parseArgs(args).slice(1).join(' '); // 兼容 playnbs play | <歌名>

    if (!fileName || fileName === 'help') {
        reply('用法: **run playnbs <歌曲名.nbs> | [1bot] | stop | list | <关键词>（1bot 强制单 bot 演奏）');
        reply(`歌曲文件放到项目根目录 songs/ 文件夹（${SONG_DIR}）`);
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
    let target = path.resolve(SONG_DIR, fileName);
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
        reply(`歌曲不存在: songs/${fileName}（可用 **run playnbs list 查看）`);
        return;
    }
    if (!target.toLowerCase().endsWith('.nbs')) {
        reply('只支持 .nbs 音符方块谱文件');
        return;
    }

    reply(`开始播放: ${path.relative(SONG_DIR, target)}`);
    await playNBS(bot, session, target, reply, log, config, singleBot);
};
