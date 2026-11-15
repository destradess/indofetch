const site = 'https://nontonanime.id';
const metadata = 'https://tmdb.elfhosted.com/meta/series';
const animeMappings = 'https://api.ani.zip/mappings';
const player = 'https://yoredesu.blogspot.com/';
const mediaUrl = /^https:\/\/(?:storage\.animekita\.org|mystorageindo\.com)\/[^\s"'<>]+\.mp4(?:\?[^\s"'<>]*)?$/i;

async function read(url, method) {
    const response = await fetch(url);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response[method]();
}

function normalize(title) {
    return title.normalize('NFKD').toLowerCase().replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z\d]+/g, ' ').trim();
}

function sameTitle(left, right) {
    return left.replace(/ /g, '') === right.replace(/ /g, '');
}

function unqualifiedTitle(title) {
    return title.replace(/\s+\((?:19|20)\d{2}\)\s*$/, '').trim();
}

function titleKey(title) {
    return normalize(unqualifiedTitle(title)).replace(/ s ?(\d+)$/, ' season $1');
}

async function searchTitles(titles) {
    const names = titles.flatMap(title => [title, ...title.split(':')]).map(unqualifiedTitle);
    const strong = names.map(titleKey);
    const aliases = [...new Set(strong.map(title => title.replace(/ season \d+$/, '')).filter(value => value.length >= 3))];
    const queries = new Map();
    const compact = aliases.filter(value => value.split(' ').length <= 3).map(value => value.replace(/ /g, ''));
    for (const query of [...names, ...aliases, ...compact]) {
        const key = query.toLowerCase();
        if (key && !queries.has(key)) queries.set(key, query);
    }
    const results = await Promise.all([...queries.values()].map(query =>
        read(site + '/live-search?q=' + encodeURIComponent(query), 'json').catch(() => null)));
    const entries = new Map();
    for (const response of results) {
        if (!Array.isArray(response?.data)) continue;
        for (const entry of response.data) {
            if (entry.type !== 'tv' || typeof entry.title !== 'string' ||
                !/^[a-z\d]+(?:-[a-z\d]+)*$/.test(entry.slug)) continue;
            const title = titleKey(entry.title);
            const base = title.replace(/ season \d+$/, '');
            const exact = aliases.some(alias => sameTitle(base, alias));
            const related = exact || aliases.some(alias => (' ' + base + ' ').includes(' ' + alias + ' '));
            if (related) entries.set(entry.slug, {
                ...entry, exact, titleSeason: Number(/ season (\d+)$/.exec(title)?.[1]),
                fullMatch: strong.some(name => sameTitle(title, name)),
            });
        }
    }
    return [...entries.values()];
}

async function findEpisode(meta, season, episode) {
    const seasons = new Map();
    for (const video of meta.videos ?? []) {
        if (!Number.isInteger(video.season) || video.season < 1 ||
            !Number.isInteger(video.episode) || video.episode < 1) continue;
        if (!seasons.has(video.season)) seasons.set(video.season, new Map());
        seasons.get(video.season).set(video.episode, video);
    }
    const ordered = [...seasons.entries()].sort(([left], [right]) => left - right);
    const contiguous = ordered.every(([key, videos], index) =>
        key === index + 1 && [...videos.keys()].every(number => number <= videos.size));
    if (season === null) {
        if (!contiguous) return null;
        for (const [key, videos] of ordered) {
            if (episode <= videos.size) {
                season = key;
                break;
            }
            episode -= videos.size;
        }
    }
    const current = seasons.get(season);
    if (!current?.has(episode)) return null;
    const premiereYear = value => Number(String(value?.get(1)?.released ?? '').slice(0, 4));
    const year = premiereYear(current);
    if (!year) return null;

    const matches = await searchTitles([meta.name]);
    const sameYear = matches.filter(entry => Number(entry.release_year) === year &&
        Number(entry.episodes) >= episode && (!entry.titleSeason || entry.titleSeason === season));
    const numbered = sameYear.filter(entry => entry.titleSeason === season);
    const exact = sameYear.filter(entry => entry.exact);
    const sharedYear = [...seasons.values()].filter(value => premiereYear(value) === year).length > 1;
    const candidates = numbered.length ? numbered : sharedYear && season !== 1 ? [] :
        exact.length ? exact : sameYear;
    const coordinates = 'S' + String(season).padStart(2, '0') + 'E' + String(episode).padStart(2, '0');
    if (candidates.length === 1) return { entry: candidates[0], number: episode, coordinates };
    if (candidates.length > 1 || season === 1) return null;

    // Some titles use one continuous episode list even when TMDB splits seasons.
    if (!contiguous) return null;
    const total = ordered.reduce((count, [, videos]) => count + videos.size, 0);
    const combined = matches.filter(entry => entry.exact && !entry.titleSeason &&
        Number(entry.release_year) === premiereYear(seasons.get(1)) && Number(entry.episodes) === total);
    if (combined.length !== 1) return null;
    const previous = ordered.filter(([key]) => key < season).reduce((count, [, videos]) => count + videos.size, 0);
    return { entry: combined[0], number: previous + episode, coordinates };
}

async function findTrackerEpisode(idType, id, episode) {
    const key = idType + '_id';
    const data = await read(animeMappings + '?' + key + '=' + id, 'json');
    if (data.mappings?.type !== 'TV' || Number(data.mappings[key]) !== Number(id) ||
        !data.episodes?.[episode]) return null;
    const titles = [data.titles?.en, data.titles?.['x-jat']].filter(value => typeof value === 'string' && value.trim());
    const year = Number(String(data.episodes[1]?.airDate ?? data.episodes[1]?.airdate ?? '').slice(0, 4));
    if (!titles.length || !year) return null;
    const candidates = (await searchTitles(titles)).filter(entry =>
        Number(entry.release_year) === year && Number(entry.episodes) >= episode);
    const exact = candidates.filter(entry => entry.fullMatch);
    const matching = exact.length ? exact : candidates;
    if (matching.length !== 1) return null;
    return { entry: matching[0], number: episode, coordinates: 'E' + String(episode).padStart(2, '0'), title: titles[0] };
}

function decodeBase64(value) {
    const encoded = decodeURIComponent(value).replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/');
    if (!/^[a-z\d+/]{1,65536}={0,2}$/i.test(encoded)) throw new Error('Invalid player data');
    return atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '='));
}

function mirrorLinks(html) {
    const links = new Map();
    function add(url, referer, label) {
        if (typeof url !== 'string' || !mediaUrl.test(url)) return;
        const quality = typeof label === 'string' ? /^\s*(\d{3,4}p)\s*$/i.exec(label)?.[1]?.toLowerCase() : undefined;
        if (!links.has(url) || quality) links.set(url, { url, referer, quality });
    }

    const attributes = html.matchAll(/<(?:iframe|button|a)\b[^>]*\s(?:src|data-url)\s*=\s*(["'])([^"']+)\1/gi);
    for (const [, , raw] of attributes) {
        try {
            let target = raw.replace(/&amp;/gi, '&');
            for (let depth = 0; depth < 2; depth++) {
                const wrapped = /^(?:https:\/\/nontonanime\.id)?\/stream\/(?:v2\/)?([^?#]+)$/i.exec(target);
                if (!wrapped) break;
                target = decodeBase64(wrapped[1].replace(/\/$/, '')).trim();
            }
            if (target.startsWith(player + '?')) {
                const query = new URL(target).searchParams;
                if (query.get('type') !== 'multi') continue;
                const mirrors = JSON.parse(decodeBase64(query.get('link') ?? ''));
                if (Array.isArray(mirrors)) {
                    for (const mirror of mirrors) add(mirror?.url, player, mirror?.html);
                }
            } else {
                add(target, site + '/');
            }
        } catch {
            continue;
        }
    }
    return [...links.values()];
}

function mp4Height(bytes) {
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
    if (!moov) return 0;
    for (const track of boxes(moov.start, Math.min(moov.end, bytes.byteLength), 0x7472616b)) {
        const trackEnd = Math.min(track.end, moov.end, bytes.byteLength);
        const header = boxes(track.start, trackEnd, 0x746b6864)[0];
        if (!header || header.end > trackEnd) continue;
        const version = bytes.getUint8(header.start);
        if (header.end - header.start !== (version === 0 ? 84 : version === 1 ? 96 : 0)) continue;
        const width = bytes.getUint32(header.end - 8) >>> 16;
        const height = bytes.getUint32(header.end - 4) >>> 16;
        if (width >= 144 && height >= 144 && height <= 8640) return height;
    }
    return 0;
}

async function validateMirror({ url, referer, quality }, title) {
    const headers = { Referer: referer };
    try {
        const response = await fetch(url, { redirect: 'manual', headers: { ...headers, Range: 'bytes=0-16383' } });
        if (response.status !== 206) return null;
        const bytes = new DataView(await response.arrayBuffer());
        if (bytes.byteLength < 12 || bytes.getUint32(4) !== 0x66747970) return null;
        const height = mp4Height(bytes);
        const total = Number(/\/(\d+)$/.exec(response.headers.get('Content-Range'))?.[1]);
        return {
            name: 'NontonAnimeID', title, url, type: 'mp4', headers,
            quality: height ? height + 'p' : quality,
            size: total > 0 ? (total / 1000000).toFixed(total < 10000000 ? 1 : 0) + ' MB' : undefined,
        };
    } catch {
        return null;
    }
}

async function getStreams(tmdbId, mediaType, season, episode) {
    const id = String(tmdbId).trim();
    const tracker = /^(kitsu|anilist|mal):(\d+)(?::(\d+))?$/i.exec(id);
    const catalogId = /^(?:tmdb[:/])?(tt\d+|\d+)$/i.exec(id)?.[1]?.toLowerCase();
    episode = Number(tracker?.[3] ?? episode);
    if ((!tracker && !catalogId) || !['series', 'tv', 'anime'].includes(mediaType) ||
        !Number.isInteger(episode) || episode < 1) return [];

    try {
        let match;
        if (tracker) {
            match = await findTrackerEpisode(tracker[1].toLowerCase(), tracker[2], episode);
        } else {
            season = season == null ? null : Number(season);
            if (season !== null && (!Number.isInteger(season) || season < 1)) return [];
            const key = catalogId.startsWith('tt') ? catalogId : 'tmdb:' + catalogId;
            const { meta } = await read(metadata + '/' + key + '.json', 'json');
            if (typeof meta?.name !== 'string' || !meta.genres?.includes('Animation')) return [];
            const episodeMatch = await findEpisode(meta, season, episode);
            if (episodeMatch) match = { ...episodeMatch, title: meta.name };
        }
        if (!match) return [];
        const path = '/' + match.entry.slug + '-episode-' + match.number;
        const response = await fetch(site + path);
        const resolved = new URL(response.url || site + path);
        if (!response.ok || resolved.origin !== site || resolved.pathname.replace(/\/$/, '') !== path) return [];
        const page = await response.text();
        const heading = /<h1\b[^>]*>\s*([^<]+?)\s*<\/h1>/i.exec(page)?.[1];
        if (!heading || !sameTitle(normalize(heading.replace(/&amp;/gi, '&')), normalize(match.entry.title))) return [];

        const title = match.title + ' • ' + match.coordinates;
        const streams = await Promise.all(mirrorLinks(page).map(mirror => validateMirror(mirror, title)));
        return streams.filter(Boolean).sort((left, right) => (parseInt(right.quality, 10) || 0) - (parseInt(left.quality, 10) || 0));
    } catch {
        return [];
    }
}

module.exports = { getStreams };
