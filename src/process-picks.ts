import yargs from 'yargs';
import fetch from 'node-fetch';
import XLSX from 'xlsx';
import unidecode from 'unidecode';
import { sprintf } from 'sprintf-js';

const argv = yargs.argv;

interface CustomSheet {
  sheet: XLSX.WorkSheet;
  name: string;
}

const COLS = {
  RANK: 'A',
  ARTIST: 'B',
  ALBUM: 'C',
  URL: 'D',
};

function getCell(sheet, col, row): string | number | boolean {
  const cell = sheet[`${col}${row}`];
  if (!cell) {
    return false;
  }
  return cell.v;
}

function makeSlug(thing: string): string {
  return unidecode(thing)
    .toLowerCase()
    .trim()
    .replace(/[^a-z]+/, '-');
}

async function main(): Promise<string> {
  const report: string[] = [];
  const defaultURL =
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vS0RBycTbJhVVtEQv4WlC1UcZpHZSyP7ym71eTiOH45NXX_3gtfFp-IQggBr0fseqavRq-thurRdvuO/pub?output=xlsx';
  const url: string = !argv.source
    ? defaultURL
    : ((argv.source as string) || defaultURL).toString();

  const skip: number =
    typeof argv.skip === 'undefined' ? 1 : parseInt(argv.skip as string, 10);

  const res = await fetch(url);
  const raw = await res.buffer();
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
  const scores = {};

  const MAX_ALBUMS = 10;
  let usersWhoRated = 0;
  const usernames: string[] = [];
  sheets.forEach(s => {
    interface MemberRatings {
      raw: XLSX.WorkSheet;
      name: string;
      bySlug: any;
    }

    const member: MemberRatings = {
      raw: s.sheet,
      name: s.name,
      bySlug: {},
    };

    membersByName[s.name] = member;
    if (/^[^_]/.test(s.name)) {
      usersWhoRated++;
      usernames.push(s.name);
      for (let row = 1 + skip; row < MAX_ALBUMS + 1 + skip; row++) {
        const rank: number = parseInt(
          getCell(s.sheet, COLS.RANK, row).toString(),
          10,
        );
        const artist = getCell(s.sheet, COLS.ARTIST, row);
        const album = getCell(s.sheet, COLS.ALBUM, row);
        if (rank && artist && album) {
          const slug = makeSlug(`${artist}-${album}`);

          const score = MAX_ALBUMS - rank + 1;
          member.bySlug[slug] = score;
          if (!scores[slug]) {
            scores[slug] = {
              points: 0,
              sources: [],
              artist,
              album,
            };
          }
          scores[slug].points += score;
          scores[slug].sources.push(score);
        }
      }
    }
  });

  let totalVotesCast = 0;
  let totalRatings = 0;

  // foreach my $slug (keys %{ $scores }) {
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

  // foreach my $slug (keys %{ $scores }) {
  Object.keys(scores).forEach(slug => {
    const item = scores[slug];
    scores[slug].bayesianWeightedRank =
      (averageNumberVotesTotal * totalAverageRating +
        item.votesForItem * item.totalScoreForItem) /
      (averageNumberVotesTotal + item.votesForItem);
  });

  const sortBy = 'bayesianWeightedRank';
  const allScores: any[] = [];
  Object.keys(scores).forEach(slug => {
    allScores.push(scores[slug]);
  });
  allScores.sort((a, b) => {
    if (a[sortBy] < b[sortBy]) {
      return 1;
    } else if (a[sortBy] > b[sortBy]) {
      return -1;
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
    report.push(
      sprintf(
        '%2s. *%s* - _%s_ %.01f/10 (%s votes; %.01f)',
        count,
        rel.artist,
        rel.album,
        rel.averageRating,
        rel.votesForItem,
        rel[sortBy],
      ),
    );
  });

  console.log(report.join('\n'));
  return report.join('\n');
}

main();
