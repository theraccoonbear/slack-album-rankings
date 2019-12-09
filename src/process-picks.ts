import yargs from 'yargs';
import fetch from 'node-fetch';
import XLSX from 'xlsx';
import unidecode from 'unidecode';
import { sprintf } from 'sprintf-js';
import { type } from 'os';

const argv = yargs.argv;

interface CustomSheet {
  sheet: XLSX.WorkSheet;
  name: string;
}

interface AlbumRating {
  artist: string;
  album: string;
  url: string;
  cover: string;
  points: number;
  sources: number[];
  slug: string;
  votesForItem: number;
  totalScoreForItem: number;
  averge: number;
  averageRating: number;
  bayesianWeightedRank: number;
}

interface AlbumRatingsCollection {
  [key: string]: AlbumRating;
}

interface MemberRatings {
  raw: XLSX.WorkSheet;
  name: string;
  bySlug: { [key: string]: number };
}
interface ColMap {
  [key: string]: string;
}
interface SortOrder {
  field: string;
  reverse: boolean;
}

const COLS: ColMap = {
  RANK: 'A',
  ARTIST: 'B',
  ALBUM: 'C',
  URL: 'D',
};

const sortKeys: (string | SortOrder)[] = [
  'bayesianWeightedRank',
  { field: 'artist', reverse: true },
  { field: 'album', reverse: true },
];

function getCell(sheet, col, row): string | number | boolean {
  const cell = sheet[`${col}${row}`];
  if (!cell) {
    return false;
  }
  return cell.v;
}

function makeSlug(thing: string | string[]): string {
  const ar: string[] = Array.isArray(thing) ? thing : [thing];
  return unidecode(ar.map(s => s.trim()).join('-'))
    .toLowerCase()
    .replace(/[^a-z]+/gi, '-');
}

function getBaseRating(): AlbumRating {
  return {
    points: 0,
    sources: [],
    artist: '',
    album: '',
    slug: '',
    url: '',
    cover: '',
    votesForItem: 0,
    totalScoreForItem: 0,
    averageRating: 0,
    bayesianWeightedRank: 0,
    averge: 0,
  };
}

async function main(): Promise<string> {
  const report: string[] = [];
  const defaultURL =
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vS0RBycTbJhVVtEQv4WlC1UcZpHZSyP7ym71eTiOH45NXX_3gtfFp-IQggBr0fseqavRq-thurRdvuO/pub?output=xlsx';
  const url: string = !argv.source
    ? defaultURL
    : (argv.source as string) || defaultURL;

  const skip: number =
    typeof argv.skip === 'undefined' ? 1 : parseInt(argv.skip as string, 10);

  const res = await fetch(url);
  const raw: Buffer = await res.buffer();
  const wb: XLSX.WorkBook = XLSX.read(raw, { type: 'buffer' });
  const sheets = wb.SheetNames.map((sheetName: string) => {
    const sheet: XLSX.WorkSheet = wb.Sheets[sheetName];
    const cs: CustomSheet = {
      sheet,
      name: sheetName,
    };
    return cs;
  });

  const membersByName = {};
  const scores: AlbumRatingsCollection = {};

  const MAX_ALBUMS = 10;
  let usersWhoRated = 0;
  const usernames: string[] = [];
  sheets.forEach(s => {
    const member: MemberRatings = {
      raw: s.sheet,
      name: s.name,
      bySlug: {},
    };

    membersByName[s.name] = member;
    // Skips sheets with leading underscore
    if (/^[^_]/.test(s.name)) {
      usersWhoRated++;
      usernames.push(s.name);
      for (let row = 1 + skip; row < MAX_ALBUMS + 1 + skip; row++) {
        const rank: number = parseInt(
          getCell(s.sheet, COLS.RANK, row).toString(),
          10,
        );
        const artist: string = getCell(s.sheet, COLS.ARTIST, row).toString();
        const album: string = getCell(s.sheet, COLS.ALBUM, row).toString();
        const url: string = getCell(s.sheet, COLS.URL, row).toString();
        if (rank && artist && album) {
          const slug = makeSlug([artist, album]);

          const score = MAX_ALBUMS - rank + 1;
          member.bySlug[slug] = score;
          if (!scores[slug]) {
            scores[slug] = getBaseRating();
            scores[slug].slug = slug;
            scores[slug].artist = artist;
            scores[slug].album = album;
          }
          if (url && !!url !== false && url !== 'false') {
            scores[slug].url = url;
          }
          scores[slug].points += score;
          scores[slug].sources.push(score);
        }
      }
    }
  });

  let totalVotesCast = 0;
  let totalRatings = 0;

  Object.keys(scores).forEach(slug => {
    scores[slug].votesForItem = scores[slug].sources.length;
    scores[slug].totalScoreForItem = scores[slug].sources.reduce(
      (p, c) => p + c,
      0,
    );
    totalVotesCast += scores[slug].votesForItem;
    totalRatings += scores[slug].totalScoreForItem;
    scores[slug].averageRating =
      scores[slug].totalScoreForItem / scores[slug].votesForItem;
  });

  const totalAverageRating =
    Object.keys(scores)
      .map(s => scores[s].averageRating)
      .reduce((p, c) => p + c, 0) / Object.keys(scores).length;
  const averageNumberVotesTotal = totalVotesCast / Object.keys(scores).length;

  Object.keys(scores).forEach(slug => {
    const item = scores[slug];
    scores[slug].bayesianWeightedRank =
      (averageNumberVotesTotal * totalAverageRating +
        item.votesForItem * item.totalScoreForItem) /
      (averageNumberVotesTotal + item.votesForItem);
  });

  const allScores: AlbumRating[] = [];
  Object.keys(scores).forEach(slug => {
    allScores.push(scores[slug]);
  });
  allScores.sort((a, b) => {
    for (const sortBy of sortKeys) {
      const key = typeof sortBy === 'string' ? sortBy : sortBy.field;
      const order: number = typeof sortBy === 'string' ? 1 : -1;
      if (a[key] < b[key]) {
        return order;
      } else if (a[key] > b[key]) {
        return -order;
      }
    }
    return 0;
  });

  report.push(`
*Total Votes Cast:* ${totalVotesCast}
*Total Ratings:* ${totalRatings}
*Avg Rating Total:* ${totalAverageRating}
*Avg Votes Total:* ${averageNumberVotesTotal}
*Users Who Voted:* ${usersWhoRated}
*Voting Users:* ${usernames
    .sort()
    .map(u => `@${u}`)
    .join(', ')}
  `);

  let count = 0;
  allScores.forEach(rel => {
    rel.averge = rel.points / rel.sources.length;
    count++;
    // const entry = sprintf(
    //   '%2s. %s - %s [%s]',
    //   count,
    //   rel.artist,
    //   rel.album,
    //   rel.slug,
    // );
    const entry = sprintf(
      '%2s. *%s* - _%s_ %.01f/10 (%s votes; %.01f) %s',
      count,
      rel.artist,
      rel.album,
      rel.averageRating,
      rel.votesForItem,
      rel.bayesianWeightedRank,
      rel.url || '',
    );
    // const entry = sprintf(
    //   '%2s. *%s* - _%s_ %.01f/10 (%s votes; %.01f)',
    //   count,
    //   rel.artist,
    //   rel.album,
    //   rel.averageRating,
    //   rel.votesForItem,
    //   rel.bayesianWeightedRank,
    // );
    report.push(entry);
  });

  console.log(report.join('\n'));
  return report.join('\n');
}

main();
