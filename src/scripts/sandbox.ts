import BandcampController from '../lib/bandcamp';
import MetallumController from '../lib/metallum';

const main = async () => {
  const bc = new BandcampController('./cache');
  const mc = new MetallumController('./cache');

  const res = await mc.searchBand('svrm');

  // const res = await bc.pullRelease(
  //   'https://andoceans.bandcamp.com/album/cosmic-world-mother',
  // );
  console.log(JSON.stringify(res, null, 2));
};

main();
