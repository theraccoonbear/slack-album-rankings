import * as cbfs from 'fs';
import util from 'util';
import path from 'path';
import yargs from 'yargs';
import fetch from 'node-fetch';
import XLSX from 'xlsx';
import unidecode from 'unidecode';
import Handlebars from 'handlebars';
import { sprintf } from 'sprintf-js';

const fs = {
  readFile: util.promisify(cbfs.readFile),
  writeFile: util.promisify(cbfs.writeFile),
  exists: util.promisify(cbfs.exists),
  readdir: util.promisify(cbfs.readdir),
};

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
  place: number;
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

Handlebars.registerHelper('joiner', (data, joinWith = ', ') => {
  return (data as string[]).join(joinWith.toString());
});

Handlebars.registerHelper('sprintf', (templateString, ...data) => {
  return sprintf(templateString.toString(), ...data);
});

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
    place: 0,
  };
}

async function render(templateName: string, data): Promise<string> {
  const tmplPath: string = path.join('templates', `${templateName}.hbs`);
  if (!(await fs.exists(tmplPath))) {
    throw new Error(`Cannot find template ${tmplPath}`);
  }
  const rawTmpl = await fs.readFile(tmplPath, { encoding: 'utf8' });
  const tmpl = Handlebars.compile(rawTmpl);
  return tmpl(data);
}

async function main(): Promise<void> {
  const report: string[] = [];
  const defaultURL =
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vS0RBycTbJhVVtEQv4WlC1UcZpHZSyP7ym71eTiOH45NXX_3gtfFp-IQggBr0fseqavRq-thurRdvuO/pub?output=xlsx';
  const url: string = !argv.source
    ? defaultURL
    : (argv.source as string) || defaultURL;

  const skip: number =
    typeof argv.skip === 'undefined' ? 1 : parseInt(argv.skip as string, 10);

  console.log('Fetching data...');
  const res = await fetch(url);
  const raw: Buffer = await res.buffer();
  console.log(`...fetched ${(raw.length / 1024).toFixed(1)}Kbytes`);
  console.log('Reading workbook...');
  const wb: XLSX.WorkBook = XLSX.read(raw, { type: 'buffer' });
  console.log(
    `Read ${wb.SheetNames.length} worksheet${
      wb.SheetNames.length === 1 ? '' : 's'
    }`,
  );
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
  const allVotingUsernames: string[] = [];
  sheets.forEach(s => {
    const member: MemberRatings = {
      raw: s.sheet,
      name: s.name,
      bySlug: {},
    };

    membersByName[s.name] = member;
    // Skips sheets with leading underscore
    if (/^[^_]/.test(s.name)) {
      console.log(`Processing ${s.name}...`);
      usersWhoRated++;
      allVotingUsernames.push(s.name);
      for (let row = 1 + skip; row < MAX_ALBUMS + 1 + skip; row++) {
        const rank: number = parseInt(
          getCell(s.sheet, COLS.RANK, row).toString(),
          10,
        );
        const artist: string = getCell(s.sheet, COLS.ARTIST, row)
          .toString()
          .trim();
        const album: string = getCell(s.sheet, COLS.ALBUM, row)
          .toString()
          .trim();
        const url: string = getCell(s.sheet, COLS.URL, row)
          .toString()
          .trim();
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

  console.log('');
  console.log('Calculating album averages...');
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

    console.log(
      `${slug} => ${'☑'.repeat(scores[slug].sources.length)} => ${scores[
        slug
      ].averageRating.toFixed(1)}/10`,
    );
  });

  console.log('Calculating total average rating...');
  const totalAverageRating =
    Object.keys(scores)
      .map(s => scores[s].averageRating)
      .reduce((p, c) => p + c, 0) / Object.keys(scores).length;
  const averageNumberVotesTotal = totalVotesCast / Object.keys(scores).length;

  console.log('Weighting rankings...');
  Object.keys(scores).forEach(slug => {
    const item = scores[slug];
    scores[slug].bayesianWeightedRank =
      (averageNumberVotesTotal * totalAverageRating +
        item.votesForItem * item.totalScoreForItem) /
      (averageNumberVotesTotal + item.votesForItem);
    console.log(
      `${slug} => ${item.averageRating.toFixed(1)}/10 via ${
        item.votesForItem
      } votes ∴ ${item.bayesianWeightedRank.toFixed(1)}`,
    );
  });

  console.log('');
  console.log('Sorting...');

  const allScores: AlbumRating[] = [];
  Object.keys(scores).forEach(slug => {
    allScores.push(scores[slug]);
  });
  allScores.sort((a, b) => {
    for (const sortBy of sortKeys) {
      const key = typeof sortBy === 'string' ? sortBy : sortBy.field;
      const order: number = typeof sortBy === 'string' ? 1 : -1;

      const aVal = typeof a[key] === 'string' ? a[key].toLowerCase() : a[key];
      const bVal = typeof b[key] === 'string' ? b[key].toLowerCase() : b[key];

      if (aVal < bVal) {
        return order;
      } else if (aVal > bVal) {
        return -order;
      }
    }
    return 0;
  });

  let placeCount = 0;
  allScores.forEach(s => (s.place = ++placeCount));

  const usernames = allVotingUsernames
    .sort((a: string, b: string) => {
      if (a.toLowerCase() < b.toLocaleLowerCase()) {
        return -1;
      } else if (a.toLowerCase() > b.toLocaleLowerCase()) {
        return 1;
      }
      return 0;
    })
    .map(u => `@${u}`);

  const totals = {
    totalVotesCast,
    totalRatings,
    totalAverageRating,
    averageNumberVotesTotal,
    usersWhoRated,
    usernames,
  };

  const reportData = {
    totals,
    picks: allScores,
  };

  console.log('Reporting...');

  const slackRendered = await render('slack', reportData);

  await fs.writeFile('rendered/2019-slacker-picks.md', slackRendered, {
    encoding: 'utf8',
  });

  const htmlRendered = await render('html', reportData);

  await fs.writeFile('rendered/2019-slacker-picks.html', htmlRendered, {
    encoding: 'utf8',
  });

  console.log('Done!');

  // console.log(slackRendered);
}

main();
