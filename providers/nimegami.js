const site = 'https://nimegami.id';
const mediaOrigin = 'https://stream-stor.berkasdrive.com';
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
    const clean = stripYear(title).normalize('NFKD').toLowerCase().replace(/[\u0300-\u036f]/g, '').replace(/×/g, 'x')
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

function cards(html) {
    return html.matchAll(/<a\b(?=[^>]*\bclass=["']card-title["'])[^>]*\shref\s*=\s*(["'])([^"']+)\1[^>]*>([^<]+)<\/a>/gi);
}

async function findShow(request) {
    const names = request.titles.flatMap(title => [title, ...title.split(':')]).map(stripYear).filter(Boolean);
    const aliases = [...new Set(names.map(title => titleParts(title).title).filter(title => title.length >= 3))];
    const compact = aliases.filter(title => title.split(' ').length <= 3).map(title => title.replace(/ /g, ''));
    const queries = new Map();
    for (const query of [...names, ...aliases, ...compact]) {
        if (!queries.has(query.toLowerCase())) queries.set(query.toLowerCase(), query);
    }
    const results = await Promise.all([...queries.values()].map(query =>
        read(site + '/anime/?q=' + encodeURIComponent(query), 'text').catch(() => '')));
    const titles = new Map();
    for (const html of results) {
        for (const [, , href, raw] of cards(html)) {
            const url = absolute(href, site + '/');
            if (url?.origin !== site || !/^\/[a-z\d-]+\/$/i.test(url.pathname)) continue;
            const label = decodeHtml(raw).trim();
            const score = titleScore(label, request, aliases);
            if (score) titles.set(url.href, Math.max(titles.get(url.href) ?? 0, score));
        }
    }
    const highest = Math.max(0, ...titles.values());
    const candidates = [...titles].filter(([, score]) => score === highest);
    if (candidates.length !== 1) return null;
    const showUrl = candidates[0][0];
    return { url: showUrl, aliases };
}

function seriesTitle(page, request, aliases) {
    for (const [, raw] of page.matchAll(/<script\b[^>]*\stype=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
        let graph;
        try {
            graph = JSON.parse(raw)['@graph'];
        } catch {
            continue;
        }
        if (!Array.isArray(graph)) continue;
        const item = graph.find(node => node?.['@type'] === 'TVSeason' && node.seasonNumber === request.season) ??
            (request.season === 1 && !graph.some(node => node?.['@type'] === 'TVSeason')
                ? graph.find(node => node?.['@type'] === 'TVSeries') : null);
        if (typeof item?.name === 'string' && titleScore(item.name, request, aliases)) return item.name;
    }
    return null;
}

function episodePlayers(page, showUrl, episode) {
    const flight = Array.from(page.matchAll(/self\.__next_f\.push\(\[\s*1\s*,\s*("(?:\\.|[^"\\])*")\s*\]\)/g),
        match => JSON.parse(match[1])).join('');
    const pending = [];
    for (const row of flight.split('\n')) {
        const record = /^[a-f\d]+:([\[{].*"links"\s*:\s*\[.*)$/i.exec(row)?.[1];
        if (!record) continue;
        try {
            pending.push(JSON.parse(record));
        } catch {
            continue;
        }
    }
    const links = new Map();
    const episodePath = new URL(showUrl).pathname + 'streaming/' + episode + '/';
    for (const node of pending) {
        if (!node || typeof node !== 'object') continue;
        if (!Array.isArray(node.links)) {
            for (const child of Object.values(node)) if (child && typeof child === 'object') pending.push(child);
            continue;
        }

        for (const entry of node.links) {
            if (entry?.episode !== episode || entry.kind !== 'episode' || entry.mode !== 'embed' ||
                typeof entry.playUrl !== 'string') continue;
            const url = absolute(entry.playUrl, showUrl);
            if (url?.origin !== site || !url.pathname.startsWith(episodePath)) continue;
            const address = /^(\d{3,4}p)\/(?:[a-f\d]{20}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})\/$/i.exec(url.pathname.slice(episodePath.length));
            if (address) links.set(url.href, address[1].toLowerCase());
        }
    }
    return links;
}

async function resolvePlayer(player, showUrl, quality) {
    try {
        const response = await fetch(player, { headers: { Referer: showUrl } });
        const referer = response.url || player;
        if (!response.ok || absolute(referer, player)?.origin !== site) return null;
        const page = await response.text();
        const tag = /<main\b[^>]*\bid\s*=\s*(["'])player\1[^>]*>/i.exec(page)?.[0] ?? '';
        const raw = /\bdata-src\s*=\s*(["'])([^"']+)\1/i.exec(tag)?.[2];
        const media = raw && absolute(raw, referer);
        if (media?.origin !== mediaOrigin || !/^\/v\/v1\.[a-z\d_.-]+$/i.test(media.pathname)) return null;
        const headers = { Referer: referer };
        const probe = await fetch(media.href, { headers: { ...headers, Range: 'bytes=0-1023' } });
        if (probe.status !== 206 || absolute(probe.url || media.href, media.href)?.origin !== mediaOrigin) {
            await probe.body?.cancel();
            return null;
        }

        const bytes = new DataView(await probe.arrayBuffer());
        if (bytes.byteLength < 12 || bytes.getUint32(4) !== 0x66747970) return null;
        const length = Number(/\/(\d+)$/.exec(probe.headers.get('content-range'))?.[1]);
        return { url: media.href, headers, type: 'mp4', quality,
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
        const show = await findShow(request);
        if (!show) return [];
        const page = await read(show.url, 'text');
        const series = seriesTitle(page, request, show.aliases);
        if (!series) return [];
        const embeds = episodePlayers(page, show.url, request.episode);
        const results = await Promise.all([...embeds].map(([url, quality]) => resolvePlayer(url, show.url, quality)));
        const streams = [...new Map(results.filter(Boolean).map(stream => [stream.url, stream])).values()];
        streams.sort((first, second) => parseInt(second.quality, 10) - parseInt(first.quality, 10));
        const title = series + ' • E' + String(request.episode).padStart(2, '0');
        return streams.map((stream, index) => ({
            ...stream, name: streams.length === 1 ? 'Nimegami' : 'Nimegami · Link ' + (index + 1), title,
        }));
    } catch {
        return [];
    }
}

module.exports = { getStreams };
