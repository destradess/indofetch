const catalog = 'https://tv12.lk21official.cc';
const metadata = 'https://tmdb.elfhosted.com/meta/movie';
const player = 'https://videonode.de';
const playback = 'https://playcdn.de';

const movieSlugs = { '496243': 'parasite-gisaengchung-2019' };
const serverNames = { p2p: 'P2P', cast: 'Cast', hydrax: 'Hydrax' };
const hlsUrl = /^https:\/\/(?:[a-z\d-]+\.)+[a-z]{2,}\/[^\s"'<>]+\.m3u8(?:[?#][^\s"'<>]*)?$/i;
const playCdnSegment = /^https:\/\/(?:stream\.playcdn\.de|[a-z\d-]+\.qornexia\.xyz)\//i;

function readResponse(response, method) {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response[method]();
}

async function resolvePlayer(server, id, embed) {
    const response = await fetch(`${player}/api.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: embed },
        body: `host=${server}&id=${encodeURIComponent(id)}`,
    });
    const { embedUrl } = await readResponse(response, 'json');
    const publicEmbed = /^https:\/\/playcdn\.de\/([a-z\d_-]+)(?:[/?#]|$)/i.exec(embedUrl);
    if (publicEmbed) {
        const result = await fetch(`${playback}/verify/${publicEmbed[1]}`, { headers: { Referer: embedUrl } });
        const { fileUrl } = await readResponse(result, 'json');
        return typeof fileUrl === 'string' ? [{ url: fileUrl, headers: { Referer: `${playback}/` } }] : [];
    }

    // Only use media URLs exposed directly by the player's HTML.
    if (server !== 'hydrax' || !/^https:\/\/(?:play\.)?abyssplayer\.com\/[a-z\d_-]+(?:[/?#]|$)/i.test(embedUrl)) {
        return [];
    }
    const html = await fetch(embedUrl, { headers: { Referer: embed } }).then(result => readResponse(result, 'text'));
    const files = html.matchAll(/(?:<(?:video|source)\b[^>]*\ssrc\s*=|\bfile\s*:)\s*(["'])([^"']+)\1/gi);
    return Array.from(files, ([, , url]) => ({ url: url.replace(/&amp;/gi, '&'), headers: { Referer: embedUrl } }));
}

function transportTracks(bytes) {
    const tracks = new Map();
    for (let offset = 0; offset + 188 <= bytes.length; offset += 188) {
        if (bytes[offset] !== 0x47) break;
        const flags = bytes[offset + 3];
        if (!(flags & 0x10) || (flags & 0xc0)) continue;
        const pid = ((bytes[offset + 1] & 0x1f) << 8) | bytes[offset + 2];
        const end = offset + 188;
        let start = offset + 4;
        if (flags & 0x20) start += 1 + bytes[start];
        if (start >= end) continue;

        if (bytes[offset + 1] & 0x40) {
            if (start + 9 > end || bytes[start] !== 0 || bytes[start + 1] !== 0 || bytes[start + 2] !== 1) continue;
            const streamId = bytes[start + 3];
            start += 9 + bytes[start + 8];
            if (!tracks.has(pid)) tracks.set(pid, { streamId, payload: [] });
        }
        const track = tracks.get(pid);
        if (track) track.payload.push(...bytes.subarray(start, end));
    }
    return [...tracks.values()];
}

function avcQuality(payload) {
    const starts = [];
    for (let i = 0; i + 3 < payload.length; i++) {
        if (payload[i] === 0 && payload[i + 1] === 0 && payload[i + 2] === 1) starts.push(i + 3);
    }
    const index = starts.findIndex(start => (payload[start] & 0x1f) === 7);
    if (index < 0) return;

    const start = starts[index] + 1;
    const end = Math.min(starts[index + 1] ?? payload.length, start + 256);
    const data = [];
    for (let i = start; i < end; i++) {
        if (i > start + 1 && payload[i] === 3 && payload[i - 1] === 0 && payload[i - 2] === 0) continue;
        data.push(payload[i]);
    }
    let offset = 0;
    function bits(count) {
        if (offset + count > data.length * 8) throw new Error('Incomplete AVC sequence header');
        let value = 0;
        for (let i = 0; i < count; i++, offset++) {
            value = value * 2 + ((data[offset >> 3] >> (7 - (offset & 7))) & 1);
        }
        return value;
    }
    function unsigned() {
        let zeros = 0;
        while (!bits(1)) {
            if (++zeros > 30) throw new Error('Invalid AVC sequence header');
        }
        return 2 ** zeros - 1 + bits(zeros);
    }
    function signed() {
        const code = unsigned();
        return code % 2 ? (code + 1) / 2 : -code / 2;
    }

    const profile = bits(8);
    bits(16);
    unsigned();
    let chroma = 1;
    if ([44, 83, 86, 100, 110, 118, 122, 128, 134, 135, 138, 139, 144, 244].includes(profile)) {
        chroma = unsigned();
        if (chroma === 3) bits(1);
        unsigned();
        unsigned();
        bits(1);
        if (bits(1)) {
            const lists = chroma === 3 ? 12 : 8;
            for (let i = 0; i < lists; i++) {
                if (!bits(1)) continue;
                let last = 8;
                let next = 8;
                const count = i < 6 ? 16 : 64;
                for (let j = 0; j < count; j++) {
                    if (next) next = (last + signed() + 256) % 256;
                    last = next || last;
                }
            }
        }
    }
    unsigned();
    const pictureOrder = unsigned();
    if (pictureOrder === 0) {
        unsigned();
    } else if (pictureOrder === 1) {
        bits(1);
        signed();
        signed();
        const count = unsigned();
        if (count > 255) return;
        for (let i = 0; i < count; i++) signed();
    }
    unsigned();
    bits(1);
    unsigned();
    const rows = unsigned() + 1;
    const progressive = bits(1);
    if (!progressive) bits(1);
    bits(1);
    let croppedRows = 0;
    if (bits(1)) {
        unsigned();
        unsigned();
        croppedRows = unsigned() + unsigned();
    }
    const fieldFactor = progressive ? 1 : 2;
    const height = fieldFactor * (rows * 16 - croppedRows * (chroma === 1 ? 2 : 1));
    if (height >= 144 && height <= 8640) return String(height) + (progressive ? 'p' : '');
}

function adtsChannels(payload) {
    function isHeader(offset) {
        return offset + 7 <= payload.length && payload[offset] === 0xff && (payload[offset + 1] & 0xf6) === 0xf0;
    }
    for (let i = 0; i + 7 < payload.length; i++) {
        if (!isHeader(i)) continue;
        const length = ((payload[i + 3] & 3) << 11) | (payload[i + 4] << 3) | (payload[i + 5] >> 5);
        if (length >= 7 && isHeader(i + length)) {
            return ((payload[i + 2] & 1) << 2) | (payload[i + 3] >> 6);
        }
    }
    return -1;
}

async function playlistMetadata(link, playlistUrl, playlist) {
    const variants = [...playlist.matchAll(/^#EXT-X-STREAM-INF:.*\bRESOLUTION=\d+x(\d+)/gm)];
    if (variants.length) return { quality: Math.max(...variants.map(match => Number(match[1]))) + 'p' };
    if (!playlistUrl.startsWith('https://stream.playcdn.de/') || playlist.includes('#EXT-X-KEY:')) return {};

    try {
        const firstSegment = playlist.split(/\r?\n/).map(line => line.trim()).find(line => line && !line.startsWith('#'));
        if (!firstSegment) return {};
        const segment = new URL(firstSegment, playlistUrl);
        if (!playCdnSegment.test(segment.href)) return {};
        const response = await fetch(segment.href, {
            redirect: 'manual',
            headers: { ...link.headers, Range: 'bytes=0-32767' },
        });
        if (response.status !== 206) return {};

        const bytes = new Uint8Array(await response.arrayBuffer());
        const tracks = transportTracks(bytes.subarray(0, 32768));
        const video = tracks.find(track => (track.streamId & 0xf0) === 0xe0);
        const audio = tracks.find(track => (track.streamId & 0xe0) === 0xc0);
        const quality = video ? avcQuality(video.payload) : undefined;
        const channels = audio ? adtsChannels(audio.payload) : -1;
        const audioLabel = { 1: 'AAC mono', 2: 'AAC 2.0', 6: 'AAC 5.1', 7: 'AAC 7.1' }[channels];
        return {
            quality,
            details: [quality ? 'H.264' : null, channels >= 0 ? audioLabel ?? 'AAC' : null].filter(Boolean),
        };
    } catch {
        return {};
    }
}

async function findPlaylists(page) {
    const players = new Map();
    const tabs = page.matchAll(/\bdata-url\s*=\s*(["'])(https:\/\/videonode\.de\/iframe3\/(p2p|cast|hydrax)\/([a-z\d_-]+))\1/gi);
    for (const [, , embed, server, id] of tabs) {
        players.set(embed, { embed, server: server.toLowerCase(), id });
    }
    const groups = await Promise.all([...players.values()].map(async ({ embed, server, id }) => {
        const links = await resolvePlayer(server, id, embed).catch(() => []);
        return links.filter(link => hlsUrl.test(link.url)).map(link => ({ ...link, server }));
    }));
    const checked = await Promise.all(groups.flat().map(async link => {
        try {
            const response = await fetch(link.url, { headers: link.headers });
            const playlist = await readResponse(response, 'text');
            if (!/^\s*#EXTM3U\b/.test(playlist)) return null;
            return { ...link, ...await playlistMetadata(link, response.url || link.url, playlist) };
        } catch {
            return null;
        }
    }));
    const unique = new Map();
    for (const link of checked) {
        if (link && !unique.has(link.url)) unique.set(link.url, link);
    }
    return [...unique.values()];
}

function getStreams(tmdbId, mediaType) {
    const id = String(tmdbId);
    if (mediaType !== 'movie' || !/^\d+$/.test(id)) return Promise.resolve([]);

    return fetch(`${metadata}/tmdb:${id}.json`).then(response => readResponse(response, 'json'))
        .then(({ meta }) => {
            const title = meta?.name;
            const year = String(meta?.year ?? meta?.releaseInfo ?? '').slice(0, 4);
            if (typeof title !== 'string' || !/^\d{4}$/.test(year)) return [];

            const slugTitle = title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
                .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            const slug = movieSlugs[id] ?? `${slugTitle}-${year}`;
            if (!slugTitle) return [];

            return fetch(`${catalog}/${slug}`).then(response => readResponse(response, 'text'))
                .then(findPlaylists).then(links => links.map(({ server, url, headers, quality, details = [] }, index) => ({
                    name: links.length === 1 ? 'LK21' : `LK21 · ${serverNames[server]} ${index + 1}`,
                    title: [`${title} (${year})`, ...details].join(' • '), url, provider: 'LK21', type: 'hls', headers, quality,
                })));
        }).catch(() => []);
}

module.exports = { getStreams };
