'use strict';

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

function allocateBots(notes, safeLimit, maxBots, windowSec = 7) {
    const n = notes.length;
    if (n === 0) return { botCount: 1, assign: [], fits: true, maxLoad: 0 };
    for (let botCount = 1; botCount <= maxBots; botCount++) {
        // 每个 bot 维护一个时间数组 + head 指针（数组有序，滑动窗口 O(1) 均摊）
        const queues = Array.from({ length: botCount }, () => ({ arr: [], head: 0 }));
        const assign = new Array(n);
        let fits = true;
        for (let i = 0; i < n; i++) {
            const t = notes[i].seconds;
            let best = 0, bestLoad = Infinity;
            for (let b = 0; b < botCount; b++) {
                const q = queues[b];
                while (q.head < q.arr.length && q.arr[q.head] < t - windowSec) q.head++;
                const load = q.arr.length - q.head;
                if (load < bestLoad) { bestLoad = load; best = b; }
            }
            if (bestLoad >= safeLimit) { fits = false; break; }
            queues[best].arr.push(t);
            assign[i] = best;
        }
        if (fits) {
            // 独立验证：统计每个 bot 的实际 7s 窗口峰值
            let maxLoad = 0;
            const perBot = Array.from({ length: botCount }, () => []);
            for (let i = 0; i < n; i++) perBot[assign[i]].push(notes[i].seconds);
            for (const times of perBot) {
                let left = 0;
                for (let right = 0; right < times.length; right++) {
                    while (times[right] - times[left] > windowSec) left++;
                    maxLoad = Math.max(maxLoad, right - left + 1);
                }
            }
            return { botCount, assign, fits: true, maxLoad };
        }
    }
    // 达到 maxBots 仍不满足：返回贪心结果（由限速器兜底，最多只是拖慢）
    return { botCount: maxBots, assign: null, fits: false, maxLoad: 0 };
}

module.exports = { allocateBots };
