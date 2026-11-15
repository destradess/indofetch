const catalog = 'https://tv12.lk21official.cc';
const metadata = 'https://tmdb.elfhosted.com/meta/movie';
const player = 'https://videonode.de';
const playback = 'https://playcdn.de';

const movieSlugs = { '496243': 'parasite-gisaengchung-2019' };
const serverNames = { p2p: 'P2P', cast: 'Cast', hydrax: 'Hydrax' };
const hlsUrl = /^https:\/\/(?:[a-z\d-]+\.)+[a-z]{2,}\/[^\s"'<>]+\.m3u8(?:[?#][^\s"'<>]*)?$/i;

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
            return /^\s*#EXTM3U\b/.test(playlist) ? link : null;
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
                .then(findPlaylists).then(links => links.map(({ server, url, headers }, index) => ({
                    name: links.length === 1 ? 'LK21' : `LK21 · ${serverNames[server]} ${index + 1}`,
                    title: `${title} (${year})`, url, provider: 'LK21', type: 'hls', headers,
                })));
        }).catch(() => []);
}

module.exports = { getStreams };
