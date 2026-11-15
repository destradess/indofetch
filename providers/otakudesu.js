const site = 'https://otakudesu.blog';
const metadata = 'https://tmdb.elfhosted.com/meta/series';
const animeMappings = 'https://api.ani.zip/mappings';
const playerHost = /^(?:desustream\.(?:net|me|com)|odvidhide\.com)$/i;
const streamHost = /^(?:cdn\.odcloud\.net|(?:[a-z\d-]+\.)*archive\.org|odvidhide\.com|[a-z\d-]+\.(?:dramiyos-cdn|acek-cdn)\.com)$/i;

function absolute(value, base) {
    try {
        const cleaned = value.replace(/&amp;/gi, '&');
        const url = new URL(cleaned.startsWith('//') ? 'https:' + cleaned : cleaned, base);
        if (/^https:\/\/[a-z\d.-]+\//i.test(url.href)) return url;
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

function frames(html) {
    return Array.from(html.matchAll(/<iframe\b[^>]*?\s(?:data-src|src)\s*=\s*(["'])([^"']+)\1/gi), match => match[2]);
}

function unpackPlayer(html) {
    // Decode the player configuration as text without executing the embed script.
    const packed = /\breturn p\s*}\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1\s*,\s*(\d+)\s*,\s*\d+\s*,\s*(['"])([^'"]*)\4\.split\(['"]\|['"]\)/.exec(html);
    if (!packed) return '';
    const radix = Number(packed[3]);
    const words = packed[5].split('|');
    const digits = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    if (radix < 2 || radix > digits.length) return '';

    return packed[2].replace(/\b[a-z\d]{1,6}\b/gi, key => {
        let index = 0;
        for (const digit of key) {
            const value = digits.indexOf(digit);
            if (value >= radix) return key;
            index = index * radix + value;
        }
        return words[index] || key;
    }).replace(/\\(['"/])/g, '$1');
}

async function playlist(url, headers) {
    try {
        const response = await fetch(url, { headers });
        if (!response.ok) return null;
        const text = await response.text();
        if (!/^\s*#EXTM3U\b/.test(text)) return null;

        const variants = [...text.matchAll(/^#EXT-X-STREAM-INF:.*\bRESOLUTION=\d+x(\d+)/gm)];
        if (text.includes('#EXT-X-STREAM-INF:')) {
            const first = text.split(/\r?\n/).map(line => line.trim()).find(line => line && !line.startsWith('#'));
            const child = first && absolute(first, response.url || url);
            if (!child || !streamHost.test(child.hostname)) return null;
            const media = await read(child.href, 'text', { headers });
            if (!/^\s*#EXTM3U\b/.test(media) || !media.includes('#EXTINF:')) return null;
        } else if (!text.includes('#EXTINF:')) {
            return null;
        }
        const height = variants.length ? Math.max(...variants.map(match => Number(match[1]))) : 0;
        return { url, headers, type: 'hls', quality: height ? height + 'p' : undefined };
    } catch {
        return null;
    }
}

function mediaLinks(html, base) {
    const content = html + '\n' + unpackPlayer(html);
    const links = new Set();
    for (const [, , raw] of content.matchAll(/(["'])([^"'<>\s]+\.(?:m3u8|mp4)(?:\?[^"'<>\s]*)?)\1/gi)) {
        const url = absolute(raw, base);
        if (url && streamHost.test(url.hostname)) links.add(url.href);
    }
    return [...links];
}

function cleanTitle(title) {
    return title.replace(/&amp;/gi, '&').replace(/\s+Subtitle Indonesia$/i, '')
        .replace(/\s+\((?:Episode\b[^)]*|\d{4})\)$/i, '').trim();
}

function titleKey(title) {
    return cleanTitle(title).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/[^a-z\d]+/g, ' ').trim().replace(/ s ?(\d+)$/, ' season $1');
}

function titleFamily(title, aliases) {
    const base = titleKey(title).replace(/ season \d+$/, '');
    return aliases.some(alias =>
        base.replace(/ /g, '') === alias.replace(/ /g, '') || (' ' + base + ' ').includes(' ' + alias + ' '));
}

async function identify(contentId, season, episode) {
    const tracker = /^(kitsu|anilist|mal):(\d+)(?::(\d+))?$/i.exec(contentId);
    const id = /^(?:tmdb[:/])?(tt\d+|\d+)$/i.exec(contentId)?.[1]?.toLowerCase();
    episode = Number(tracker?.[3] ?? episode);
    if (!Number.isSafeInteger(episode) || episode < 1 || (!tracker && !id)) return null;

    if (tracker) {
        const key = tracker[1].toLowerCase() + '_id';
        const data = await read(animeMappings + '?' + key + '=' + tracker[2], 'json');
        if (data.mappings?.type !== 'TV' || Number(data.mappings[key]) !== Number(tracker[2]) ||
            !data.episodes?.[episode]) return null;
        const year = Number(String(data.episodes[1]?.airDate ?? data.episodes[1]?.airdate ?? '').slice(0, 4));
        const titles = [data.titles?.en, data.titles?.['x-jat']].filter(value => typeof value === 'string' && value.trim());
        return year && titles.length ? { titles, year, episode, label: 'E' + String(episode).padStart(2, '0') } : null;
    }

    const { meta } = await read(metadata + '/' + (id.startsWith('tt') ? id : 'tmdb:' + id) + '.json', 'json');
    if (typeof meta?.name !== 'string' || !meta.genres?.includes('Animation')) return null;
    const absoluteEpisode = season == null;
    season = absoluteEpisode ? 1 : Number(season);
    if (!Number.isInteger(season) || season < 1) return null;
    if (!absoluteEpisode && !meta.videos?.some(video => video.season === season && video.episode === episode)) return null;
    const first = meta.videos?.find(video => video.season === season && video.episode === 1);
    const year = Number(String(first?.released ?? '').slice(0, 4));
    const label = (absoluteEpisode ? '' : 'S' + String(season).padStart(2, '0')) + 'E' + String(episode).padStart(2, '0');
    return year ? { titles: [meta.name], year, episode, label } : null;
}

async function episodePage(request) {
    const names = request.titles.flatMap(title => [title, ...title.split(':')]).map(cleanTitle).filter(Boolean);
    const aliases = [...new Set(names.map(titleKey).map(value => value.replace(/ season \d+$/, '')).filter(value => value.length >= 3))];
    const queries = new Map();
    const compact = aliases.filter(value => value.split(' ').length <= 3).map(value => value.replace(/ /g, ''));
    for (const query of [...names, ...aliases, ...compact]) {
        if (!queries.has(query.toLowerCase())) queries.set(query.toLowerCase(), query);
    }
    const results = await Promise.all([...queries.values()].map(query =>
        read(site + '/?s=' + encodeURIComponent(query) + '&post_type=anime', 'text').catch(() => '')));
    const titles = new Set();
    for (const page of results) {
        for (const [, , link, label] of page.matchAll(/<h2\b[^>]*>\s*<a\b[^>]*\shref\s*=\s*(["'])([^"']+)\1[^>]*>([^<]+)/gi)) {
            const url = absolute(link, site + '/');
            if (url?.origin === site && /^\/anime\/[a-z\d-]+\/$/.test(url.pathname) && titleFamily(label.trim(), aliases)) {
                titles.add(url.href);
            }
        }
    }

    const matches = await Promise.all([...titles].map(async url => {
        const page = await read(url, 'text').catch(() => '');
        const detail = /<b>\s*Judul\s*<\/b>\s*:\s*([^<]+)/i.exec(page)?.[1];
        const date = /<b>\s*Tanggal Rilis\s*<\/b>\s*:\s*([^<]+)/i.exec(page)?.[1];
        const year = Number(/\b\d{4}\b/.exec(date)?.[0]);
        if (!detail || year !== request.year || !titleFamily(detail.trim(), aliases)) return null;

        const episodes = new Set();
        for (const [, , link] of page.matchAll(/<a\b[^>]*\shref\s*=\s*(["'])([^"']+)\1/gi)) {
            const target = absolute(link, url);
            if (target?.origin !== site || !target.pathname.startsWith('/episode/')) continue;
            const number = /-(?:episode|eps?)-(\d+)(?:-|\/)/i.exec(target.pathname)?.[1];
            if (Number(number) === request.episode) episodes.add(target.href);
        }
        return episodes.size === 1 ? [...episodes][0] : null;
    }));
    const unique = [...new Set(matches.filter(Boolean))];
    return unique.length === 1 ? unique[0] : null;
}

async function ajax(form, referer) {
    const body = Object.entries(form).map(([key, value]) => key + '=' + encodeURIComponent(value)).join('&');
    const data = await read(site + '/wp-admin/admin-ajax.php', 'json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest', Referer: referer },
        body,
    });
    return data?.data;
}

async function episodePlayers(html, referer) {
    const players = new Map();
    function add(source, quality) {
        const url = absolute(source, referer);
        if (url && playerHost.test(url.hostname) && (!players.has(url.href) || quality)) players.set(url.href, quality);
    }
    for (const url of frames(html)) add(url);
    const mirrors = [];
    for (const [, , value] of html.matchAll(/<a\b[^>]*\sdata-content\s*=\s*(["'])([a-z\d+/=]+)\1/gi)) {
        try {
            const { id, i, q } = JSON.parse(atob(value));
            if (Number.isSafeInteger(id) && Number.isSafeInteger(i) && /^\d{3,4}p$/.test(q)) mirrors.push({ id, i, q });
        } catch { continue; }
    }
    if (mirrors.length) {
        const nonce = await ajax({ action: 'aa1208d27f29ca340c92c66d1926f13f' }, referer).catch(() => null);
        if (typeof nonce === 'string' && nonce) {
            await Promise.all(mirrors.map(async mirror => {
                try {
                    const data = await ajax({ ...mirror, nonce, action: '2a3505c93b0035d3f455df82bf976b84' }, referer);
                    for (const url of frames(atob(data))) add(url, mirror.q);
                } catch { return; }
            }));
        }
    }
    return [...players];
}

async function mp4(url, headers, quality) {
    try {
        const response = await fetch(url, { headers: { ...headers, Range: 'bytes=0-1023' } });
        if (response.status !== 206) return null;
        const final = absolute(response.url || url);
        if (!final || !streamHost.test(final.hostname)) return null;
        const bytes = new DataView(await response.arrayBuffer());
        if (bytes.byteLength < 12 || bytes.getUint32(4) !== 0x66747970) return null;
        const length = Number(/\/(\d+)$/.exec(response.headers.get('content-range'))?.[1]);
        const size = length > 0 ? (length / 1000000).toFixed(length < 10000000 ? 1 : 0) + ' MB' : undefined;
        return { url, headers, type: 'mp4', quality, size };
    } catch {
        return null;
    }
}

async function extractPlayer(url, quality, referer) {
    try {
        const response = await fetch(url, { headers: { Referer: referer } });
        const player = absolute(response.url || url);
        if (!response.ok || !player || !playerHost.test(player.hostname)) return [];
        const html = await response.text();
        const headers = { Referer: player.href };
        const links = mediaLinks(html, player.href);
        const results = await Promise.all(links.map(link => {
            if (/\.m3u8(?:\?|$)/i.test(link)) return playlist(link, headers);
            const resolution = /(?:^|[\/_.-])(\d{3,4}p)\.mp4(?:\?|$)/i.exec(link)?.[1];
            return mp4(link, headers, resolution || quality);
        }));
        return results.filter(Boolean).map(stream => ({ ...stream, quality: stream.quality ?? quality }));
    } catch {
        return [];
    }
}

async function getStreams(contentId, mediaType, season, episode) {
    if (!['anime', 'series', 'tv'].includes(mediaType)) return [];
    try {
        const request = await identify(String(contentId), season, episode);
        if (!request) return [];
        const page = await episodePage(request);
        if (!page) return [];
        const html = await read(page, 'text');
        const players = await episodePlayers(html, page);
        const results = (await Promise.all(players.map(([url, quality]) => extractPlayer(url, quality, page)))).flat();
        const streams = [...new Map(results.map(stream => [stream.url, stream])).values()]
            .sort((a, b) => (parseInt(b.quality, 10) || 0) - (parseInt(a.quality, 10) || 0));
        const title = request.titles[0] + ' • ' + request.label;
        return streams.map((stream, index) => ({
            ...stream, name: streams.length === 1 ? 'Otakudesu' : 'Otakudesu · Link ' + (index + 1), title,
        }));
    } catch {
        return [];
    }
}

module.exports = { getStreams };
