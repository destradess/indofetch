const site = 'https://www.dubbindo.site';
const metadata = 'https://tmdb.elfhosted.com/meta/movie';
const mediaHost = 'stream.dubbindo.site';
const deliveryHosts = new Set([
    mediaHost,
    'uvideoweb.s3.ap-southeast-1.wasabisys.com',
    'autumn-sea-3dce.monetag-447.workers.dev',
]);

function absolute(value, base) {
    try {
        const decoded = value.replace(/&amp;/gi, '&');
        const url = new URL(decoded.startsWith('//') ? 'https:' + decoded : decoded, base);
        if (/^https:\/\/[a-z\d.-]+\//i.test(url.href)) return url;
    } catch {
        return null;
    }
    return null;
}

function attribute(tag, key) {
    const match = new RegExp('\\s' + key + '\\s*=\\s*(["\'])(.*?)\\1', 'i').exec(tag);
    return match?.[2] ?? '';
}

function slug(title) {
    return title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/[^a-z\d]+/g, '-').replace(/^-|-$/g, '');
}

function filmKey(title) {
    return slug(title).replace(/-(?:dubbing|dubbed|dub)-(?:indonesia|indo)(?:-(?:hd|\d{3,4}p))?$/i, '');
}

function findWatchPages(html, title, year) {
    const key = slug(title);
    const pages = new Set();
    for (const [, , href] of html.matchAll(/<a\b[^>]*\shref\s*=\s*(["'])([^"']+)\1/gi)) {
        const url = absolute(href, site + '/');
        if (url?.origin !== site) continue;
        const match = /^\/watch\/([^/]+)_[a-z\d]+\.html$/i.exec(url.pathname);
        if (!match) continue;
        const name = filmKey(decodeURIComponent(match[1]));
        if (name === key || name === key + '-' + year) pages.add(url.origin + url.pathname);
    }
    return [...pages];
}

function mp4Quality(bytes) {
    function boxes(start, limit, type) {
        const matches = [];
        for (let offset = start; offset + 8 <= limit;) {
            const size = bytes.getUint32(offset);
            if (size < 8) break;
            const end = offset + size;
            if (bytes.getUint32(offset + 4) === type) matches.push({ start: offset + 8, end });
            offset = end;
        }
        return matches;
    }

    const moov = boxes(0, bytes.byteLength, 0x6d6f6f76)[0];
    if (!moov) return;
    for (const track of boxes(moov.start, Math.min(moov.end, bytes.byteLength), 0x7472616b)) {
        const limit = Math.min(track.end, moov.end, bytes.byteLength);
        const header = boxes(track.start, limit, 0x746b6864)[0];
        if (!header || header.end > limit || header.start >= header.end) continue;
        const version = bytes.getUint8(header.start);
        if (header.end - header.start !== (version === 0 ? 84 : version === 1 ? 96 : 0)) continue;
        const width = bytes.getUint32(header.end - 8) >>> 16;
        const height = bytes.getUint32(header.end - 4) >>> 16;
        if (width >= 144 && height >= 144 && height <= 8640) return height + 'p';
    }
}

async function probe(url) {
    const headers = { Referer: site + '/' };
    try {
        const response = await fetch(url, { headers: { ...headers, Range: 'bytes=0-16383' } });
        const final = absolute(response.url || url);
        if (response.status !== 206 || !final || !deliveryHosts.has(final.hostname)) return null;
        const bytes = new DataView(await response.arrayBuffer());
        if (bytes.byteLength < 12 || bytes.getUint32(4) !== 0x66747970) return null;
        const length = Number(/\/(\d+)$/.exec(response.headers.get('content-range'))?.[1]);
        return {
            url, headers, type: 'mp4', language: 'id', quality: mp4Quality(bytes),
            size: length > 0 ? (length / 1000000).toFixed(length < 10000000 ? 1 : 0) + ' MB' : undefined,
        };
    } catch {
        return null;
    }
}

async function findVideoSources(page, title, year) {
    try {
        const response = await fetch(page);
        if (!response.ok) return [];
        const html = await response.text();
        const property = [...html.matchAll(/<meta\b[^>]*>/gi)].map(match => match[0])
            .find(tag => attribute(tag, 'property').toLowerCase() === 'og:title');
        const publishedTitle = property ? attribute(property, 'content').replace(/&amp;/gi, '&') : '';
        if (!/\b(?:dubbing|dubbed|dub)\s+(?:indonesia|indo)\b/i.test(publishedTitle) ||
            filmKey(publishedTitle) !== slug(title) + '-' + year) return [];

        const sources = [];
        for (const [video] of html.matchAll(/<video\b[^>]*>[\s\S]*?<\/video>/gi)) {
            for (const [tag] of video.matchAll(/<(?:video|source)\b[^>]*>/gi)) {
                const url = absolute(attribute(tag, 'src'), page);
                if (url?.hostname === mediaHost && /\.mp4$/i.test(url.pathname)) sources.push(url.href);
            }
        }
        return sources;
    } catch {
        return [];
    }
}

async function getStreams(contentId, mediaType) {
    const id = /^(?:tmdb[:/])?(tt\d+|\d+)$/i.exec(String(contentId))?.[1]?.toLowerCase();
    if (!id || mediaType !== 'movie') return [];

    try {
        const response = await fetch(metadata + '/' + (id.startsWith('tt') ? id : 'tmdb:' + id) + '.json');
        if (!response.ok) return [];
        const { meta } = await response.json();
        const year = String(meta?.year ?? meta?.releaseInfo ?? '').slice(0, 4);
        if (typeof meta?.name !== 'string' || !/^\d{4}$/.test(year) || !slug(meta.name)) return [];
        const search = await fetch(site + '/search?keyword=' + encodeURIComponent(meta.name));
        if (!search.ok) return [];
        const pages = findWatchPages(await search.text(), meta.name, year);
        const links = new Set((await Promise.all(pages.map(page => findVideoSources(page, meta.name, year)))).flat());
        const streams = (await Promise.all([...links].map(probe))).filter(Boolean);
        return streams.map((stream, index) => ({
            ...stream,
            name: streams.length === 1 ? 'Dubbindo' : 'Dubbindo · Link ' + (index + 1),
            title: meta.name + ' (' + year + ') • Dubbing Indonesia',
        }));
    } catch {
        return [];
    }
}

module.exports = { getStreams };
