const site = 'https://anichin.moe';
const rumble = 'https://rumble.com';
const catalogRequest = { headers: { 'User-Agent': 'IndoFetch/1.0', Accept: 'text/html' } };
const metaBase = 'https://tmdb.elfhosted.com/meta/series';
const animeMappings = 'https://api.ani.zip/mappings';

function decodeHtml(text) {
    return text.replace(/&(?:amp|quot|apos|#39|#8217);/gi, entity => ({
        '&amp;': '&', '&quot;': '"', '&apos;': "'", '&#39;': "'", '&#8217;': '’',
    }[entity.toLowerCase()]));
}

function absolute(value, base) {
    try {
        const clean = decodeHtml(value);
        const url = new URL(clean.startsWith('//') ? 'https:' + clean : clean, base);
        if (url.protocol === 'https:' && !url.username && !url.password) return url;
    } catch {
        return null;
    }
    return null;
}

async function read(url, method, options) {
    const response = await fetch(url, options);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response[method]();
}

function stripYear(title) {
    return title.replace(/\s*\((?:19|20)\d{2}\)\s*$/, '').trim();
}

function titleParts(title) {
    const year = Number(/\(((?:19|20)\d{2})\)\s*$/.exec(title)?.[1]) || null;
    const clean = stripYear(title).normalize('NFKD').toLowerCase().replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z\d]+/g, ' ').trim();
    const season = /(?: season (\d+)| s ?(\d+)| (\d+)(?:st|nd|rd|th) season)$/.exec(clean);
    return {
        title: season ? clean.slice(0, season.index) : clean,
        season: season ? Number(season[1] ?? season[2] ?? season[3]) : null,
        year,
    };
}

async function identify(contentId, season, episode) {
    const tracker = /^(kitsu|anilist|mal):(\d+)(?::(\d+))?$/i.exec(contentId);
    const id = /^(?:tmdb[:/])?(tt\d+|\d+)$/i.exec(contentId)?.[1]?.toLowerCase();
    episode = Number(tracker?.[3] ?? episode);
    if (!Number.isSafeInteger(episode) || episode < 1) return null;
    if (tracker) {
        const key = tracker[1].toLowerCase() + '_id';
        const data = await read(animeMappings + '?' + key + '=' + tracker[2], 'json');
        if (!['TV', 'ONA'].includes(data.mappings?.type) || Number(data.mappings[key]) !== Number(tracker[2]) ||
            !data.episodes?.[episode]) return null;
        const titles = [data.titles?.en, data.titles?.['x-zht'], data.titles?.['x-jat']].filter(title => typeof title === 'string' && title.trim());
        if (!titles.length) return null;
        const premiere = data.episodes[1];
        const explicitSeason = titles.map(titleParts).find(part => part.season)?.season;
        return { titles, episode, season: explicitSeason ?? (Number(premiere?.seasonNumber) || 1),
            year: Number(String(premiere?.airDate ?? premiere?.airdate ?? '').slice(0, 4)) || null };
    }
    if (!id) return null;
    const { meta } = await read(metaBase + '/' + (id.startsWith('tt') ? id : 'tmdb:' + id) + '.json', 'json');
    if (typeof meta?.name !== 'string' || !meta.genres?.includes('Animation')) return null;
    const absoluteNumber = season == null;
    season = absoluteNumber ? 1 : Number(season);
    if (!Number.isInteger(season) || season < 1 ||
        (!absoluteNumber && !meta.videos?.some(video => video.season === season && video.episode === episode))) return null;
    const premiere = meta.videos?.find(video => video.season === season && video.episode === 1);
    const year = Number(String(premiere?.released ?? '').slice(0, 4)) || null;
    return { titles: [meta.name], season, episode, year };
}

function titleScore(title, request, aliases) {
    const value = titleParts(title);
    if ((value.season ?? 1) !== request.season || (value.year && request.year && value.year !== request.year)) return 0;
    if (aliases.some(alias => alias.replace(/ /g, '') === value.title.replace(/ /g, ''))) return 2;
    return aliases.some(alias => value.title.endsWith(' ' + alias)) ? 1 : 0;
}

function anchors(html) {
    return html.matchAll(/<a\b[^>]*\shref\s*=\s*(["'])([^"']+)\1([^>]*)>/gi);
}

async function findEpisode(request) {
    const names = request.titles.flatMap(title => [title, ...title.split(':')]).map(stripYear).filter(Boolean);
    const aliases = [...new Set(names.map(title => titleParts(title).title).filter(title => title.length >= 3))];
    const compact = aliases.filter(title => title.split(' ').length <= 3).map(title => title.replace(/ /g, ''));
    const queries = new Map();
    for (const query of [...names, ...aliases, ...compact]) {
        if (!queries.has(query.toLowerCase())) queries.set(query.toLowerCase(), query);
    }
    const results = await Promise.all([...queries.values()].map(query =>
        read(site + '/?s=' + encodeURIComponent(query).replace(/%20/g, '+'), 'text', catalogRequest).catch(() => '')));
    const titles = new Map();
    for (const html of results) {
        for (const [, , href, attrs] of anchors(html)) {
            const url = absolute(href, site + '/');
            if (url?.origin !== site || !/^\/[a-z\d-]+\/?$/i.test(url.pathname)) continue;
            if (!/\bitemprop\s*=\s*(["'])url\1/i.test(attrs)) continue;
            const raw = /\btitle\s*=\s*(["'])([^"']+)\1/i.exec(attrs)?.[2] ?? '';
            const label = decodeHtml(raw);
            const score = titleScore(label, request, aliases);
            if (score) titles.set(url.href, Math.max(titles.get(url.href) ?? 0, score));
        }
    }
    const highest = Math.max(0, ...titles.values());
    const candidates = [...titles].filter(([, score]) => score === highest);
    if (candidates.length !== 1) return null;
    const showUrl = candidates[0][0];
    const show = await read(showUrl, 'text', catalogRequest);
    const title = decodeHtml(/<title\b[^>]*>([^<]+)<\/title>/i.exec(show)?.[1] ?? '')
        .replace(/\s+[-–]\s*Anichin\s*$/i, '').trim();
    if (!titleScore(title, request, aliases)) return null;

    const episodes = new Set();
    const entries = show.matchAll(/<a\b[^>]*\shref\s*=\s*(["'])([^"']+)\1[^>]*>\s*<div\b[^>]*\bclass\s*=\s*["']epl-num["'][^>]*>\s*(\d+)(?:\s+END)?\s*</gi);
    for (const [, , href, number] of entries) {
        const url = absolute(href, showUrl);
        if (url?.origin !== site || Number(number) !== request.episode) continue;
        const slugEpisode = /-episode-(\d+)(?:-tamat)?-subtitle-indonesia\/?$/i.exec(url.pathname)?.[1];
        if (Number(slugEpisode) === request.episode) episodes.add(url.href);
    }
    if (episodes.size === 1) return { url: [...episodes][0], title };
    return null;
}

function players(page, episodeUrl) {
    const frames = [page];
    const mirrors = /<select\b[^>]*\bclass\s*=\s*(["'])[^"']*\bmirror\b[^"']*\1[^>]*>([\s\S]*?)<\/select>/i.exec(page)?.[2] ?? '';
    for (const [, , encoded] of mirrors.matchAll(/<option\b[^>]*\bvalue\s*=\s*(["'])([a-z\d+/=]+)\1/gi)) {
        try {
            frames.push(atob(encoded));
        } catch {
            continue;
        }
    }

    const results = new Set();
    for (const html of frames) {
        for (const [, , raw] of html.matchAll(/<iframe\b[^>]*\ssrc\s*=\s*(["'])([^"']+)\1/gi)) {
            const url = absolute(raw, episodeUrl);
            if (url?.origin === rumble && /^\/embed\/[a-z\d]+\/?$/i.test(url.pathname)) results.add(url.href);
        }
    }
    return results;
}

async function resolvePlayer(embed, episodeUrl) {
    try {
        const response = await fetch(embed, { headers: { Referer: episodeUrl } });
        const referer = response.url || embed;
        if (!response.ok || absolute(referer, embed)?.origin !== rumble) return [];
        const html = await response.text();
        const streams = new Map();
        for (const [, raw] of html.matchAll(/"hls"\s*:\s*\{\s*"url"\s*:\s*("(?:\\.|[^"\\])*")/gi)) {
            const url = absolute(JSON.parse(raw), referer);
            if (url?.origin !== rumble || !/^\/hls-vod\/[a-z\d_-]+\/playlist\.m3u8$/i.test(url.pathname) ||
                streams.has(url.href)) continue;

            const headers = { Referer: referer };
            const master = await read(url.href, 'text', { headers });
            const firstVariant = master.split(/\r?\n/).map(line => line.trim()).find(line => line && !line.startsWith('#'));
            const variant = firstVariant && absolute(firstVariant, url.href);
            if (!/^\s*#EXTM3U\b/.test(master) || !master.includes('#EXT-X-STREAM-INF:') ||
                !variant || !/^(?:[a-z\d-]+\.)+cdn\.rumble\.cloud$/i.test(variant.hostname)) continue;

            const playlist = await read(variant.href, 'text', { headers });
            if (/^\s*#EXTM3U\b/.test(playlist) && /^#EXTINF:/m.test(playlist)) {
                streams.set(url.href, { url: url.href, headers, type: 'hls' });
            }
        }
        return [...streams.values()];
    } catch {
        return [];
    }
}

async function getStreams(contentId, mediaType, season, episode) {
    if (!['series', 'anime', 'tv'].includes(mediaType)) return [];
    try {
        const request = await identify(String(contentId), season, episode);
        if (!request) return [];
        const match = await findEpisode(request);
        if (!match) return [];
        const page = await read(match.url, 'text', catalogRequest);
        const heading = decodeHtml(/<title\b[^>]*>([^<]+)<\/title>/i.exec(page)?.[1] ?? '').trim();
        const label = /^Nonton\s+(.+?)\s+Episode\s+(\d+)(?:\s+Tamat)?\s+Subtitle Indonesia\s*[-–]\s*Anichin$/i.exec(heading);
        if (!label || Number(label[2]) !== request.episode ||
            titleParts(label[1]).title !== titleParts(match.title).title) return [];
        const displaySeason = titleParts(label[1]).season;
        if (displaySeason && displaySeason !== request.season) return [];

        const links = players(page, match.url);
        const results = (await Promise.all([...links].map(url => resolvePlayer(url, match.url)))).flat();
        const streams = [...new Map(results.map(stream => [stream.url, stream])).values()];
        const title = match.title + ' • E' + String(request.episode).padStart(2, '0');
        return streams.map((stream, index) => ({
            ...stream, name: streams.length === 1 ? 'Anichin' : 'Anichin · Link ' + (index + 1), title,
        }));
    } catch {
        return [];
    }
}

module.exports = { getStreams };
