// import cheerio from 'cheerio';
// import CollItem from './model/CollItem';
import fs from './fs';
// import format from 'date-fns/format';
// import path from 'path';
// import XLSX from 'xlsx';
import * as Fetch from './fetch-cache';

const fetch = Fetch.cFetch;

const euc = encodeURIComponent;

type MetallumBandSearchResult = [string, string, string];

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
    console.log(data);

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
}
