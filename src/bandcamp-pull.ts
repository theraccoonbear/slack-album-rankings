import * as Fetch from './lib/fetch-cache';
import path from 'path';

import BandcampController from './lib/bandcamp';
import * as sms from 'source-map-support';
import XLSX from 'xlsx';
sms.install();

async function main(): Promise<void> {
  const bc = new BandcampController('./cache');
  Fetch.setCacheDir('./cache');
  await Fetch.readCache();

  const members = [
    'theraccoonbear',
    'jtextreme',
    'hurriquakes',
    'erosenoir',
    'blacksaabath',
    'quercusalba',
    'thechrisproject',
    'WestbyC',
    'matte_black',
    'paperwasp',
    'Tsq',
    'e-rock10',
    'adamsimcock',
  ];

  const wb = await bc.processFans(members);

  console.log(`Outputting complete XLSX workbook...`);
  XLSX.writeFile(
    wb,
    path.join('rendered', 'data', '2020-slacker-raw-lists.xlsx'),
  );
  console.log('done!');
}

main();
