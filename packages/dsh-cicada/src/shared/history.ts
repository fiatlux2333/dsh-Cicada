import type { Persona, Visit } from './types.ts';

interface Site {
  url: string;
  title: string;
  category: string;
}
const site = (url: string, title: string, category: string): Site => ({ url, title, category });
const common: Site[] = [
  site('https://www.zhihu.com/hot', '知乎热榜', 'social'),
  site('https://www.thepaper.cn/', '澎湃新闻', 'news'),
  site('https://movie.douban.com/', '豆瓣电影', 'social'),
];
const pools: Record<Persona, Site[]> = {
  worker: [
    site('https://github.com/microsoft/vscode', 'Visual Studio Code - GitHub', 'work'),
    site('https://developer.mozilla.org/zh-CN/docs/Web/JavaScript', 'JavaScript - MDN', 'work'),
    site('https://docs.python.org/3/', 'Python 3 documentation', 'work'),
    site('https://stackoverflow.com/', 'Stack Overflow', 'work'),
  ],
  student: [
    site('https://www.icourse163.org/', '中国大学MOOC', 'work'),
    site('https://www.runoob.com/', '菜鸟教程', 'work'),
    site('https://www.bilibili.com/', '哔哩哔哩', 'video'),
  ],
  designer: [
    site('https://www.zcool.com.cn/', '站酷 ZCOOL', 'work'),
    site('https://www.uisdc.com/', '优设网', 'work'),
    site('https://dribbble.com/', 'Dribbble', 'work'),
    site('https://huaban.com/', '花瓣网', 'work'),
  ],
  trader: [
    site('https://xueqiu.com/', '雪球', 'work'),
    site('https://www.eastmoney.com/', '东方财富网', 'work'),
    site('https://finance.sina.com.cn/', '新浪财经', 'work'),
    site('https://www.10jqka.com.cn/', '同花顺', 'work'),
  ],
  gamer: [
    site('https://store.steampowered.com/', 'Steam', 'work'),
    site('https://www.gamersky.com/', '游民星空', 'work'),
    site('https://tieba.baidu.com/', '百度贴吧', 'social'),
  ],
  lifestyle: [
    site('https://www.xiachufang.com/', '下厨房', 'work'),
    site('https://music.163.com/', '网易云音乐', 'music'),
    site('https://news.sina.com.cn/', '新浪新闻', 'news'),
  ],
};
const hours = [0, 0, 0, 0, 0, 1, 2, 3, 5, 6, 6, 5, 7, 5, 5, 5, 6, 7, 8, 9, 9, 7, 4, 1];
export function seededRandom(seed: number): () => number {
  let n = seed >>> 0;
  return () => {
    n += 0x6d2b79f5;
    let t = Math.imul(n ^ (n >>> 15), 1 | n);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function generateHistory(
  persona: Persona,
  days: number,
  now: number,
  seed = 42,
  keywords: string[] = [],
): Visit[] {
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error('invalid-days');
  const rng = seededRandom(seed),
    integer = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
  const source = [...pools[persona], ...pools[persona], ...common];
  const weightedHours = hours.flatMap((w, hour) => Array<number>(w).fill(hour));
  const visits: Visit[] = [];
  let session = 0;
  for (let offset = days; offset > 0; offset--) {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - offset);
    const end = new Date(day);
    end.setDate(end.getDate() + 1);
    const weekend = [0, 6].includes(day.getDay());
    const sessions = integer(weekend && persona !== 'gamer' ? 1 : 2, weekend && persona === 'gamer' ? 7 : 5);
    for (let s = 0; s < sessions; s++) {
      const start = new Date(day);
      start.setHours(weightedHours[integer(0, weightedHours.length - 1)]!, integer(0, 59), integer(0, 59));
      let at = start.getTime(),
        previous = '';
      const category = source[integer(0, source.length - 1)]!.category;
      const candidates = source.filter((v) => v.category === category);
      for (let page = 0, count = integer(3, 8); page < count && at < end.getTime(); page++) {
        const item = candidates[integer(0, candidates.length - 1)]!;
        if (item.url === previous) continue;
        previous = item.url;
        const dwellSeconds = integer(45, 900);
        if (
          !keywords.some((k) =>
            `${item.url} ${item.title}`.toLocaleLowerCase().includes(k.toLocaleLowerCase()),
          )
        )
          visits.push({ url: item.url, title: item.title, at, dwellSeconds, session });
        at += (dwellSeconds + integer(20, 300)) * 1000;
      }
      session++;
    }
  }
  return visits.sort((a, b) => a.at - b.at);
}
export function dripHistory(persona: Persona, now: number, seed: number, keywords: string[]): Visit[] {
  const rng = seededRandom(seed);
  return generateHistory(persona, 2, now, seed, keywords)
    .map((v) => ({ v, rank: rng() }))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 12)
    .map((x) => x.v)
    .sort((a, b) => a.at - b.at);
}
