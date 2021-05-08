import util from 'util';
import * as cbfs from 'fs';

const fs = {
  readFile: util.promisify(cbfs.readFile),
  writeFile: util.promisify(cbfs.writeFile),
  exists: util.promisify(cbfs.exists),
  readdir: util.promisify(cbfs.readdir),
  unlink: util.promisify(cbfs.unlink),
  copyFile: util.promisify(cbfs.copyFile),
  mkdir: util.promisify(cbfs.mkdir),
  stat: util.promisify(cbfs.stat),
};

export default fs;
