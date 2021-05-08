require('source-map-support').install();
require('dotenv').config();

import TrelloNodeAPI from 'trello-node-api';
import * as Fetch from './fetch-cache';
import { format, differenceInSeconds, parse } from 'date-fns';
import fs from './fs';
import path from 'path';

import { filterCard } from './trello/default';

const esc = String.fromCharCode(27);

const fetch = Fetch.cFetch;

const TRELLO_API_KEY = process.env.TRELLO_API_KEY;
const TRELLO_OAUTH_TOKEN = process.env.TRELLO_OAUTH_TOKEN;
const TRELLO_BOARD_ID = process.env.TRELLO_BOARD_ID || '';
const TRELLO_QUEUE_LIST_NAME = process.env.TRELLO_QUEUE_LIST_NAME;
const MAX_CACHE_AGE_IN_MINUTES = parseInt(
  process.env.MAX_CACHE_AGE_IN_MINUTES || '5',
  10,
);
const CUSTOM_EVALUATOR = process.env.CUSTOM_EVALUATOR || 'default';

if (!TRELLO_API_KEY) {
  throw new Error('No TRELLO_API_KEY');
}
if (!TRELLO_OAUTH_TOKEN) {
  throw new Error('No TRELLO_OAUTH_TOKEN');
}
if (!TRELLO_BOARD_ID) {
  throw new Error('No TRELLO_BOARD_ID');
}
if (!TRELLO_QUEUE_LIST_NAME) {
  throw new Error('No TRELLO_QUEUE_LIST_NAME');
}

export interface TrelloConfig {
  APIKey: string;
  OAuthToken: string;
  boardId: string;
  queueListName: string;
  cacheDir: string;
}

export interface APIRequest {
  objType: string;
  method: string;
  params?: string[];
}

export interface APICallHistory {
  timestamp: Date;
  request: APIRequest;
  response?: any;
}

export interface PrepareCardOptions {
  cover?: boolean;
  mp3s?: boolean;
}

export class TrelloController {
  private static sharedRgx = /^(?<album>.+), by (?<artist>.*?)( shared by (?<slacker>.+))?$/ims;
  private static artAlbRgx = /^(?<album>[^|]+?)\s+\|\s+(?<artist>.+)$/ims;
  private static releaseDateRgx = /(^|[^\d])(?<mon>[1-9]|1[012])\/(?<day>0?[1-9]|[12][0-9]|3[01])(?:\/(?<year>\d{2,4}))?($|[^\d])/ims;

  private trello: TrelloNodeAPI;
  private queueListName: string;
  private apiReqHist: APICallHistory[] = [];

  constructor(config: TrelloConfig) {
    this.trello = new TrelloNodeAPI(config.APIKey, config.OAuthToken);
    this.queueListName = config.queueListName;
    Fetch.setCacheDir(config.cacheDir);
  }

  APIRequestsInSeconds(seconds: number): number {
    const now = new Date();
    return this.apiReqHist.filter(
      h => differenceInSeconds(now, h.timestamp) <= seconds,
    ).length;
  }

  async APICall(objType: string, method: string, ...params: string[]) {
    const key = [objType, method, params].join('.');

    // if (hasCache(key)) {
    //   // console.log('Cache Hit!', key);
    //   return cachedTrelloResponses[key];
    // }

    // API Rate Limits
    // To help prevent strain on Trello’s servers, our API imposes rate limits per API key for all issued tokens.
    // There is a limit of 300 requests per 10 seconds for each API key and no more than 100 requests per 10 second
    // interval for each token. If a request exceeds the limit, Trello will return a 429 error.
    // source: https://help.trello.com/article/838-api-rate-limits

    let inLast10 = this.APIRequestsInSeconds(10);
    if (inLast10 >= 100) {
      await new Promise(resolve => {
        const intTimer = setInterval(() => {
          inLast10 = this.APIRequestsInSeconds(10);
          if (inLast10 < 100) {
            clearInterval(intTimer);
            resolve();
          }
        }, 1000);
      });
    }

    const apiHit: APICallHistory = {
      timestamp: new Date(),
      request: { objType, method, params },
    };
    this.apiReqHist.push(apiHit);

    const resp = await this.trello[objType][method](...params);
    apiHit.response = resp;

    // setCache(key, resp);
    return resp;
  }

  async getLabels(
    boardId: string = TRELLO_BOARD_ID,
    cleanLabels = true,
  ): Promise<CardLabel[]> {
    const board = await this.APICall('board', 'search', boardId);
    const labels: CardLabel[] = [];
    Object.keys(board.labelNames).forEach(color =>
      labels.push({
        color,
        label: cleanLabels
          ? this.cleanName(board.labelNames[color])
          : board.labelNames[color],
      }),
    );
    return labels;
  }

  async getMonthListsForBoard(
    boardId: string = TRELLO_BOARD_ID,
  ): Promise<{ [key: string]: PreparedList }> {
    const allLists = await this.APICall('board', 'searchLists', boardId);
    const listsByID: {
      [key: string]: PreparedList;
    } = {};
    const now = new Date();
    allLists
      .filter(l => /^[A-Z]{3}\s+'\d{2}$/i.test(l.name))
      .map((l: PreparedList) => {
        l.parseDate = l.name.replace(/[^a-z0-9\s]+/gi, '');
        l.date = parse(l.parseDate, 'MMM yy', now);
        l.monthNumber = parseInt(format(l.date, 'M'), 10);
        return l;
      })
      .forEach(l => (listsByID[l.id] = l));
    return listsByID;
  }

  async listElligibleCards(
    boardId: string = TRELLO_BOARD_ID,
  ): Promise<PreparedList[]> {
    const cards = await this.APICall('board', 'searchCards', boardId);
    const listsByID = await this.getMonthListsForBoard(boardId);
    // console.log(Object.keys(listsByID));
    return Promise.all(
      cards
        .filter(c => filterCard(c, { lists: listsByID }))
        .map(async c => {
          const card = await this.prepareCard(c);
          card.list = listsByID[c.idList];
          // console.log(card);
          // process.exit(0);
          return card;
        }),
    );
  }

  async listCards(boardId) {
    return this.APICall('board', 'searchCards', boardId);
  }

  cleanName(name) {
    return name
      .toLowerCase()
      .replace(/(^(\s+|[^a-z0-9]+)|(\s+|[^a-z0-9]+)$)/gms, '')
      .replace(/-/gms, '')
      .replace(/[^a-z0-9_]+/gms, '_');
  }

  roundToNearest(num: number, nth = 10) {
    const n = parseInt(nth.toString(), 10);
    return Math.round(Math.round(num / n) * n);
  }

  async getCardAttachment(cardId: string, attachmentId: string) {
    // const attach = await Trello.card.searchAttachmentByAttachmentId(cardId, attachmentId);
    const attach = await this.APICall(
      'card',
      'searchAttachmentByAttachmentId',
      cardId,
      attachmentId,
    );
    const image = await fetch(attach.url);
    attach.imageBuffer = await image.buffer();
    return attach;
  }

  async listCardAttachments(cardId: string) {
    return this.APICall('card', 'searchAttachments', cardId);
  }

  async prepareCard(c: any, options: PrepareCardOptions = {}) {
    const card: PreparedCard = {
      id: c.id,
      idBoard: c.idBoard,
      idList: c.idList,
      idLabels: c.idLabels,
      name: c.name,
      desc: c.desc,
      score: 0,
      _meta: c,
      urls: [],
    };

    const o: PrepareCardOptions = {
      ...{
        cover: false,
        mp3s: false,
      },
      ...options,
    };

    card.name = card.name.replace(/\s+$/gims, '');
    if (TrelloController.sharedRgx.test(card.name)) {
      const match = TrelloController.sharedRgx.exec(card.name);
      if (match && match.groups) {
        card.artist = match.groups.artist;
        card.album = match.groups.album;
        if (match.groups.slacker) {
          card.slacker = match.groups.slacker;
        }
      }
    } else if (TrelloController.artAlbRgx.test(card.name)) {
      const match = TrelloController.artAlbRgx.exec(card.name);
      if (match && match.groups) {
        card.artist = match.groups.artist.trim();
        card.album = match.groups.album.trim();
      }
    }

    // console.log('CARD NAME:', card.artist, '--', card.album);

    c.labels.forEach(l => {
      card[`has_${this.cleanName(l.name)}`] = true;
    });
    //   card.score = scoreRelease(card);

    if (TrelloController.releaseDateRgx.test(card.desc)) {
      const match = TrelloController.releaseDateRgx.exec(card.desc);
      if (match && match.groups) {
        const currYear = format(new Date(), 'yyyy');
        const mon = parseInt(match.groups.mon, 10);
        const day = parseInt(match.groups.day, 10);
        const year = parseInt(match.groups.year || currYear, 10);
        card.releaseDate = new Date(year, mon - 1, day);
      }
    }

    const attachments = await this.listCardAttachments(c.id);

    card.urls = attachments
      .filter(a => /\.bandcamp\.com/.test(a.url))
      .map(a => a.url);

    // console.log(c.cover.idAttachment);
    try {
      if (o.cover && c.cover && c.cover.idAttachment) {
        card.cover = await this.getCardAttachment(
          card.id,
          c.cover.idAttachment,
        );
      }
    } catch (err) {
      console.log(err);
      process.exit(0);
    }
    // console.log(attachments);

    return card;
  }
}

// **************************************************************************************************************

// console.log(`Using the "${CUSTOM_EVALUATOR}" evaluator`);
// export const {
//   scoreRelease,
//   filterCard,
//   MAX_SCORE,
// } = require(`./custom/${CUSTOM_EVALUATOR}`);

const Trello = new TrelloNodeAPI(TRELLO_API_KEY, TRELLO_OAUTH_TOKEN);

// import { BandcampAlbum, loadAlbum } from './bandcamp';
import { load } from 'cheerio';
import { isThisTypeNode } from 'typescript';

const CACHE_DIR = '.cache';

const currYear = format(new Date(), 'yyyy');

let sharesBySlacker = {};
let boardLists = [];

const cachedTrelloResponses = {};

export interface PreparedList {
  monthNumber: number;
  id: string;
  name: string;
  closed: boolean;
  pos: number;
  softLimit: null;
  idBoard: string;
  subscribed: boolean;
  parseDate: string;
  date: Date;
}

export interface PreparedCard {
  id: string;
  idBoard: string;
  idList: string;
  idLabels: string[];
  name: string;
  desc: string;
  artist?: string;
  album?: string;
  BCAlbum?: any; //BandcampAlbum;
  slacker?: string;
  releaseDate?: Date;
  score: number;
  _meta: any;
  cover?: any;
  urls: string[];
  list?: any;
}

export interface CardLabel {
  color: string;
  label: string;
}

export interface RankedSlacker {
  slacker: string;
  average: number;
  count: number;
  bayesianWeightedRank: number;
  weightedAverage: number;
  percent: number;
}

function recordSlackerShare(slacker, score) {
  sharesBySlacker[slacker] = sharesBySlacker[slacker] || [];
  sharesBySlacker[slacker].push(score);
}

export function terminalHyperlink(url: string, text: string): string {
  return `${esc}]8;;${url}${esc}\\${text}${esc}]8;;${esc}\\`;
}

export async function loadCache() {
  const files = await fs.readdir(CACHE_DIR);
  // console.log(files);
  const now = new Date();
  await Promise.all(
    files.map(async f => {
      const key = f.replace(/\.cache$/, '');
      // console.log(`Remembering ${key}`);
      const file = path.join(CACHE_DIR, f);
      const stat = await fs.stat(file);
      const age = differenceInSeconds(now, stat.mtime);
      // console.log(`${key} is ${age} seconds old`);
      if (age < 60 * MAX_CACHE_AGE_IN_MINUTES) {
        // default 5 minute cache expiry
        const raw = await fs.readFile(file, { encoding: 'utf-8' });
        try {
          cachedTrelloResponses[key] = JSON.parse(raw);
        } catch (err) {
          console.log(`...curious ${key}`);
          console.error(file);
          console.log(`"${raw}"`);
        }
        return raw;
      }
    }),
  );
}

export function hasCache(key) {
  return typeof cachedTrelloResponses[key] !== 'undefined';
}

export async function setCache(key, val) {
  // console.log('Caching:', key);
  cachedTrelloResponses[key] = val;
  const file = path.join(CACHE_DIR, `${key}.cache`);

  const json = JSON.stringify(val);
  // if (/5e2ce6164aed8d3bcfc31475/.test(key)) {
  //     console.log('WRITING CACHE FOR 5e2ce6164aed8d3bcfc31475');
  //     console.log('Data:', val);
  //     console.log('JSON:', json);
  //     // process.exit(0);
  // }
  if (json.trim().length < 1) {
    console.log('cache wat!', key, val);
    // process.exit(0);
    return;
  }
  try {
    // console.log(`${key} => ${file}`);
    await fs.writeFile(file, json);
  } catch (err) {
    console.log(`File write error!`, err);
  }
}

export async function getCache(key) {
  ``;
  return cachedTrelloResponses[key];
}

// const apiReqHist: APICallHistory[] = [];

// function APIRequestsInSeconds(seconds: number): number {
//   const now = new Date();
//   return apiReqHist.filter(
//     h => differenceInSeconds(now, h.timestamp) <= seconds,
//   ).length;
// }

// export async function APICall(
//   objType: string,
//   method: string,
//   ...params: string[]
// ) {
//   const key = [objType, method, params].join('.');

//   if (hasCache(key)) {
//     // console.log('Cache Hit!', key);
//     return cachedTrelloResponses[key];
//   }

//   // API Rate Limits
//   // To help prevent strain on Trello’s servers, our API imposes rate limits per API key for all issued tokens.
//   // There is a limit of 300 requests per 10 seconds for each API key and no more than 100 requests per 10 second
//   // interval for each token. If a request exceeds the limit, Trello will return a 429 error.
//   // source: https://help.trello.com/article/838-api-rate-limits

//   let inLast10 = APIRequestsInSeconds(10);
//   if (inLast10 >= 100) {
//     await new Promise((resolve, reject) => {
//       const intTimer = setInterval(() => {
//         inLast10 = APIRequestsInSeconds(10);
//         if (inLast10 < 100) {
//           clearInterval(intTimer);
//           resolve();
//         }
//       }, 1000);
//     });
//   }

//   const apiHit: APICallHistory = {
//     timestamp: new Date(),
//     request: { objType, method, params },
//   };
//   apiReqHist.push(apiHit);

//   const resp = await Trello[objType][method](...params);
//   apiHit.response = resp;

//   setCache(key, resp);
//   return resp;
// }

// export async function getLabels(
//   boardId: string = TRELLO_BOARD_ID,
//   cleanLabels = true,
// ): Promise<CardLabel[]> {
//   const board = await APICall('board', 'search', boardId);
//   const labels: CardLabel[] = [];
//   Object.keys(board.labelNames).forEach(color =>
//     labels.push({
//       color,
//       label: cleanLabels
//         ? cleanName(board.labelNames[color])
//         : board.labelNames[color],
//     }),
//   );
//   return labels;
// }

// export async function getMonthListsForBoard(
//   boardId: string = TRELLO_BOARD_ID,
// ): Promise<{ [key: string]: PreparedList }> {
//   const allLists = await APICall('board', 'searchLists', boardId);
//   const listsByID: {
//     [key: string]: PreparedList;
//   } = {};
//   const now = new Date();
//   allLists
//     .filter(l => /^[A-Z]{3}\s+'\d{2}$/i.test(l.name))
//     .map((l: PreparedList) => {
//       l.parseDate = l.name.replace(/[^a-z0-9\s]+/gi, '');
//       l.date = parse(l.parseDate, 'MMM yy', now);
//       l.monthNumber = parseInt(format(l.date, 'M'), 10);
//       return l;
//     })
//     .forEach(l => (listsByID[l.id] = l));
//   return listsByID;
// }

// export async function listElligibleCards(
//   boardId: string = TRELLO_BOARD_ID,
// ): Promise<PreparedList[]> {
//   const cards = await APICall('board', 'searchCards', boardId);
//   const listsByID = await getMonthListsForBoard(boardId);
//   // console.log(Object.keys(listsByID));
//   return Promise.all(
//     cards
//       .filter(c => filterCard(c, { lists: listsByID }))
//       .map(async c => {
//         const card = await prepareCard(c);
//         card.list = listsByID[c.idList];
//         // console.log(card);
//         // process.exit(0);
//         return card;
//       }),
//   );
// }

// export async function listCards(boardId) {
//   return APICall('board', 'searchCards', boardId);
//   // return Trello.board.searchCards(boardId);
// }

// const sharedRgx = /^(?<album>.+), by (?<artist>.*?)( shared by (?<slacker>.+))?$/ims;
// const artAlbRgx = /^(?<album>[^|]+?)\s+\|\s+(?<artist>.+)$/ims;
// const releaseDateRgx = /(^|[^\d])(?<mon>[1-9]|1[012])\/(?<day>0?[1-9]|[12][0-9]|3[01])(?:\/(?<year>\d{2,4}))?($|[^\d])/ims;

// let totalShares = 0;
// const shareScores: number[] = [];

// export function cleanName(name) {
//   return name
//     .toLowerCase()
//     .replace(/(^(\s+|[^a-z0-9]+)|(\s+|[^a-z0-9]+)$)/gms, '')
//     .replace(/-/gms, '')
//     .replace(/[^a-z0-9_]+/gms, '_');
// }

// export function roundToNearest(num: number, nth = 10) {
//   const n = parseInt(nth.toString(), 10);
//   return Math.round(Math.round(num / n) * n);
// }

// export async function getCardAttachment(cardId: string, attachmentId: string) {
//   // const attach = await Trello.card.searchAttachmentByAttachmentId(cardId, attachmentId);
//   const attach = await APICall(
//     'card',
//     'searchAttachmentByAttachmentId',
//     cardId,
//     attachmentId,
//   );
//   const image = await fetch(attach.url);
//   attach.imageBuffer = await image.buffer();
//   return attach;
// }

// export async function listCardAttachments(cardId: string) {
//   return await APICall('card', 'searchAttachments', cardId);
// }

// export interface PrepareCardOptions {
//   cover?: boolean;
//   mp3s?: boolean;
// }

// export async function prepareCard(c: any, options: PrepareCardOptions = {}) {
//   const card: PreparedCard = {
//     id: c.id,
//     idBoard: c.idBoard,
//     idList: c.idList,
//     idLabels: c.idLabels,
//     name: c.name,
//     desc: c.desc,
//     score: 0,
//     _meta: c,
//     urls: [],
//   };

//   const o: PrepareCardOptions = {
//     ...{
//       cover: false,
//       mp3s: false,
//     },
//     ...options,
//   };

//   card.name = card.name.replace(/\s+$/gims, '');
//   if (sharedRgx.test(card.name)) {
//     const match = sharedRgx.exec(card.name);
//     if (match && match.groups) {
//       card.artist = match.groups.artist;
//       card.album = match.groups.album;
//       if (match.groups.slacker) {
//         card.slacker = match.groups.slacker;
//       }
//     }
//   } else if (artAlbRgx.test(card.name)) {
//     const match = artAlbRgx.exec(card.name);
//     if (match && match.groups) {
//       card.artist = match.groups.artist.trim();
//       card.album = match.groups.album.trim();
//     }
//   }

//   // console.log('CARD NAME:', card.artist, '--', card.album);

//   c.labels.forEach(l => {
//     card[`has_${cleanName(l.name)}`] = true;
//   });
//   //   card.score = scoreRelease(card);

//   if (releaseDateRgx.test(card.desc)) {
//     const match = releaseDateRgx.exec(card.desc);
//     if (match && match.groups) {
//       const mon = parseInt(match.groups.mon, 10);
//       const day = parseInt(match.groups.day, 10);
//       const year = parseInt(match.groups.year || currYear, 10);
//       card.releaseDate = new Date(year, mon - 1, day);
//     }
//   }

//   const attachments = await listCardAttachments(c.id);

//   card.urls = attachments
//     .filter(a => /\.bandcamp\.com/.test(a.url))
//     .map(a => a.url);

//   // console.log(c.cover.idAttachment);
//   try {
//     if (o.cover && c.cover && c.cover.idAttachment) {
//       card.cover = await getCardAttachment(card.id, c.cover.idAttachment);
//     }
//   } catch (err) {
//     console.log(err);
//     process.exit(0);
//   }
//   // console.log(attachments);

//   return card;
// }

// export async function slackerCompatability() {
//   sharesBySlacker = {};
//   totalShares = 0;
//   const cards = await listCards(TRELLO_BOARD_ID);
//   await Promise.all(
//     cards.map(async c => {
//       const card = await prepareCard(c);

//       if (card.slacker && card.score >= 1) {
//         recordSlackerShare(card.slacker, card.score);
//         totalShares++;
//         shareScores.push(card.score);
//       }
//     }),
//   );

//   const averageNumberVotesTotal =
//     Object.keys(sharesBySlacker).reduce(
//       (prev, slacker) => prev + sharesBySlacker[slacker].length,
//       0,
//     ) / Object.keys(sharesBySlacker).length;
//   const totalAverageRating =
//     shareScores.reduce((p, c) => p + c, 0) / shareScores.length;
//   // console.log('averageNumberVotesTotal:', averageNumberVotesTotal);
//   // console.log('totalAverageRating:', totalAverageRating);

//   const maxShares = Object.keys(sharesBySlacker).reduce(
//     (p, slacker) => Math.max(p, sharesBySlacker[slacker].length),
//     0,
//   );

//   const rankedSlackers: RankedSlacker[] = [];
//   Object.keys(sharesBySlacker).forEach(slacker => {
//     const shortBy = maxShares - sharesBySlacker[slacker].length;
//     const slackerShares = [
//       ...sharesBySlacker[slacker],
//       ...new Array(shortBy).fill(totalAverageRating),
//     ];

//     const totalScoreForItem = sharesBySlacker[slacker].reduce(
//       (p, c) => p + c,
//       0,
//     );
//     const average = totalScoreForItem / sharesBySlacker[slacker].length;
//     const count = sharesBySlacker[slacker].length;

//     const weightedAverage =
//       slackerShares.reduce((p, c) => p + c, 0) / maxShares;

//     // const bayesianWeightedRank =
//     //     (averageNumberVotesTotal * totalAverageRating +
//     //         item.votesForItem * item.totalScoreForItem) /
//     //     (averageNumberVotesTotal + item.votesForItem);
//     const bayesianWeightedRank =
//       (averageNumberVotesTotal * totalAverageRating +
//         count * totalScoreForItem) /
//       (averageNumberVotesTotal + count);
//     rankedSlackers.push({
//       slacker,
//       average,
//       count,
//       bayesianWeightedRank,
//       weightedAverage,
//       percent: (weightedAverage / 5) * 100,
//     });
//   });

//   const sortField = 'weightedAverage';

//   rankedSlackers.sort((a, b) => {
//     if (a[sortField] < b[sortField]) {
//       return 1;
//     }
//     if (a[sortField] > b[sortField]) {
//       return -1;
//     }
//     return 0;
//   });

//   return rankedSlackers;
// }

// export async function getNextPlay() {
//   if (boardLists.length < 1) {
//     // boardLists = await Trello.board.searchLists(TRELLO_BOARD_ID);
//     boardLists = await APICall('board', 'searchLists', TRELLO_BOARD_ID);
//   }

//   const queueList: any = [
//     ...boardLists.filter(
//       (l: any) => cleanName(l.name) === cleanName(TRELLO_QUEUE_LIST_NAME),
//     ),
//     false,
//   ].shift();

//   if (!queueList) {
//     throw new Error(
//       `Couldn't find a Trello list called "${TRELLO_QUEUE_LIST_NAME}"`,
//     );
//   }

//   // const results = await Trello.board.searchCards(TRELLO_BOARD_ID);
//   const results = await APICall('board', 'searchCards', TRELLO_BOARD_ID);

//   const options = await Promise.all(
//     results.filter((c: any) => c.idList === queueList.id),
//   );

//   if (options.length < 1) {
//     throw new Error('nothing in the queue, check back later');
//   }

//   return prepareCard(options[0], { cover: true });
// }

// export async function getRelistens(): Promise<any[]> {
//   const raw = await APICall('board', 'searchCards', TRELLO_BOARD_ID);
//   const prepared = await Promise.all(raw.map(c => prepareCard(c)));
//   // console.log(await prepareCard(raw[1]));
//   // process.exit(0)
//   const filtered = prepared.filter(
//     (c: any) =>
//       c.has_relisten && c.artist && c.album && /bandcamp/.test(c.urls[0]),
//   );
//   const bcPrepped = await Promise.all(
//     filtered.map(async (c: any) => {
//       c.BCAlbum = await loadAlbum(c.urls[0], false);
//       return c;
//     }),
//   );
//   bcPrepped.sort((a: any, b: any) =>
//     compareAsc(b.BCAlbum.releaseDate, a.BCAlbum.releaseDate),
//   );

//   return await Promise.all(
//     bcPrepped.slice(0, 10).map(async c => {
//       const rePrepared = await prepareCard(c._meta, { cover: true });

//       return { ...c, ...rePrepared, releaseDate: c.BCAlbum.releaseDate };
//     }),
//   );
//   // const options = await Promise.all(
//   //     results
//   //         .filter((c: any) => c.idList === queueList.id)
//   // );

//   // if (options.length < 1) {
//   //     throw new Error("nothing in the queue, check back later");
//   // }

//   // return prepareCard(options[0], true);
// }
