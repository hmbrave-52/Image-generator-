const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Forces Puppeteer to save Chrome inside the project folder so Render keeps it
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
