import cheerio from 'cheerio';
// import fs from './fs';
import * as Fetch from './fetch-cache';
import { getTLD } from 'tld-countries';

const fetch = Fetch.cFetch;

const euc = encodeURIComponent;

type MetallumBandSearchResult = [string, string, string];

export interface MetallumRelease {
  name: string;
  type: string;
  year: number;
}

export interface MetallumBandRole {
  position: string;
  active_periods: string[];
}

export interface MetallumBandMember {
  name: string;
  current: boolean;
  roles: string[]; //MetallumBandRole[];
}

export interface MetallumBand {
  id: number;
  url: string;
  name: string;
  country: string;
  tld: string;
  location: string;
  status: string;
  formed: string;
  activePeriods: string[];
  description: string;
  genres: string[];
  themes: string[];
  labels: string[];
  releases: MetallumRelease[];
  members: MetallumBandMember[];
}
export interface MetallumBandSearchResponse {
  error: string;
  iTotalRecords: number;
  iTotalDisplayRecords: number;
  sEcho: number;
  aaData: MetallumBandSearchResult[];
}

export interface BandSearchResult {
  id: number;
  name: string;
  url: string;
  genres: string[];
  country: string;
}

export interface BandSearchResponse {
  error: boolean;
  message: string;
  results: BandSearchResult[];
}

const tld = (name: string) => {
  switch (name) {
    case 'United States':
      name += ' of America';
      break;
  }
  return getTLD(name);
};

export default class MetallumController {
  constructor(cacheDir: string) {
    Fetch.setCacheDir(cacheDir);
  }

  async searchBand(search: string): Promise<BandSearchResponse> {
    const results: BandSearchResult[] = [];
    const url = `https://www.metal-archives.com/search/ajax-band-search/?field=name&query=${euc(
      search,
    )}`;

    const res = await fetch(url);
    const data = JSON.parse(res) as MetallumBandSearchResponse;

    return {
      error: !!data.error.length,
      message: data.error,
      results: data.aaData.map(rt => {
        return {
          name: rt[0].replace(/^<[^>]+>([^<]+)<.+$/, '$1'),
          genres: rt[1].split(/\/|;\s*/),
          country: rt[2],
          url: rt[0].replace(/^<.+href="([^"]+)".+$/, '$1'),
          id: parseInt(rt[0].replace(/^<.+href=".+?(\d+)".+$/, '$1')),
        };
      }),
    };
  }

  async getBand(id: number): Promise<Partial<MetallumBand> | null> {
    // https://www.metal-archives.com/bands/Death/141
    const fetchUrl = `https://www.metal-archives.com/bands/band-name/${id}`;

    const resp = await fetch(fetchUrl);

    const $ = cheerio.load(resp);
    const $info = $('#band_info');
    // console.log($info.text());

    const name = $info.find('.band_name a').text();
    const url = $info.find('.band_name a').attr('href');

    const $stats = $info.find('#band_stats');
    const stats = $stats.find('dt, dd');
    let stLbl = '';
    let stVal = '';

    const blender: Partial<MetallumBand> = {
      members: [],
    };

    stats.map((i, e) => {
      if (i % 2 === 0) {
        stLbl = $(e).text();
      } else {
        stVal = $(e).text();
        switch (stLbl.toLowerCase()) {
          case 'country of origin:':
            blender.country = stVal;
            blender.tld = tld(stVal);
            break;
          case 'location:':
            blender.location = stVal;
            break;
          case 'status:':
            blender.status = stVal;
            break;
          case 'formed in:':
            blender.formed = stVal;
            break;
          case 'genre:':
            blender.genres = stVal.split(/\/|[;,]\s*/g);
            break;
          case 'lyrical themes:':
            blender.themes = stVal.split(/;\s*/g);
            break;
          case 'last label:':
            blender.labels = [stVal];
            break;
          case 'years active:':
            blender.activePeriods = stVal.trim().split(/,\s*/g);
            break;
        }
      }
    });

    const $members = $('#band_tab_members_current .lineupTable').find(
      'tr.lineupRow, tr.lineupBandsRow',
    );
    $members.map((i, e) => {
      const $e = $(e);
      // console.log($e.hasClass('lineupRow'));
    });

    // console.log(res);
    let memName = '';
    let memRoles: string[] = [];
    let memAlso: string[] = [];
    $members.map((i, e) => {
      const $e = $(e);
      if ($e.hasClass('lineupRow')) {
        memName = $e
          .find('td')
          .eq(0)
          .text()
          .trim();

        const role = $e
          .find('td')
          .eq(1)
          .text()
          .trim();
        memRoles = [role];
      } else {
        // memAlso = $e
        //   .find('td')
        //   .eq(0)
        //   .text()
        //   .trim();

        blender.members?.push({
          name: memName,
          roles: memRoles,
          current: true,
        });
      }
    });

    // process.exit(0);
    const band: Partial<MetallumBand> = {
      id,
      name,
      url,
      ...blender,
    };

    return band;
  }
}
