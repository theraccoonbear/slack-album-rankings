/* eslint-disable @typescript-eslint/camelcase */
import cheerio from 'cheerio';
import CollItem from './model/CollItem';
import fs from './fs';
import format from 'date-fns/format';
import path from 'path';
import XLSX from 'xlsx';
import * as Fetch from './fetch-cache';

const fetch = Fetch.cFetch;

export enum BandcampReleaseType {
  TRACK = 'track',
  ALBUM = 'album',
}
export interface BandcampTrack {
  ordinal: number;
  title: string;
  album: string;
  artist: string;
  mp3: string | false;
  length_seconds: number;
  length_display: string;
}

export interface BandcampRelease {
  artist: string;
  album: string;
  type: BandcampReleaseType;
  url: string;
  cover_url: string;
  tracks: BandcampTrack[];
  release_date: Date;
  length_seconds: number;
  length_display: string;
  tags: string[];
}

export enum UserListType {
  COLLECTION = 1,
  WISHLIST = 2,
}

const MONTH_NAME_TO_NUMBER = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

const rgxAlbumJSON = /application\/ld\+json">(?<json>.+?)<\/script>/ims;
const rgxRelDate = /\breleas(es|ed|ing)\s+(?<month>[A-Za-z]+)\s+(?<day>\d+),\s+(?<year>\d+)/ims;

const MONTH_NUMBER_TO_NAME = Object.values(MONTH_NAME_TO_NUMBER).map(
  m => Object.keys(MONTH_NAME_TO_NUMBER)[m - 1],
);

export const monthNameToNumber = (name: string): number =>
  MONTH_NAME_TO_NUMBER[name.trim().toLowerCase()];

export const monthNumberToName = (num: number): string =>
  MONTH_NUMBER_TO_NAME[num];

export default class BandcampController {
  constructor(cacheDir: string) {
    Fetch.setCacheDir(cacheDir);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async asyncSeq(list: any[], action: Function): Promise<object[]> {
    const ret: object[] = [];
    return new Promise((resolve, reject) => {
      try {
        const doNext = (): void => {
          if (list.length === 0) {
            return resolve(ret);
          }
          const elem = list.shift();
          action(elem).then(result => {
            ret.push(result);
            doNext();
          });
        };
        doNext();
      } catch (err) {
        reject(err);
      }
    });
  }

  public secToHMS(seconds: number): string {
    const ret: number[] = [];

    const hours = Math.floor(seconds / 60 / 60);
    seconds -= hours * 60 * 60;
    const minutes = Math.floor(seconds / 60);
    seconds -= Math.floor(minutes * 60);
    if (hours > 0) {
      ret.push(hours);
    }
    ret.push(minutes);
    ret.push(seconds);
    return ret
      .map((v, i) => (v < 9 && i > 0 ? `0${v.toFixed(0)}` : `${v.toFixed(0)}`))
      .join(':');
  }

  async downloadRelease(
    url: string,
    saveDir: string,
  ): Promise<BandcampRelease> {
    if (!(await fs.exists(saveDir))) {
      throw new Error(`Directory does not exist: "${saveDir}"`);
    }

    const release = await this.pullRelease(url);

    const albumFolder = `${release.artist} - ${release.album}`;
    const albumPath = path.join(saveDir, albumFolder);
    if (!(await fs.exists(albumPath))) {
      await fs.mkdir(albumPath);
    }


    return release;
  }

  async pullRelease(url: string): Promise<BandcampRelease> {
    const html = await fetch(url);

    const release: BandcampRelease = {
      url,
      cover_url: '_cover_',
      artist: '_artist_',
      album: '_album_',
      release_date: new Date(1950, 0, 1),
      tracks: [],
      type: BandcampReleaseType.ALBUM,
      length_display: '0:00',
      length_seconds: 0,
      tags: [],
    };

    const $ = cheerio.load(html);
    let dataAlbum: boolean | any = false;
    const data = $('head script').filter((i, s) => $(s).data('tralbum'));
    if (data.length) {
      dataAlbum = $(data).data('tralbum');
    }

    if (rgxAlbumJSON.test(html)) {
      const match = rgxAlbumJSON.exec(html);
      const json = JSON.parse(
        match && match.groups && match.groups.json
          ? match.groups.json.trim()
          : '{}',
      ) as any;

      // console.log(JSON.stringify(json, null, 2));

      if (json.name) {
        release.album = json.name;
      }
      if (json.byArtist) {
        if (json.byArtist.name) {
          release.artist = json.byArtist.name;
        }
        if (json.byArtist.image) {
          release.cover_url = json.byArtist.image;
        }
      }
      if (json.keywords) {
        release.tags = json.keywords.split(/, /);
      }
      let time = 0;
      release.tracks = json.track.itemListElement
        .filter(t => !!t.item)
        .map(
          (t, idx): BandcampTrack => {
            time += t.item.duration_secs;
            const tr: BandcampTrack = {
              mp3: false,
              artist: release.artist,
              album: release.album,
              ordinal: t.position,
              title: t.item.name,
              length_seconds: t.item.duration_secs,
              length_display: this.secToHMS(t.item.duration_secs),
            };

            if (dataAlbum && dataAlbum.trackinfo && dataAlbum.trackinfo[idx]) {
              tr.mp3 = dataAlbum.trackinfo[idx].file['mp3-128'];
            }

            return tr;
          },
        );

      release.length_seconds = time;
      release.length_display = this.secToHMS(time);
    }

    if (rgxRelDate.test(html)) {
      const matches = rgxRelDate.exec(html);
      if (
        matches &&
        matches.groups &&
        matches.groups.month &&
        matches.groups.day &&
        matches.groups.year
      ) {
        const mNum = monthNameToNumber(matches.groups.month) - 1;
        release.release_date = new Date(
          parseInt(matches.groups.year),
          mNum,
          parseInt(matches.groups.day),
        );
      }
    }

    return release;
  }

  async pullFanList(
    username: string,
    listType: UserListType = UserListType.COLLECTION,
  ): Promise<CollItem[]> {
    const userPage = await fetch(`https://bandcamp.com/${username}`, {
      method: 'GET',
      headers: {
        Referer: `https://bandcamp.com/`,
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/83.0.4103.116 Safari/537.36',
      },
    });
    const $ = cheerio.load(userPage);
    const $pagedata = $('#pagedata');
    const userData = $pagedata.data('blob');
    const type = listType === UserListType.WISHLIST ? 'wishlist' : 'collection';
    const collection = `https://bandcamp.com/api/fancollection/1/${type}_items`;

    console.info(`Grabbing ${type} for ${username}`);
    const resp = await fetch(
      collection,
      {
        method: 'POST',
        body: JSON.stringify({
          fan_id: userData.fan_data.fan_id,
          older_than_token: '3000000000:1:a::',
          count: 10000,
        }),
        headers: {
          Referer: `https://bandcamp.com/${username}`,
        },
      },
      { json: true, cacheValidator: { forceUpdate: true } },
    );

    const items = resp.items as CollItem[];

    console.info(`Found ${items.length} items in ${username}'s ${type}`);
    console.info(`Checking cache...`);
    let cacheHitCnt = 0;
    await Promise.all(
      items.map(async a => {
        const is = await Fetch.isCached(a.item_url);
        if (is) {
          cacheHitCnt++;
        }
        process.stdout.write(is ? '+' : '-');
        return is;
      }),
    );
    console.info(
      `\nLocated ${cacheHitCnt} of ${username}'s collection in the cache`,
    );
    console.info(`Retrieving info for ${items.length - cacheHitCnt} albums...`);
    const list = await this.asyncSeq(items, async (a: CollItem) => {
      const data = await fetch(a.item_url);
      process.stdout.write('.');

      if (rgxRelDate.test(data)) {
        const matches = rgxRelDate.exec(data);
        if (matches && matches.groups) {
          const d = matches.groups;
          const year = parseInt(d.year);
          const month =
            parseInt(MONTH_NAME_TO_NUMBER[d.month.toLowerCase()]) - 1;
          const day = parseInt(d.day);
          a.release_date = new Date(year, month, day);
        }
      } else {
        // default to something obviously wrong
        a.release_date = new Date(1950, 0, 1);
      }
      return a;
    });

    console.log(`\nDetails for ${list.length} releases retrieved`);

    return list as CollItem[];
  }

  private toRow(a: CollItem): string[] {
    return [
      a.purchased ? '✓' : '✖',
      format(a.release_date, 'M/d/y'),
      a.band_name,
      a.album_title,
      a.item_url,
    ];
  }

  async pullFanFullList(
    username: string,
    wb: XLSX.WorkBook,
  ): Promise<CollItem[]> {
    const list = [
      ...(await this.pullFanList(username, UserListType.COLLECTION)),
      ...(await this.pullFanList(username, UserListType.WISHLIST)),
    ];

    console.log(`Filtering for this year's ${list.length} releases...`);

    const sortProp = 'band_name';

    const filtered = list
      .filter((a: CollItem) => a.release_date.getFullYear() === 2020)
      .sort((a: CollItem, b: CollItem) => {
        if (a.purchased && !b.purchased) {
          return -1;
        }
        if (!a.purchased && b.purchased) {
          return 1;
        }
        if ((a[sortProp] as string) < (b[sortProp] as string)) {
          return -1;
        }
        if ((a[sortProp] as string) > (b[sortProp] as string)) {
          return 1;
        }
        return 0;
      });
    console.log(`${username}'s 2020 Albums:`);
    filtered.map((a: CollItem) => {
      const month = monthNumberToName(a.release_date.getMonth());
      console.log(
        `  ${a.purchased ? '✓' : '✖'} ${a.band_name} - ${
          a.album_title
        } (${month[0].toUpperCase() +
          month.slice(
            1,
          )} ${a.release_date.getDate()}, ${a.release_date.getFullYear()})`,
      );
    });

    console.log(`Found ${filtered.length} albums for ${username}`);
    console.log('***************************************');

    const rawCollData = filtered.map(i => this.toRow(i));
    const sheet = XLSX.utils.aoa_to_sheet([
      ['purchased?', 'release date', 'artist', 'album', 'url'],
      ...rawCollData,
    ]);
    XLSX.utils.book_append_sheet(wb, sheet, username);

    const tsv = rawCollData.map(r => r.join('\t')).join('\n');

    const newFile = path.join('rendered', 'data', `${username}.tsv`);
    await fs.writeFile(newFile, tsv);

    return filtered;
  }

  async processFans(fans: string[]): Promise<XLSX.WorkBook> {
    const wb: XLSX.WorkBook = XLSX.utils.book_new();

    const ret: object[] = [];
    return new Promise((resolve, reject) => {
      try {
        const doNext = (): void => {
          if (fans.length === 0) {
            return resolve(wb);
          }
          const elem: string = fans.shift() || '';
          this.pullFanFullList(elem, wb).then(result => {
            ret.push(result);
            doNext();
          });
        };
        doNext();
      } catch (err) {
        reject(err);
      }
    });
  }
}
