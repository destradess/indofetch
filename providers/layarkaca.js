const catalog = 'https://tv12.lk21official.cc';
const metadata = 'https://tmdb.elfhosted.com/meta/movie';
const player = 'https://videonode.de';
const playback = 'https://playcdn.de';

const movieSlugs = { '496243': 'parasite-gisaengchung-2019' };

function readResponse(response, method) {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response[method]();
}

function findPlaylist(page) {
    const match = page.match(/\bdata-url="https:\/\/videonode\.de\/iframe3\/p2p\/([a-z\d_-]+)"/i);
    if (!match) return null;

    const id = match[1];
    const embed = `${player}/iframe3/p2p/${id}`;
    return fetch(`${player}/api.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: embed },
        body: `host=p2p&id=${encodeURIComponent(id)}`,
    }).then(response => readResponse(response, 'json')).then(result => {
        const publicEmbed = /^https:\/\/playcdn\.de\/([a-z\d_-]+)(?:[/?#]|$)/i.exec(result?.embedUrl);
        if (!publicEmbed) return null;
        return fetch(`${playback}/verify/${publicEmbed[1]}`, {
            headers: { Referer: result.embedUrl },
        }).then(response => readResponse(response, 'json'));
    });
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
                .then(findPlaylist).then(result => {
                    const url = result?.fileUrl;
                    if (typeof url !== 'string' || !/^https:\/\/[^\s]+\.m3u8(?:[?#][^\s]*)?$/i.test(url)) return [];
                    return [{ name: 'LK21', title: `${title} (${year})`, url, provider: 'LK21',
                        headers: { Referer: `${playback}/` } }];
                });
        }).catch(() => []);
}

module.exports = { getStreams };
