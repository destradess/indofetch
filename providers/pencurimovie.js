const site = 'https://ww44.pencurimovie.baby';
const metadata = 'https://tmdb.elfhosted.com/meta/movie';
const playerHost = /^(?:jodwish\.com|sfastwish\.com|wishonly\.site|swdyu\.com)$/i;
const streamHost = /^(?:jodwish\.com|sfastwish\.com|wishonly\.site|swdyu\.com|[a-z\d-]+\.cdn-centaurus\.com)$/i;

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

function slug(title) {
    return title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/[^a-z\d]+/g, '-').replace(/^-|-$/g, '');
}

async function fromPlayer(url, referer) {
    try {
        const response = await fetch(url, { headers: { Referer: referer } });
        const player = absolute(response.url || url);
        if (!response.ok || !player || !playerHost.test(player.hostname)) return [];
        const html = await response.text();
        const links = mediaLinks(html, player.href).filter(link => /\.m3u8(?:\?|$)/i.test(link));
        return (await Promise.all(links.map(link => playlist(link, { Referer: player.href })))).filter(Boolean);
    } catch {
        return [];
    }
}

async function streamsFromFrames(html, page, name, title) {
    const embeds = new Set();
    for (const source of frames(html)) {
        const embed = absolute(source, page);
        if (embed && playerHost.test(embed.hostname)) embeds.add(embed.href);
    }
    const results = (await Promise.all([...embeds].map(url => fromPlayer(url, page)))).flat();
    const streams = [...new Map(results.map(stream => [stream.url, stream])).values()];
    return streams.map((stream, index) => ({
        ...stream, name: streams.length === 1 ? name : name + ' · Link ' + (index + 1), title,
    }));
}

async function getStreams(contentId, mediaType) {
    const id = /^(?:tmdb[:/])?(tt\d+|\d+)$/i.exec(String(contentId))?.[1]?.toLowerCase();
    if (!id || mediaType !== 'movie') return [];

    try {
        const key = id.startsWith('tt') ? id : 'tmdb:' + id;
        const { meta } = await read(metadata + '/' + key + '.json', 'json');
        const year = String(meta?.year ?? meta?.releaseInfo ?? '').slice(0, 4);
        if (typeof meta?.name !== 'string' || !/^\d{4}$/.test(year)) return [];
        const movie = slug(meta.name);
        if (!movie) return [];

        const page = site + '/' + movie + '-' + year + '/';
        const html = await read(page, 'text');
        return streamsFromFrames(html, page, 'Pencurimovie', meta.name + ' (' + year + ')');
    } catch {
        return [];
    }
}

module.exports = { getStreams };
