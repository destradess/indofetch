const site = 'https://layaranime.net';
const playerOrigin = 'https://player.ablink.sbs';
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
        if (data.mappings?.type !== 'TV' || Number(data.mappings[key]) !== Number(tracker[2]) ||
            !data.episodes?.[episode]) return null;
        const titles = [data.titles?.en, data.titles?.['x-jat']].filter(title => typeof title === 'string' && title.trim());
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
        read(site + '/search?s=' + encodeURIComponent(query), 'text').catch(() => '')));
    const titles = new Map();
    for (const html of results) {
        for (const [, , href, attrs] of anchors(html)) {
            const url = absolute(href, site + '/');
            if (url?.origin !== site || !/^\/[a-z\d-]+\/?$/i.test(url.pathname)) continue;
            if (!/\bitemprop\s*=\s*(["'])url\1/i.test(attrs)) continue;
            const raw = /\btitle\s*=\s*(["'])([^"']+)\1/i.exec(attrs)?.[2] ?? '';
            const label = decodeHtml(raw).replace(/\s+Sub Indo\s*$/i, '');
            const score = titleScore(label, request, aliases);
            if (score) titles.set(url.href, Math.max(titles.get(url.href) ?? 0, score));
        }
    }
    const highest = Math.max(0, ...titles.values());
    const candidates = [...titles].filter(([, score]) => score === highest);
    if (candidates.length !== 1) return null;
    const showUrl = candidates[0][0];
    const show = await read(showUrl, 'text');
    const title = decodeHtml(/<title\b[^>]*>([^<]+)<\/title>/i.exec(show)?.[1] ?? '')
        .replace(/\s+Sub Indo\s*-\s*Layaranime\s*$/i, '').trim();
    if (!titleScore(title, request, aliases)) return null;

    const episodePath = new URL(showUrl).pathname.replace(/\/$/, '') + '/episode-';
    for (const [, , href] of anchors(show)) {
        const url = absolute(href, showUrl);
        if (url?.origin !== site || !url.pathname.startsWith(episodePath)) continue;
        const number = /^(\d+)\/?$/.exec(url.pathname.slice(episodePath.length))?.[1];
        if (Number(number) === request.episode) return { url: url.href, title };
    }
    return null;
}

function frameSources(html, base) {
    return Array.from(html.matchAll(/<iframe\b[^>]*\ssrc\s*=\s*(["'])([^"']+)\1/gi),
        match => absolute(match[2], base)).filter(url => url?.origin === playerOrigin);
}

async function playerPage(url, referer) {
    const response = await fetch(url.href, { headers: { Referer: referer } });
    const target = absolute(response.url || url.href, url.href);
    if (!response.ok || target?.origin !== playerOrigin || target.pathname !== url.pathname) return null;
    return { url: target, html: await response.text() };
}

async function resolveStream(wrapper, episodeUrl) {
    try {
        const embed = await playerPage(wrapper, episodeUrl);
        if (!embed) return null;
        const player = frameSources(embed.html, embed.url.href)
            .find(url => /^\/[a-z\d_-]+$/i.test(url.pathname));
        if (!player) return null;
        const page = await playerPage(player, embed.url.href);
        if (!page) return null;

        const files = page.html.matchAll(/(["'])(https:\/\/[^"'\s<>\\]+\/master\.m3u8(?:\?[^"'\s<>\\]*)?)\1/gi);
        for (const [, , raw] of files) {
            const url = absolute(raw, page.url.href);
            if (url?.origin !== playerOrigin || !/^\/img\.banter\d+\.click\//i.test(url.pathname) ||
                url.pathname.slice(url.pathname.indexOf('/', 1)) !== player.pathname + '/master.m3u8') continue;
            const headers = { Referer: page.url.href };
            const playlist = await read(url.href, 'text', { headers });
            if (/^\s*#EXTM3U\b/.test(playlist) && /^#EXTINF:/m.test(playlist)) {
                return { url: url.href, headers, type: 'hls' };
            }
        }
        return null;
    } catch {
        return null;
    }
}

async function getStreams(contentId, mediaType, season, episode) {
    if (!['series', 'anime', 'tv'].includes(mediaType)) return [];
    try {
        const request = await identify(String(contentId), season, episode);
        if (!request) return [];
        const match = await findEpisode(request);
        if (!match) return [];
        const page = await read(match.url, 'text');
        const heading = decodeHtml(/<title\b[^>]*>([^<]+)<\/title>/i.exec(page)?.[1] ?? '').trim();
        const label = /^(.*?)\s+Episode\s+(\d+)\s+Sub Indo\s*-\s*Layaranime$/i.exec(heading);
        if (!label || Number(label[2]) !== request.episode || titleParts(label[1]).title !== titleParts(match.title).title ||
            (titleParts(label[1]).season ?? 1) !== request.season) return [];

        const wrappers = new Map(frameSources(page, match.url).filter(url => url.pathname === '/iframe')
            .map(url => [url.href, url]));
        const results = await Promise.all([...wrappers.values()].map(url => resolveStream(url, match.url)));
        const streams = [...new Map(results.filter(Boolean).map(stream => [stream.url, stream])).values()];
        const title = match.title + ' • E' + String(request.episode).padStart(2, '0');
        return streams.map((stream, index) => ({
            ...stream, name: streams.length === 1 ? 'Layaranime' : 'Layaranime · Link ' + (index + 1), title,
        }));
    } catch {
        return [];
    }
}

module.exports = { getStreams };
