module.exports = async function(bot, context) {
    const { reply, args, log } = context;
    reply('示例脚本已运行！参数: ' + (args.join(' ') || '无'));
    log('info', '示例脚本执行完毕');
};