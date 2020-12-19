import fetch, { RequestInit } from 'node-fetch';
import { sha256 } from 'js-sha256';
import path from 'path';
import fs from './fs';

const rgxCache = /\.cache$/i;

interface CacheEntry {
  rawKey: string;
  hashKey: string;
  updated: Date;
  data: any;
}

interface Cache {
  [cacheKey: string]: CacheEntry;
}

interface CacheValidator {
  maxAge?: Date;
  forceUpdate?: boolean;
}

interface CachedFetchOptions {
  json?: boolean;
  cacheValidator?: CacheValidator;
}

let cache: Cache = {};
let dir = '';

// eslint-disable-next-line @typescript-eslint/no-use-before-define
const sizeOf = value => typeSizes[typeof value](value);
const typeSizes = {
  undefined: () => 0,
  boolean: () => 4,
  number: () => 8,
  string: item => 2 * item.length,
  object: item =>
    !item
      ? 0
      : Object.keys(item).reduce(
          (total, key) => sizeOf(key) + sizeOf(item[key]) + total,
          0,
        ),
};

export const setCacheDir = (directory: string): void => {
  dir = directory;
};

export const ingestCache = async (file: string): Promise<void> => {
  const p = path.join(dir, file);
  const data = await fs.readFile(p, { encoding: 'utf-8' });
  const k = file.replace(rgxCache, '');
  try {
    const dat = JSON.parse(data);
    cache[k] = dat;
  } catch (err) {
    console.error(`Cache ${file} corrupt, removing`);
    await fs.unlink(p);
  }
};

export const readCache = async (): Promise<any> => {
  const allFiles = await fs.readdir(dir);
  const files = allFiles
    .filter(f => rgxCache.test(f))
    .filter(f => f.indexOf('_') !== 0);

  console.log(`Loading ${files.length} cache files`);

  cache = {};
  let cc = 0;
  await Promise.all(
    files.map(async f => {
      await ingestCache(f);
      cc++;
      if (cc % 100 === 0) {
        process.stdout.write('.');
      }
    }),
  );
  console.log('');
  const keys = Object.keys(cache).length;
  console.info(`${keys} cache item${keys === 1 ? '' : 's'}`);
};

export const buildHashKey = (rawKey: string): string => sha256(rawKey);

export const buildCachePath = (rawKey: string): string => {
  return path.join(dir, `${buildHashKey(rawKey)}.cache`);
};

export const cacheSet = async (key: string, data: any): Promise<boolean> => {
  const hashKey = buildHashKey(key);
  cache[hashKey] = {
    updated: new Date(),
    hashKey,
    rawKey: key,
    data,
  };
  const cachePath = buildCachePath(key);
  // console.log(`writing ${key} to ${hashKey}`);
  await fs.writeFile(cachePath, JSON.stringify(cache[hashKey], null, 2));
  return true;
};

export const cacheExists = async (rawKey: string): Promise<boolean> => {
  const hashKey = buildHashKey(rawKey);
  // console.log(`Checking cache status ${rawKey}...`);
  const inMem = typeof cache[hashKey] !== 'undefined';
  if (inMem) {
    // console.log(`...${rawKey} is in MEM cache`);
    return true;
  }
  if (await fs.exists(path.join(dir, `${hashKey}.cache`))) {
    // console.log(`...${rawKey} is in DISK cache`);
    return true;
  }
  // console.log(`...${rawKey} is NOT cached`);
  return false;
};

export const cacheGet = async (rawKey: string): Promise<any> => {
  const hashKey = buildHashKey(rawKey);
  // console.info(`Getting ${rawKey} : ${hashKey} from cache...`);
  if (await cacheExists(rawKey)) {
    // console.log(`${rawKey} is in cached`);
    if (typeof cache[hashKey] !== 'undefined') {
      // console.log(`${rawKey} pulled from MEM`, !cache[hashKey] ? '!!!' : ':-)');
      return cache[hashKey].data;
    }
    // console.log(`${rawKey} pulled from DISK`);
    await ingestCache(`${hashKey}.cache`);
    return cache[hashKey].data;
  } else {
    // console.log(`${rawKey} : ${hashKey} : CACHE MISS!`);
  }
  return null;
};

export const wipeCache = async (key: string): Promise<void> => {
  if (await cacheExists(key)) {
    const path = buildCachePath(key);
    if (await fs.exists(path)) {
      await fs.unlink(path);
    }
    delete cache[buildHashKey(key)];
  }
};

export const requestCacheKey = (
  url: string,
  init: RequestInit = {},
): string => {
  const kc: string[] = [];
  kc.push(init.method || 'GET');
  kc.push(url);
  if (init.method === 'POST' && init.body) {
    kc.push(sha256(init.body as string));
  }

  return JSON.stringify(kc);
};

export const isCached = async (
  url: string,
  init: RequestInit = {},
): Promise<boolean> => {
  const key = requestCacheKey(url, init);
  return cacheExists(key);
};

export const cFetch = async (
  url: string,
  init: RequestInit = {},
  options: CachedFetchOptions = {},
): Promise<any> => {
  const rawKey = requestCacheKey(url, init);
  const hashKey = buildHashKey(rawKey);

  // console.log(`cFetch ${rawKey} : ${hashKey} ------------------------`);

  const validator: CacheValidator = {
    forceUpdate: false,
  };

  const o = {
    cacheValidator: validator,
    ...options,
  };

  if (o.cacheValidator.forceUpdate !== true && (await cacheExists(rawKey))) {
    // console.info('Cached:', cache[hashKey]);
    // console.info(`Cache hit for ${rawKey} : ${hashKey}`);
    return cacheGet(rawKey);
  }

  if (o.cacheValidator.forceUpdate === true) {
    console.log(`Cache busting for ${url}`);
  }

  // console.info(`Cache miss for ${url}`); // :: ${kc}`);
  // stdout.write('...');

  let resp = await fetch(url, init);
  if (!resp.ok) {
    return Promise.reject(
      `Error fetching ${url}: ${resp.status} ${resp.statusText}`,
    );
  }
  resp = options.json ? await resp.json() : await resp.text();
  // console.info(`Saving ${buildKey(key)} to cache`);
  await cacheSet(rawKey, resp);
  return resp;
};
