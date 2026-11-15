const catalog = 'https://aubergedelavenir.com';
const metadata = 'https://tmdb.elfhosted.com/meta/movie';
const playerHosts = new Set([
    'bingezove.com', 'callistanise.com', 'dingtezuni.com', 'embedfirex.xyz',
    'embedpyrox.xyz', 'minochinos.com', 'morencius.com', 'ryderjet.com', 'vidhidepro.com',
]);
const mediaHost = /^(?:callistanise\.com|[a-z\d-]+\.(?:dramiyos-cdn|acek-cdn)\.com)$/i;

function httpsUrl(value, base) {
    try {
        const decoded = value.replace(/&amp;/gi, '&');
        const url = new URL(decoded.startsWith('//') ? 'https:' + decoded : decoded, base);
        if (/^https:\/\/[a-z\d.-]+(?:[/?#]|$)/i.test(url.href)) return url;
    } catch {
        return null;
    }
    return null;
}

async function readPage(url, referer) {
    try {
        const response = await fetch(url, referer ? { headers: { Referer: referer } } : undefined);
        if (response.ok) return { url: response.url || url, html: await response.text() };
    } catch {
        return null;
    }
    return null;
}

function findMovie(page, title, year) {
    const slug = title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/[^a-z\d]+/g, '-').replace(/^-|-$/g, '');
    if (!slug) return null;

    const base = httpsUrl(page.url);
    if (!base) return null;
    const path = '/' + slug + '-' + year;
    const results = page.html.matchAll(/<h2\b[^>]*>\s*<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/gi);
    for (const result of results) {
        const url = httpsUrl(result[2], page.url);
        if (url?.origin === base.origin && !url.search && url.pathname.replace(/\/$/, '') === path) {
            return url.href;
        }
    }
    return null;
}

function playerTabs(page) {
    const base = httpsUrl(page.url);
    if (!base) return [];
    const players = new Set();
    for (const [, , href] of page.html.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])([^"']+)\1/gi)) {
        const tab = httpsUrl(href.startsWith('?') ? base.pathname + href : href, page.url);
        if (tab?.origin !== base.origin || tab.pathname !== base.pathname) continue;
        const number = /(?:^\?|&)player=([1-9]\d?)(?:&|$)/.exec(tab.search)?.[1];
        if (number) players.add(base.origin + base.pathname + '?player=' + number);
    }
    return [...players];
}

function unpackPlayer(html) {
    // Read the packed JW Player text without running code from the embed page.
    const packed = /\breturn p\s*}\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(['"])([^'"]*)\5\.split\(['"]\|['"]\)/.exec(html);
    if (!packed) return '';

    const radix = Number(packed[3]);
    const words = packed[6].split('|');
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

function playlistMetadata(playlist) {
    const variants = [];
    const audioTracks = [];

    for (const line of playlist.split(/\r?\n/)) {
        const tag = /^#EXT-X-(STREAM-INF|MEDIA):(.*)$/.exec(line);
        if (!tag) continue;
        const attributes = Object.fromEntries(Array.from(
            tag[2].matchAll(/(?:^|,)([\w-]+)=(?:"([^"]*)"|([^,]*))/g),
            ([, key, quoted, unquoted]) => [key, quoted ?? unquoted],
        ));
        if (tag[1] === 'MEDIA') {
            if (attributes.TYPE === 'AUDIO') audioTracks.push(attributes);
            continue;
        }
        const height = Number(/^\d+x(\d+)$/.exec(attributes.RESOLUTION)?.[1]) || 0;
        variants.push({ height, attributes });
    }

    variants.sort((a, b) => b.height - a.height || Number(b.attributes.BANDWIDTH) - Number(a.attributes.BANDWIDTH));
    const best = variants[0];
    if (!best) return {};
    const attributes = best.attributes;
    const codecs = (attributes.CODECS ?? '').toLowerCase().split(',').map(codec => codec.trim());
    const video = codecs.find(codec => /^(?:avc[13]|hvc1|hev1|av01|vp09)\./.test(codec))?.split('.')[0];
    const videoLabel = { avc1: 'H.264', avc3: 'H.264', hvc1: 'HEVC', hev1: 'HEVC', av01: 'AV1', vp09: 'VP9' }[video];
    const range = { SDR: 'SDR', PQ: 'HDR (PQ)', HLG: 'HDR (HLG)' }[attributes['VIDEO-RANGE']];
    const tracks = audioTracks.filter(track => track['GROUP-ID'] === attributes.AUDIO);
    const languages = [...new Set(tracks.map(track => track.LANGUAGE).filter(code => /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(code)))];
    const channels = tracks.length && tracks.every(track => track.CHANNELS === '2') ? ' 2.0' : '';
    const audio = codecs.some(codec => /^mp4a\.40\./.test(codec)) ? 'AAC' + channels : null;

    return {
        quality: best.height ? best.height + 'p' : undefined,
        language: languages.length ? languages.join(' / ') : undefined,
        details: [videoLabel, range, audio].filter(Boolean),
    };
}

async function getPlaylists(embed, referer) {
    const page = await readPage(embed, referer);
    if (!page || !playerHosts.has(httpsUrl(page.url)?.hostname)) return [];

    const candidates = new Set();
    const content = page.html + '\n' + unpackPlayer(page.html);
    for (const [, , value] of content.matchAll(/(["'])([^"'<>\s]+\.m3u8(?:\?[^"'<>\s]*)?)\1/gi)) {
        const url = httpsUrl(value, page.url);
        if (url && mediaHost.test(url.hostname)) candidates.add(url.href);
    }

    const checks = await Promise.all([...candidates].map(async url => {
        const playlist = await readPage(url, page.url);
        if (playlist && /^\s*#EXTM3U\b/.test(playlist.html)) {
            return { url, headers: { Referer: page.url }, ...playlistMetadata(playlist.html) };
        }
        return null;
    }));
    return checks.filter(Boolean);
}

async function streamsFromPage(page) {
    if (!page) return [];
    const embeds = new Set();
    for (const [, , value] of page.html.matchAll(/<iframe\b[^>]*\ssrc\s*=\s*(["'])([^"']+)\1/gi)) {
        const url = httpsUrl(value, page.url);
        if (url && playerHosts.has(url.hostname)) embeds.add(url.href);
    }
    return (await Promise.all([...embeds].map(url => getPlaylists(url, page.url)))).flat();
}

async function getStreams(tmdbId, mediaType) {
    const id = String(tmdbId);
    if (mediaType !== 'movie' || !/^\d+$/.test(id)) return [];

    try {
        const response = await fetch(metadata + '/tmdb:' + id + '.json');
        if (!response.ok) return [];
        const { meta } = await response.json();
        const title = meta?.name;
        const year = String(meta?.year ?? meta?.releaseInfo ?? '').slice(0, 4);
        if (typeof title !== 'string' || !/^\d{4}$/.test(year)) return [];

        const search = await readPage(catalog + '/?s=' + encodeURIComponent(title) + '&post_type%5B%5D=post');
        const movie = search && findMovie(search, title, year);
        const page = movie && await readPage(movie, search.url);
        if (!page) return [];

        const alternates = playerTabs(page).map(async url => streamsFromPage(await readPage(url, page.url)));
        const groups = await Promise.all([streamsFromPage(page), ...alternates]);
        const streams = new Map();
        for (const { url, headers, quality, language, details = [] } of groups.flat()) {
            if (!streams.has(url)) {
                const displayTitle = [title + ' (' + year + ')', ...details].join(' • ');
                streams.set(url, { name: 'Dutamovie', title: displayTitle, url, type: 'hls', headers, quality, language });
            }
        }
        const results = [...streams.values()];
        return results.length < 2 ? results : results.map((stream, index) => ({
            ...stream,
            name: 'Dutamovie · Link ' + (index + 1),
        }));
    } catch {
        return [];
    }
}

module.exports = { getStreams };
