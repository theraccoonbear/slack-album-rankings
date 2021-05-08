import BandcampController from '../lib/bandcamp';
import MetallumController from '../lib/metallum';

const main = async () => {
  const bc = new BandcampController('./cache');
  const mc = new MetallumController('./cache');

  const bands = await mc.searchBand('Death');
  // console.log(JSON.stringify(bands, null, 2));

  if (bands.results.length) {
    const band = await mc.getBand(bands.results[0].id);
    console.log(band);
  }
};

main();
