const site = 'https://oploverz.diy';
const metadata = 'https://tmdb.elfhosted.com/meta/series';
const animeMappings = 'https://api.ani.zip/mappings';
const player = /^https:\/\/(?:www|draft)\.blogger\.com\/video\.g\?/i;
const media = /^https:\/\/[a-z\d.-]+\.googlevideo\.com\/videoplayback\?/i;

function decodeHtml(value) {
    return value.replace(/&(?:amp|quot|apos|#39);/gi, entity => ({
        '&amp;': '&', '&quot;': '"', '&apos;': "'", '&#39;': "'",
    }[entity.toLowerCase()]));
}

function titleSlug(value) {
    return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/[^a-z\d]+/g, '-').replace(/^-|-$/g, '');
}

async function json(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.json();
}

async function identify(contentId, season, episode) {
    const tracker = /^(kitsu|anilist|mal):(\d+)(?::(\d+))?$/i.exec(contentId);
    const id = /^(?:tmdb[:/])?(tt\d+|\d+)$/i.exec(contentId)?.[1]?.toLowerCase();
    episode = Number(tracker?.[3] ?? episode);
    if (!Number.isSafeInteger(episode) || episode < 1) return null;
    if (tracker) {
        const key = tracker[1].toLowerCase() + '_id';
        const value = await json(animeMappings + '?' + key + '=' + tracker[2]);
        if (value.mappings?.type !== 'TV' || Number(value.mappings[key]) !== Number(tracker[2]) ||
            !value.episodes?.[episode]) return null;
        const titles = [value.titles?.en, value.titles?.['x-jat']].filter(title => typeof title === 'string' && title.trim());
        return titles.length ? { titles, episode, coordinates: 'E' + String(episode).padStart(2, '0') } : null;
    }
    if (!id) return null;
    const { meta } = await json(metadata + '/' + (id.startsWith('tt') ? id : 'tmdb:' + id) + '.json');
    if (typeof meta?.name !== 'string' || !meta.genres?.includes('Animation')) return null;
    season = season == null ? null : Number(season);
    if (season !== null && (!Number.isInteger(season) || season < 1 ||
        !meta.videos?.some(video => video.season === season && video.episode === episode))) return null;
    const first = meta.videos?.find(video => video.season === 1 && video.episode === 1);
    const year = /^\d{4}/.exec(first?.released)?.[0];
    const titles = season > 1 ? [meta.name + ' Season ' + season] : [meta.name, ...(year ? [meta.name + ' (' + year + ')'] : [])];
    const coordinates = (season === null ? '' : 'S' + String(season).padStart(2, '0')) + 'E' + String(episode).padStart(2, '0');
    return { titles, episode, coordinates };
}

// The page embeds the current episode alongside its neighbors. Follow the current
// object boundaries without executing the page script.
function currentEpisode(page, number) {
    const marker = new RegExp('\\bepisode:\\{id:\\d+,[^{}]{0,1200}?\\bepisodeNumber:"' + number + '"').exec(page);
    if (!marker) return '';
    const start = marker.index + 'episode:'.length;
    let depth = 0;
    let quoted = '';
    for (let i = start; i < page.length && i - start < 80000; i++) {
        const char = page[i];
        if (quoted) {
            if (char === '\\') i++;
            else if (char === quoted) quoted = '';
        } else if (char === '"' || char === "'") {
            quoted = char;
        } else if (char === '{') {
            depth++;
        } else if (char === '}' && --depth === 0) {
            return page.slice(start, i + 1);
        }
    }
    return '';
}

async function episodePlayers(request) {
    const keys = new Set();
    for (const title of request.titles) {
        const key = titleSlug(title);
        const expanded = key.replace(/-s-?(\d+)$/, '-season-$1');
        const short = key.replace(/-season-(\d+)$/, '-s$1');
        for (const variant of [key, expanded, short]) if (variant) keys.add(variant);
    }

    const results = await Promise.all([...keys].map(async key => {
        const path = '/series/' + key + '/episode/' + request.episode;
        const url = site + path;
        try {
            const response = await fetch(url);
            if (!response.ok || new URL(response.url || url).href !== url) return [];
            const page = await response.text();
            const heading = decodeHtml(/<title\b[^>]*>([^<]+)<\/title>/i.exec(page)?.[1] ?? '');
            const match = /^(.*?)\s+Episode\s+(\d+)\s*\|\s*Oploverz$/i.exec(heading);
            if (!match || Number(match[2]) !== request.episode || !keys.has(titleSlug(match[1]))) return [];
            const episode = currentEpisode(page, request.episode);
            const mirrors = /\bstreamUrl:\[([^\]]*)\]/.exec(episode)?.[1] ?? '';
            return Array.from(mirrors.matchAll(/\burl:"((?:\\.|[^"\\])+)"/g), ([, value]) => ({
                url: JSON.parse('"' + value + '"'), referer: url,
            })).filter(link => player.test(link.url));
        } catch {
            return [];
        }
    }));
    return [...new Map(results.flat().map(link => [link.url, link])).values()];
}

async function playerStreams(link) {
    try {
        const response = await fetch(link.url, { headers: { Referer: link.referer } });
        const referer = response.url || link.url;
        if (!response.ok || !player.test(referer)) return [];
        const html = decodeHtml(await response.text());
        const urls = new Set();
        for (const [raw] of html.matchAll(/https:\/\/[a-z\d.-]+\.googlevideo\.com\/videoplayback\?[^"'\s<>]+/gi)) {
            const url = raw.replace(/\\u([\da-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
            if (media.test(url) && !/[\s"'<>\\]/.test(url)) urls.add(url);
        }
        const headers = { Referer: referer };
        return (await Promise.all([...urls].map(async url => {
            try {
                const response = await fetch(url, { headers: { ...headers, Range: 'bytes=0-1023' } });
                if (response.status !== 206 || !media.test(response.url || url)) return null;
                const bytes = new DataView(await response.arrayBuffer());
                if (bytes.byteLength < 12 || bytes.getUint32(4) !== 0x66747970) return null;
                const length = Number(/\/(\d+)$/.exec(response.headers.get('content-range'))?.[1]);
                const size = length > 0 ? (length / 1000000).toFixed(length < 10000000 ? 1 : 0) + ' MB' : undefined;
                return { url, headers, size, type: 'mp4' };
            } catch {
                return null;
            }
        }))).filter(Boolean);
    } catch {
        return [];
    }
}

async function getStreams(contentId, mediaType, season, episode) {
    if (!['anime', 'series', 'tv'].includes(mediaType)) return [];
    try {
        const request = await identify(String(contentId).trim(), season, episode);
        if (!request) return [];
        const players = await episodePlayers(request);
        const results = (await Promise.all(players.map(playerStreams))).flat();
        const streams = [...new Map(results.map(stream => [stream.url, stream])).values()];
        const title = request.titles[0] + ' • ' + request.coordinates;
        return streams.map((stream, index) => ({
            ...stream, name: streams.length === 1 ? 'Oploverz' : 'Oploverz · Link ' + (index + 1), title,
        }));
    } catch {
        return [];
    }
}

module.exports = { getStreams };
