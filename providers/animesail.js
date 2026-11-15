const site = 'https://anisail.com';
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
    return html.matchAll(/<a\b[^>]*\shref\s*=\s*(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi);
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
        read(site + '/?s=' + encodeURIComponent(query), 'text').catch(() => '')));
    const titles = new Map();
    for (const html of results) {
        for (const [, , href, raw] of anchors(html)) {
            const url = absolute(href, site + '/');
            if (url?.origin !== site || !/^\/anime\/[a-z\d-]+\/$/i.test(url.pathname)) continue;
            const label = decodeHtml(raw.replace(/<[^>]*>/g, ' ').trim()).split(/\s+Subtitle Indonesia\b/i, 1)[0];
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
        .replace(/\s+Subtitle Indonesia\s*-\s*AnimeSail\s*$/i, '').trim();
    if (!titleScore(title, request, aliases)) return null;

    const slug = new URL(showUrl).pathname.split('/')[2];
    for (const [, , href] of anchors(show)) {
        const url = absolute(href, showUrl);
        if (url?.origin !== site || !url.pathname.startsWith('/' + slug + '-episode-')) continue;
        const number = /^(\d+)\/$/.exec(url.pathname.slice(slug.length + '-episode-'.length + 1))?.[1];
        if (Number(number) === request.episode) return { url: url.href, title };
    }
    return null;
}

function optionPlayers(page, episodeUrl) {
    const players = new Map();
    for (const [, , encoded, label] of page.matchAll(/<option\b[^>]*\bdata-em\s*=\s*(["'])([^"']+)\1[^>]*>([^<]*)<\/option>/gi)) {
        let frame;
        try {
            frame = atob(decodeHtml(encoded));
        } catch {
            continue;
        }
        const src = /<iframe\b[^>]*\ssrc\s*=\s*(["'])([^"']+)\1/i.exec(frame)?.[2];
        const url = src && absolute(src, episodeUrl);
        if (!url || !playerHost(url)) continue;
        const quality = /\b(\d{3,4}p)\b/i.exec(label)?.[1]?.toLowerCase();
        players.set(url.href, quality ?? players.get(url.href));
    }
    return players;
}

function playerHost(url) {
    if (!url || url.username || url.password || url.port) return null;
    if (['mp4upload.com', 'www.mp4upload.com'].includes(url.hostname) &&
        /^\/embed-[a-z\d]+\.html$/i.test(url.pathname)) return 'mp4upload';
    if (['yourupload.com', 'www.yourupload.com'].includes(url.hostname) &&
        /^\/embed\/[a-z\d]+\/?$/i.test(url.pathname)) return 'yourupload';
    return null;
}

function isVideo(value, host) {
    const url = absolute(value, site);
    if (!url || url.username || url.password || !/\/video\.mp4$/i.test(url.pathname)) return false;
    return host === 'mp4upload' ? /^[a-z\d-]+\.mp4upload\.com$/i.test(url.hostname) :
        /^(?:[a-z\d-]+\.)?vidcache\.net$/i.test(url.hostname);
}

async function resolvePlayer(url, episodeUrl, quality) {
    try {
        const host = playerHost(absolute(url, episodeUrl));
        const player = await fetch(url, { headers: { Referer: episodeUrl } });
        const referer = player.url || url;
        if (!player.ok || playerHost(absolute(referer, url)) !== host) return null;
        const page = await player.text();
        const raw = (host === 'mp4upload'
            ? /player\.src\(\s*\{[\s\S]*?\bsrc\s*:\s*(["'])(https:\/\/[^"']+)\1/i
            : /\bfile\s*:\s*(["'])(https:\/\/[^"']+)\1/i).exec(page)?.[2];
        if (!raw || !isVideo(raw, host)) return null;
        const media = decodeHtml(raw);
        const headers = { Referer: referer };
        const response = await fetch(media, { headers: { ...headers, Range: 'bytes=0-1023' } });
        if (response.status !== 206 || !isVideo(response.url || media, host)) {
            await response.body?.cancel();
            return null;
        }
        const bytes = new DataView(await response.arrayBuffer());
        if (bytes.byteLength < 12 || bytes.getUint32(4) !== 0x66747970) return null;
        const length = Number(/\/(\d+)$/.exec(response.headers.get('content-range'))?.[1]);
        return { url: media, headers, type: 'mp4', quality,
            size: length > 0 ? (length / 1000000).toFixed(0) + ' MB' : undefined };
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
        const label = /^(.*?)\s+Episode\s+(\d+)\s+Subtitle Indonesia\s*-\s*AnimeSail$/i.exec(heading);
        if (!label || Number(label[2]) !== request.episode || titleParts(label[1]).title !== titleParts(match.title).title ||
            (titleParts(label[1]).season ?? 1) !== request.season) return [];

        const players = optionPlayers(page, match.url);
        const results = await Promise.all([...players].map(([url, quality]) => resolvePlayer(url, match.url, quality)));
        const streams = [...new Map(results.filter(Boolean).map(stream => [stream.url, stream])).values()];
        const title = match.title + ' • E' + String(request.episode).padStart(2, '0');
        return streams.map((stream, index) => ({
            ...stream, name: streams.length === 1 ? 'AnimeSail' : 'AnimeSail · Link ' + (index + 1), title,
        }));
    } catch {
        return [];
    }
}

module.exports = { getStreams };
